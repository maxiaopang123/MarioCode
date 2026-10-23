/**
 * Codex bridge deadline policy.
 *
 * The bridge (src/main/providers/codex-sdk/codexResponsesBridge.ts) used to
 * give each /responses call ONE fixed 5-minute deadline. That is the wrong
 * shape for a streaming turn: a healthy reply that streams for longer than the
 * budget was aborted mid-stream with "Codex upstream request timed out".
 *
 * The policy is now: bound SILENCE, not total duration.
 *   A. steady output is never killed — 300ms of output with a 60ms idle budget
 *      finishes normally (5x the idle budget, every gap well under it);
 *   B. a stream that stops moving is aborted on the idle budget ("went silent");
 *   C. an upstream that only sends SSE heartbeats cannot hold the request open
 *      forever — the absolute ceiling still fires.
 *
 * The test drives the real handler over its real loopback HTTP server, with a
 * fake upstream `fetch` injected, and scaled-down budgets passed through
 * config (`idleTimeoutMs` / `firstByteTimeoutMs` / `timeoutMs`) — the defaults
 * are 120s / 180s / 12h, which no test could wait for.
 *
 * Run: node scripts/codex-bridge-timeout-smoke/run.mjs
 */
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { desktopDir, importMainModule } from "../lib/main-bundle.mjs";

// The bridge's default upstream (`engineFetch`) drags in electron and
// better-sqlite3; importMainModule shims both, and we inject our own fetch.
const { startCodexResponsesBridge } = await importMainModule(
  resolve(desktopDir, "src/main/providers/codex-sdk/codexResponsesBridge.ts"),
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * A fake upstream whose SSE body is produced by `gen`.
 *
 * The signal wiring matters: a real `fetch` body REJECTS `read()` when the
 * request signal aborts. A bare ReadableStream knows nothing about the signal,
 * so without this the bridge would sit in `await reader.read()` forever and the
 * watchdog cases would never observe an abort.
 */
function upstreamFrom(gen) {
  const encoder = new TextEncoder();
  return async (_url, init) => {
    const signal = init.signal;
    const body = new ReadableStream({
      start(controller) {
        const onAbort = () => {
          try { controller.error(signal.reason ?? new Error("aborted")); } catch { /* already closed */ }
        };
        if (signal.aborted) { onAbort(); return; }
        signal.addEventListener("abort", onAbort, { once: true });
        void (async () => {
          try {
            for await (const chunk of gen()) {
              if (signal.aborted) return;
              controller.enqueue(encoder.encode(chunk));
            }
            controller.close();
          } catch {
            // The bridge cancels the reader on abort; the generator unwinds here.
            try { controller.close(); } catch { /* already closed */ }
          }
        })();
      },
    });
    return {
      ok: true,
      status: 200,
      headers: { get: (name) => (name.toLowerCase() === "content-type" ? "text/event-stream" : null) },
      body,
    };
  };
}

/** Drive one /responses call through a fresh bridge and return { text, elapsedMs }. */
async function runTurn({ gen, idleTimeoutMs, firstByteTimeoutMs, timeoutMs }) {
  const bridge = await startCodexResponsesBridge(
    {
      protocol: "chat-completions",
      baseUrl: "http://upstream.invalid/v1",
      apiKey: "test-key",
      model: "test-model",
      sessionId: "smoke",
      idleTimeoutMs,
      firstByteTimeoutMs,
      timeoutMs,
    },
    upstreamFrom(gen),
  );
  const started = Date.now();
  try {
    const res = await fetch(`${bridge.localUrl}/responses`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${bridge.routeToken}` },
      body: JSON.stringify({ model: "test-model", input: "hi", stream: true }),
    });
    return { text: await res.text(), elapsedMs: Date.now() - started };
  } finally {
    bridge.close();
  }
}

const TIMEOUT_MARKERS = /went silent|absolute limit|sent no response within/;

// ── A. Steady output is never killed by a total-duration budget ──────────────
// 15 chunks x 20ms = ~300ms of continuous output against a 60ms idle budget.
// Under the old fixed-deadline behaviour any budget shorter than the total
// runtime would have aborted this; now a live stream simply keeps resetting it.
{
  const { text, elapsedMs } = await runTurn({
    idleTimeoutMs: 60,
    firstByteTimeoutMs: 5_000,
    timeoutMs: 10_000,
    gen: async function* () {
      for (let i = 0; i < 15; i++) {
        await sleep(20);
        yield ": keep-alive\n\n";
      }
    },
  });
  assert.ok(elapsedMs >= 250, `A: expected the full ~300ms stream, got ${elapsedMs}ms`);
  assert.ok(!TIMEOUT_MARKERS.test(text), `A: steady output must not trip a deadline, got: ${text.slice(0, 200)}`);
  console.log(`  A steady output survives: ${elapsedMs}ms of streaming, no abort`);
}

// ── B. A stalled stream is aborted on the idle budget ───────────────────────
{
  const { text, elapsedMs } = await runTurn({
    idleTimeoutMs: 60,
    firstByteTimeoutMs: 5_000,
    timeoutMs: 10_000,
    gen: async function* () {
      yield ": first byte\n\n";
      await sleep(3_000); // silence far beyond the idle budget
    },
  });
  assert.ok(elapsedMs < 1_500, `B: idle watchdog should fire near 60ms, took ${elapsedMs}ms`);
  assert.match(text, /went silent for 60ms/, `B: expected an idle abort, got: ${text.slice(0, 300)}`);
  console.log(`  B silent stream aborted after ${elapsedMs}ms`);
}

// ── C. Heartbeats alone cannot hold the request open forever ────────────────
{
  const { text, elapsedMs } = await runTurn({
    idleTimeoutMs: 50,
    firstByteTimeoutMs: 5_000,
    timeoutMs: 150, // absolute ceiling, far below the 600ms of heartbeats
    gen: async function* () {
      for (let i = 0; i < 30; i++) {
        await sleep(20);
        yield ": ping\n\n";
      }
    },
  });
  assert.ok(elapsedMs < 600, `C: absolute ceiling should fire near 150ms, took ${elapsedMs}ms`);
  assert.match(text, /150ms absolute limit/, `C: expected the absolute ceiling, got: ${text.slice(0, 300)}`);
  console.log(`  C heartbeat-only upstream capped after ${elapsedMs}ms`);
}

console.log("PASS: codex-bridge-timeout");
