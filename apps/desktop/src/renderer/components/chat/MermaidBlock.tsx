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
import { fitMermaidSource, hslToRgb } from "@renderer/lib/themeColor.js";
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

/**
 * Categorical hues for the diagram types that DRAW DATA: pie slices, xychart
 * bars/lines, git branches, quadrant zones. Depth is held constant per theme
 * and the hue carries the series identity — the same split `themeColor.ts`
 * uses for cards, except that charts sit at a stronger contrast than a card
 * ground (a slice has to be distinguishable from its neighbour, not just from
 * the page). Twelve hues so mermaid's full 12-colour scale is covered.
 */
const SERIES_HUES = [205, 158, 268, 32, 340, 188, 12, 100, 292, 48, 232, 128] as const;
const SERIES_TONE = { light: { s: 0.52, l: 0.72 }, dark: { s: 0.46, l: 0.45 } } as const;

/** One series colour. Emitted as `rgb()` (not the `hsl()` we computed from)
 *  because mermaid runs `darken`/`lighten`/`mkBorder` over these values, and
 *  its colour library is happier with the rgb form than with CSS Color 4's
 *  space-separated hsl(). */
function seriesColor(index: number, dark: boolean): string {
  const tone = SERIES_TONE[dark ? "dark" : "light"];
  const { r, g, b } = hslToRgb(SERIES_HUES[index % SERIES_HUES.length], tone.s, tone.l);
  return `rgb(${r} ${g} ${b})`;
}

/** Quadrant zones are large areas, so they get the CARD treatment instead of
 *  the series treatment: hue varies, lightness is pinned to the theme's fill
 *  band, and four quadrants never read as four different materials. */
function quadrantTint(index: number, dark: boolean): string {
  const { r, g, b } = hslToRgb(SERIES_HUES[index % SERIES_HUES.length], dark ? 0.3 : 0.5, dark ? 0.17 : 0.965);
  return `rgb(${r} ${g} ${b})`;
}

function themeVariables(dark: boolean): Record<string, unknown> {
  const p = readPalette(dark);
  // Text sitting ON the accent fill: the accent is light in dark mode and
  // mid-tone in light mode, so the legible partner flips with the theme.
  const onAccent = dark ? p.surface : p.content;
  const series = SERIES_HUES.map((_, index) => seriesColor(index, dark));
  // Mermaid's base theme derives every data colour from `primaryColor`, which
  // we set to the app's near-neutral surface — so a pie chart would otherwise
  // come out as a GRAY ramp (`cScale0..11` are a greyscale ladder in the base
  // theme). Writing `cScaleN` is what corrects it: mermaid fills each slot with
  // `x = x || default`, i.e. our value survives its own derivation.
  //
  // `pieN` needs the opposite treatment. Its `updateColors()` ends with an
  // UNCONDITIONAL `pie[i] = cScale[i]` for i < 12, so any `pie0..pie11` we set
  // is overwritten — deriving the pie palette from `cScale` is the only way to
  // colour it. And because the pie renderer reads `pie1..pie12` while the loop
  // only fills `pie0..pie11`, `pie12` is the single slot NOTHING assigns: left
  // alone it is `undefined`, and the 12th slice of a 12-slice pie draws with no
  // fill at all. It is also the only `pieN` an override can win, since the loop
  // never touches it.
  const seriesVars: Record<string, string> = {};
  series.forEach((color, index) => {
    seriesVars[`cScale${index}`] = color;
    // Labels drawn on a series colour: our tones sit at 72% lightness (light)
    // and 45% (dark), so the app's own text colour is the legible partner in
    // both themes.
    seriesVars[`cScaleLabel${index}`] = p.content;
  });
  // pie1..pie11 come from cScale1..cScale11 (H1..H11); this supplies H0, which
  // the offset leaves unused, so twelve slices still get twelve distinct hues.
  seriesVars.pie12 = series[0];
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

    // data diagrams — the categorical scale, see SERIES_HUES
    ...seriesVars,
    pieTitleTextColor: p.content,
    pieSectionTextColor: p.content,
    pieLegendTextColor: p.content,
    // 1px of surface between slices: two neighbouring hues at the same
    // lightness are otherwise hard to tell apart at the boundary.
    pieStrokeColor: p.surface,
    pieStrokeWidth: "1px",
    pieOpacity: "1",

    // quadrant — zones are large areas, so they use the card bands
    quadrant1Fill: quadrantTint(0, dark),
    quadrant2Fill: quadrantTint(1, dark),
    quadrant3Fill: quadrantTint(2, dark),
    quadrant4Fill: quadrantTint(3, dark),
    quadrant1TextFill: p.content,
    quadrant2TextFill: p.content,
    quadrant3TextFill: p.content,
    quadrant4TextFill: p.content,
    quadrantPointFill: p.content,
    quadrantPointTextFill: p.surface,
    quadrantXAxisTextFill: p.contentMuted,
    quadrantYAxisTextFill: p.contentMuted,
    quadrantInternalBorderStrokeFill: p.edge,
    quadrantExternalBorderStrokeFill: p.edge,
    quadrantTitleFill: p.content,

    // xychart-beta: mermaid REPLACES this nested object with whatever it is
    // given (after filling in its own defaults), so every key it reads has to
    // be present — a partial object would blank the axes. Keys mirror the base
    // theme in mermaid 11.17; keep them in sync when the dependency moves.
    xyChart: {
      backgroundColor: "transparent",
      titleColor: p.content,
      dataLabelColor: p.contentMuted,
      legendTextColor: p.contentMuted,
      xAxisTitleColor: p.contentMuted,
      xAxisLabelColor: p.contentMuted,
      xAxisTickColor: p.contentSubtle,
      xAxisLineColor: p.edge,
      yAxisTitleColor: p.contentMuted,
      yAxisLabelColor: p.contentMuted,
      yAxisTickColor: p.contentSubtle,
      yAxisLineColor: p.edge,
      plotColorPalette: series.join(","),
    },
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

type MermaidLook = "classic" | "handDrawn" | "neo";

/**
 * Mermaid supports an `%%{init: ...}%%` directive at the top of a diagram.
 * Let the model choose the visual stroke style, but keep the app's theme,
 * security level, fonts and external-resource policy authoritative. Unknown
 * init keys are discarded and the directive is rewritten to the small safe
 * subset before Mermaid sees it.
 */
function normalizeMermaidInit(source: string): { renderSource: string; look: MermaidLook } {
  const lines = source.split("\n");
  const first = lines[0] ?? "";
  const match = /^\s*%%\s*\{\s*init\s*:\s*(\{.*\})\s*\}\s*%%\s*$/i.exec(first);
  if (!match) return { renderSource: source, look: "classic" };

  let config: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(match[1]);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { renderSource: lines.slice(1).join("\n"), look: "classic" };
    }
    config = parsed as Record<string, unknown>;
  } catch {
    // An invalid init directive should not make an otherwise valid diagram
    // fail; drop it and let Mermaid parse the diagram body.
    return { renderSource: lines.slice(1).join("\n"), look: "classic" };
  }

  const look = config.look === "handDrawn" || config.look === "neo" || config.look === "classic"
    ? config.look
    : "classic";
  const safe: Record<string, unknown> = { look };
  if (look === "handDrawn" && Number.isInteger(config.handDrawnSeed)) {
    const seed = Number(config.handDrawnSeed);
    if (seed >= 0 && seed <= 1_000_000) safe.handDrawnSeed = seed;
  }
  lines[0] = `%%{init: ${JSON.stringify(safe)}}%%`;
  return { renderSource: lines.join("\n"), look };
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
  const normalized = normalizeMermaidInit(source);
  // What mermaid parses. Differs from `source` only in the colours the model
  // and the small safe visual-style directive: those are re-fitted or
  // normalized for the theme in play (see lib/themeColor.ts). The user still
  // sees and copies the ORIGINAL source — the toggle and copy button use
  // `source`.
  const renderSource = fitMermaidSource(normalized.renderSource, themeSignature.startsWith("dark"));
  const tooLarge = source.length > MAX_SOURCE_CHARS;

  const [state, setState] = useState<RenderState>(() => {
    const cached = getMermaidSvg(mermaidCacheKey(renderSource, themeSignature));
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
    const key = mermaidCacheKey(renderSource, themeSignature);
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
          const { svg } = await mermaid.render(id, renderSource);
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
  }, [renderSource, themeSignature, tooLarge]);

  const failed = state.status === "error" || tooLarge;
  const sourceVisible = showSource || failed;

  return (
    <div
      data-mermaid
      data-mermaid-look={normalized.look}
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
