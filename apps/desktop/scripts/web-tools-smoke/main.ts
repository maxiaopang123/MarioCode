// Electron main-process smoke for the built-in web tools (TODO-005): the real
// mario_web_search / mario_web_fetch modules against the live web, with an in-memory
// settings store (shared-provider-smoke's stub) and a throwaway userData dir.
// Needs network access; Baidu may answer with a human check, which counts as
// a warning, not a failure.
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { app, nativeImage } from "electron";
import {
  BROWSER_SCREENSHOT_DIR_SETTING_KEY,
  BUILTIN_TOOLS_CONFIG_SETTING_KEY,
  DEFAULT_BUILTIN_TOOLS_CONFIG,
  type WebSearchBackend,
} from "@contracts/ipc";
import { SettingRepo } from "@main/store/repositories.js";
import { SharedProviderStore } from "@main/lib/sharedProviderStore.js";
import {
  builtinToolsState,
  readBuiltinToolsConfig,
  resolveImageEndpoint,
  writeBuiltinToolSecret,
} from "@main/tools/builtinToolsConfig.js";
import { parseBraveResponse, parseExaResponse, runWebSearch, webSearch } from "@main/tools/webSearch.js";
import { webFetch } from "@main/tools/webFetch.js";
import { imageGenerate } from "@main/tools/imageGenerate.js";
import { builtinToolNeedsApproval } from "@main/tools/builtinToolSpecs.js";
import {
  buildScheduleCreateInput,
  changedDefinitionKeys,
  formatScheduleText,
  mergeScheduleUpdate,
} from "@main/tools/scheduleToolArgs.js";
import type { ScheduledTask } from "@contracts/scheduledTask";

/** Settings row of the encrypted search-API keys (builtinToolsConfig.ts). */
const KEYS_SETTING_KEY = "builtinTools.keys";

const userData = mkdtempSync(join(tmpdir(), "mariocode-web-tools-"));
app.setPath("userData", userData);
app.on("window-all-closed", () => {});

let failures = 0;
function report(level: "PASS" | "FAIL" | "WARN", label: string, detail = ""): void {
  if (level === "FAIL") failures++;
  console.log(`${level} ${label}${detail ? ` — ${detail}` : ""}`);
}
function check(label: string, ok: boolean, detail = ""): void {
  report(ok ? "PASS" : "FAIL", label, detail);
}
function useBackend(backend: WebSearchBackend): void {
  SettingRepo.set(
    BUILTIN_TOOLS_CONFIG_SETTING_KEY,
    JSON.stringify({ ...DEFAULT_BUILTIN_TOOLS_CONFIG, search: { ...DEFAULT_BUILTIN_TOOLS_CONFIG.search, backend } }),
  );
}
const textOf = (r: { content: Array<{ type: string; text?: string }> }): string =>
  r.content.map((b) => b.text ?? "").join("\n");

async function main(): Promise<void> {
  // Offline first: the legacy key drop runs once per process.
  await legacyConfigChecks();
  parserChecks();
  marioToolPolicyChecks();

  // Bing, no key.
  useBackend("bing");
  let started = Date.now();
  const bing = textOf(await webSearch({ query: "Electron BrowserWindow 文档" }));
  const bingHits = (bing.match(/^\d+\. /gm) ?? []).length;
  check("mario_web_search via Bing returns results", bingHits >= 3, `${bingHits} hits, ${bing.length} chars, ${Date.now() - started}ms`);
  console.log(bing.split("\n").slice(0, 9).map((l) => `    ${l}`).join("\n"));

  // Baidu, no key.
  useBackend("baidu");
  started = Date.now();
  let baiduLink: string | undefined;
  try {
    const outcome = await runWebSearch("Electron 教程", 5, "baidu", { noCache: true });
    baiduLink = outcome.hits.find((h) => /baidu\.com\/link\?/.test(h.url))?.url;
    report(outcome.hits.length >= 3 ? "PASS" : "WARN", "mario_web_search via Baidu returns results", `${outcome.hits.length} hits, ${Date.now() - started}ms`);
  } catch (err) {
    report("WARN", "mario_web_search via Baidu", err instanceof Error ? err.message : String(err));
  }

  // A keyed backend with a bad key falls back to Bing and says so.
  useBackend("bocha");
  writeBuiltinToolSecret("bocha", "sk-invalid-smoke-key");
  const bocha = textOf(await webSearch({ query: "Electron 版本发布" }));
  check("bad 博查 key falls back to Bing", bocha.includes("博查搜索失败") && /^\d+\. /m.test(bocha), bocha.split("\n")[0]);
  useBackend("bing");

  // mario_web_fetch: a JS-heavy docs page, then read on from the cache.
  started = Date.now();
  const page1 = textOf(await webFetch({ url: "https://www.runoob.com/js/js-tutorial.html", maxChars: 1000 }));
  const total = Number(/共 (\d+) 字/.exec(page1)?.[1] ?? 0);
  check("mario_web_fetch reads a page's main text", total > 800 && page1.includes("JavaScript"), `total ${total} chars, ${Date.now() - started}ms`);
  console.log(page1.split("\n").slice(0, 6).map((l) => `    ${l}`).join("\n"));
  const next = /offset:(\d+)/.exec(page1)?.[1];
  started = Date.now();
  const page2 = textOf(await webFetch({ url: "https://www.runoob.com/js/js-tutorial.html", offset: Number(next ?? 1000), maxChars: 1000 }));
  check("mario_web_fetch reads on from the cache", !!next && page2.includes("缓存") && page2.includes(`第 ${next}–`), `${Date.now() - started}ms`);

  // Plain JSON renders as a fenced block.
  const json = textOf(await webFetch({ url: "https://registry.npmmirror.com/-/package/electron/dist-tags" }));
  check("mario_web_fetch reads a JSON response", json.includes("latest"), json.split("\n")[0]);

  // Refusals.
  check("mario_web_fetch refuses localhost", textOf(await webFetch({ url: "http://localhost:5173/" })).startsWith("❌"));
  check("mario_web_fetch refuses file://", textOf(await webFetch({ url: "file:///C:/Windows/win.ini" })).startsWith("❌"));
  check("mario_web_fetch refuses a results page", textOf(await webFetch({ url: "https://www.baidu.com/s?wd=electron" })).includes("mario_web_search"));

  // Baidu result links are redirectors; mario_web_fetch follows them to the site.
  if (baiduLink) {
    const viaLink = textOf(await webFetch({ url: baiduLink, maxChars: 1000 }));
    const landed = /^URL: (\S+)/m.exec(viaLink)?.[1] ?? "";
    report(!viaLink.startsWith("❌") && !/baidu\.com\/link/.test(landed) ? "PASS" : "WARN", "mario_web_fetch follows a Baidu result link", landed || viaLink.slice(0, 120));
  }

  await imageChecks();
}

/** Settings saved before the custom image endpoint was removed: a stored
 *  keyed backend (bocha) stays, an unknown backend falls back to Bing, a
 *  "custom" image source reads as not configured, and the obsolete `image`
 *  entry is dropped from the encrypted key map while the search keys survive.
 *  Offline. Must run before anything else touches the key map — the legacy
 *  drop happens once per process. */
async function legacyConfigChecks(): Promise<void> {
  SettingRepo.set(
    BUILTIN_TOOLS_CONFIG_SETTING_KEY,
    JSON.stringify({
      search: { backend: "bocha", maxResults: 8 },
      fetch: { maxChars: 8000 },
      image: { source: "custom", baseUrl: "https://example.invalid/v1", model: "gpt-image-1", size: "1024x1024" },
    }),
  );
  SettingRepo.set(KEYS_SETTING_KEY, JSON.stringify({ bocha: "legacy-cipher", image: "legacy-cipher" }));
  const config = readBuiltinToolsConfig();
  check(
    "stored keyed backend (bocha) is kept; other sections survive",
    config.search.backend === "bocha" && config.fetch.maxChars === 8000 && !("baseUrl" in config.image),
    JSON.stringify(config),
  );
  const endpoint = resolveImageEndpoint(config);
  check("legacy custom image source resolves to not configured", !endpoint.ok && endpoint.issue === "noSource", JSON.stringify(endpoint));
  const state = await builtinToolsState();
  const keysRow = SettingRepo.get(KEYS_SETTING_KEY) ?? "";
  check(
    "legacy image key entry is dropped; the bocha key survives",
    !keysRow.includes('"image"') && keysRow.includes('"bocha"') && state.keys.bocha && !state.keys.exa && state.imageIssue === "noSource",
    keysRow,
  );
  SettingRepo.set(
    BUILTIN_TOOLS_CONFIG_SETTING_KEY,
    JSON.stringify({ ...DEFAULT_BUILTIN_TOOLS_CONFIG, search: { backend: "duckduckgo", maxResults: 8 } }),
  );
  check("unknown stored backend falls back to Bing", readBuiltinToolsConfig().search.backend === "bing");
  useBackend("bing");
}

/** Offline: builtinToolNeedsApproval truth table + mario_schedule_* argument
 *  building / merging with ScheduledTaskCreateSchema. Pure functions. */
function marioToolPolicyChecks(): void {
  const table: Array<[string, boolean, boolean]> = [
    // [tool, needs approval interactive, needs approval unattended]
    ["mario_web_search", false, false],
    ["mario_web_fetch", false, false],
    ["mario_schedule_list", false, false],
    ["mario_image_generate", true, true],
    ["mario_schedule_create", true, false],
    ["mario_schedule_update", true, false],
    ["mario_schedule_delete", true, false],
    ["mario_wechat_notify", true, false],
    ["mario_unknown_tool", true, true],
  ];
  const wrong = table.filter(
    ([name, interactive, unattended]) =>
      builtinToolNeedsApproval(name, false) !== interactive || builtinToolNeedsApproval(name, true) !== unattended,
  );
  check("builtinToolNeedsApproval truth table", wrong.length === 0, wrong.map(([n]) => n).join(", "));

  const created = buildScheduleCreateInput(
    { name: " 日报 ", prompt: "汇总今天的提交", scheduleKind: "weekly", timeOfDay: "09:00", weekdays: ["1", 3] },
    { projectId: "p1", providerId: "claude-sdk" },
  );
  check(
    "schedule create: defaults + coercion + schema",
    created.ok && created.input.projectId === "p1" && created.input.name === "日报" &&
      JSON.stringify(created.input.weekdays) === "[1,3]" && created.input.enabled && !created.input.pushEnabled,
    JSON.stringify(created),
  );
  const noTime = buildScheduleCreateInput({ name: "x", prompt: "y", scheduleKind: "daily" }, { projectId: "p1", providerId: "claude-sdk" });
  check("schedule create: daily without timeOfDay rejected", !noTime.ok && noTime.error.includes("timeOfDay"), JSON.stringify(noTime));
  const noOffset = buildScheduleCreateInput(
    { name: "x", prompt: "y", scheduleKind: "one-time", runAt: "2026-09-28T09:00:00" },
    { projectId: "p1", providerId: "claude-sdk" },
  );
  check("schedule create: runAt without offset rejected", !noOffset.ok && noOffset.error.includes("runAt"), JSON.stringify(noOffset));
  const noProject = buildScheduleCreateInput({ name: "x", prompt: "y", scheduleKind: "daily", timeOfDay: "08:00" }, {});
  check("schedule create: no project → refused", !noProject.ok && noProject.error.startsWith("projectId"));

  const existing: ScheduledTask = {
    id: "task_1", name: "日报", projectId: "p1", providerId: "claude-sdk", prompt: "汇总", scheduleKind: "daily",
    timeOfDay: "09:00", weekdays: [], runAt: null, enabled: true, pushEnabled: false, nextRunAt: null, lastRunAt: null,
    lastStatus: "idle", lastError: null, lastSessionId: null, lastPushStatus: "idle", lastPushAt: null, lastPushError: null,
    createdAt: 0, updatedAt: 0,
  };
  const merged = mergeScheduleUpdate(existing, { id: "task_1", scheduleKind: "weekly", weekdays: [5] });
  check(
    "schedule update: merge keeps untouched fields",
    merged.ok && merged.input.prompt === "汇总" && merged.input.timeOfDay === "09:00" && merged.input.scheduleKind === "weekly",
    JSON.stringify(merged),
  );
  const badMerge = mergeScheduleUpdate(existing, { scheduleKind: "one-time" });
  check("schedule update: one-time without runAt rejected", !badMerge.ok && badMerge.error.includes("runAt"));
  const onlyEnabled = changedDefinitionKeys(existing, { id: "task_1", enabled: false, timeOfDay: "09:00" });
  check("schedule update: enabled-only change detected", JSON.stringify(onlyEnabled) === '["enabled"]', JSON.stringify(onlyEnabled));
  check(
    "schedule text",
    formatScheduleText(existing) === "每天 09:00" &&
      formatScheduleText({ ...existing, scheduleKind: "weekly", weekdays: [3, 1] }) === "每周一、三 09:00",
  );
}

/** Exa / Brave response parsing on sample JSON (no network). */
function parserChecks(): void {
  const exa = parseExaResponse({
    results: [
      { title: " Exa A ", url: "https://a.example/", highlights: ["first bit", "second bit"], publishedDate: "2025-01-02T03:04:05.000Z" },
      { title: "Exa B", url: "https://b.example/", highlights: [], summary: "a summary" },
      { title: "Exa C", url: "https://c.example/", text: "raw   text" },
      null,
    ],
  });
  check(
    "Exa parser: highlights → summary → text, date",
    exa.length === 3 &&
      exa[0]?.title === "Exa A" &&
      exa[0].snippet === "first bit second bit" &&
      exa[0].date === "2025-01-02" &&
      exa[1]?.snippet === "a summary" &&
      exa[2]?.snippet === "raw text",
    JSON.stringify(exa),
  );
  check("Exa parser tolerates a malformed body", parseExaResponse({ results: "nope" }).length === 0 && parseExaResponse(null).length === 0);
  const brave = parseBraveResponse({
    web: {
      results: [
        { title: "<strong>Brave</strong> A", url: "https://a.example/", description: "Some <strong>bold</strong> &amp; text", age: "2 days ago", profile: { name: "A Site" } },
        { title: "Brave B", url: "https://b.example/", description: "plain", page_age: "2024-05-06T00:00:00" },
      ],
    },
  });
  check(
    "Brave parser: strips tags, description, age / page_age",
    brave.length === 2 &&
      brave[0]?.title === "Brave A" &&
      brave[0].snippet === "Some bold & text" &&
      brave[0].date === "2 days ago" &&
      brave[0].site === "A Site" &&
      brave[1]?.date === "2024-05-06",
    JSON.stringify(brave),
  );
  check("Brave parser tolerates a malformed body", parseBraveResponse({ web: null }).length === 0 && parseBraveResponse("x").length === 0);
}

/** mario_image_generate through a shared provider whose endpoint is a local
 *  stand-in for an OpenAI-compatible images API: request shape, both response
 *  styles (b64_json / url), the JPEG display copy, the saved original, and an
 *  upstream error. Uses Electron's real safeStorage for the provider key. */
async function imageChecks(): Promise<void> {
  const png = nativeImage.createFromBitmap(Buffer.alloc(64 * 48 * 4, 200), { width: 64, height: 48 }).toPNG();
  const seen: Array<{ auth?: string; body: Record<string, unknown> }> = [];
  let mode: "b64" | "url" | "error" = "b64";
  const server = createServer((req, res) => {
    if (req.method === "GET" && req.url === "/files/out.png") {
      res.writeHead(200, { "content-type": "image/png" }).end(png);
      return;
    }
    let raw = "";
    req.on("data", (c: Buffer) => (raw += c.toString()));
    req.on("end", () => {
      seen.push({ auth: req.headers.authorization, body: JSON.parse(raw || "{}") as Record<string, unknown> });
      const port = (server.address() as AddressInfo).port;
      if (mode === "error") {
        res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "model not found" } }));
        return;
      }
      const item = mode === "b64" ? { b64_json: png.toString("base64"), revised_prompt: "a grey test card" } : { url: `http://127.0.0.1:${port}/files/out.png` };
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: [item] }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  const shots = join(userData, "shots");
  SettingRepo.set(BROWSER_SCREENSHOT_DIR_SETTING_KEY, shots);
  // Two models on purpose (TODO-024 ①): "cogview-4" carries the 生图 marker
  // the settings picker lists, while the config below points at the UNMARKED
  // "gpt-image-1" — the shape of every setup made before the marker existed.
  // Resolving must not care about the marker, only that a model id is set.
  const provider = SharedProviderStore.save({
    name: "Smoke image provider",
    baseUrl: `http://127.0.0.1:${port}/v1/`,
    protocols: ["chat-completions"],
    models: [{ id: "gpt-image-1" }, { id: "cogview-4", imageGeneration: true }],
    enabledAgents: ["pi"],
    apiKey: "sk-image-smoke",
  }).find((p) => p.name === "Smoke image provider")!;
  SettingRepo.set(
    BUILTIN_TOOLS_CONFIG_SETTING_KEY,
    JSON.stringify({ ...DEFAULT_BUILTIN_TOOLS_CONFIG, image: { source: provider.id, model: "gpt-image-1", size: "1024x1024" } }),
  );
  const endpoint = resolveImageEndpoint();
  check("image source resolves to the shared provider's endpoint and key", endpoint.ok && endpoint.label === "Smoke image provider", JSON.stringify(endpoint.ok ? { ...endpoint, apiKey: "***" } : endpoint));
  check(
    "the 生图 marker round-trips, and an UNMARKED configured model still resolves",
    provider.models.find((m) => m.id === "cogview-4")?.imageGeneration === true
      && provider.models.find((m) => m.id === "gpt-image-1")?.imageGeneration === undefined
      && endpoint.ok && endpoint.model === "gpt-image-1",
    JSON.stringify(provider.models),
  );
  try {
    const images: string[] = [];
    const ctx = { toolCallId: "call_smoke_1", sessionId: "session-smoke", turnNumber: 3, onImage: (i: { data: string; mimeType: string }) => images.push(i.mimeType) };
    const r1 = await imageGenerate({ prompt: "a grey test card", size: "1536x1024" }, ctx);
    const saved = /已保存到: (.+)/.exec(textOf(r1))?.[1]?.trim() ?? "";
    const block = r1.content.find((b) => b.type === "image") as { mimeType?: string } | undefined;
    check(
      "mario_image_generate (b64_json) posts model/prompt/size with the key",
      seen[0]?.auth === "Bearer sk-image-smoke" && seen[0].body.model === "gpt-image-1" && seen[0].body.size === "1536x1024" && seen[0].body.n === 1,
      JSON.stringify(seen[0]?.body),
    );
    check(
      "mario_image_generate saves the original and returns a JPEG copy",
      existsSync(saved) && saved.includes(join("session-smoke", "turn-3")) && block?.mimeType === "image/jpeg" && images[0] === "image/jpeg",
      saved,
    );
    check("mario_image_generate reports the revised prompt and size", textOf(r1).includes("a grey test card") && textOf(r1).includes("64x48"));
    mode = "url";
    const r2 = await imageGenerate({ prompt: "second", size: "not-a-size" }, { ...ctx, toolCallId: "call_smoke_2" });
    check("mario_image_generate downloads a url response; bad size falls back to the default", textOf(r2).includes("已生成图片") && seen[1]?.body.size === "1024x1024");
    mode = "error";
    const r3 = await imageGenerate({ prompt: "third" }, { ...ctx, toolCallId: "call_smoke_3" });
    check("mario_image_generate surfaces an upstream error", textOf(r3).includes("HTTP 400") && textOf(r3).includes("model not found"), textOf(r3));
  } finally {
    server.close();
  }
}

app.whenReady().then(async () => {
  try {
    await main();
  } catch (err) {
    report("FAIL", "smoke crashed", err instanceof Error ? err.stack ?? err.message : String(err));
  }
  console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
  try {
    rmSync(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    // Chromium keeps a few profile files (spellcheck dictionaries) open until exit.
  }
  app.exit(failures ? 1 : 0);
});
