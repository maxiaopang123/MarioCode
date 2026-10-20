/**
 * The fast lane of mario_web_fetch: read a page over plain HTTP and turn its
 * HTML into the same Markdown-ish text the browser path produces.
 *
 * Why a second lane exists (TODO-060): reading every page through a real
 * Chromium page is the only way to see JS-rendered sites, but it costs a
 * renderer process, 0.6–2 s of load/settle waits, and a native window that
 * must never surface. Most pages a model reads — news, docs, blogs, forums —
 * are static HTML that HTTP returns in tens of milliseconds. So the reader
 * tries this lane first and only falls back to Chromium (webPage.ts) when the
 * static result is unusable: too little text, no HTML at all, or a page whose
 * content is clearly injected by script.
 *
 * Fidelity: this is a heuristic extractor, not a DOM. It mirrors the rules of
 * MAIN_TEXT_JS (snapshotScript.ts) — skip site chrome, blank lines between
 * blocks, `#` headings, `- ` list items, `---` rules, `[text](href)` links —
 * but it cannot see computed styles, so hidden-by-CSS content is kept and
 * `main`/`article` detection is structural. The Chromium path remains the
 * reference implementation; when this lane's text is thin, it is not used.
 *
 * Safety: http(s) only, the final URL is handed back for the caller's
 * private-host / search-engine checks, bodies are capped, and non-HTML
 * responses are refused rather than fed to the extractor.
 */
import { engineFetch } from "@main/network/engineProxy.js";
import { WEB_FETCH_MIN_CHARS } from "./builtinToolSpecs.js";

/** A page this large is almost never prose; the browser path gets it instead. */
const MAX_BYTES = 6 * 1024 * 1024;
/** Give up on a server that never finishes sending the body. */
const TIMEOUT_MS = 15_000;
/** Chars of markup scanned for <meta charset>; the declaration lives in <head>. */
const CHARSET_SNIFF_BYTES = 4096;

export interface StaticPage {
  ok: true;
  finalUrl: string;
  title: string;
  text: string;
  /** Same vocabulary as MAIN_TEXT_JS: main / article / block / body. */
  source: string;
}

export interface StaticPageMiss {
  ok: false;
  /** Why this lane can't answer; the caller logs it before rendering. */
  reason: string;
}

export type StaticPageResult = StaticPage | StaticPageMiss;

/** Thrown for content the browser path would only report the same way. */
export class StaticPageRejected extends Error {}

function userAgent(): string {
  const platform = process.platform === "win32" ? "Windows NT 10.0; Win64; x64" : "X11; Linux x86_64";
  return `Mozilla/5.0 (${platform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${process.versions.chrome ?? "120"} Safari/537.36`;
}

/** Chromium's decoding rules, without Chromium: the header wins, then the
 *  document's <meta>, then UTF-8. Chinese sites are still routinely GBK. */
function decodeBody(bytes: Uint8Array, contentType: string): string {
  let label = /charset=["']?([\w-]+)/i.exec(contentType)?.[1] ?? "";
  if (!label) {
    // latin1 maps bytes 1:1, so the sniffed declaration is readable even when
    // the document turns out to be GBK.
    const head = new TextDecoder("latin1").decode(bytes.subarray(0, CHARSET_SNIFF_BYTES));
    label = /<meta[^>]+charset=["']?([\w-]+)/i.exec(head)?.[1] ?? "utf-8";
  }
  // GB18030 is a superset of GBK/GB2312; decoding the narrow names with it is
  // strictly safer for the characters real pages actually use.
  const chosen = /^(gb2312|gbk|gb18030)$/i.test(label) ? "gb18030" : label;
  try {
    return new TextDecoder(chosen, { fatal: false }).decode(bytes);
  } catch {
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  }
}

async function readCapped(res: Response): Promise<Uint8Array> {
  const body = res.body;
  if (!body) return new Uint8Array(await res.arrayBuffer());
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      chunks.push(value);
      total += value.length;
      if (total >= MAX_BYTES) {
        await reader.cancel().catch(() => {});
        break;
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* already released by cancel() */
    }
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    const take = Math.min(chunk.length, total - at);
    if (take <= 0) break;
    out.set(chunk.subarray(0, take), at);
    at += take;
  }
  return out;
}

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  mdash: "—", ndash: "–", hellip: "…", middot: "·", times: "×",
  copy: "©", reg: "®", trade: "™", laquo: "«", raquo: "»",
  ldquo: "“", rdquo: "”", lsquo: "‘", rsquo: "’",
};

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (whole, body: string) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[body.toLowerCase()] ?? whole;
  });
}

/** Elements whose content is never prose. Stripped with their closing tag
 *  before the walk; `br`/`hr` stay because they become markers. */
const DROP = [
  "script", "style", "noscript", "template", "svg", "canvas", "iframe",
  "object", "embed", "nav", "aside", "footer", "button", "select", "dialog",
  "menu", "head", "picture", "video", "audio",
];
/** Void/element-only tags that carry no text. */
const DROP_VOID = ["img", "input", "meta", "link", "source", "track", "wbr", "area", "base", "col"];

const BLOCK = new Set([
  "address", "article", "blockquote", "caption", "dd", "details", "div", "dl", "dt",
  "fieldset", "figcaption", "figure", "form", "h1", "h2", "h3", "h4", "h5", "h6",
  "header", "li", "main", "ol", "p", "pre", "section", "summary", "table", "tr", "ul",
]);
const PARA = new Set(["p", "h1", "h2", "h3", "h4", "h5", "h6", "pre", "table", "blockquote"]);

function stripChrome(html: string): string {
  let out = html;
  // Repeat so nested/malformed pairs (the common case in real pages) shrink
  // until stable; a page that never stabilises ends up with too little text
  // and the caller renders it instead.
  for (let pass = 0; pass < 4; pass++) {
    const before = out.length;
    for (const tag of DROP) out = out.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}\\s*>`, "gi"), " ");
    for (const tag of DROP_VOID) out = out.replace(new RegExp(`<${tag}\\b[^>]*>`, "gi"), " ");
    out = out.replace(/<!--[\s\S]*?-->/g, " ");
    if (out.length === before) break;
  }
  return out;
}

function attr(attrs: string, name: string): string {
  // Anchored on a boundary rather than `\b`, so `data-href` is not `href`.
  const m = new RegExp(`(?:^|\\s)${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(attrs);
  return m ? (m[2] ?? m[3] ?? m[4] ?? "") : "";
}

interface WalkOptions {
  links: boolean;
  baseUrl: string;
  limit: number;
}

function collapse(s: string): string {
  return decodeEntities(s).replace(/[ \t\r\f\v]+/g, " ").replace(/\s*\n\s*/g, "\n");
}

function stripTags(s: string): string {
  return s.replace(/<[^>]*>/g, " ");
}

function resolveHref(raw: string, base: string): string {
  const href = raw.trim();
  if (!href || /^(javascript:|#|mailto:|tel:)/i.test(href)) return "";
  try {
    const url = new URL(href, base);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : "";
  } catch {
    return "";
  }
}

/** Walk an HTML fragment, emitting text in the same shape MAIN_TEXT_JS does. */
function walkHtml(html: string, opts: WalkOptions): string {
  const out: string[] = [];
  const lower = html.toLowerCase();
  let size = 0;
  // Newlines at the end of the output so far: block boundaries top it up
  // instead of stacking, and whitespace at a line start is dropped.
  let trail = 2;
  let pre = 0;
  // Cells emitted in the current row; the separator goes between them, never
  // before the first (MAIN_TEXT_JS uses `td:not(:first-child)` the same way).
  let cells = 0;

  const push = (s: string): void => {
    if (!s || size >= opts.limit) return;
    out.push(s);
    size += s.length;
    const m = /\n*$/.exec(s);
    const tail = m ? m[0].length : 0;
    trail = tail === s.length ? trail + tail : tail;
  };
  const brk = (n: number): void => {
    while (trail < n && size < opts.limit) push("\n");
  };
  // Prose collapses runs of whitespace; a code block must keep its indentation.
  const chunk = (s: string): string => (pre > 0 ? decodeEntities(s).replace(/\r\n?/g, "\n") : collapse(s));

  let i = 0;
  while (i < html.length && size < opts.limit) {
    const lt = html.indexOf("<", i);
    if (lt === -1) {
      push(chunk(html.slice(i)));
      break;
    }
    if (lt > i) push(chunk(html.slice(i, lt)));
    const gt = html.indexOf(">", lt + 1);
    if (gt === -1) break;
    const raw = html.slice(lt + 1, gt);
    i = gt + 1;

    if (raw.startsWith("!") || raw.startsWith("?")) continue;
    const closing = raw[0] === "/";
    const nameMatch = /^\/?\s*([a-zA-Z][\w:-]*)/.exec(raw);
    if (!nameMatch) continue;
    const tag = nameMatch[1]!.toLowerCase();

    if (!closing && (tag === "script" || tag === "style" || tag === "textarea" || tag === "title")) {
      // Raw-text elements: jump past their closing tag instead of tokenising
      // inner markup (a script body full of `<` would otherwise derail the walk).
      const end = lower.indexOf(`</${tag}`, i);
      if (end === -1) break;
      const close = html.indexOf(">", end);
      i = close === -1 ? html.length : close + 1;
      continue;
    }

    if (closing) {
      if (tag === "pre" && pre > 0) {
        pre--;
        brk(2);
        push("```\n");
        continue;
      }
      if (BLOCK.has(tag)) brk(PARA.has(tag) ? 2 : 1);
      continue;
    }

    if (raw.endsWith("/")) {
      // Self-closing: an `<img/>`, `<br/>` or stray `<div/>` with no content.
      if (tag === "br") push("\n");
      else if (tag === "hr") {
        brk(2);
        push("---");
        brk(2);
      }
      continue;
    }

    if (tag === "br") {
      push("\n");
      continue;
    }
    if (tag === "hr") {
      brk(2);
      push("---");
      brk(2);
      continue;
    }

    if (tag === "a" && opts.links) {
      const href = resolveHref(attr(raw, "href"), opts.baseUrl);
      if (href) {
        const close = lower.indexOf("</a", i);
        const innerEnd = close === -1 ? html.length : close;
        const inner = collapse(stripTags(html.slice(i, innerEnd))).replace(/\s+/g, " ").trim();
        if (inner) push(`[${inner}](${href})`);
        const gt2 = close === -1 ? -1 : html.indexOf(">", close);
        i = close === -1 ? html.length : gt2 === -1 ? html.length : gt2 + 1;
        continue;
      }
    }

    if (BLOCK.has(tag)) brk(PARA.has(tag) ? 2 : 1);
    if (/^h[1-6]$/.test(tag)) push("#".repeat(Number(tag[1]!)) + " ");
    else if (tag === "li") push("- ");
    else if (tag === "pre") {
      push("```\n");
      pre++;
    }
    if (tag === "tr") cells = 0;
    if (tag === "td" || tag === "th") {
      if (cells++ > 0) push(" | ");
    }
  }

  return finish(out.join(""));
}

function finish(text: string): string {
  return text
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/g, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function pageTitle(html: string): string {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return m ? collapse(stripTags(m[1]!)).replace(/\s+/g, " ").trim().slice(0, 300) : "";
}

/** Inner markup of the first `<main>` / `<article>`, if the page has one. */
function containerHtml(html: string, tag: string): string | null {
  const open = new RegExp(`<${tag}\\b[^>]*>`, "i").exec(html);
  if (!open) return null;
  const from = open.index + open[0].length;
  const close = html.toLowerCase().indexOf(`</${tag}`, from);
  return html.slice(from, close === -1 ? html.length : close);
}

/**
 * Read `url` over plain HTTP. Returns `{ ok:false }` when the browser path
 * should render it instead, and throws StaticPageRejected for content the
 * browser path would only report the same way (PDF).
 */
export async function readStaticPage(
  url: string,
  opts: {
    links: boolean;
    limit: number;
    /** Called with the URL the request landed on, before the body is read:
     *  following a redirect must not reach a host the caller refuses (a public
     *  page bouncing to 127.0.0.1 is the classic case). Return a message to
     *  refuse, or null to continue. */
    guard?: (finalUrl: string) => string | null;
  },
): Promise<StaticPageResult> {
  let res: Response;
  try {
    res = await engineFetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        "User-Agent": userAgent(),
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
      },
    });
  } catch (err) {
    return { ok: false, reason: `HTTP 请求失败:${err instanceof Error ? err.message : String(err)}` };
  }

  const type = (res.headers.get("content-type") ?? "").toLowerCase();
  const finalUrl = res.url || url;
  // Leaving an unread body attached holds the connection open until GC.
  const abandon = (): void => {
    void res.body?.cancel().catch(() => {});
  };
  // The redirect has already been followed, so this is the last point at which
  // the body can still be left unread for a destination the caller refuses.
  const refusal = opts.guard?.(finalUrl);
  if (refusal) {
    abandon();
    throw new StaticPageRejected(refusal);
  }
  if (type.includes("application/pdf")) {
    abandon();
    throw new StaticPageRejected("这是 PDF 文件,mario_web_fetch 暂不支持;可以用 browser_navigate 打开查看,或下载后用文件工具读取");
  }
  if (type && !/^(text\/html|application\/xhtml\+xml|text\/plain)/.test(type)) {
    abandon();
    return { ok: false, reason: `不是 HTML(${type})` };
  }
  if (res.status >= 400) {
    abandon();
    return { ok: false, reason: `HTTP ${res.status}` };
  }

  let html: string;
  try {
    html = decodeBody(await readCapped(res), type);
  } catch (err) {
    return { ok: false, reason: `读取正文失败:${err instanceof Error ? err.message : String(err)}` };
  }

  const title = pageTitle(html);
  const body = stripChrome(html);
  const full = walkHtml(body, { links: opts.links, baseUrl: finalUrl, limit: opts.limit });

  // Prefer the semantic container when it holds most of the page, exactly as
  // mcMainRoot does — but measured on text length, since there is no layout.
  let text = full;
  let source = "body";
  let chosen = body;
  for (const tag of ["main", "article"] as const) {
    const inner = containerHtml(html, tag);
    if (!inner) continue;
    const candidate = walkHtml(stripChrome(inner), { links: opts.links, baseUrl: finalUrl, limit: opts.limit });
    if (candidate.length >= 200 && candidate.length >= full.length * (tag === "main" ? 0.3 : 0.25)) {
      text = candidate;
      source = tag;
      chosen = inner;
      break;
    }
  }

  // A short *article* still beats rendering; a short *shell* does not. Paragraph
  // count separates them: real prose markup has several <p>, while a JS app's
  // served HTML is a div/script skeleton with a line or two of fallback copy.
  const paragraphs = (chosen.match(/<p\b/gi) ?? []).length;
  if (text.length < WEB_FETCH_MIN_CHARS && !(text.length >= 200 && paragraphs >= 3)) {
    // Either a JS-rendered shell, a cookie/consent interstitial, or a page this
    // extractor didn't understand. Rendering is what the reader did before this
    // lane existed, so the fallback is never worse than the old behavior.
    return { ok: false, reason: `正文只有 ${text.length} 字、${paragraphs} 个段落,可能由脚本渲染` };
  }
  return { ok: true, finalUrl, title, text, source };
}
