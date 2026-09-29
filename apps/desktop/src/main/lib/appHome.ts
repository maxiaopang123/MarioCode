/**
 * MarioCode's per-user home directory (`~/.mariocode`).
 *
 * Single source of truth for every path under it: the redirected
 * CLAUDE_CONFIG_DIR (`.claude.json`, skills, output styles), the isolated
 * CODEX_HOME (`codex/`), the skill market cache, skill-sync mirrors, etc.
 *
 * Electron-free on purpose — the Pi host bundle and offline smoke scripts
 * import modules that depend on this.
 */
import { homedir } from "node:os";
import path from "node:path";

export const MARIOCODE_HOME = path.join(homedir(), ".mariocode");
