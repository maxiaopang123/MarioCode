/**
 * Theme / color-scheme domain types.
 *
 * `ThemeName` is the user's *preference* (what they picked in Settings); it
 * may be "system", which resolves at runtime to either dark or light based on
 * the OS. `EffectiveTheme` is that resolved value — what's actually rendering.
 */

/** User-selectable theme preference. */
export type ThemeName = "dark" | "light" | "system";

/** The theme currently in effect (system resolved down to one of these). */
export type EffectiveTheme = "dark" | "light";

/**
 * Colour TONE — a dimension orthogonal to light/dark (V4, TODO-044): "neutral"
 * (default, plain greys) or "warm" (paper tones + serif chat prose). The
 * renderer mirrors it as `data-tone="warm"` on <html>; main reads it only for
 * the native window / title-bar colours. Persisted as `ui.themeTone` via the
 * generic setting.get/set IPC.
 */
export type ThemeTone = "neutral" | "warm";

/** Payload of the theme.changed push event (main → renderer). */
export interface ThemeChangedMessage {
  /** Push channel discriminator — distinguishes this from claude/terminal events. */
  channel: "theme:changed";
  /** The user's persisted preference. */
  theme: ThemeName;
  /** What's actually rendering right now (system resolved). */
  effective: EffectiveTheme;
}
