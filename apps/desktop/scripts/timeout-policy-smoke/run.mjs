/**
 * Deadline policy for the two engines the Codex fix did not cover.
 *
 * ── Claude (src/main/providers/claude-sdk/customEnv.ts) ────────────────────
 * The CLI's per-HTTP-request budget is `API_TIMEOUT_MS ?? 600000`. On a
 * third-party gateway that is the ONLY guard: the CLI's byte-idle watchdog is
 * gated to first-party/bedrock providers, so it never runs against a gateway.
 * Leaving the var unset therefore meant every gateway turn silently inherited
 * a 10-minute ceiling — a long answer or a slow model died mid-stream.
 * We now always set it, defaulting to CLAUDE_API_TIMEOUT_MS (60 min).
 *
 * ── Pi (src/main/providers/pi-sdk/reverseBudgets.ts) ──────────────────────
 * The pi-host process' reverse channel used to give every method one flat
 * 5-minute budget, which conflated a tool running with a human looking at an
 * approval card. Budgets are now per method: human prompts untimed, tools
 * 30 min, instantaneous state lookups 60s.
 *
 * Run: node scripts/timeout-policy-smoke/run.mjs
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { desktopDir, importMainModule } from "../lib/main-bundle.mjs";

const { buildCustomEnv, CLAUDE_API_TIMEOUT_MS } = await importMainModule(
  resolve(desktopDir, "src/main/providers/claude-sdk/customEnv.ts"),
);
const { reverseTimeoutMs, REVERSE_HUMAN_TIMEOUT_MS, REVERSE_TOOL_TIMEOUT_MS, REVERSE_STATE_TIMEOUT_MS } =
  await importMainModule(resolve(desktopDir, "src/main/providers/pi-sdk/reverseBudgets.ts"));

/* ═══ Claude ══════════════════════════════════════════════════════════════ */

/** Minimal gateway config: third party, `openai` protocol, one model. */
function claudeConfig(overrides = {}) {
  return {
    baseUrl: "https://gateway.invalid/v1",
    authToken: "test-token",
    authMode: "auth_token",
    protocol: "openai",
    selectedModel: "test-model",
    models: [{ id: "test-model" }],
    disableNonEssentialTraffic: true,
    ...overrides,
  };
}

const MINUTE = 60_000;

// ── A. The default is 60 min, not the CLI's own 10 min ──────────────────────
{
  assert.equal(CLAUDE_API_TIMEOUT_MS, 60 * MINUTE);
  // The whole point: the value we inject must strictly exceed the CLI's
  // built-in fallback, or setting it would change nothing.
  assert.ok(CLAUDE_API_TIMEOUT_MS > 600_000, "Claude default must beat the CLI's 600000 fallback");

  const env = buildCustomEnv(claudeConfig());
  assert.equal(env.API_TIMEOUT_MS, String(CLAUDE_API_TIMEOUT_MS));
  console.log(`  A unconfigured gateway gets ${CLAUDE_API_TIMEOUT_MS / MINUTE}min, not 10min`);
}

// ── B. An explicit per-config timeoutMs still wins ──────────────────────────
{
  const env = buildCustomEnv(claudeConfig({ timeoutMs: 1234 }));
  assert.equal(env.API_TIMEOUT_MS, "1234");
  console.log("  B explicit timeoutMs wins (1234)");

  // 0 / negative / NaN are "not configured", not "no timeout" — falling back
  // is the safe reading, since 0 would otherwise become an instant abort.
  for (const bad of [0, -5, Number.NaN]) {
    const fallback = buildCustomEnv(claudeConfig({ timeoutMs: bad }));
    assert.equal(
      fallback.API_TIMEOUT_MS,
      String(CLAUDE_API_TIMEOUT_MS),
      `timeoutMs=${bad} must fall back to the default, not disable the guard`,
    );
  }
  console.log("  B 0/negative/NaN fall back to the default");
}

// ── C. Both protocols get the same budget ───────────────────────────────────
{
  // `anthropic` talks straight to the gateway; `openai`/`responses` go through
  // the in-process bridge. The CLI's budget applies to the CLI side either way,
  // so the injected value must not depend on the protocol.
  for (const protocol of ["anthropic", "openai", "responses"]) {
    const env = buildCustomEnv(claudeConfig({ protocol }));
    assert.equal(env.API_TIMEOUT_MS, String(CLAUDE_API_TIMEOUT_MS), `protocol=${protocol} lost the timeout`);
  }
  console.log("  C anthropic / openai / responses all carry the budget");
}

/* ═══ Pi ══════════════════════════════════════════════════════════════════ */

const MCP_TOOL_CAP_MS = 600_000; // McpToolSession's tool_timeout_sec hard cap

// ── D. Human prompts are not on a clock ─────────────────────────────────────
{
  for (const method of ["requestApproval", "requestUserInput", "requestPlanApproval"]) {
    assert.equal(reverseTimeoutMs(method), 0, `${method} must wait indefinitely — a user stepping away is not an error`);
  }
  assert.equal(REVERSE_HUMAN_TIMEOUT_MS, 0);
  console.log("  D approvals / questions / plan review are untimed");
}

// ── E. Tool calls get a ceiling that never undercuts MCP's own ──────────────
{
  for (const method of ["browser", "builtinTool", "mcpTool"]) {
    assert.equal(reverseTimeoutMs(method), REVERSE_TOOL_TIMEOUT_MS);
    assert.ok(
      REVERSE_TOOL_TIMEOUT_MS > MCP_TOOL_CAP_MS,
      `tool budget ${REVERSE_TOOL_TIMEOUT_MS}ms must exceed MCP's ${MCP_TOOL_CAP_MS}ms cap, ` +
        "otherwise McpToolSession's configured timeout can never be reached",
    );
  }
  console.log(`  E tool calls capped at ${REVERSE_TOOL_TIMEOUT_MS / MINUTE}min (> MCP's 10min)`);
}

// ── F. Instantaneous state lookups fail fast ────────────────────────────────
{
  assert.equal(reverseTimeoutMs("permissionState"), REVERSE_STATE_TIMEOUT_MS);
  assert.ok(REVERSE_STATE_TIMEOUT_MS < REVERSE_TOOL_TIMEOUT_MS);
  assert.ok(REVERSE_STATE_TIMEOUT_MS >= 1_000, "under a second would race a busy main process");
  console.log(`  F permissionState fails after ${REVERSE_STATE_TIMEOUT_MS / 1_000}s`);
}

// ── G. Every reverse method declared in the protocol has a budget ───────────
// The `Record<PiHostReverseMethod, number>` makes a missing entry a type error,
// but a method added to the union with a WRONG budget type-checks fine. Reading
// the union back out of the protocol file keeps this list from rotting into a
// copy that silently passes.
{
  const protocolSrc = await readFile(resolve(desktopDir, "src/main/providers/pi-sdk/piHostProtocol.ts"), "utf8");
  const union = protocolSrc.match(/export type PiHostReverseMethod =([^;]+);/)?.[1];
  assert.ok(union, "could not locate PiHostReverseMethod in piHostProtocol.ts");
  const declared = [...union.matchAll(/"([a-zA-Z]+)"/g)].map((m) => m[1]);
  assert.ok(declared.length >= 7, `parsed only ${declared.length} reverse methods — did the union change shape?`);

  for (const method of declared) {
    const budget = reverseTimeoutMs(method);
    assert.equal(typeof budget, "number", `${method} has no budget`);
    assert.ok(Number.isFinite(budget) && budget >= 0, `${method} budget is not a sane number: ${budget}`);
  }
  console.log(`  G all ${declared.length} declared reverse methods have a budget`);
}

console.log("PASS: timeout-policy");
