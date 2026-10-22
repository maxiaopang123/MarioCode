/**
 * Mermaid diagram block — the renderer for ```` ```mermaid ```` fenced code.
 *
 * Why a separate component (and a lazy import)
 * --------------------------------------------
 * `mermaid` is ~1 MB of ESM (d3, dagre, the sequence/gantt/pie parsers). It is
 * pulled in with a dynamic `import()` the first time a diagram is actually
 * seen, the same trick `Markdown.tsx` already uses for Shiki — a session that
 * never draws a diagram never pays for one. It also keeps `Markdown.tsx` a
 * thin dispatcher: the plain code-block renderer keeps all of its hooks, so
 * react-markdown never has to reconcile a component whose hook count depends
 * on which fenced language it happens to be looking at.
 *
 * Streaming
 * ---------
 * Chat markdown is re-parsed progressively (`useDeferredValue` in
 * MessageBlocks), so a fenced block is handed to us many times while the model
 * is still writing it. Mermaid throws on an unterminated source, so we only
 * attempt a parse once the source has been STABLE for {@link SETTLE_MS} — and
 * while a re-render is pending the previous SVG stays on screen, so a diagram
 * does not blink out on every token.
 *
 * Security
 * --------
 * `securityLevel: "strict"` is what makes it safe to hand the produced SVG to
 * the DOM: labels are escaped, `click` handlers and `javascript:` links are
 * rejected, and mermaid runs its own DOMPurify pass over HTML labels. The
 * source is model output, and the SVG we insert is generated from it by
 * mermaid — never model-authored markup.
 */
import { memo, useEffect, useRef, useState } from "react";
import { cn } from "@renderer/lib/cn.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { IconAlertTriangle, IconChevronDown, IconChevronUp, IconLoader2, IconPhoto } from "@renderer/lib/icons.js";
import { getMermaidSvg, mermaidCacheKey, setMermaidSvg } from "@renderer/lib/markdownCache.js";
import { useThemeSignature } from "@renderer/lib/theme.js";
import { CopyButton } from "./CopyButton.js";

/**
 * Source ceiling. Mermaid lays out on the renderer's main thread; a runaway
 * block (a model pasting a generated suite of diagrams into one fence) would
 * freeze the UI for seconds. Past this the source is shown as code instead —
 * still readable, still copyable.
 */
const MAX_SOURCE_CHARS = 60_000;

/** How long the source must stay unchanged before a parse is attempted. */
const SETTLE_MS = 320;

type MermaidApi = (typeof import("mermaid"))["default"];

let mermaidPromise: Promise<MermaidApi> | null = null;
/**
 * Mermaid keeps its configuration in module state, so `initialize` has to be
 * re-run whenever the palette changes. Tracked as the theme SIGNATURE (not a
 * boolean): the app has four palettes — light/dark × warm/neutral — and two of
 * them share a `.dark` class.
 */
let initialisedSignature: string | null = null;

/** Unique suffix for mermaid's scratch node ids (mermaid renders into a
 *  temporary element keyed by the id we pass, and it must not collide across
 *  concurrently mounting diagrams). */
let renderSeq = 0;

const FONT_FAMILY = "ui-sans-serif, system-ui, 'Segoe UI', 'Microsoft YaHei', sans-serif";

/**
 * Mermaid bakes the palette into the SVG it emits — there is no stylesheet
 * hook that would let the app theme it afterwards. So the colours have to be
 * handed to it, and the only correct source is the LIVE stylesheet: styles.css
 * keeps bare RGB triplets per token (so Tailwind can add alpha), and the warm
 * tone plus both themes mean the same token resolves to four different values.
 * Reading them at init time picks up whichever is active, no duplication.
 */
const TOKEN_VARS = {
  surface: "--surface",
  surfaceMuted: "--surface-muted",
  content: "--content",
  contentMuted: "--content-muted",
  contentSubtle: "--content-subtle",
  edge: "--edge",
  accent: "--accent",
} as const;

type PaletteToken = keyof typeof TOKEN_VARS;
type Palette = Record<PaletteToken, string>;

/** Stock values, used only if a token is missing (a stylesheet edit mid-flight
 *  or a detached document). Never the primary source. */
const FALLBACK_PALETTE: Record<"light" | "dark", Palette> = {
  light: {
    surface: "rgb(255 255 255)",
    surfaceMuted: "rgb(243 243 241)",
    content: "rgb(26 26 25)",
    contentMuted: "rgb(82 82 78)",
    contentSubtle: "rgb(112 112 107)",
    edge: "rgb(228 228 225)",
    accent: "rgb(217 119 87)",
  },
  dark: {
    surface: "rgb(24 25 24)",
    surfaceMuted: "rgb(32 33 32)",
    content: "rgb(236 236 233)",
    contentMuted: "rgb(168 168 163)",
    contentSubtle: "rgb(134 134 129)",
    edge: "rgb(40 41 39)",
    accent: "rgb(229 138 99)",
  },
};

function readPalette(dark: boolean): Palette {
  const style = getComputedStyle(document.documentElement);
  const palette: Palette = { ...FALLBACK_PALETTE[dark ? "dark" : "light"] };
  for (const token of Object.keys(TOKEN_VARS) as PaletteToken[]) {
    const triplet = style.getPropertyValue(TOKEN_VARS[token]).trim();
    // "24 25 24" → "rgb(24 25 24)"; CSS parses the same triplet as Tailwind's
    // `<alpha-value>` placeholder does.
    if (triplet) palette[token] = `rgb(${triplet})`;
  }
  return palette;
}

function themeVariables(dark: boolean): Record<string, string | boolean> {
  const p = readPalette(dark);
  // Text sitting ON the accent fill: the accent is light in dark mode and
  // mid-tone in light mode, so the legible partner flips with the theme.
  const onAccent = dark ? p.surface : p.content;
  return {
    darkMode: dark,
    // The block already paints itself with `bg-surface-muted`; a second
    // opaque rect from mermaid would fight the chat's own surface.
    background: "transparent",
    fontFamily: FONT_FAMILY,
    fontSize: "13px",

    // shared / flowchart
    primaryColor: p.surface,
    primaryTextColor: p.content,
    primaryBorderColor: p.edge,
    secondaryColor: p.surfaceMuted,
    secondaryTextColor: p.content,
    secondaryBorderColor: p.edge,
    tertiaryColor: p.surfaceMuted,
    tertiaryTextColor: p.content,
    tertiaryBorderColor: p.edge,
    mainBkg: p.surface,
    nodeBorder: p.edge,
    nodeTextColor: p.content,
    textColor: p.content,
    titleColor: p.content,
    lineColor: p.contentSubtle,
    edgeLabelBackground: p.surface,
    clusterBkg: p.surfaceMuted,
    clusterBorder: p.edge,

    // sequence
    actorBkg: p.surface,
    actorBorder: p.edge,
    actorTextColor: p.content,
    actorLineColor: p.contentSubtle,
    signalColor: p.contentMuted,
    signalTextColor: p.content,
    labelBoxBkgColor: p.surface,
    labelBoxBorderColor: p.edge,
    labelTextColor: p.content,
    loopTextColor: p.content,
    noteBkgColor: p.surfaceMuted,
    noteTextColor: p.content,
    noteBorderColor: p.edge,
    activationBkgColor: p.surfaceMuted,
    activationBorderColor: p.edge,

    // state
    labelColor: p.content,
    altBackground: p.surfaceMuted,

    // gantt
    sectionBkgColor: p.surfaceMuted,
    altSectionBkgColor: p.surface,
    gridColor: p.edge,
    taskBkgColor: p.surfaceMuted,
    taskBorderColor: p.edge,
    taskTextColor: p.content,
    taskTextDarkColor: p.content,
    taskTextOutsideColor: p.content,
    activeTaskBkgColor: p.accent,
    activeTaskBorderColor: p.accent,
    activeTaskTextColor: onAccent,
    doneTaskBkgColor: p.surfaceMuted,
    doneTaskBorderColor: p.edge,
    doneTaskTextColor: p.contentMuted,
    critBkgColor: p.accent,
    critBorderColor: p.accent,
    critTextColor: onAccent,

    // ER
    attributeBackgroundColorOdd: p.surface,
    attributeBackgroundColorEven: p.surfaceMuted,
  };
}

async function ensureMermaid(signature: string): Promise<MermaidApi> {
  mermaidPromise ??= import("mermaid").then((mod) => mod.default);
  const mermaid = await mermaidPromise;
  if (initialisedSignature !== signature) {
    const dark = signature.startsWith("dark");
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      // "base" is mermaid's only theme that renders OUR colours verbatim; its
      // own "dark"/"neutral" palettes are close in spirit but never land on the
      // app's surfaces, which makes a diagram read as a foreign object pasted
      // into the reply.
      theme: "base",
      darkMode: dark,
      fontFamily: FONT_FAMILY,
      themeVariables: themeVariables(dark),
      // useMaxWidth lets the SVG scale down to the message column instead of
      // forcing a horizontal scroll for every diagram wider than the pane.
      flowchart: { htmlLabels: true, useMaxWidth: true, curve: "basis" },
      sequence: { useMaxWidth: true },
      gantt: { useMaxWidth: true },
      journey: { useMaxWidth: true },
      class: { useMaxWidth: true },
      state: { useMaxWidth: true },
      er: { useMaxWidth: true },
    });
    initialisedSignature = signature;
  }
  return mermaid;
}

/** First line of a mermaid parse error, bounded — the full message is a
 *  multi-line dump of the offending source with a caret. */
function firstLine(message: string): string {
  const line = message.split("\n").find((part) => part.trim() !== "") ?? message;
  return line.length > 180 ? `${line.slice(0, 180)}…` : line;
}

type RenderState =
  | { status: "rendering" }
  | { status: "ready"; svg: string }
  | { status: "error"; message: string };

export const MermaidBlock = memo(function MermaidBlock({ code }: { code: string }) {
  const { t } = useI18n();
  // "dark|warm" / "light|neutral" … — also the cache key discriminator, since
  // the palette is baked into the SVG and must be re-rendered per theme.
  const themeSignature = useThemeSignature();
  // Trailing newline is an artifact of the fenced block, not the diagram.
  const source = code.replace(/\s+$/, "");
  const tooLarge = source.length > MAX_SOURCE_CHARS;

  const [state, setState] = useState<RenderState>(() => {
    const cached = getMermaidSvg(mermaidCacheKey(source, themeSignature));
    return cached ? { status: "ready", svg: cached } : { status: "rendering" };
  });
  const [showSource, setShowSource] = useState(false);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    if (tooLarge) return;
    const key = mermaidCacheKey(source, themeSignature);
    const cached = getMermaidSvg(key);
    if (cached) {
      setState({ status: "ready", svg: cached });
      return;
    }
    // Nothing cached: wait for the source to stop growing. An already-rendered
    // diagram stays visible while the new one is being prepared.
    setState((prev) => (prev.status === "ready" ? prev : { status: "rendering" }));
    let cancelled = false;
    const timer = setTimeout(() => {
      void (async () => {
        const id = `mc-mmd-${++renderSeq}`;
        try {
          const mermaid = await ensureMermaid(themeSignature);
          const { svg } = await mermaid.render(id, source);
          if (cancelled || !alive.current) return;
          setMermaidSvg(key, svg);
          setState({ status: "ready", svg });
        } catch (error) {
          // mermaid leaves its scratch node behind when parsing fails; left
          // alone these accumulate as invisible divs at the end of <body>.
          document.getElementById(id)?.remove();
          document.getElementById(`d${id}`)?.remove();
          if (cancelled || !alive.current) return;
          setState({
            status: "error",
            message: firstLine(error instanceof Error ? error.message : String(error)),
          });
        }
      })();
    }, SETTLE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [source, themeSignature, tooLarge]);

  const failed = state.status === "error" || tooLarge;
  const sourceVisible = showSource || failed;

  return (
    <div
      data-mermaid
      className="my-[var(--chat-md-gap-md)] overflow-hidden rounded-xl border border-edge bg-surface-muted"
    >
      <div className="flex h-[34px] items-center justify-between gap-2 border-b border-edge pl-3 pr-1.5 text-content-subtle [font-size:var(--chat-fs-xxs)]">
        <span className="flex min-w-0 items-center gap-1.5">
          <IconPhoto size={11} className="shrink-0" />
          <span className="truncate font-mono">mermaid</span>
        </span>
        <span className="flex shrink-0 items-center gap-1">
          <button
            onClick={() => setShowSource((value) => !value)}
            className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 transition-colors hover:bg-surface-hover/60 hover:text-content-muted"
            title={showSource ? t("chatStream.mermaid.diagram") : t("chatStream.mermaid.source")}
          >
            {showSource ? <IconChevronUp size={10} /> : <IconChevronDown size={10} />}
            {showSource ? t("chatStream.mermaid.diagram") : t("chatStream.mermaid.source")}
          </button>
          <CopyButton text={source} />
        </span>
      </div>

      {!failed && !showSource && state.status === "ready" && (
        <div
          className="mermaid-svg overflow-x-auto px-3.5 py-3"
          // Generated by mermaid from the (escaped) source under
          // securityLevel "strict" — see the module comment.
          dangerouslySetInnerHTML={{ __html: state.svg }}
        />
      )}

      {!failed && !showSource && state.status === "rendering" && (
        <div className="flex items-center gap-2 px-3.5 py-3 text-content-subtle [font-size:var(--chat-fs-xs)]">
          <IconLoader2 size={12} className="animate-spin" />
          {t("chatStream.mermaid.rendering")}
        </div>
      )}

      {failed && (
        <div className="flex items-start gap-2 border-b border-edge px-3.5 py-2 text-warning [font-size:var(--chat-fs-xs)]">
          <IconAlertTriangle size={12} className="mt-0.5 shrink-0" />
          <span className="min-w-0 break-words">
            {tooLarge ? t("chatStream.mermaid.tooLarge") : t("chatStream.mermaid.failed")}
            {state.status === "error" && (
              <span className="mt-0.5 block font-mono text-content-subtle">{state.message}</span>
            )}
          </span>
        </div>
      )}

      {sourceVisible && (
        <pre
          className={cn(
            "overflow-auto px-3.5 py-3 font-mono leading-relaxed text-content [font-size:var(--chat-fs-xs)]",
            "max-h-[360px]",
          )}
        >
          <code>{source}</code>
        </pre>
      )}
    </div>
  );
});
