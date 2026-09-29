/**
 * User-authored system prompt — storage + per-turn loading (TODO-006).
 *
 * Two scopes, both plain text the user edits in settings → 系统提示词:
 *  - global: settings table, AGENT_SYSTEM_PROMPT_GLOBAL_SETTING_KEY;
 *  - project: `<project>/.mariocode/prompt.md` (PROJECT_SYSTEM_PROMPT_RELATIVE_PATH),
 *    a file so it can be committed and shared like CLAUDE.md / AGENTS.md.
 *
 * Every provider calls `loadUserSystemPrompt` at turn start and appends the
 * result via `formatUserPromptSections` (see `systemPrompt.ts`) — Claude into
 * `systemPrompt.append`, Pi through the host protocol into its
 * `before_agent_start` injector, Codex as `developerInstructions` on
 * thread/start + thread/resume. Nothing here is cached: a turn always reads
 * the current text, so edits land on the next message.
 */
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  AGENT_SYSTEM_PROMPT_GLOBAL_SETTING_KEY,
  PROJECT_SYSTEM_PROMPT_RELATIVE_PATH,
  SYSTEM_PROMPT_MAX_CHARS,
} from "@contracts/ipc";
import { awaitDb } from "@main/store/db.js";
import { ProjectRepo, SessionRepo, SettingRepo } from "@main/store/repositories.js";
import { formatUserPromptSections } from "./systemPrompt.js";

export interface UserSystemPrompt {
  /** Global scope text (trimmed, capped). Empty when unset. */
  global: string;
  /** Project scope text (trimmed, capped). Empty when no file was found. */
  project: string;
  /** Absolute path of the project prompt file that supplied `project`, or
   *  null when none of the candidate roots had one. */
  projectFile: string | null;
}

/** Absolute path of the project-scope prompt file under `projectRoot`. */
export function projectPromptFile(projectRoot: string): string {
  return path.join(projectRoot, PROJECT_SYSTEM_PROMPT_RELATIVE_PATH);
}

/** Cap runaway text (externally edited files) so one prompt can't swallow
 *  the context window. The panel enforces the same bound on save. */
function capPrompt(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= SYSTEM_PROMPT_MAX_CHARS) return trimmed;
  return `${trimmed.slice(0, SYSTEM_PROMPT_MAX_CHARS)}\n…(提示词超过 ${SYSTEM_PROMPT_MAX_CHARS} 字,已截断)`;
}

/** Read the project prompt file. Missing file → `exists: false`, `content: ""`.
 *  Other read errors (permissions, EISDIR) propagate to the caller. */
export async function readProjectPrompt(
  projectRoot: string,
): Promise<{ path: string; exists: boolean; content: string }> {
  const file = projectPromptFile(projectRoot);
  try {
    const content = await readFile(file, "utf-8");
    return { path: file, exists: true, content };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { path: file, exists: false, content: "" };
    }
    throw err;
  }
}

/** Write the project prompt file (creating `.mariocode/`). Whitespace-only
 *  content deletes the file instead, so clearing the editor leaves no stub
 *  behind; the `.mariocode/` directory itself is left alone. */
export async function writeProjectPrompt(
  projectRoot: string,
  content: string,
): Promise<{ path: string; exists: boolean }> {
  const file = projectPromptFile(projectRoot);
  if (!content.trim()) {
    try {
      await unlink(file);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    return { path: file, exists: false };
  }
  await mkdir(path.dirname(file), { recursive: true });
  // Normalize to LF + trailing newline like every other markdown we own.
  const normalized = `${content.replace(/\r\n/g, "\n").replace(/\s+$/, "")}\n`;
  await writeFile(file, normalized, "utf-8");
  return { path: file, exists: true };
}

/** The persisted global prompt (raw, untrimmed). Empty string when unset. */
export async function getGlobalPromptSetting(): Promise<string> {
  await awaitDb();
  return SettingRepo.get(AGENT_SYSTEM_PROMPT_GLOBAL_SETTING_KEY) ?? "";
}

/** The global prompt as injected (trimmed + capped). Never throws. */
export async function loadGlobalUserPrompt(): Promise<string> {
  return capPrompt(await getGlobalPromptSetting().catch(() => ""));
}

/**
 * Resolve the roots to probe for `.mariocode/prompt.md`, most specific first:
 * the turn's cwd, then — when the session runs in a worktree whose checkout
 * doesn't carry the file (it's often gitignored) — the project root itself.
 * Duplicates are removed so a plain (non-worktree) session probes once.
 */
function projectRootCandidates(cwd: string, sessionId?: string): string[] {
  const roots = [cwd];
  if (sessionId) {
    try {
      const session = SessionRepo.get(sessionId);
      const project = session ? ProjectRepo.get(session.projectId) : undefined;
      if (project?.path) roots.push(project.path);
    } catch {
      /* DB not ready or session gone — cwd alone is still a valid probe */
    }
  }
  const seen = new Set<string>();
  return roots.filter((r) => {
    const key = path.resolve(r).toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Per-turn loader: global setting + first project prompt file found among
 * the candidate roots. Never throws — an unreadable file degrades to "no
 * project prompt" rather than failing the turn.
 */
export async function loadUserSystemPrompt(opts: {
  cwd: string;
  sessionId?: string;
}): Promise<UserSystemPrompt> {
  const global = await loadGlobalUserPrompt();
  let project = "";
  let projectFile: string | null = null;
  for (const root of projectRootCandidates(opts.cwd, opts.sessionId)) {
    try {
      const res = await readProjectPrompt(root);
      if (!res.exists) continue;
      const capped = capPrompt(res.content);
      if (!capped) continue;
      project = capped;
      projectFile = res.path;
      break;
    } catch {
      /* unreadable — try the next root */
    }
  }
  return { global, project, projectFile };
}

/** The loaded prompt as ready-to-append sections (see `formatUserPromptSections`). */
export function userSystemPromptSections(prompt: UserSystemPrompt): string[] {
  return formatUserPromptSections(prompt.global, prompt.project);
}
