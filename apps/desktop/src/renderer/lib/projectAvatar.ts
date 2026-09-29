/**
 * Deterministic project avatar: background hue from the name hash plus the
 * uppercase initial. Shared by the stream sidebar's cards / scope menu and
 * the composer's directory switcher so a project renders the same color on
 * every surface.
 */
import type { CSSProperties } from "react";

/* 界面焕新 v3: low-saturation "mist" hues (slate blue / terracotta / misty
 * teal …) in the same lightness band as the icon's graphite, so avatars
 * identify a project without competing with the text. Same length + order
 * slots as before, so every project keeps its hash slot. Rendered as a tint
 * (see .proj-av in styles.css), not a solid white-on-color chip. */
const PROJECT_AVATAR_COLORS = ["#687296", "#a47a56", "#7a6a98", "#50808c", "#9a6470", "#5f7f9e"];

/** Swatch palette offered by the project color picker (new-session panel's
 *  manage menu). Deliberately a SEPARATE superset — extending the hash list
 *  above would reshuffle every existing project's auto color. */
export const PROJECT_COLOR_SWATCHES = [
  "#687296",
  "#5f7f9e",
  "#5c8f78",
  "#50808c",
  "#7c8a58",
  "#a47a56",
  "#9a6470",
  "#a0708e",
  "#7a6a98",
  "#5e5a8e",
  "#6f7a76",
];

/** Style for a tinted project avatar: feeds the hue to .proj-av via --av. */
export function projectAvatarStyle(color: string): CSSProperties {
  return { ["--av" as string]: color } as CSSProperties;
}

/** Effective avatar color for a project: the user's pick when one was set
 *  (settings key `project.colors`, store bucket `projectColors`), else the
 *  deterministic name-hash default. Every surface that renders a project
 *  avatar goes through this so the choice shows up everywhere at once. */
export function projectDisplayColor(
  p: { id: string; name: string },
  custom: Record<string, string>,
): string {
  return custom[p.id] || projectAvatarColor(p.name);
}

export function projectAvatarColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = (hash * 31 + name.charCodeAt(i)) | 0;
  }
  return PROJECT_AVATAR_COLORS[Math.abs(hash) % PROJECT_AVATAR_COLORS.length];
}

export function projectInitial(name: string): string {
  const first = name.trim().charAt(0);
  return first ? first.toUpperCase() : "?";
}
