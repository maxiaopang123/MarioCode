/**
 * Markdown rendering with syntax highlighting (Shiki + codeDiffs),
 * KaTeX math, and code-block output caching (FNV-1a + LRU).
 *
 * Performance layering:
 *  - react-markdown for the base markdown→React pipeline.
 *  - remark-math + rehype-katex for LaTeX math ($...$ / $$...$$).
 *  - Shiki for fenced-code-block highlighting (+ diff annotations via
 *    transformerNotationDiff).
 *  - code-html cache (fnv1a hash → shiki HTML) to avoid re-highlighting.
 *  - useDeferredValue is applied at the MessageBlocks layer, not here.
 *
 * Security: react-markdown escapes raw HTML by default, so we never need
 * DOMPurify. The only `dangerouslySetInnerHTML` usage is for shiki-generated
 * code-block HTML, which is produced from known content (the code text) and
 * is thus safe by construction.
 */
import { memo, useState, useMemo, useRef, useLayoutEffect, createContext, useContext } from "react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import { cn } from "@renderer/lib/cn.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { IconCheck, IconChevronDown, IconChevronUp, IconCopy } from "@renderer/lib/icons.js";
import type { Components } from "react-markdown";
import { codeCacheKey, getCodeHtml, setCodeHtml } from "@renderer/lib/markdownCache.js";
import {
  classifyInlinePath,
  fileHrefToPath,
  isAbsolutePath,
  isLocalFileHref,
  splitProsePaths,
} from "@renderer/lib/fileLink.js";
import { FileChip } from "./FileChip.js";
import { resolveRelativePath } from "@renderer/lib/path.js";
import { FileLink } from "./FileLink.js";
import {
  MarkdownGallery,
  MarkdownLocalImage,
  MarkdownRemoteImage,
  isInlineImagePath,
} from "./MarkdownImage.js";

// ── Lazy highlighter singleton ────────────────────────────────────────
// Initialised on first encounter of a fenced code block; kept alive for the
// lifetime of the page. Dual-theme (light / dark) resolved via CSS class.
import { createHighlighter, type Highlighter, type BundledLanguage, type BundledTheme } from "shiki";
import { transformerNotationDiff } from "@shikijs/transformers";

type ShikiHighlighter = Highlighter;

let highlighterPromise: Promise<ShikiHighlighter> | null = null;
let highlighterInstance: ShikiHighlighter | null = null;

/** Languages we bundle eagerly (the ones Claude uses most). */
const EAGER_LANGS: BundledLanguage[] = [
  "typescript", "javascript", "jsx", "tsx",
  "python", "bash", "shell",
  "json", "markdown", "md", "yaml", "yml",
  "html", "css", "scss", "less", "sql", "xml", "diff",
  "vue", "svelte",
  "rust", "go", "java", "c", "cpp", "csharp",
  "ruby", "php", "swift", "kotlin",
  "docker", "dockerfile",
  "graphql", "gql",
  "ini", "toml", "makefile",
];

/**
 * Map common language aliases used in markdown fences to canonical Shiki
 * language ids. When a `resolveLang` falls back to "text" the code block
 * is rendered as plain monospace (no highlighting) instead of crashing.
 */
const LANG_ALIAS: Record<string, string> = {
  sh: "shell", zsh: "shell", fish: "shell",
  powershell: "shell", ps: "shell", cmd: "shell", dos: "shell", batch: "shell",
  mjs: "javascript", cjs: "javascript", es: "javascript", es6: "javascript",
  ts: "typescript",
  py: "python",
  mdx: "markdown",
  jsonc: "json", json5: "json",
  yml: "yaml",
  scss: "css", less: "css", sass: "css", stylus: "css",
  cc: "cpp", cxx: "cpp", hh: "cpp", hpp: "cpp",
  h: "c",
  containerfile: "dockerfile",
};

/** Resolve a markdown code-fence language tag to a Shiki language id.
 *  Falls back to "text" when the language is unknown, effectively disabling
 *  highlighting for that block. */
function resolveLang(tag: string): string {
  if (!tag || tag === "text" || tag === "none" || tag === "plain") return "text";
  if (EAGER_LANGS.includes(tag as BundledLanguage)) return tag;
  return LANG_ALIAS[tag] ?? "text";
}

function ensureHighlighter(): Promise<ShikiHighlighter> {
  if (highlighterInstance) return Promise.resolve(highlighterInstance);
  if (highlighterPromise) return highlighterPromise;
  highlighterPromise = createHighlighter({
    // github-dark-default (#0d1117 bg) matches the app's deep dark surface
    // better than github-dark (#24292e), so code blocks blend into the
    // stream instead of punching out as a brighter island. Its token
    // palette is also brighter/more saturated, improving legibility.
    themes: ["github-light", "github-dark-default"],
    langs: EAGER_LANGS,
  }).then((hl) => {
    highlighterInstance = hl;
    return hl;
  });
  return highlighterPromise;
}

function currentTheme(): BundledTheme {
  if (typeof document !== "undefined") {
    return document.documentElement.classList.contains("dark") ? "github-dark-default" : "github-light";
  }
  return "github-dark-default";
}

// ── Helpers ───────────────────────────────────────────────────────────

function extractText(node: unknown): string {
  if (node == null || node === false) return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(extractText).join("");
  if (typeof node === "object" && "props" in node) {
    return extractText((node as { props: { children?: unknown } }).props.children);
  }
  return "";
}

function extractLanguage(className?: string): string {
  const match = /language-(\w+)/.exec(className ?? "");
  return match?.[1] ?? "text";
}

function isFencedCode(className?: string): boolean {
  return /language-\w+/.test(className ?? "");
}

/** Minimal HTML entity escaping for the safe fallback path. */
function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ── Copy button ───────────────────────────────────────────────────────

/** Collapsed height of a fenced code block before the user clicks 展开
 *  (taller blocks preview-scroll inside this box). */
const CODE_COLLAPSE_MAX_PX = 360;

/** Link text (ui-refresh prototype `.prose a`): accent-strong ink over a
 *  faint accent underline that firms up on hover. */
const LINK_CLASS =
  "text-accent-strong underline decoration-accent/35 underline-offset-2 transition-colors hover:decoration-accent";

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const { t } = useI18n();
  return (
    <button
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        });
      }}
      className={cn(
        "inline-flex items-center gap-1 rounded px-1.5 py-0.5 transition-colors",
        "text-content-subtle hover:bg-surface-hover/60 hover:text-content-muted",
      )}
      title={t("chatStream.copyCode")}
    >
      {copied ? (<><IconCheck size={10} /> {t("common.copied")}</>) : (<><IconCopy size={10} /> {t("common.copy")}</>)}
    </button>
  );
}

// ── Rehype plugin: inline skill/command highlighting ──────────────────
//
// react-markdown v10 does NOT support a `text` component override — text
// nodes are passed through as raw strings by hast-util-to-jsx-runtime. So
// we intercept at the hast level: this plugin walks the tree, finds `text`
// nodes that contain `/skillName` references (outside code/pre), and
// replaces them with styled `<span class="skill-pill-inline">` element
// nodes. react-markdown then renders these normally.
//
// This is the standard unified/rehype pattern — the same approach used by
// rehype-katex, rehype-autolink-headings, etc.

/** Minimal hast node shape — we only need these three fields. */
interface HastNode {
  type: string;
  value?: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
}

/** True when the element is a `<code>` or `<pre>` — text inside should
 *  never be linkified. */
function isCodeElement(node: HastNode): boolean {
  return node.type === "element" && (node.tagName === "code" || node.tagName === "pre");
}

/** Split a text value by skill/command references, producing an array of
 *  text nodes and styled span elements that mirror the composer's skill
 *  pill (✦ glyph + /name in accent color). Returns [] when nothing matched,
 *  so the caller can keep the original node untouched. */
function transformTextBySkills(value: string, skillRe: RegExp): HastNode[] {
  skillRe.lastIndex = 0;
  const nodes: HastNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = skillRe.exec(value)) !== null) {
    const start = m.index;
    const name = m[1];
    if (start > last) {
      nodes.push({ type: "text", value: value.slice(last, start) });
    }
    nodes.push({
      type: "element",
      tagName: "span",
      properties: { className: ["skill-pill-inline"], title: `Skill: /${name}` },
      children: [
        {
          type: "element",
          tagName: "span",
          properties: { className: ["skill-pill-inline-glyph"], ariaHidden: true },
          children: [{ type: "text", value: "✦" }],
        },
        { type: "text", value: `/${name}` },
      ],
    });
    last = start + m[0].length;
  }
  if (nodes.length === 0) return []; // no match — caller keeps original
  if (last < value.length) {
    nodes.push({ type: "text", value: value.slice(last) });
  }
  return nodes;
}

/** Recursively walk hast children, replacing text nodes (outside code/pre)
 *  with skill-highlighted element nodes. Returns a new children array. */
function walkAndTransform(children: HastNode[], skillRe: RegExp, inCode: boolean): HastNode[] {
  const out: HastNode[] = [];
  for (const child of children) {
    if (child.type === "text" && !inCode && child.value && child.value.includes("/")) {
      const transformed = transformTextBySkills(child.value, skillRe);
      if (transformed.length > 0) {
        out.push(...transformed);
      } else {
        out.push(child);
      }
    } else if (child.type === "element" && child.children) {
      out.push({
        ...child,
        children: walkAndTransform(child.children, skillRe, inCode || isCodeElement(child)),
      });
    } else if (child.children) {
      out.push({ ...child, children: walkAndTransform(child.children, skillRe, inCode) });
    } else {
      out.push(child);
    }
  }
  return out;
}

/** Create a rehype plugin that highlights inline skill/command references.
 *  The plugin closes over `skillRe` so it can be recreated when the set of
 *  known skills changes. */
function rehypeSkillInline(skillRe: RegExp) {
  return function skillInlinePlugin() {
    return function transformer(tree: HastNode) {
      if (tree.children) {
        tree.children = walkAndTransform(tree.children, skillRe, false);
      }
    };
  };
}

// ── react-markdown component overrides ────────────────────────────────

/**
 * Project root of the session whose message is being rendered — consumed by
 * the `a`/`img` overrides to resolve local file links. A context (not a
 * `buildComponents` argument) keeps the components object identity stable
 * across project switches, so code-block collapse state survives.
 */
const MarkdownProjectContext = createContext<string | null>(null);

/**
 * Absolute directory that relative local paths in links/images resolve
 * against. Set ONLY by contexts that know the source file's location (the
 * IDE's .md preview passes the previewed file's directory); chat leaves it
 * null, so relative refs keep the search-based FileLink resolution and local
 * images render as chips instead of inline `<img>`.
 */
const MarkdownBaseDirContext = createContext<string | null>(null);

/**
 * Rehype plugin: group a run of 2+ images that share one paragraph into a
 * gallery container.
 *
 * `![a](1.png) ![b](2.png) ![c](3.png)` on consecutive lines is ONE markdown
 * paragraph, so without this the three pictures would flow as inline content
 * of a `<p>` — three differently-sized boxes wrapping like words. Replacing
 * that paragraph with `<div class="md-gallery">` lets the `div` override below
 * mount a {@link MarkdownGallery}, which renders an equal-width tile grid and
 * gives the lightbox ←/→ stepping across the whole run.
 *
 * Paragraphs that mix images with text are left alone — the text is part of the
 * sentence and must keep flowing with the picture.
 */
function rehypeImageGallery() {
  return function transformer(tree: HastNode) {
    const walk = (node: HastNode) => {
      if (!node.children) return;
      for (const child of node.children) {
        if (child.type !== "element") continue;
        if (child.tagName === "p") {
          const kids = child.children ?? [];
          const significant = kids.filter(
            (k) => !(k.type === "text" && (k.value ?? "").trim() === ""),
          );
          const images = significant.filter((k) => k.type === "element" && k.tagName === "img");
          if (images.length >= 2 && images.length === significant.length) {
            child.tagName = "div";
            child.properties = { ...(child.properties ?? {}), className: ["md-gallery"] };
            child.children = images;
            continue; // images have no element children worth walking
          }
        }
        walk(child);
      }
    };
    walk(tree);
  };
}

/** Elements whose text must never become a file chip. */
const NO_PATH_CHIP_TAGS = new Set(["code", "pre", "a", "kbd", "script", "style"]);

/**
 * Rehype plugin: file paths written in PLAIN prose become chips (TODO-022).
 *
 * Text nodes outside code / links are split by {@link splitProsePaths}; each
 * path turns into an EMPTY `<span data-mc-path>` element that the `span`
 * override below renders as a {@link FileChip}. The span carries the path as a
 * property and has no text children, so later text-walking plugins (the skill
 * highlighter matches `/name`, which a path like `src/pdf/x.ts` contains) have
 * nothing to rewrite inside it.
 */
function rehypePathChips() {
  return function transformer(tree: HastNode) {
    const walk = (children: HastNode[]): HastNode[] => {
      const out: HastNode[] = [];
      for (const child of children) {
        if (child.type === "text" && child.value) {
          const segs = splitProsePaths(child.value);
          if (!segs) {
            out.push(child);
            continue;
          }
          for (const s of segs) {
            if (s.kind === "text") out.push({ type: "text", value: s.text });
            else out.push({ type: "element", tagName: "span", properties: { dataMcPath: s.raw }, children: [] });
          }
          continue;
        }
        if (child.type === "element" && child.children && !NO_PATH_CHIP_TAGS.has(child.tagName ?? "")) {
          child.children = walk(child.children);
        }
        out.push(child);
      }
      return out;
    };
    if (tree.children) tree.children = walk(tree.children);
  };
}

/**
 * Preserve local-file paths in link/image URLs. react-markdown's default
 * sanitizer treats `D:/...` as an unknown protocol (`d`) and `file://` as
 * unsafe, rewriting BOTH to "" — the anchor then carries `href=""` and
 * clicking it re-opens the app's own origin (dev: http://localhost:5173/)
 * in the system browser via the main window's window-open guard. Web URLs
 * keep the default behavior (http/https/mailto preserved, `javascript:` etc.
 * stripped).
 */
function urlTransform(url: string): string {
  if (isLocalFileHref(url)) return url;
  return defaultUrlTransform(url);
}

/**
 * Vestigial: formerly consumed by the `text` component override (now removed)
 * to skip path linkification inside code. Code-context skipping now happens
 * in the `rehypeSkillInline` plugin via {@link isCodeElement}. Kept because
 * the `code`/`pre` overrides below still wrap children in a Provider (harmless).
 */
const CodeContext = createContext(false);
const useInCode = () => useContext(CodeContext);

/**
 * Build the react-markdown component overrides. Skill/command highlighting
 * is NOT done here — it's handled by the `rehypeSkillInline` rehype plugin
 * (see above), which operates at the hast level because react-markdown v10
 * does not call a `text` component override.
 */
function buildComponents(): Components {
  return {
  // Inline code - styled inline, no highlighting needed.
  code({ className, children }) {
    const isInline = !isFencedCode(className);
    const projectPath = useContext(MarkdownProjectContext);
    const baseDir = useContext(MarkdownBaseDirContext);
    // An inline span that is exactly a path renders as a file chip (TODO-022).
    // Only in chat: the .md preview (baseDir set) is a document, where code
    // spans are content the author formatted on purpose.
    const pathToken = isInline && !baseDir ? classifyInlinePath(extractText(children)) : null;
    if (pathToken) {
      return <FileChip token={pathToken} projectPath={projectPath} />;
    }
    if (isInline) {
      return (
        <code className="rounded border border-edge bg-surface-muted px-[5px] py-px font-mono [font-size:var(--chat-fs-xs)] [color:var(--code-fg)]">
          <CodeContext.Provider value={true}>{children}</CodeContext.Provider>
        </code>
      );
    }
    return <code className="font-mono"><CodeContext.Provider value={true}>{children}</CodeContext.Provider></code>;
  },

  // Fenced code block: highlighted via shiki with copy button + lang label.
  // Falls back to plain code when highlighting fails (unknown language etc.).
  pre({ children }) {
    const child = Array.isArray(children) ? children[0] : children;
    const childProps = (child as { props?: { className?: string; children?: unknown } })?.props;
    const className = childProps?.className ?? "";
    const rawCode = extractText(childProps?.children);
    const lang = resolveLang(extractLanguage(className));

    // Lazy-init highlighter on first encounter of a fenced block.
    const [ready, setReady] = useState(!!highlighterInstance);
    useMemo(() => {
      if (!highlighterInstance) {
        ensureHighlighter().then(() => setReady(true));
      }
    }, []);

    const html = useMemo(() => {
      if (!rawCode) return null;

      // Theme is part of the cache key so a theme switch (light↔dark, or a
      // theme-name change) invalidates stale HTML and re-highlights instead
      // of serving the wrong palette.
      const theme = currentTheme();
      const key = codeCacheKey(rawCode, lang, theme);
      // Cache hit?
      const cached = getCodeHtml(key);
      if (cached) return { __html: cached, key };

      // Highlighter ready?
      if (highlighterInstance) {
        // Helper: attempt highlighting with a given language, returning null
        // on any error instead of throwing.
        const tryHighlight = (tryLang: string): string | null => {
          try {
            return highlighterInstance!.codeToHtml(rawCode, {
              lang: tryLang,
              theme,
              transformers: [transformerNotationDiff()],
            });
          } catch {
            return null; // Language not found or other error — caller handles.
          }
        };

        // First attempt: requested language.
        let highlighted = tryHighlight(lang);
        // Fallback: "text" (always available, plain monospace).
        if (!highlighted && lang !== "text") {
          highlighted = tryHighlight("text");
        }
        if (highlighted) {
          setCodeHtml(key, highlighted);
          return { __html: highlighted, key };
        }
        // Both attempts failed — cache a safe placeholder.
        setCodeHtml(key, `<pre class="shiki fallback"><code>${escapeHtml(rawCode)}</code></pre>`);
      }

      return null; // Not ready yet or highlight failed — show raw text.
    }, [rawCode, lang, ready]);

    // Long code blocks are collapsed to a max-height preview with a 展开
    // overlay; clicking it (or the 收起 header button once expanded) toggles
    // full height. `clippable` is re-measured only while collapsed, so
    // streaming growth stays accurate and an expanded block's unbounded
    // scrollHeight never accidentally un-clips it.
    const { t } = useI18n();
    const [expanded, setExpanded] = useState(false);
    const [clippable, setClippable] = useState(false);
    const bodyRef = useRef<HTMLDivElement>(null);
    useLayoutEffect(() => {
      const el = bodyRef.current;
      if (!el || expanded) return;
      setClippable(el.scrollHeight > el.clientHeight + 1);
    }, [rawCode, lang, ready, html, expanded]);

    return (
      <pre className="my-[var(--chat-md-gap-md)] overflow-hidden rounded-xl border border-edge bg-surface-muted">
        <div className="flex h-[34px] items-center justify-between gap-2 border-b border-edge pl-3 pr-1.5 text-content-subtle [font-size:var(--chat-fs-xxs)]">
          <span className="truncate font-mono">{lang}</span>
          <span className="flex shrink-0 items-center gap-1">
            {clippable && expanded && (
              <button
                onClick={() => setExpanded(false)}
                className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 transition-colors hover:bg-surface-hover/60 hover:text-content-muted"
                title={t("chatStream.code.collapse")}
              >
                <IconChevronUp size={10} /> {t("chatStream.code.collapse")}
              </button>
            )}
            <CopyButton text={rawCode.replace(/\n$/, "")} />
          </span>
        </div>
        <div className="relative">
          <div
            ref={bodyRef}
            className="overflow-auto"
            style={{ maxHeight: expanded ? undefined : CODE_COLLAPSE_MAX_PX }}
          >
            {html ? (
              <div className="px-3.5 py-3 [font-size:var(--chat-fs-xs)]" dangerouslySetInnerHTML={html} />
            ) : (
              <code className="block px-3.5 py-3 font-mono leading-relaxed text-content [font-size:var(--chat-fs-xs)]">
                {childProps?.children as React.ReactNode}
              </code>
            )}
          </div>
          {clippable && !expanded && (
            <>
              <div className="pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-gradient-to-t from-surface-muted/90 to-transparent" />
              <button
                onClick={() => setExpanded(true)}
                className="absolute bottom-1.5 left-1/2 inline-flex -translate-x-1/2 items-center gap-1 rounded-full border border-edge bg-surface px-2.5 py-0.5 text-content-muted shadow-sm transition-colors hover:bg-surface-hover hover:text-content"
                title={t("chatStream.code.expand")}
              >
                <IconChevronDown size={12} /> {t("chatStream.code.expand")}
              </button>
            </>
          )}
        </div>
      </pre>
    );
  },

  a({ children, href }) {
    const projectPath = useContext(MarkdownProjectContext);
    const baseDir = useContext(MarkdownBaseDirContext);
    const raw = (href ?? "").trim();
    // Sanitized-away href (e.g. `javascript:`): an `<a href="">` would navigate
    // the app's own origin on click — render a non-navigating span instead.
    if (!raw) {
      return <span className={LINK_CLASS}>{children}</span>;
    }
    // Local file path (drive-letter / file:// / scheme-less): resolve and open
    // in the IDE instead of navigating — see fileLink.ts. In a base-dir
    // context (md preview) relative refs resolve against the previewed file's
    // directory so the exact sibling file opens instead of a search match.
    if (isLocalFileHref(raw)) {
      const path = fileHrefToPath(raw);
      const token =
        baseDir && !isAbsolutePath(path) ? resolveRelativePath(baseDir, path) : path;
      return (
        <FileLink
          token={token}
          projectPath={projectPath}
          asLink
          display={<span className={LINK_CLASS}>{children}</span>}
        />
      );
    }
    return (
      <a href={href} target="_blank" rel="noreferrer" className={LINK_CLASS}>
        {children}
      </a>
    );
  },
  // Local-path images can't be loaded by the webview (drive-letter "scheme"
  // / file:// / relative refs are not fetchable). With a base directory (md
  // preview) resolve against it and render inline via file.readBinary; in
  // chat (no base dir) render a clickable file chip that opens the IDE's
  // image preview. Web images pass through untouched.
  img({ src, alt }) {
    const projectPath = useContext(MarkdownProjectContext);
    const baseDir = useContext(MarkdownBaseDirContext);
    const raw = (src ?? "").trim();
    if (isLocalFileHref(raw)) {
      const path = fileHrefToPath(raw);
      // Relative refs resolve against the preview file's directory (.md
      // preview) or, in chat, the session's project root — the model writes
      // `![hero](outputs/splash/hero.png)` relative to the cwd it works in.
      // Main's readBinary guard still refuses anything outside known roots.
      const root = baseDir ?? projectPath;
      const absolute = root && !isAbsolutePath(path) ? resolveRelativePath(root, path) : path;
      // Inline the picture whenever we have an absolute path to a displayable
      // format — chat included (TODO-022). A path we can't resolve (a relative
      // ref with no root) or a format an <img> can't show keeps the clickable
      // chip, which at least opens in the editor.
      if (isAbsolutePath(absolute) && isInlineImagePath(absolute)) {
        return <MarkdownLocalImage filePath={absolute} alt={alt ?? ""} />;
      }
      return (
        <span className="my-[var(--chat-md-gap-xs)] inline-flex max-w-full items-center gap-1 rounded border border-edge/60 bg-surface-muted/60 px-1.5 py-0.5 align-middle text-content-muted [font-size:var(--chat-fs-xs)]">
          <FileLink
            token={absolute}
            projectPath={projectPath}
            display={alt ? <span className={LINK_CLASS}>{alt}</span> : undefined}
          />
        </span>
      );
    }
    // Remote picture: rendered as a placeholder with a load button. A bare
    // <img src="https://…"> would be blocked by the window CSP anyway (and we
    // do not want reading a reply to ping a host the model quoted).
    if (/^https?:\/\//i.test(raw)) {
      return <MarkdownRemoteImage src={raw} alt={alt ?? ""} />;
    }
    return <img src={src} alt={alt ?? ""} />;
  },
  // Spans come from our own rehype plugins only (raw HTML is escaped): skill
  // pills pass through untouched, `data-mc-path` spans become file chips.
  span({ node, children, ...rest }) {
    const projectPath = useContext(MarkdownProjectContext);
    const raw = node?.properties?.dataMcPath;
    if (typeof raw === "string") {
      const token = classifyInlinePath(raw);
      return token ? <FileChip token={token} projectPath={projectPath} /> : <>{raw}</>;
    }
    return <span {...rest}>{children}</span>;
  },
  // `div` only ever appears here because `rehypeImageGallery` created one (the
  // markdown pipeline escapes raw HTML), so the className check is a safe way
  // to mount the gallery provider.
  div({ className, children }) {
    if (typeof className === "string" && className.includes("md-gallery")) {
      return <MarkdownGallery>{children}</MarkdownGallery>;
    }
    return <div className={className}>{children}</div>;
  },
  ul({ children }) {
    return <ul className="my-[var(--chat-md-gap-sm)] list-disc space-y-[var(--chat-md-gap-xs)] pl-5 text-content-muted marker:text-content-subtle">{children}</ul>;
  },
  ol({ children }) {
    return <ol className="my-[var(--chat-md-gap-sm)] list-decimal space-y-[var(--chat-md-gap-xs)] pl-5 text-content-muted marker:text-content-subtle">{children}</ol>;
  },
  blockquote({ children }) {
    return <blockquote className="my-[var(--chat-md-gap-md)] border-l-2 border-edge pl-3 text-content-muted">{children}</blockquote>;
  },
  hr() {
    // Model-emitted "---". Without an override the browser default renders
    // (border: 1px inset + 0.5em margins) — a faint double line with
    // unpredictable spacing that reads as an unexplained gap on dark surfaces.
    return <hr className="my-[var(--chat-md-gap-md)] border-0 border-t border-edge" />;
  },
  // Bold is full --content: in paragraphs that matches the body color (weight
  // alone marks emphasis); in muted contexts (lists / tables / blockquotes) the
  // extra brightness keeps emphasized words legible. Dark chat lists soften
  // that jump via the `.dark .chat-md li strong` rule in styles.css — see the
  // "Chat markdown list lift" block there for the rationale.
  strong({ children }) {
    return <strong className="text-content">{children}</strong>;
  },
  // Table sizing is content-first: `w-full` + auto layout squeezed text-heavy
  // columns to per-word vertical strips on narrow panes (and stretched sparse
  // tables to full width). max-content lets every column take its natural
  // width, min-width:100% keeps sparse tables filling the column (previous
  // look), and the per-cell max-width cap makes long prose wrap at a readable
  // measure instead of rendering one enormous unbroken line. The overflow-x-auto
  // wrapper scrolls whatever still exceeds the pane, and carries the rounded
  // frame (ui-refresh `.prose table`): rows split by hairlines, no column rules.
  table({ children }) {
    return (
      <div className="my-[var(--chat-md-gap-md)] overflow-x-auto rounded-xl border border-edge">
        <table className="[width:max-content] [min-width:100%] border-collapse [font-size:var(--chat-fs-sm)] [&_tr:last-child>td]:border-b-0">{children}</table>
      </div>
    );
  },
  th({ children }) {
    return <th className="max-w-[32ch] border-b border-edge bg-surface-muted px-3 py-2 text-left font-medium text-content-muted [font-size:var(--chat-fs-xs)]">{children}</th>;
  },
  td({ children }) {
    return <td className="max-w-[32ch] border-b border-edge px-3 py-2 text-content">{children}</td>;
  },
  // Headings stay at 600 (the type scale's heaviest weight): h1 one step up,
  // h2 / h3 share the 16px reply-subheading size.
  h1({ children }) {
    return <h1 className="mb-[var(--chat-md-gap-md)] mt-[var(--chat-md-gap-lg)] font-semibold text-content [font-size:var(--chat-fs-lg)]">{children}</h1>;
  },
  h2({ children }) {
    return <h2 className="mb-[var(--chat-md-gap-sm)] mt-[var(--chat-md-gap-lg)] font-semibold text-content [font-size:var(--chat-fs-heading)]">{children}</h2>;
  },
  h3({ children }) {
    return <h3 className="mb-[var(--chat-md-gap-xs)] mt-[var(--chat-md-gap-md)] font-semibold text-content [font-size:var(--chat-fs-heading)]">{children}</h3>;
  },
  };
}

// ── LaTeX normalization helper ────────────────────────────────────────
/**
 * Normalize LaTeX math delimiters in raw markdown:
 * - `\[ ... \]` -> `$$ ... $$` (standard block math)
 * - `\( ... \)` -> `$ ... $`   (standard inline math)
 * - Lone lines like `[ \rho ... ]` or `[ x(t) = ... \rho ... ]` where the model omitted
 *   the leading backslash but contained LaTeX syntax commands (`\rho`, `\alpha`, `\frac`, etc.)
 *
 * Models frequently emit `\[ ... \]` or naked `[ \command ... ]` instead of `$$...$$`.
 * `remark-math` only recognizes dollar-sign delimiters by default. Normalizing before
 * remark-math ensures KaTeX renders them.
 *
 * Guarded against code blocks (fenced ``` or indented) and backtick inline code.
 */
function normalizeMathDelimiters(content: string): string {
  if (!content) return content;

  // Split by code blocks (```...```) and inline code (`...`) so we never touch math-like syntax inside code
  const parts = content.split(/(```[\s\S]*?```|`[^`\n]*`)/g);

  return parts
    .map((part, idx) => {
      // Odd indices are code fences or inline code spans
      if (idx % 2 === 1) return part;

      let res = part;
      // 1. Standard LaTeX block math: \[ math \] -> $$ math $$
      res = res.replace(/\\\[([\s\S]*?)\\\]/g, (_, math) => `$$\n${math.trim()}\n$$`);
      // 2. Standard LaTeX inline math: \( math \) -> $math$
      res = res.replace(/\\\(([\s\S]*?)\\\)/g, (_, math) => `$${math.trim()}$`);

      // 3. Fallback: Standalone line or block like `[ x(t) = ... \rho ... ]` where the
      // leading backslash was omitted or stripped by model/markdown, but contains LaTeX commands (\rho, \frac, etc.)
      const lines = res.split("\n");
      const mappedLines = lines.map((line) => {
        const trimmed = line.trim();
        if (
          trimmed.startsWith("[") &&
          trimmed.endsWith("]") &&
          !trimmed.endsWith("](") &&
          /\\[a-zA-Z]/.test(trimmed)
        ) {
          const inner = trimmed.slice(1, -1).trim();
          return `$$\n${inner}\n$$`;
        }
        return line;
      });
      res = mappedLines.join("\n");

      return res;
    })
    .join("");
}

export const Markdown = memo(function Markdown({
  children,
  projectPath,
  skillNames,
  baseDir,
}: {
  children: string;
  /** Project root — reserved for future inline file-path linkification.
   *  Currently unused (the feature was in the dead `text` override; see the
   *  rehype plugin section for the replacement strategy). */
  projectPath?: string | null;
  /** Names of skills/commands that should be highlighted when they appear as
   *  `/name` in this text. Passed to the `rehypeSkillInline` plugin which
   *  transforms matching text nodes at the hast level. */
  skillNames?: ReadonlyArray<string>;
  /** Absolute directory that relative local paths in links/images resolve
   *  against (the previewed .md file's directory). When set, local images
   *  render INLINE (loaded via file.readBinary) and relative links open the
   *  exact sibling file; leave unset for chat output. */
  baseDir?: string | null;
}) {
  // Build a single regex matching any known `/skillName` at its boundary.
  // Sorted longest-first so a skill named `pdf` doesn't shadow `pdf-generator`.
  const skillRe = useMemo(() => {
    if (!skillNames || skillNames.length === 0) return null;
    const escaped = skillNames
      .map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .sort((a, b) => b.length - a.length);
    return new RegExp(`/(${escaped.join("|")})(?![A-Za-z0-9_-])`, "g");
  }, [skillNames]);
  const components = useMemo(() => buildComponents(), []);
  // rehype-katex is always active; the skill-inline plugin is added only when
  // we have known skill names to highlight. Recreated when `skillRe` changes
  // (i.e. when the skills list updates), so react-markdown re-parses.
  // Path chips run BEFORE the skill highlighter (so a path's `/segment` is
  // never mistaken for a skill) and only in chat — the .md preview (baseDir
  // set) is a document whose prose should stay prose.
  const chatChips = !baseDir;
  const normalizedChildren = useMemo(() => normalizeMathDelimiters(children), [children]);
  const rehypePlugins = useMemo(() => {
    const list: NonNullable<Parameters<typeof ReactMarkdown>[0]["rehypePlugins"]> = [rehypeKatex, rehypeImageGallery];
    if (chatChips) list.push(rehypePathChips);
    if (skillRe) list.push(rehypeSkillInline(skillRe));
    return list;
  }, [skillRe, chatChips]);
  // Block margins + line-height here are density-driven (--chat-md-gap-* /
  // --chat-md-leading, see the chat-density section in styles.css) so the
  // 对话紧凑度 setting shapes the reply body itself, not just the gaps
  // between message rows.
  //
  // Flush edges: the first/last CHILD's own margin is zeroed so this block's
  // boundary sits flush with whatever container gap surrounds it. Without
  // this, a first/last <p> (or list/code block) margin collapses OUT of this
  // div — it has no padding/border/BFC — and max()-collapses with the
  // container's row/block gap, so identical seams render at different heights
  // depending on where the block boundary falls. Internal paragraph margins
  // are untouched; the container alone controls the outer rhythm.
  return (
    <div
      className="chat-md break-words text-content [font-size:var(--chat-font-size)] [line-height:var(--chat-md-leading)] [font-weight:var(--chat-font-weight)] [&>p]:my-[var(--chat-md-gap-sm)] [&>:first-child]:mt-0 [&>:last-child]:mb-0"
    >
      <MarkdownProjectContext.Provider value={projectPath ?? null}>
        <MarkdownBaseDirContext.Provider value={baseDir ?? null}>
          <ReactMarkdown
            remarkPlugins={[remarkGfm, remarkMath]}
            rehypePlugins={rehypePlugins}
            urlTransform={urlTransform}
            components={components}
          >
            {normalizedChildren}
          </ReactMarkdown>
        </MarkdownBaseDirContext.Provider>
      </MarkdownProjectContext.Provider>
    </div>
  );
});
