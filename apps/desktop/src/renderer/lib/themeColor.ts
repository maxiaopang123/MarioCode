/**
 * Theme-fitting for colours that come from the MODEL, not from us.
 *
 * The problem this solves: a reply like
 *
 *     <div style="background:#ffffff;border:1px solid #eeeeee;color:#333">
 *
 * is written against the model's idea of a light page. In MarioCode's dark
 * theme it becomes a glaring white slab — and worse, a card that sets only
 * `background:#fff` keeps the inherited light text, so the content disappears.
 * The reverse happens in light theme with `background:#111;color:#eee`.
 *
 * Sanitizing alone cannot fix this: the renders are safe, just wrong-looking.
 * Nor can the prompt: the model cannot know which theme the reader is in, and
 * `prefers-color-scheme` inside the app is not something it can query.
 *
 * So the colour is reinterpreted in theme terms instead of trusted verbatim:
 *
 *  - FILLS (`background`, `background-color`, `border*`) keep their HUE and
 *    saturation (a red warning card stays red-ish) but their LIGHTNESS is
 *    snapped into the current theme's band — a near-white becomes a near-black
 *    inset in dark mode.
 *  - TEXT (`color`) is kept only when it is legible against the theme; when it
 *    is not (white on dark, near-black on light), the declaration is DROPPED so
 *    the element inherits the app's own text colour, which is guaranteed
 *    contrast-correct by styles.css.
 *
 * Deliberately conservative: values we cannot parse (`currentcolor`,
 * `transparent`, unknown keywords, `var(--x)`), and washes with alpha < 0.1
 * (shadows, faint tints) are left exactly as written — guessing there would
 * change intent without removing any risk.
 */

export interface Rgb {
  r: number;
  g: number;
  b: number;
  a: number;
}

/** The handful of CSS colour keywords models actually emit. Anything else is
 *  left to the browser (and to the contrast rules below, which simply cannot
 *  judge it). */
const NAMED_HEX: Record<string, string> = {
  white: "#ffffff",
  black: "#000000",
  silver: "#c0c0c0",
  gray: "#808080",
  grey: "#808080",
  darkgray: "#a9a9a9",
  darkgrey: "#a9a9a9",
  lightgray: "#d3d3d3",
  lightgrey: "#d3d3d3",
  dimgray: "#696969",
  dimgrey: "#696969",
  whitesmoke: "#f5f5f5",
  gainsboro: "#dcdcdc",
  snow: "#fffafa",
  ivory: "#fffff0",
  beige: "#f5f5dc",
  ghostwhite: "#f8f8ff",
};

/** One pass over a declaration value, picking out colour literals. Function
 *  forms are matched non-greedily to their own closing paren; keywords only as
 *  whole words (so `red` in `border` is not a colour match — it is preceded by
 *  word chars only when it is not). */
const COLOR_TOKEN =
  /#[0-9a-f]{3,8}\b|rgba?\([^()]*\)|hsla?\([^()]*\)|\b(?:white|black|silver|gray|grey|darkgray|darkgrey|lightgray|lightgrey|dimgray|dimgrey|whitesmoke|gainsboro|snow|ivory|beige|ghostwhite)\b/gi;

function hexToRgb(hex: string): Rgb | null {
  let body = hex.slice(1);
  if (body.length === 3 || body.length === 4) {
    body = body
      .split("")
      .map((char) => char + char)
      .join("");
  }
  if (body.length !== 6 && body.length !== 8) return null;
  const r = Number.parseInt(body.slice(0, 2), 16);
  const g = Number.parseInt(body.slice(2, 4), 16);
  const b = Number.parseInt(body.slice(4, 6), 16);
  const a = body.length === 8 ? Number.parseInt(body.slice(6, 8), 16) / 255 : 1;
  if ([r, g, b].some((channel) => Number.isNaN(channel))) return null;
  return { r, g, b, a };
}

/** `rgb(1, 2, 3)`, `rgb(1 2 3)`, `rgb(1 2 3 / 50%)`, `rgba(1,2,3,.5)` — the
 *  percentages `rgb()` also accepts are handled because models copy them from
 *  design docs. */
function rgbFunctionToRgb(value: string): Rgb | null {
  const inner = value.replace(/^rgba?\(/i, "").replace(/\)$/, "");
  const [channels, alphaPart] = inner.split("/");
  const parts = channels.replace(/,/g, " ").trim().split(/\s+/).filter(Boolean);
  if (parts.length < 3) return null;
  const channel = (part: string): number => {
    if (part.endsWith("%")) return Math.round((Number.parseFloat(part) / 100) * 255);
    return Number.parseFloat(part);
  };
  const [r, g, b] = parts.slice(0, 3).map(channel);
  if ([r, g, b].some((value) => Number.isNaN(value))) return null;
  // Alpha can be the 4th comma-separated arg or the `/` tail.
  const alphaToken = alphaPart ?? parts[3];
  let a = 1;
  if (alphaToken !== undefined) {
    const parsed = alphaToken.trim();
    a = parsed.endsWith("%")
      ? Number.parseFloat(parsed) / 100
      : Number.parseFloat(parsed);
    if (Number.isNaN(a)) a = 1;
  }
  return { r, g, b, a: Math.min(1, Math.max(0, a)) };
}

function hslToRgb(h: number, s: number, l: number): { r: number; g: number; b: number } {
  const chroma = (1 - Math.abs(2 * l - 1)) * s;
  const hp = ((h % 360) + 360) % 360 / 60;
  const x = chroma * (1 - Math.abs((hp % 2) - 1));
  const [r1, g1, b1] =
    hp < 1
      ? [chroma, x, 0]
      : hp < 2
        ? [x, chroma, 0]
        : hp < 3
          ? [0, chroma, x]
          : hp < 4
            ? [0, x, chroma]
            : hp < 5
              ? [x, 0, chroma]
              : [chroma, 0, x];
  const m = l - chroma / 2;
  return {
    r: Math.round((r1 + m) * 255),
    g: Math.round((g1 + m) * 255),
    b: Math.round((b1 + m) * 255),
  };
}

function hslFunctionToRgb(value: string): Rgb | null {
  const inner = value.replace(/^hsla?\(/i, "").replace(/\)$/, "");
  const [channels, alphaPart] = inner.split("/");
  const parts = channels.replace(/,/g, " ").trim().split(/\s+/).filter(Boolean);
  if (parts.length < 3) return null;
  const h = Number.parseFloat(parts[0]);
  const s = Number.parseFloat(parts[1]) / (parts[1].endsWith("%") ? 100 : 1);
  const l = Number.parseFloat(parts[2]) / (parts[2].endsWith("%") ? 100 : 1);
  if ([h, s, l].some((part) => Number.isNaN(part))) return null;
  const alphaToken = alphaPart ?? parts[3];
  const a = alphaToken === undefined ? 1 : Number.parseFloat(alphaToken) || 1;
  return { ...hslToRgb(h, s, l), a: Math.min(1, Math.max(0, a)) };
}

/** Parse one colour literal, or null when it is not one we can reason about. */
export function parseColor(token: string): Rgb | null {
  const value = token.trim().toLowerCase();
  if (!value) return null;
  const named = NAMED_HEX[value];
  if (named) return hexToRgb(named);
  if (value.startsWith("#")) return hexToRgb(value);
  if (value.startsWith("rgb")) return rgbFunctionToRgb(value);
  if (value.startsWith("hsl")) return hslFunctionToRgb(value);
  return null;
}

/** WCAG relative luminance (0 = black, 1 = white). Alpha is ignored: every
 *  caller has already skipped translucent colours. */
export function relativeLuminance({ r, g, b }: Rgb): number {
  const linear = (channel: number): number => {
    const c = channel / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

export function rgbToHsl({ r, g, b }: Rgb): { h: number; s: number; l: number } {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  const delta = max - min;
  if (delta === 0) return { h: 0, s: 0, l };
  const s = delta / (1 - Math.abs(2 * l - 1));
  let h: number;
  if (max === rn) h = ((gn - bn) / delta) % 6;
  else if (max === gn) h = (bn - rn) / delta + 2;
  else h = (rn - gn) / delta + 4;
  h *= 60;
  if (h < 0) h += 360;
  return { h, s, l };
}

function hslCss(h: number, s: number, l: number, a: number): string {
  const hue = Math.round(((h % 360) + 360) % 360);
  const sat = Math.round(s * 100);
  const light = Math.round(l * 100);
  return a >= 0.999
    ? `hsl(${hue} ${sat}% ${light}%)`
    : `hsl(${hue} ${sat}% ${light}% / ${Number(a.toFixed(2))})`;
}

/** Lightness band a fill is snapped into, per theme. Chosen to sit on the
 *  app's own surfaces: light ≈ the white card ground, dark ≈ one step above
 *  `--surface-muted` so a card still reads as a raised panel. */
const FILL_BAND = { light: 0.965, dark: 0.17 } as const;
const LINE_BAND = { light: 0.88, dark: 0.31 } as const;
/** Saturation ceilings keep a snapped fill from turning into a neon block —
 *  at band lightness, a saturated hue reads far louder than it did at the
 *  lightness the model picked. */
const FILL_SAT = { light: 0.55, dark: 0.3 } as const;
const LINE_SAT = { light: 0.18, dark: 0.22 } as const;

/** Text colours outside this luminance window are unreadable in the given
 *  theme and get dropped (the element then inherits the app's colour). */
const TEXT_MIN_LUMINANCE = { light: 0, dark: 0.18 } as const;
const TEXT_MAX_LUMINANCE = { light: 0.55, dark: 1 } as const;

type Role = "fill" | "line";

function snap(token: string, role: Role, dark: boolean): string {
  const rgb = parseColor(token);
  if (!rgb) return token;
  // A wash (shadow, faint tint) already works on any background.
  if (rgb.a < 0.1) return token;
  const theme = dark ? "dark" : "light";
  const hsl = rgbToHsl(rgb);
  const lightness = role === "fill" ? FILL_BAND[theme] : LINE_BAND[theme];
  const saturation = Math.min(hsl.s, role === "fill" ? FILL_SAT[theme] : LINE_SAT[theme]);
  return hslCss(hsl.h, saturation, lightness, rgb.a);
}

/** True when a text colour would be illegible in this theme. */
function isIllegibleText(token: string, dark: boolean): boolean {
  const rgb = parseColor(token);
  if (!rgb) return false;
  if (rgb.a < 0.1) return false;
  const luminance = relativeLuminance(rgb);
  return (
    luminance < TEXT_MIN_LUMINANCE[dark ? "dark" : "light"] ||
    luminance > TEXT_MAX_LUMINANCE[dark ? "dark" : "light"]
  );
}

/**
 * Re-emit one declaration so it works in the current theme.
 *
 * Returns the value to keep, or null when the declaration must be dropped
 * (only ever the case for `color`). Non-colour properties are returned
 * untouched — this function is not a sanitizer; `sanitizeInlineStyle` has
 * already decided WHAT may be set, this only decides HOW it looks.
 */
export function fitColorDeclaration(property: string, value: string, dark: boolean): string | null {
  if (property === "color") {
    // A `color` value is a single colour; anything with several tokens is
    // beyond what the contrast rule can judge, so it is left alone.
    const tokens = value.match(COLOR_TOKEN) ?? [];
    if (tokens.length === 1 && tokens[0] === value.trim() && isIllegibleText(tokens[0], dark)) {
      return null;
    }
    return value;
  }
  if (property === "background" || property === "background-color") {
    return value.replace(COLOR_TOKEN, (token) => snap(token, "fill", dark));
  }
  if (property === "border" || property.startsWith("border-") || property === "outline") {
    return value.replace(COLOR_TOKEN, (token) => snap(token, "line", dark));
  }
  return value;
}
