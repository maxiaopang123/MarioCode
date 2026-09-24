/**
 * Switch — accessible on/off toggle.
 *
 * Built on @base-ui/react Switch primitive (renders a span + hidden checkbox,
 * so keyboard / screen-reader support come for free). Visual style matches
 * the app's accent token: a 28×16 rounded track with a sliding 12×12 thumb.
 *
 * @example
 *   <Switch checked={enabled} onCheckedChange={setEnabled} label="自动生成" />
 */
import { forwardRef } from "react";
import { Switch as BaseSwitch } from "@base-ui/react/switch";
import { cn } from "@renderer/lib/cn.js";

export interface SwitchProps {
  /** Whether the switch is currently on. */
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  /** id for the hidden checkbox input (label click-through). */
  id?: string;
  /** Accessible name (aria-label) + native title tooltip. */
  label: string;
  className?: string;
}

const Switch = forwardRef<HTMLElement, SwitchProps>(
  ({ checked, onCheckedChange, disabled, id, label, className }, ref) => {
    return (
      <BaseSwitch.Root
        ref={ref}
        id={id}
        checked={checked}
        onCheckedChange={onCheckedChange}
        disabled={disabled}
        aria-label={label}
        title={label}
        className={cn(
          "relative h-[18px] w-8 shrink-0 rounded-full outline-none transition-colors",
          "focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:ring-offset-1 focus-visible:ring-offset-surface",
          checked ? "bg-accent" : "bg-edge-input",
          disabled && "cursor-not-allowed opacity-50",
          className,
        )}
      >
        {/* White thumb in both themes (ui-refresh `.switch`). */}
        <BaseSwitch.Thumb
          className={cn(
            "absolute top-0.5 h-3.5 w-3.5 rounded-full bg-white shadow transition-[left]",
            checked ? "left-4" : "left-0.5",
          )}
        />
      </BaseSwitch.Root>
    );
  },
);

Switch.displayName = "Switch";

export { Switch };
