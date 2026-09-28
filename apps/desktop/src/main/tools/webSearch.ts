/**
 * mario_web_search — titles, links and short snippets only; full text is
 * mario_web_fetch's job, so a search costs a few hundred tokens instead of a
 * results page's 10K+.
 *
 * Backends: Bing (default) and Baidu read the engine's own results page in a
 * hidden window and need no key. 博查 / 智谱 / Tavily / Exa / Brave are
 * optional search APIs that need the user's key (Brave may need a proxy from
 * mainland networks). A keyed backend that fails (missing / bad key, quota,
 * network) falls back to Bing and the result says so, rather than leaving the
 * model with nothing.
 */
import type { WebContents } from "electron";
import type { WebSearchBackend, WebSearchKeyedBackend } from "@contracts/ipc";
import { engineFetch } from "@main/network/engineProxy.js";
import { matchSearchEngine } from "@main/browser/searchEngines.js";
import { log } from "@main/lib/logger.js";
import { readBuiltinToolSecret, readBuiltinToolsConfig } from "./builtinToolsConfig.js";
import { evalInPage, withHiddenPage } from "./webPage.js";
import { WEB_SEARCH_MAX_RESULTS, WEB_SEARCH_SNIPPET_CHARS, type BuiltinToolResult } from "./builtinToolSpecs.js";

export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
  site?: string;
  date?: string;
}

export interface SearchOutcome {
  hits: SearchHit[];
  backend: WebSearchBackend;
  /** Set when the configured keyed backend failed and Bing answered instead. */
  fallback?: { from: WebSearchBackend; error: string };
}

export const WEB_SEARCH_BACKEND_LABEL: Record<WebSearchBackend, string> = {
  bing: "必应",
  baidu: "百度",
  bocha: "博查",
  zhipu: "智谱",
  tavily: "Tavily",
  exa: "Exa",
  brave: "Brave",
};

const API_TIMEOUT_MS = 15_000;
const CACHE_TTL_MS = 10 * 60_000;
const CACHE_MAX = 100;
const cache = new Map<string, { at: number; outcome: SearchOutcome }>();

function clean(s: unknown): string {
  return typeof s === "string" ? s.replace(/\s+/g, " ").trim() : "";
}

function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

function records(v: unknown): Record<string, unknown>[] {
  return Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => !!x && typeof x === "object") : [];
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** Strip HTML tags / common entities (Brave wraps matches in <strong>). */
function stripTags(s: unknown): string {
  if (typeof s !== "string") return "";
  return clean(
    s
      .replace(/<[^>]*>/g, "")
      .replace(/&quot;/g, '"')
      .replace(/&#39;|&#x27;/g, "'")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&"),
  );
}

/** Short human message from a search API's error body. */
function apiErrorMessage(json: unknown, text: string): string {
  const j = asRecord(json) ?? {};
  const err = j.error;
  const errRec = asRecord(err);
  const detail = j.detail;
  const detailRec = asRecord(detail);
  return (
    (typeof err === "string" ? clean(err) : "") ||
    clean(errRec?.message) ||
    clean(errRec?.detail) ||
    clean(j.msg) ||
    clean(j.message) ||
    (typeof detail === "string" ? clean(detail) : clean(detailRec?.error)) ||
    clip(clean(text), 160)
  );
}

async function requestJson(url: string, init: { method: "GET" | "POST"; headers: Record<string, string>; body?: unknown }): Promise<unknown> {
  const res = await engineFetch(url, {
    method: init.method,
    headers: init.headers,
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    // non-JSON error bodies are reported raw below
  }
  if (!res.ok) {
    const message = apiErrorMessage(json, text);
    throw new Error(`HTTP ${res.status}${message ? ` ${message}` : ""}`);
  }
  return json;
}

function postJson(url: string, key: string, body: unknown): Promise<unknown> {
  return requestJson(url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body,
  });
}

async function searchBocha(query: string, count: number, key: string): Promise<SearchHit[]> {
  const json = (await postJson("https://api.bochaai.com/v1/web-search", key, {
    query,
    count,
    summary: true,
    freshness: "noLimit",
  })) as Record<string, unknown> | null;
  // Business errors can arrive with HTTP 200: { code: 4xx, msg }.
  if (json && typeof json.code === "number" && json.code !== 200) throw new Error(`${json.code} ${clean(json.msg)}`);
  const data = (json?.data ?? json) as Record<string, unknown> | undefined;
  const pages = (data?.webPages ?? {}) as Record<string, unknown>;
  return records(pages.value).map((r) => ({
    title: clean(r.name),
    url: clean(r.url),
    snippet: clean(r.summary) || clean(r.snippet),
    site: clean(r.siteName) || undefined,
    date: clean(r.datePublished).slice(0, 10) || undefined,
  }));
}

async function searchZhipu(query: string, count: number, key: string): Promise<SearchHit[]> {
  const json = (await postJson("https://open.bigmodel.cn/api/paas/v4/web_search", key, {
    search_query: query,
    search_engine: "search_std",
    count,
  })) as Record<string, unknown> | null;
  return records(json?.search_result).map((r) => ({
    title: clean(r.title),
    url: clean(r.link),
    snippet: clean(r.content),
    site: clean(r.media) || undefined,
    date: clean(r.publish_date).slice(0, 10) || undefined,
  }));
}

async function searchTavily(query: string, count: number, key: string): Promise<SearchHit[]> {
  const json = (await postJson("https://api.tavily.com/search", key, {
    query,
    max_results: count,
    search_depth: "basic",
    include_answer: false,
  })) as Record<string, unknown> | null;
  return records(json?.results).map((r) => ({
    title: clean(r.title),
    url: clean(r.url),
    snippet: clean(r.content),
    date: clean(r.published_date).slice(0, 10) || undefined,
  }));
}

/** Exa `/search` response → hits. Pure (exported for the offline smoke). */
export function parseExaResponse(json: unknown): SearchHit[] {
  return records(asRecord(json)?.results).map((r) => {
    const highlights = Array.isArray(r.highlights)
      ? clean(r.highlights.filter((h): h is string => typeof h === "string").join(" "))
      : "";
    return {
      title: clean(r.title),
      url: clean(r.url),
      snippet: highlights || clean(r.summary) || clean(r.text),
      date: clean(r.publishedDate).slice(0, 10) || undefined,
    };
  });
}

async function searchExa(query: string, count: number, key: string): Promise<SearchHit[]> {
  const json = await requestJson("https://api.exa.ai/search", {
    method: "POST",
    headers: { "x-api-key": key, "content-type": "application/json" },
    body: { query, numResults: count, contents: { highlights: true } },
  });
  return parseExaResponse(json);
}

/** Brave Web Search response → hits. Pure (exported for the offline smoke). */
export function parseBraveResponse(json: unknown): SearchHit[] {
  const web = asRecord(asRecord(json)?.web);
  return records(web?.results).map((r) => {
    const profile = asRecord(r.profile);
    return {
      title: stripTags(r.title),
      url: clean(r.url),
      snippet: stripTags(r.description),
      site: clean(profile?.name) || undefined,
      date: clean(r.age) || clean(r.page_age).slice(0, 10) || undefined,
    };
  });
}

async function searchBrave(query: string, count: number, key: string): Promise<SearchHit[]> {
  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${Math.min(count, 20)}`;
  const json = await requestJson(url, {
    method: "GET",
    headers: { Accept: "application/json", "X-Subscription-Token": key },
  });
  return parseBraveResponse(json);
}

/** Result extraction on the engine's own page. Selectors follow the current
 *  markup (Bing `li.b_algo`, Baidu `.c-container`); `blocked` flags a human
 *  verification page so the error can say so. */
const RESULTS_SCRIPT = `
(function (argJson) {
  var arg = JSON.parse(argJson);
  function clean(s) { return (s || '').replace(/\\s+/g, ' ').trim(); }
  var out = [];
  if (arg.engine === 'bing') {
    var items = document.querySelectorAll('#b_results > li.b_algo');
    for (var i = 0; i < items.length && out.length < arg.max; i++) {
      var a = items[i].querySelector('h2 a');
      if (!a || !a.href) continue;
      var snip = items[i].querySelector('.b_caption p, [class*="b_lineclamp"], .b_paractl, .b_algoSlug');
      var cite = items[i].querySelector('cite');
      out.push({ title: clean(a.textContent), url: a.href, snippet: clean(snip ? snip.textContent : ''), site: clean(cite ? cite.textContent : '') });
    }
  } else {
    var nodes = document.querySelectorAll('#content_left > .c-container, #content_left > .result, #content_left > .result-op');
    for (var j = 0; j < nodes.length && out.length < arg.max; j++) {
      var it = nodes[j];
      var link = it.querySelector('h3 a');
      if (!link || !link.href) continue;
      var real = it.getAttribute('mu') || '';
      var abs = it.querySelector('[class*="abstract"], [data-module="abstract"], [class*="content-right"], .c-span-last');
      var text = clean(abs ? abs.textContent : (it.innerText || '').replace(link.innerText || '', ''));
      var src = it.querySelector('.c-showurl, [class*="source-text"], [class*="siteLink"]');
      out.push({ title: clean(link.textContent), url: /^https?:/.test(real) ? real : link.href, snippet: text, site: clean(src ? src.textContent : '') });
    }
  }
  var t = document.title || '';
  var blocked = out.length === 0 && (/验证|captcha|verify/i.test(t) || !!document.querySelector('#captcha, .captcha, [id*="verify"], #b_captcha'));
  return { hits: out, blocked: blocked, title: t };
})(%ARG_JSON%)
`;

/** Bing wraps some result links as bing.com/ck/a?…&u=a1<base64url(target)>. */
function unwrapBingLink(url: string): string {
  try {
    const u = new URL(url);
    if (!/(^|\.)bing\.com$/.test(u.hostname) || u.pathname !== "/ck/a") return url;
    const enc = u.searchParams.get("u");
    if (!enc?.startsWith("a1")) return url;
    const decoded = Buffer.from(enc.slice(2).replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    return /^https?:\/\//.test(decoded) ? decoded : url;
  } catch {
    return url;
  }
}

async function searchBrowser(engine: "bing" | "baidu", query: string, count: number): Promise<SearchHit[]> {
  const url =
    engine === "bing"
      ? `https://cn.bing.com/search?q=${encodeURIComponent(query)}`
      : `https://www.baidu.com/s?wd=${encodeURIComponent(query)}&rn=${Math.max(count, 10)}`;
  const script = RESULTS_SCRIPT.replace("%ARG_JSON%", () => JSON.stringify(JSON.stringify({ engine, max: count })));
  const result = await withHiddenPage(url, (wc: WebContents) => evalInPage<{ hits: SearchHit[]; blocked: boolean; title: string }>(wc, script), {
    timeoutMs: 15_000,
    settleMs: 300,
  });
  if (result.blocked) throw new Error(`${WEB_SEARCH_BACKEND_LABEL[engine]}要求人机验证,暂时无法自动搜索`);
  return result.hits.map((h) => ({
    ...h,
    url: engine === "bing" ? unwrapBingLink(h.url) : h.url,
    // Bing's <cite> is a URL breadcrumb ("https://x.com › docs") — the link says it already.
    site: h.site && !/^https?:|›/.test(h.site) ? h.site : undefined,
  }));
}

async function searchOnce(backend: WebSearchBackend, query: string, count: number): Promise<SearchHit[]> {
  if (backend === "bing" || backend === "baidu") return searchBrowser(backend, query, count);
  const key = readBuiltinToolSecret(backend satisfies WebSearchKeyedBackend);
  if (!key) throw new Error("没有配置 API Key");
  switch (backend) {
    case "bocha":
      return searchBocha(query, count, key);
    case "zhipu":
      return searchZhipu(query, count, key);
    case "tavily":
      return searchTavily(query, count, key);
    case "exa":
      return searchExa(query, count, key);
    case "brave":
      return searchBrave(query, count, key);
  }
}

/** Tidy hits: drop entries without a title/URL, links back into a search
 *  engine, and duplicate URLs; cap snippets. */
function tidy(hits: SearchHit[], count: number): SearchHit[] {
  const seen = new Set<string>();
  const out: SearchHit[] = [];
  for (const h of hits) {
    const url = h.url.trim();
    if (!h.title || !/^https?:\/\//i.test(url) || seen.has(url)) continue;
    // Keep search-engine redirect links (Baidu's /link?url=…) — mario_web_fetch
    // follows them; drop links to another results page.
    if (matchSearchEngine(url) && !/\/link\?|\/ck\/a\?/.test(url)) continue;
    seen.add(url);
    out.push({ ...h, url, snippet: clip(h.snippet, WEB_SEARCH_SNIPPET_CHARS) });
    if (out.length >= count) break;
  }
  return out;
}

/** Run a search with the configured backend (or `backend`), falling back to
 *  Bing when a keyed backend fails. Cached for 10 minutes per query unless
 *  `noCache` (the settings page's test button, right after a key change). */
export async function runWebSearch(
  query: string,
  count: number,
  backend?: WebSearchBackend,
  opts: { noCache?: boolean } = {},
): Promise<SearchOutcome> {
  const chosen = backend ?? readBuiltinToolsConfig().search.backend;
  const cacheKey = `${chosen}\u0000${count}\u0000${query}`;
  const cached = opts.noCache ? undefined : cache.get(cacheKey);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.outcome;
  let outcome: SearchOutcome;
  try {
    outcome = { hits: tidy(await searchOnce(chosen, query, count), count), backend: chosen };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    if (chosen === "bing" || chosen === "baidu") throw new Error(`${WEB_SEARCH_BACKEND_LABEL[chosen]}搜索失败:${error}`);
    log.warn(`mario_web_search: ${chosen} failed (${error}); falling back to bing`);
    outcome = { hits: tidy(await searchOnce("bing", query, count), count), backend: "bing", fallback: { from: chosen, error } };
  }
  cache.set(cacheKey, { at: Date.now(), outcome });
  if (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  return outcome;
}

function text(t: string): BuiltinToolResult {
  return { content: [{ type: "text", text: t }] };
}

/** The mario_web_search tool. */
export async function webSearch(args: { query?: unknown; count?: unknown }): Promise<BuiltinToolResult> {
  const query = clean(args.query).slice(0, 300);
  if (!query) return text("❌ query 不能为空");
  const config = readBuiltinToolsConfig();
  const count =
    typeof args.count === "number" && Number.isFinite(args.count)
      ? Math.min(WEB_SEARCH_MAX_RESULTS, Math.max(1, Math.floor(args.count)))
      : config.search.maxResults;
  let outcome: SearchOutcome;
  try {
    outcome = await runWebSearch(query, count, config.search.backend);
  } catch (err) {
    return text(`❌ ${err instanceof Error ? err.message : String(err)}。可以换个关键词重试,或告诉用户暂时无法联网搜索。`);
  }
  const lines: string[] = [];
  if (outcome.fallback) {
    lines.push(`(${WEB_SEARCH_BACKEND_LABEL[outcome.fallback.from]}搜索失败:${outcome.fallback.error};以下是必应的结果)`);
  }
  if (outcome.hits.length === 0) {
    lines.push(`搜索「${query}」(${WEB_SEARCH_BACKEND_LABEL[outcome.backend]})没有结果。可以换个说法或更短的关键词再试。`);
    return text(lines.join("\n"));
  }
  lines.push(`搜索「${query}」(${WEB_SEARCH_BACKEND_LABEL[outcome.backend]},${outcome.hits.length} 条):`);
  outcome.hits.forEach((h, i) => {
    const meta = [h.site, h.date].filter(Boolean).join(" · ");
    lines.push("", `${i + 1}. ${h.title}`, `   ${h.url}`);
    if (h.snippet) lines.push(`   ${h.snippet}`);
    if (meta) lines.push(`   (${meta})`);
  });
  lines.push("", "需要详细内容时用 mario_web_fetch 读取对应链接;引用时注明来源。");
  return text(lines.join("\n"));
}
