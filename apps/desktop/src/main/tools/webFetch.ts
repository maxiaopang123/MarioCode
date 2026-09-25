/**
 * web_fetch — a page's main content as light Markdown, in bounded slices.
 *
 * The page loads in a hidden window (webPage.ts) and goes through the same
 * main-content extractor as browser_snapshot (MAIN_TEXT_JS). The whole
 * extracted text is cached on disk for 30 minutes under
 * `userData/web-cache/`, so reading on with `offset` never reloads the page
 * and never puts more than one slice in the model's context.
 *
 * Refused: non-http(s) URLs, local / private-network hosts (web_fetch is
 * auto-approved; reaching into the LAN stays with the approval-gated browser
 * tools), and search-engine result pages (web_search is the bounded way to
 * search). Search-engine redirect links such as Baidu's /link?url= are
 * allowed — the check runs again on the URL the page finally lands on.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { app, type WebContents } from "electron";
import { matchSearchEngine } from "@main/browser/searchEngines.js";
import { MAIN_TEXT_JS } from "@main/browser/snapshotScript.js";
import { log } from "@main/lib/logger.js";
import { readBuiltinToolsConfig } from "./builtinToolsConfig.js";
import { evalInPage, withHiddenPage } from "./webPage.js";
import { WEB_FETCH_MAX_CHARS, WEB_FETCH_MIN_CHARS, type BuiltinToolResult } from "./builtinToolSpecs.js";

const CACHE_TTL_MS = 30 * 60_000;
const CACHE_PRUNE_AGE_MS = 24 * 60 * 60_000;
const TEXT_LIMIT = 400_000;

const SOURCE_LABEL: Record<string, string> = {
  main: "主内容区 <main>",
  article: "文章 <article>",
  block: "正文段落最集中的区块",
  body: "整页,已去掉导航/页脚/侧栏",
};

interface CachedPage {
  url: string;
  finalUrl: string;
  title: string;
  text: string;
  source: string;
  at: number;
}

const EXTRACT_SCRIPT = `
(function (argJson) {
  var arg = JSON.parse(argJson);
${MAIN_TEXT_JS}
  if (document.contentType === 'application/pdf') return { kind: 'pdf', url: location.href, title: document.title };
  var root = mcMainRoot(document);
  if (!root) return { kind: 'empty', url: location.href, title: document.title };
  var text = mcExtractText(root.el, { siteChrome: root.kind === 'body', links: !!arg.links, limit: arg.limit });
  return { kind: 'html', url: location.href, title: document.title, text: text, source: root.kind };
})(%ARG_JSON%)
`;

function text(t: string): BuiltinToolResult {
  return { content: [{ type: "text", text: t }] };
}

function errorResult(msg: string): BuiltinToolResult {
  return text(`❌ ${msg}`);
}

function isPrivateHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || /\.(localhost|local|internal|lan|home)$/.test(h)) return true;
  const v4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(h);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    return (
      a === 0 || a === 10 || a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }
  if (h.includes(":")) return h === "::" || h === "::1" || /^f[cd]/.test(h) || h.startsWith("fe80");
  return false;
}

/** Search engines' result-link redirectors (they bounce to the target site). */
function isSearchRedirect(url: URL): boolean {
  return /^\/(link|url|ck\/a)$/.test(url.pathname);
}

function cacheDir(): string {
  return join(app.getPath("userData"), "web-cache");
}

function cacheFile(url: string, links: boolean): string {
  return join(cacheDir(), `${createHash("sha1").update(`${links ? 1 : 0}|${url}`).digest("hex")}.json`);
}

async function readCache(url: string, links: boolean): Promise<CachedPage | null> {
  try {
    const page = JSON.parse(await readFile(cacheFile(url, links), "utf8")) as CachedPage;
    return Date.now() - page.at < CACHE_TTL_MS && typeof page.text === "string" ? page : null;
  } catch {
    return null;
  }
}

let lastPrune = 0;

async function writeCache(page: CachedPage, links: boolean): Promise<void> {
  try {
    await mkdir(cacheDir(), { recursive: true });
    await writeFile(cacheFile(page.url, links), JSON.stringify(page), "utf8");
    if (Date.now() - lastPrune > 60 * 60_000) {
      lastPrune = Date.now();
      for (const name of await readdir(cacheDir())) {
        const file = join(cacheDir(), name);
        const info = await stat(file).catch(() => null);
        if (info && Date.now() - info.mtimeMs > CACHE_PRUNE_AGE_MS) await rm(file, { force: true });
      }
    }
  } catch (err) {
    log.warn(`web_fetch: cache write failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function loadPage(url: string, links: boolean): Promise<CachedPage> {
  const script = EXTRACT_SCRIPT.replace("%ARG_JSON%", () => JSON.stringify(JSON.stringify({ links, limit: TEXT_LIMIT })));
  const read = async (wc: WebContents): Promise<unknown> => {
    // Some redirectors bounce by script after their own page has loaded.
    if (isSearchRedirect(new URL(wc.getURL()))) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 6_000);
        wc.once("did-finish-load", () => {
          clearTimeout(timer);
          setTimeout(resolve, 600);
        });
      });
    }
    return evalInPage(wc, script);
  };
  const result = (await withHiddenPage(url, read, {
    timeoutMs: 20_000,
    settleMs: 600,
    waitForStableText: true,
  })) as { kind: string; url: string; title: string; text?: string; source?: string };
  if (result.kind === "pdf") throw new Error("这是 PDF 文件,web_fetch 暂不支持;可以用 browser_navigate 打开查看,或下载后用文件工具读取");
  return {
    url,
    finalUrl: result.url || url,
    title: result.title || "",
    text: result.text ?? "",
    source: result.source ?? "body",
    at: Date.now(),
  };
}

/** The web_fetch tool. */
export async function webFetch(args: {
  url?: unknown;
  offset?: unknown;
  maxChars?: unknown;
  links?: unknown;
}): Promise<BuiltinToolResult> {
  const raw = typeof args.url === "string" ? args.url.trim() : "";
  if (!raw) return errorResult("url 不能为空");
  let parsed: URL;
  try {
    parsed = new URL(/^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return errorResult(`不是有效的网址:${raw.slice(0, 80)}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return errorResult("只支持 http / https 网址");
  if (isPrivateHost(parsed.hostname)) {
    return errorResult("web_fetch 不读取本地或内网地址;需要的话请用 browser_navigate + browser_snapshot(需用户审批)");
  }
  const engine = matchSearchEngine(parsed.href);
  if (engine && !isSearchRedirect(parsed)) {
    return errorResult(`这是搜索引擎 ${engine} 的页面;搜索请用 web_search,它只返回标题、链接和摘要`);
  }

  const url = parsed.href;
  const links = args.links === true;
  const config = readBuiltinToolsConfig();
  const maxChars =
    typeof args.maxChars === "number" && Number.isFinite(args.maxChars)
      ? Math.min(WEB_FETCH_MAX_CHARS, Math.max(WEB_FETCH_MIN_CHARS, Math.floor(args.maxChars)))
      : config.fetch.maxChars;
  const offset = typeof args.offset === "number" && Number.isFinite(args.offset) && args.offset > 0 ? Math.floor(args.offset) : 0;

  let page = await readCache(url, links);
  const fromCache = !!page;
  if (!page) {
    try {
      page = await loadPage(url, links);
    } catch (err) {
      return errorResult(`${err instanceof Error ? err.message : String(err)}(${url})`);
    }
    let landed: URL | null = null;
    try {
      landed = new URL(page.finalUrl);
    } catch {
      landed = null;
    }
    if (landed && isPrivateHost(landed.hostname)) return errorResult("该网址跳转到了本地或内网地址,web_fetch 不读取");
    const landedEngine = landed ? matchSearchEngine(landed.href) : null;
    if (landedEngine) return errorResult(`该网址落在了搜索引擎 ${landedEngine} 的页面上;搜索请用 web_search`);
    await writeCache(page, links);
  }

  const total = page.text.length;
  const start = Math.min(offset, total);
  const slice = page.text.slice(start, start + maxChars);
  const end = start + slice.length;
  const lines = [
    `网页正文(Markdown):${page.title || "(无标题)"}`,
    `URL: ${page.finalUrl}${page.finalUrl !== url ? `(由 ${url} 跳转)` : ""}`,
    `(内容来自${SOURCE_LABEL[page.source] ?? SOURCE_LABEL.body};第 ${start}–${end} 字,共 ${total} 字${fromCache ? ",取自 30 分钟内的缓存" : ""})`,
    "",
  ];
  if (total === 0) lines.push("(页面没有可读的正文,可能需要登录,或内容在图片、视频里)");
  else lines.push(slice || "(offset 已超出正文末尾)");
  if (end < total) lines.push("", `(未完,续读:web_fetch({url:${JSON.stringify(url)}, offset:${end}}))`);
  return text(lines.join("\n"));
}
