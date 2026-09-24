/**
 * Shared frame for the prompt cards docked above the composer — tool
 * approval, plan approval and AskUserQuestion (ui-refresh prototype
 * `.dock`): a 12px-radius card on the strongest border with the tier-2
 * shadow, a 42px header, a padded body, and a 48px footer on the inset-well
 * color under a hairline. Neutral throughout — the accent shows only where
 * the prototype's accent list allows it (primary button, radio / check
 * marks, focus ring).
 */

/** Card frame. `mb-2.5` lifts it off the composer below. */
export const DOCK_CARD =
  "mb-2.5 flex flex-col overflow-hidden rounded-xl border border-edge-input bg-surface text-[13px] text-content shadow-md animate-[qa-sheet-in_140ms_ease-out]";

export const DOCK_HEAD = "flex min-h-[42px] shrink-0 items-center gap-2 pl-3.5 pr-2 font-medium";

/** Header glyph — neutral, never the accent. */
export const DOCK_HEAD_ICON = "shrink-0 text-content-muted";

/** Secondary text in the header / footer. */
export const DOCK_MUTED = "text-xs font-normal text-content-subtle";

export const DOCK_BODY = "px-3.5 pb-3.5";

export const DOCK_FOOT =
  "flex min-h-12 shrink-0 items-center gap-2 border-t border-edge bg-surface-muted py-2 pl-3.5 pr-2.5";

/** Inset well for command / payload previews. */
export const DOCK_WELL = "rounded-lg border border-edge bg-surface-muted";

/** Size override for <Button> inside a dock (prototype `.btn.sm`: 28px,
 *  12px text, 8px radius). */
export const DOCK_BUTTON = "h-7 gap-1.5 rounded-lg px-2.5 text-xs";

/** Prototype `.btn-secondary` — the bordered surface button that pairs with
 *  the primary one in a decision (拒绝 next to 允许). */
export const DOCK_SECONDARY =
  "border border-edge-input bg-surface text-content shadow-sm hover:bg-surface-muted";

/** Key hint inside a dock button (Esc / Enter). */
export const DOCK_KBD =
  "ml-0.5 inline-flex h-4 items-center rounded border border-current px-1 font-mono text-[11px] font-normal leading-none opacity-60";
