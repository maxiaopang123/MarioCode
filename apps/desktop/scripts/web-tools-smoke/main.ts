// Electron main-process smoke for the built-in web tools (TODO-005): the real
// web_search / web_fetch modules against the live web, with an in-memory
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
  IMAGE_SOURCE_CUSTOM,
  type WebSearchBackend,
} from "@contracts/ipc";
import { SettingRepo } from "@main/store/repositories.js";
import { writeBuiltinToolSecret } from "@main/tools/builtinToolsConfig.js";
import { runWebSearch, webSearch } from "@main/tools/webSearch.js";
import { webFetch } from "@main/tools/webFetch.js";
import { imageGenerate } from "@main/tools/imageGenerate.js";

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
  // Bing, no key.
  useBackend("bing");
  let started = Date.now();
  const bing = textOf(await webSearch({ query: "Electron BrowserWindow 文档" }));
  const bingHits = (bing.match(/^\d+\. /gm) ?? []).length;
  check("web_search via Bing returns results", bingHits >= 3, `${bingHits} hits, ${bing.length} chars, ${Date.now() - started}ms`);
  console.log(bing.split("\n").slice(0, 9).map((l) => `    ${l}`).join("\n"));

  // Baidu, no key.
  useBackend("baidu");
  started = Date.now();
  let baiduLink: string | undefined;
  try {
    const outcome = await runWebSearch("Electron 教程", 5, "baidu", { noCache: true });
    baiduLink = outcome.hits.find((h) => /baidu\.com\/link\?/.test(h.url))?.url;
    report(outcome.hits.length >= 3 ? "PASS" : "WARN", "web_search via Baidu returns results", `${outcome.hits.length} hits, ${Date.now() - started}ms`);
  } catch (err) {
    report("WARN", "web_search via Baidu", err instanceof Error ? err.message : String(err));
  }

  // A keyed backend with a bad key falls back to Bing and says so.
  useBackend("bocha");
  writeBuiltinToolSecret("bocha", "sk-invalid-smoke-key");
  const bocha = textOf(await webSearch({ query: "Electron 版本发布" }));
  check("bad 博查 key falls back to Bing", bocha.includes("博查搜索失败") && /^\d+\. /m.test(bocha), bocha.split("\n")[0]);
  useBackend("bing");

  // web_fetch: a JS-heavy docs page, then read on from the cache.
  started = Date.now();
  const page1 = textOf(await webFetch({ url: "https://www.runoob.com/js/js-tutorial.html", maxChars: 1000 }));
  const total = Number(/共 (\d+) 字/.exec(page1)?.[1] ?? 0);
  check("web_fetch reads a page's main text", total > 800 && page1.includes("JavaScript"), `total ${total} chars, ${Date.now() - started}ms`);
  console.log(page1.split("\n").slice(0, 6).map((l) => `    ${l}`).join("\n"));
  const next = /offset:(\d+)/.exec(page1)?.[1];
  started = Date.now();
  const page2 = textOf(await webFetch({ url: "https://www.runoob.com/js/js-tutorial.html", offset: Number(next ?? 1000), maxChars: 1000 }));
  check("web_fetch reads on from the cache", !!next && page2.includes("缓存") && page2.includes(`第 ${next}–`), `${Date.now() - started}ms`);

  // Plain JSON renders as a fenced block.
  const json = textOf(await webFetch({ url: "https://registry.npmmirror.com/-/package/electron/dist-tags" }));
  check("web_fetch reads a JSON response", json.includes("latest"), json.split("\n")[0]);

  // Refusals.
  check("web_fetch refuses localhost", textOf(await webFetch({ url: "http://localhost:5173/" })).startsWith("❌"));
  check("web_fetch refuses file://", textOf(await webFetch({ url: "file:///C:/Windows/win.ini" })).startsWith("❌"));
  check("web_fetch refuses a results page", textOf(await webFetch({ url: "https://www.baidu.com/s?wd=electron" })).includes("web_search"));

  // Baidu result links are redirectors; web_fetch follows them to the site.
  if (baiduLink) {
    const viaLink = textOf(await webFetch({ url: baiduLink, maxChars: 1000 }));
    const landed = /^URL: (\S+)/m.exec(viaLink)?.[1] ?? "";
    report(!viaLink.startsWith("❌") && !/baidu\.com\/link/.test(landed) ? "PASS" : "WARN", "web_fetch follows a Baidu result link", landed || viaLink.slice(0, 120));
  }

  await imageChecks();
}

/** image_generate against a local stand-in for an OpenAI-compatible images
 *  endpoint: request shape, both response styles (b64_json / url), the JPEG
 *  display copy, the saved original, and an upstream error. */
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
  SettingRepo.set(
    BUILTIN_TOOLS_CONFIG_SETTING_KEY,
    JSON.stringify({ ...DEFAULT_BUILTIN_TOOLS_CONFIG, image: { source: IMAGE_SOURCE_CUSTOM, baseUrl: `http://127.0.0.1:${port}/v1/`, model: "gpt-image-1", size: "1024x1024" } }),
  );
  writeBuiltinToolSecret("image", "sk-image-smoke");
  try {
    const images: string[] = [];
    const ctx = { toolCallId: "call_smoke_1", sessionId: "session-smoke", turnNumber: 3, onImage: (i: { data: string; mimeType: string }) => images.push(i.mimeType) };
    const r1 = await imageGenerate({ prompt: "a grey test card", size: "1536x1024" }, ctx);
    const saved = /已保存到: (.+)/.exec(textOf(r1))?.[1]?.trim() ?? "";
    const block = r1.content.find((b) => b.type === "image") as { mimeType?: string } | undefined;
    check(
      "image_generate (b64_json) posts model/prompt/size with the key",
      seen[0]?.auth === "Bearer sk-image-smoke" && seen[0].body.model === "gpt-image-1" && seen[0].body.size === "1536x1024" && seen[0].body.n === 1,
      JSON.stringify(seen[0]?.body),
    );
    check(
      "image_generate saves the original and returns a JPEG copy",
      existsSync(saved) && saved.includes(join("session-smoke", "turn-3")) && block?.mimeType === "image/jpeg" && images[0] === "image/jpeg",
      saved,
    );
    check("image_generate reports the revised prompt and size", textOf(r1).includes("a grey test card") && textOf(r1).includes("64x48"));
    mode = "url";
    const r2 = await imageGenerate({ prompt: "second", size: "not-a-size" }, { ...ctx, toolCallId: "call_smoke_2" });
    check("image_generate downloads a url response; bad size falls back to the default", textOf(r2).includes("已生成图片") && seen[1]?.body.size === "1024x1024");
    mode = "error";
    const r3 = await imageGenerate({ prompt: "third" }, { ...ctx, toolCallId: "call_smoke_3" });
    check("image_generate surfaces an upstream error", textOf(r3).includes("HTTP 400") && textOf(r3).includes("model not found"), textOf(r3));
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
