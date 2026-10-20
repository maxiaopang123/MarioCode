/**
 * Offline smoke for main/plugins/pluginState.ts: reads a fake ~/.mariocode
 * tree shaped like the Claude CLI's real plugin state, and checks that the
 * only write (enabledPlugins) never damages anything else in settings.json.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { listPlugins, setPluginEnabled } from "@main/plugins/pluginState.js";

let failed = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  if (ok) console.log(`ok   ${name}`);
  else {
    failed++;
    console.error(`FAIL ${name}`, detail ?? "");
  }
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "mariocode-plugins-home-"));
const write = (rel: string, body: string): void => {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body, "utf8");
};
const readSettings = (): Record<string, unknown> =>
  JSON.parse(fs.readFileSync(path.join(root, "settings.json"), "utf8"));

try {
  // ── empty home: no files at all ────────────────────────────────────────
  const empty = listPlugins(path.join(root, "nonexistent"));
  check("missing home lists nothing and does not throw", empty.plugins.length === 0);

  // ── fixture mirroring the CLI's layout ─────────────────────────────────
  const installPath = path.join(root, "plugins", "cache", "mk", "demo", "1.2.3");
  const base = "plugins/cache/mk/demo/1.2.3";
  write(`${base}/.claude-plugin/plugin.json`, JSON.stringify({
    name: "demo", version: "1.2.3", description: "Demo plugin", author: { name: "Ada" },
    homepage: "https://example.test", skills: "./skills/", mcpServers: "./claude.mcp.json",
    commands: ["./commands", "../../../../../escape"],
  }));
  write(`${base}/skills/alpha/SKILL.md`, "---\nname: alpha\ndescription: \"Alpha does things\"\n---\nbody");
  write(`${base}/skills/beta/SKILL.md`, "no frontmatter");
  write(`${base}/skills/not-a-skill/README.md`, "ignored: no SKILL.md");
  write(`${base}/commands/go.md`, "---\ndescription: Go now\n---\n");
  write(`${base}/commands/notes.txt`, "ignored: not markdown");
  write(`${base}/claude.mcp.json`, JSON.stringify({ mcpServers: { zeta: {}, alpha: {} } }));
  write(`${base}/hooks/hooks.json`, "{}");
  write("plugins/installed_plugins.json", JSON.stringify({
    version: 2,
    plugins: {
      "demo@mk": [{ scope: "user", installPath, version: "1.2.3" }],
      // install path points outside <home>/plugins — must not be followed
      "evil@mk": [{ scope: "user", installPath: path.join(os.tmpdir()), version: "9" }],
      // record whose directory vanished
      "gone@mk": [{ scope: "user", installPath: path.join(root, "plugins", "cache", "mk", "gone", "1"), version: "1" }],
    },
  }));
  write("settings.json", JSON.stringify({
    autoUpdatesChannel: "latest",
    extraKnownMarketplaces: { mk: { source: { source: "github", repo: "x/y" } } },
    enabledPlugins: { "demo@mk": true, "ghost@mk": true, "gone@mk": false, bad: true, "weird@mk": "yes" },
  }));

  const result = listPlugins(root);
  const byId = new Map(result.plugins.map((p) => [p.id, p]));
  const demo = byId.get("demo@mk");

  check("configPath points at settings.json", result.configPath === path.join(root, "settings.json"));
  check("demo is installed + enabled", demo?.installed === true && demo.enabled === true, demo);
  check("manifest fields parsed", demo?.version === "1.2.3" && demo.author === "Ada" && demo.description === "Demo plugin" && demo.marketplace === "mk" && demo.name === "demo");
  check("skills need SKILL.md and read description", JSON.stringify(demo?.skills) === JSON.stringify([
    { name: "alpha", description: "Alpha does things" },
    { name: "beta", description: null },
  ]), demo?.skills);
  check("commands: only .md, escaping manifest path ignored", JSON.stringify(demo?.commands) === JSON.stringify([{ name: "go", description: "Go now" }]), demo?.commands);
  check("mcp servers read from referenced file, sorted", JSON.stringify(demo?.mcpServers) === JSON.stringify(["alpha", "zeta"]), demo?.mcpServers);
  check("hooks detected", demo?.hasHooks === true);

  const evil = byId.get("evil@mk");
  check("install path outside plugins dir is refused", evil?.installed === false && /outside/.test(evil.error ?? ""), evil);
  const gone = byId.get("gone@mk");
  check("missing install directory reported", gone?.installed === false && /missing/.test(gone.error ?? "") && gone.enabled === false, gone);
  const ghost = byId.get("ghost@mk");
  check("enabled-but-not-installed still listed", ghost?.installed === false && ghost.enabled === true && ghost.error !== null, ghost);
  check("malformed ids and non-boolean values are dropped", !byId.has("bad") && byId.get("weird@mk")?.enabled !== true);
  check("enabled plugins sort first", result.plugins[0]?.enabled === true);

  // ── write path ─────────────────────────────────────────────────────────
  const off = setPluginEnabled("demo@mk", false, root);
  const after = readSettings();
  check("disable succeeds", off.ok);
  check("disable flips only that key", (after.enabledPlugins as Record<string, unknown>)["demo@mk"] === false
    && (after.enabledPlugins as Record<string, unknown>)["ghost@mk"] === true);
  check("other settings keys survive untouched", after.autoUpdatesChannel === "latest"
    && JSON.stringify(after.extraKnownMarketplaces) === JSON.stringify({ mk: { source: { source: "github", repo: "x/y" } } }));
  check("list reflects the write", listPlugins(root).plugins.find((p) => p.id === "demo@mk")?.enabled === false);
  check("no temp files left behind", fs.readdirSync(root).every((name) => !name.endsWith(".tmp")));

  const on = setPluginEnabled("demo@mk", true, root);
  check("re-enable round-trips", on.ok && listPlugins(root).plugins.find((p) => p.id === "demo@mk")?.enabled === true);

  // ── fresh home: settings.json is created ───────────────────────────────
  const fresh = path.join(root, "fresh");
  const created = setPluginEnabled("x@y", true, fresh);
  check("creates settings.json in a fresh home", created.ok && JSON.stringify(JSON.parse(fs.readFileSync(path.join(fresh, "settings.json"), "utf8"))) === JSON.stringify({ enabledPlugins: { "x@y": true } }));

  // ── corrupted settings.json is never overwritten ───────────────────────
  const broken = path.join(root, "broken");
  fs.mkdirSync(broken, { recursive: true });
  fs.writeFileSync(path.join(broken, "settings.json"), "{ not json", "utf8");
  const refused = setPluginEnabled("x@y", true, broken);
  check("refuses to overwrite invalid JSON", !refused.ok && fs.readFileSync(path.join(broken, "settings.json"), "utf8") === "{ not json", refused);
} finally {
  if (!path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)) throw new Error("Unsafe test cleanup target");
  fs.rmSync(root, { recursive: true, force: true });
}

if (failed > 0) {
  console.error(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log("\nplugins-state smoke: all checks passed");
