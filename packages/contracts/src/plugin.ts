import { z } from "zod";

/**
 * Claude Code plugins (settings → 插件).
 *
 * MarioCode does NOT install plugins itself: the bundled `claude` CLI owns the
 * lifecycle (`~/.mariocode/plugins/` + `enabledPlugins` in
 * `~/.mariocode/settings.json`, because CLAUDE_CONFIG_DIR is redirected there).
 * The panel only reads that state and flips the `enabledPlugins` switch, which
 * the CLI honors on its next start. Plugins affect the Claude engine only.
 */

/** `<plugin>@<marketplace>` — the key format the CLI uses in `enabledPlugins`. */
export const PluginIdSchema = z
  .string()
  .trim()
  .min(3)
  .max(200)
  .regex(/^[^@\s]+@[^@\s]+$/, "plugin id must look like name@marketplace");

export const PluginsSetEnabledSchema = z.object({
  id: PluginIdSchema,
  enabled: z.boolean(),
});
export type PluginsSetEnabledInput = z.infer<typeof PluginsSetEnabledSchema>;

export interface PluginComponentItem {
  name: string;
  /** First-line description when the component declares one. */
  description: string | null;
}

export interface PluginState {
  /** `name@marketplace`. */
  id: string;
  name: string;
  marketplace: string;
  version: string | null;
  description: string | null;
  author: string | null;
  homepage: string | null;
  /** `enabledPlugins[id] === true` in settings.json. */
  enabled: boolean;
  /** An install record exists AND its directory could be read. */
  installed: boolean;
  /** CLI install scope ("user" | "project" | "local"), when recorded. */
  scope: string | null;
  skills: PluginComponentItem[];
  commands: PluginComponentItem[];
  agents: PluginComponentItem[];
  /** MCP server names the plugin contributes (started by the CLI each turn). */
  mcpServers: string[];
  hasHooks: boolean;
  /** Why the manifest/components could not be read (installed=false cases). */
  error: string | null;
}

export interface PluginsListResult {
  plugins: PluginState[];
  /** Absolute path of the settings.json the switches write to. */
  configPath: string;
}
