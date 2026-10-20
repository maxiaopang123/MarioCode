/**
 * Read-only view of the Claude CLI's plugin state, plus the one write the
 * settings panel needs: flipping `enabledPlugins[id]` in settings.json.
 *
 * The CLI owns installation (`~/.mariocode/plugins/installed_plugins.json`,
 * `cache/<marketplace>/<plugin>/<version>/`). We never create, move or delete
 * plugin directories — that is what collided with the CLI's layout the last
 * time MarioCode shipped its own plugin manager (removed in ee5c88c).
 *
 * Electron-free on purpose: every function takes the home directory as a
 * parameter so the offline smoke script can run against a fake tree.
 */
import fs from "node:fs";
import path from "node:path";
import type { PluginComponentItem, PluginState, PluginsListResult } from "@contracts/ipc";
import { MARIOCODE_HOME } from "@main/lib/appHome.js";

interface InstallRecord {
  scope?: unknown;
  installPath?: unknown;
  version?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function settingsPath(home: string): string {
  return path.join(home, "settings.json");
}

/** `enabledPlugins` as a plain id → boolean map (non-boolean values dropped). */
function readEnabled(home: string): Record<string, boolean> {
  const settings = readJson(settingsPath(home));
  const raw = isRecord(settings) && isRecord(settings.enabledPlugins) ? settings.enabledPlugins : {};
  const out: Record<string, boolean> = {};
  for (const [id, value] of Object.entries(raw)) if (typeof value === "boolean") out[id] = value;
  return out;
}

/** Resolve `rel` under `root`; null when it would escape the plugin directory. */
function within(root: string, rel: string): string | null {
  const resolved = path.resolve(root, rel);
  const relative = path.relative(root, resolved);
  return relative.startsWith("..") || path.isAbsolute(relative) ? null : resolved;
}

/** `description:` from a leading `---` frontmatter block, first line only. */
function frontmatterDescription(file: string): string | null {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8").slice(0, 4096);
  } catch {
    return null;
  }
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!match) return null;
  const line = /^description:\s*(.+)$/m.exec(match[1]!);
  if (!line) return null;
  return line[1]!.trim().replace(/^["']|["']$/g, "").slice(0, 240) || null;
}

function manifestDirs(manifestValue: unknown, fallback: string): string[] {
  if (typeof manifestValue === "string") return [manifestValue];
  if (Array.isArray(manifestValue)) return manifestValue.filter((v): v is string => typeof v === "string");
  return [fallback];
}

function scanSkills(root: string, manifest: Record<string, unknown>): PluginComponentItem[] {
  const items: PluginComponentItem[] = [];
  for (const rel of manifestDirs(manifest.skills, "skills")) {
    const dir = within(root, rel);
    if (!dir) continue;
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const skillFile = path.join(dir, entry.name, "SKILL.md");
      if (fs.existsSync(skillFile)) items.push({ name: entry.name, description: frontmatterDescription(skillFile) });
    }
  }
  return items.sort((a, b) => a.name.localeCompare(b.name));
}

function scanMarkdown(root: string, manifestValue: unknown, fallback: string): PluginComponentItem[] {
  const items: PluginComponentItem[] = [];
  for (const rel of manifestDirs(manifestValue, fallback)) {
    const dir = within(root, rel);
    if (!dir) continue;
    let names: string[] = [];
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.toLowerCase().endsWith(".md")) continue;
      items.push({ name: name.slice(0, -3), description: frontmatterDescription(path.join(dir, name)) });
    }
  }
  return items.sort((a, b) => a.name.localeCompare(b.name));
}

/** MCP server names: manifest value is an inline object, a path, or absent
 *  (then the conventional `.mcp.json`). Both `{ mcpServers: {...} }` and a
 *  bare `{ name: {...} }` file shapes exist in the wild. */
function scanMcp(root: string, manifestValue: unknown): string[] {
  let source: unknown = manifestValue;
  if (typeof manifestValue === "string") {
    const file = within(root, manifestValue);
    source = file ? readJson(file) : null;
  } else if (manifestValue === undefined) {
    source = readJson(path.join(root, ".mcp.json"));
  }
  if (!isRecord(source)) return [];
  const servers = isRecord(source.mcpServers) ? source.mcpServers : source;
  return Object.keys(servers).sort();
}

function authorName(value: unknown): string | null {
  if (typeof value === "string") return str(value);
  return isRecord(value) ? str(value.name) : null;
}

function splitId(id: string): { name: string; marketplace: string } {
  const at = id.lastIndexOf("@");
  return { name: id.slice(0, at), marketplace: id.slice(at + 1) };
}

function inspect(home: string, id: string, enabled: boolean, record: InstallRecord | null): PluginState {
  const { name, marketplace } = splitId(id);
  const state: PluginState = {
    id,
    name,
    marketplace,
    version: str(record?.version),
    description: null,
    author: null,
    homepage: null,
    enabled,
    installed: false,
    scope: str(record?.scope),
    skills: [],
    commands: [],
    agents: [],
    mcpServers: [],
    hasHooks: false,
    error: null,
  };
  const installPath = str(record?.installPath);
  if (!installPath) {
    state.error = record ? "install record has no path" : "enabled in settings but not installed";
    return state;
  }
  // The record is CLI-written data; only follow it into the plugins tree.
  const pluginsRoot = path.join(home, "plugins");
  const rel = path.relative(pluginsRoot, installPath);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    state.error = "install path is outside the plugins directory";
    return state;
  }
  if (!fs.existsSync(installPath)) {
    state.error = "install directory is missing";
    return state;
  }
  const manifestRaw = readJson(path.join(installPath, ".claude-plugin", "plugin.json"));
  const manifest = isRecord(manifestRaw) ? manifestRaw : {};
  state.installed = true;
  state.version = str(manifest.version) ?? state.version;
  state.description = str(manifest.description);
  state.author = authorName(manifest.author);
  state.homepage = str(manifest.homepage);
  state.skills = scanSkills(installPath, manifest);
  state.commands = scanMarkdown(installPath, manifest.commands, "commands");
  state.agents = scanMarkdown(installPath, manifest.agents, "agents");
  state.mcpServers = scanMcp(installPath, manifest.mcpServers);
  state.hasHooks = manifest.hooks !== undefined || fs.existsSync(path.join(installPath, "hooks", "hooks.json"));
  return state;
}

export function listPlugins(home: string = MARIOCODE_HOME): PluginsListResult {
  const enabled = readEnabled(home);
  const installedRaw = readJson(path.join(home, "plugins", "installed_plugins.json"));
  const records = isRecord(installedRaw) && isRecord(installedRaw.plugins) ? installedRaw.plugins : {};
  const ids = new Set<string>([...Object.keys(records), ...Object.keys(enabled)]);
  const plugins: PluginState[] = [];
  for (const id of ids) {
    if (!/^[^@\s]+@[^@\s]+$/.test(id)) continue;
    const entry = records[id];
    const first = Array.isArray(entry) && isRecord(entry[0]) ? (entry[0] as InstallRecord) : null;
    plugins.push(inspect(home, id, enabled[id] === true, first));
  }
  plugins.sort((a, b) => Number(b.enabled) - Number(a.enabled) || a.id.localeCompare(b.id));
  return { plugins, configPath: settingsPath(home) };
}

/**
 * Flip `enabledPlugins[id]`, preserving every other settings key. Refuses to
 * touch a settings.json that exists but does not parse — overwriting it would
 * destroy whatever the user (or the CLI) had there.
 */
export function setPluginEnabled(
  id: string,
  enabled: boolean,
  home: string = MARIOCODE_HOME,
): { ok: boolean; error?: string } {
  const file = settingsPath(home);
  let settings: Record<string, unknown> = {};
  if (fs.existsSync(file)) {
    const parsed = readJson(file);
    if (!isRecord(parsed)) return { ok: false, error: `${file} is not valid JSON; fix or remove it first` };
    settings = parsed;
  }
  const current = isRecord(settings.enabledPlugins) ? { ...settings.enabledPlugins } : {};
  current[id] = enabled;
  settings.enabledPlugins = current;
  try {
    fs.mkdirSync(home, { recursive: true });
    // Same-directory temp + rename so a crash never leaves a half-written file.
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
    fs.renameSync(tmp, file);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
