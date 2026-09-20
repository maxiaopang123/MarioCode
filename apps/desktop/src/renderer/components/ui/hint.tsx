/**
 * Hint — one-prop tooltip for icon buttons and other terse controls.
 *
 * The compound Tooltip API needs five elements to attach one label, which is
 * why most of the app reached for the native `title` attribute instead. Hint
 * collapses that to a single prop and merges the trigger onto the child rather
 * than wrapping it, so existing markup, layout and event handlers are
 * untouched.
 *
 *   <Hint label={t("common.refresh")}>
 *     <button type="button" onClick={reload}><IconRefresh size={16} /></button>
 *   </Hint>
 *
 * Unless the child already names itself, the label is also applied as its
 * `aria-label`: the trigger only opens for mouse-like pointers, so on touch
 * and for screen readers that attribute is the only thing left. Pass
 * `describeOnly` for children that carry visible text.
 *
 * Not a drop-in for every `title=`: a truncated row whose title repeats the
 * full path is better left native — a floating panel over a list row is noise.
 */
import { cloneElement, type ReactElement } from "react";
import { Tooltip, type TooltipPositionerProps } from "./tooltip.js";

type HintChildProps = { className?: string; "aria-label"?: string };

export interface HintProps {
  /** Tooltip text, and the child's accessible name unless `describeOnly`. */
  label: string;
  /** A single element — the control the hint describes. */
  children: ReactElement<HintChildProps>;
  side?: TooltipPositionerProps["side"];
  sideOffset?: number;
  /** Hover dwell before opening; defaults to the Tooltip primitive's 280ms. */
  delay?: number;
  /** Set when the child already reads as its own label (visible text). */
  describeOnly?: boolean;
}

export function Hint({
  label,
  children,
  side = "top",
  sideOffset = 6,
  delay,
  describeOnly = false,
}: HintProps) {
  const { className, "aria-label": ownLabel } = children.props;
  // The child's classes ride on the Trigger rather than the child so they go
  // through cn(): twMerge then settles the primitive's `inline-flex` against
  // whatever display the child asked for, instead of leaving both in the list
  // for stylesheet order to decide.
  const trigger = cloneElement(children, {
    className: undefined,
    "aria-label": describeOnly ? ownLabel : (ownLabel ?? label),
  });
  return (
    <Tooltip.Root>
      <Tooltip.Trigger delay={delay} className={className} render={trigger} />
      <Tooltip.Portal>
        <Tooltip.Positioner side={side} sideOffset={sideOffset}>
          <Tooltip.Popup>{label}</Tooltip.Popup>
        </Tooltip.Positioner>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}
