/**
 * Tinted project avatar (界面焕新 v3): the project's hue as a soft tint with
 * the initial in the same hue — replaces the old solid white-on-color chip,
 * which read as loud next to the muted chrome. The hue arrives via --av;
 * .proj-av in styles.css derives the tint / ring and lifts it in dark.
 */
import { cn } from "@renderer/lib/cn.js";
import { projectAvatarStyle, projectInitial } from "@renderer/lib/projectAvatar.js";

const SIZES = {
  xs: "h-4 w-4 rounded-[4px] text-[10px]",
  sm: "h-[18px] w-[18px] rounded-[5px] text-[10.5px]",
  md: "h-[22px] w-[22px] rounded-md text-[11.5px]",
  lg: "h-7 w-7 rounded-lg text-[12px]",
} as const;

export function ProjectAvatar({
  name,
  color,
  size = "xs",
  className,
}: {
  name: string;
  color: string;
  size?: keyof typeof SIZES;
  className?: string;
}) {
  return (
    <span
      className={cn("proj-av flex shrink-0 items-center justify-center font-semibold leading-none", SIZES[size], className)}
      style={projectAvatarStyle(color)}
      aria-hidden
    >
      {projectInitial(name)}
    </span>
  );
}
