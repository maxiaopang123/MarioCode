/**
 * mario_web_search — titles, links and short snippets only; full text is
 * mario_web_fetch's job, so a search costs a few hundred tokens instead of a
 * results page's 10K+.
 *
 * Order of attempts: the search APIs first (博查 / 智谱 / Tavily / Exa / Brave,
 * each needs the user's key; Brave may need a proxy from mainland networks) -
 * the chosen one, then every other API that has a saved key. Only an error
 * moves on to the next: a valid answer with zero hits is returned as is, so
 * one search never turns into several requests.
 *
 * Bing / Baidu (read from the engine's own results page in a hidden window)
 * are the last resort and only run when the model passes `browser: true`,
 * which its prompt allows only after the user agreed in the conversation. The
 * code cannot check that agreement, but it never touches the browser without
 * the flag, and refuses the flag in unattended runs where nobody can answer.
 */
import type { WebContents } from "electron";
import { WEB_SEARCH_KEYED_BACKENDS, type WebSearchBackend, type WebSearchKeyedBackend } from "@contracts/ipc";
import { engineFetch } from "@main/network/engineProxy.js";
import { matchSearchEngine } from "@main/browser/searchEngines.js";
import { log } from "@main/lib/logger.js";
import { readBuiltinToolSecret, readBuiltinToolsConfig } from "./builtinToolsConfig.js";
import { isUnattendedSession } from "./unattended.js";
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
  /** The backend that actually answered (an API, or Bing / Baidu in the browser). */
  backend: WebSearchBackend;
  /** Set when the first backend tried failed and another one answered. */
  fallback?: { from: WebSearchBackend; error: string };
}

/** No search API could answer (none has a key, or every one failed) and the
 *  browser fallback was not allowed. The tool turns this into a message that
 *  tells the model to ask the user before retrying with `browser: true`. */
export class SearchApiUnavailable extends Error {
  constructor(readonly attempts: Array<{ backend: WebSearchBackend; error: string }>) {
    super(
      attempts.length
        ? `搜索 API 都失败了:${attempts.map((a) => `${a.backend}:${a.error}`).join(";")}`
        : "没有可用的搜索 API(还没有填 Key)",
    );
    this.name = "SearchApiUnavailable";
  }
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

/** The search APIs to try, in order: the chosen one (when it is an API and has
 *  a key), then every other API that has a saved key. */
function apiOrder(chosen: WebSearchBackend): WebSearchKeyedBackend[] {
  const withKey = WEB_SEARCH_KEYED_BACKENDS.filter((id) => !!readBuiltinToolSecret(id));
  const first = withKey.filter((id) => id === chosen);
  return [...first, ...withKey.filter((id) => id !== chosen)];
}

/** Run a search: the APIs in `apiOrder` first, each only after the previous
 *  one errored; with `opts.browser` the Bing / Baidu results page as the last
 *  resort (the engine named in the setting first, the other one if it fails).
 *  Without `opts.browser` and with no API answering this throws
 *  SearchApiUnavailable. Cached for 10 minutes per query unless `noCache`
 *  (the settings page's test button, right after a key change). */
export async function runWebSearch(
  query: string,
  count: number,
  backend?: WebSearchBackend,
  opts: { noCache?: boolean; browser?: boolean } = {},
): Promise<SearchOutcome> {
  const chosen = backend ?? readBuiltinToolsConfig().search.backend;
  const cacheKey = `${chosen}\u0000${count}\u0000${opts.browser ? "b" : "a"}\u0000${query}`;
  const cached = opts.noCache ? undefined : cache.get(cacheKey);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.outcome;

  const failures: Array<{ backend: WebSearchBackend; error: string }> = [];
  let outcome: SearchOutcome | null = null;
  const attempt = async (id: WebSearchBackend): Promise<boolean> => {
    try {
      const hits = tidy(await searchOnce(id, query, count), count);
      outcome = { hits, backend: id, ...(failures[0] ? { fallback: { from: failures[0].backend, error: failures[0].error } } : {}) };
      return true;
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      log.warn(`mario_web_search: ${id} failed (${error})`);
      failures.push({ backend: id, error });
      return false;
    }
  };

  for (const id of apiOrder(chosen)) {
    if (await attempt(id)) break;
  }
  if (!outcome) {
    if (!opts.browser) throw new SearchApiUnavailable(failures);
    const engines: Array<"bing" | "baidu"> = chosen === "baidu" ? ["baidu", "bing"] : ["bing", "baidu"];
    for (const id of engines) {
      if (await attempt(id)) break;
    }
  }
  if (!outcome) {
    throw new Error(failures.map((f) => `${WEB_SEARCH_BACKEND_LABEL[f.backend]}搜索失败:${f.error}`).join(";"));
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

/** What the model is told when no search API could answer. The browser
 *  fallback needs the user's yes in the conversation first; in an unattended
 *  run (scheduled task / ClawBot DM) nobody can answer, so it is not offered. */
function apiUnavailableMessage(err: SearchApiUnavailable, unattended: boolean): string {
  const cause = err.attempts.length ? err.message : "还没有填任何搜索 API 的 Key";
  if (unattended) {
    return `❌ 搜索 API 不可用(${cause})。这是无人值守的运行,没有人可以确认,不能改用浏览器搜索。请如实告知查不到,并建议在 设置 → MarioTool 里填一个搜索 API 的 Key。不要换关键词重试。`;
  }
  return (
    `❌ 搜索 API 不可用(${cause})。` +
    "可以改用浏览器读取搜索引擎结果页,但必须先问用户是否接受(用户在本会话里已经同意过就不必再问);" +
    "用户同意后,带 browser=true 再调用一次本工具。用户没同意或拒绝,就如实告诉用户暂时查不到,并建议在 设置 → MarioTool 里填一个搜索 API 的 Key。" +
    "不要在用户回答之前换关键词重试。"
  );
}

/** The mario_web_search tool. `ctx.sessionId` lets it tell an unattended run
 *  (where nobody can agree to the browser fallback) from an interactive one. */
export async function webSearch(
  args: { query?: unknown; count?: unknown; browser?: unknown },
  ctx: { sessionId?: string } = {},
): Promise<BuiltinToolResult> {
  const query = clean(args.query).slice(0, 300);
  if (!query) return text("❌ query 不能为空");
  const config = readBuiltinToolsConfig();
  const count =
    typeof args.count === "number" && Number.isFinite(args.count)
      ? Math.min(WEB_SEARCH_MAX_RESULTS, Math.max(1, Math.floor(args.count)))
      : config.search.maxResults;
  const unattended = isUnattendedSession(ctx.sessionId);
  const browser = args.browser === true && !unattended;
  let outcome: SearchOutcome;
  try {
    outcome = await runWebSearch(query, count, config.search.backend, { browser });
  } catch (err) {
    if (err instanceof SearchApiUnavailable) return text(apiUnavailableMessage(err, unattended));
    return text(`❌ ${err instanceof Error ? err.message : String(err)}。不要反复重试,如实告诉用户暂时无法联网搜索。`);
  }
  const lines: string[] = [];
  if (outcome.fallback) {
    lines.push(
      `(${WEB_SEARCH_BACKEND_LABEL[outcome.fallback.from]}搜索失败:${outcome.fallback.error};以下是${WEB_SEARCH_BACKEND_LABEL[outcome.backend]}的结果)`,
    );
  }
  if (outcome.hits.length === 0) {
    lines.push(
      `搜索「${query}」(${WEB_SEARCH_BACKEND_LABEL[outcome.backend]})没有结果。最多换一个说法再试一次,仍然没有就告诉用户查不到,不要继续换词。`,
    );
    return text(lines.join("\n"));
  }
  lines.push(`搜索「${query}」(${WEB_SEARCH_BACKEND_LABEL[outcome.backend]},${outcome.hits.length} 条):`);
  outcome.hits.forEach((h, i) => {
    const meta = [h.site, h.date].filter(Boolean).join(" · ");
    lines.push("", `${i + 1}. ${h.title}`, `   ${h.url}`);
    if (h.snippet) lines.push(`   ${h.snippet}`);
    if (meta) lines.push(`   (${meta})`);
  });
  lines.push("", "摘要够回答就直接回答;引用时注明来源。");
  return text(lines.join("\n"));
}
