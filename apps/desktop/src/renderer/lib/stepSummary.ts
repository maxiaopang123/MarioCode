/**
 * Rule-mapped sentences for the operation rows (原型 `exec-steps-claude-style`).
 *
 * The redesign turns every folded tool call into ONE line of prose:
 *
 *   13 个操作  Grep ×2 · Glob ×1 · Bash ×3 · Read ×7     ← old tally
 *   搜索代码、执行 3 条命令、读取 7 个文件                 ← group sentence
 *   读取 relayAccountStore.ts                            ← one row
 *
 * Where those sentences come from is the prototype's open question ①, and this
 * module is answer A: derive them locally from the tool name + input, at zero
 * token cost. Answer B (the model writing `description` into its tool_use) is
 * honoured first wherever the field exists — the helpers return "" when it
 * doesn't, so callers fall through to the rules below. A then B, as proposed.
 *
 * Nothing here is localized: every function returns a *classification* or a
 * *value* (a filename, a pattern, an ordered bucket list), and the component
 * formats it through `t()` so the same row reads in Chinese or English.
 *
 * Pure, no React, no i18n: `scripts/tool-summary-smoke/run.mjs` imports this
 * file directly under Node's type stripping.
 */
import { redactCommandSecrets, shellSummary } from "./commandSummary.js";

/** What a step is doing, at the granularity a sentence needs. `other` covers
 *  MCP and any future tool — it still renders, just with its own display name. */
export type StepKind = "search" | "command" | "read" | "write" | "web" | "tasks" | "other";

/** Sentence order for a group header. Reads as a workflow (searched, ran,
 *  read, then wrote) rather than as tally order, which is why it is fixed
 *  instead of first-seen. */
export const STEP_ORDER: readonly StepKind[] = ["search", "command", "read", "write", "web", "tasks", "other"];

/** Tool-name sets. Both naming conventions are listed: Claude's capitalized
 *  tools and Pi's lowercase ones (read/grep/bash/edit/write/find/ls). */
const SHELL = new Set(["Bash", "bash", "PowerShell", "powershell", "shell"]);
const READ = new Set(["Read", "read"]);
const GREP = new Set(["Grep", "grep"]);
const GLOB = new Set(["Glob", "glob", "find", "ls"]);
const WRITE = new Set(["Edit", "edit", "Write", "write", "MultiEdit", "multi_edit", "NotebookEdit", "notebook_edit"]);
const WEB = new Set([
  "WebSearch",
  "WebFetch",
  "mario_web_search",
  "mario_web_fetch",
  "mcp__mariocode-web__mario_web_search",
  "mcp__mariocode-web__mario_web_fetch",
]);
const TASKS = new Set(["TodoWrite", "todo_write", "TaskCreate", "TaskUpdate", "task_create", "task_update"]);

/** Classify a tool call. Unknown names (MCP, agent-browser, …) are `other`. */
export function stepKind(toolName: string): StepKind {
  if (SHELL.has(toolName)) return "command";
  if (READ.has(toolName)) return "read";
  if (GREP.has(toolName) || GLOB.has(toolName)) return "search";
  if (WRITE.has(toolName)) return "write";
  if (WEB.has(toolName)) return "web";
  if (TASKS.has(toolName)) return "tasks";
  return "other";
}

/** Ordered, non-zero buckets for a group header sentence. Input is in call
 *  order but the output follows {@link STEP_ORDER}, so two runs with the same
 *  tools always read the same way. */
export function groupCounts(toolNames: readonly string[]): Array<{ kind: StepKind; count: number }> {
  const counts = new Map<StepKind, number>();
  for (const name of toolNames) {
    const kind = stepKind(name);
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  return STEP_ORDER.filter((kind) => (counts.get(kind) ?? 0) > 0).map((kind) => ({
    kind,
    count: counts.get(kind) ?? 0,
  }));
}

/** Last path segment, for a sentence that must stay one line. Accepts Windows
 *  separators. Returns the input unchanged when it is already a bare name. */
export function fileLabel(path: string): string {
  const flat = String(path ?? "").trim().replace(/[\\/]+$/, "");
  if (!flat) return "";
  const cut = Math.max(flat.lastIndexOf("/"), flat.lastIndexOf("\\"));
  return cut === -1 ? flat : flat.slice(cut + 1);
}

/** The `description` the model attached to its own tool_use (answer B).
 *  Empty when absent or blank — callers then fall back to the rules. */
export function modelDescription(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const value = (input as Record<string, unknown>).description;
  return typeof value === "string" ? value.trim() : "";
}

/** The "what" a rule-mapped sentence names. The kind picks the verb: `file`
 *  is read/written, `pattern` searched, `glob` looked up by name, `query`
 *  searched on the web, `url` fetched, `command` run, `path` listed. `none`
 *  means the sentence has nothing better than the tool's display name. */
export type StepDetail =
  | { kind: "file"; value: string }
  | { kind: "pattern"; value: string }
  | { kind: "glob"; value: string }
  | { kind: "query"; value: string }
  | { kind: "url"; value: string }
  | { kind: "command"; value: string }
  | { kind: "path"; value: string }
  | { kind: "none" };

function str(obj: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

/**
 * Extract the subject of a rule-mapped sentence.
 *
 * Read/Edit/Write carry `file_path` (Claude) or `path` (Pi); Grep/Glob carry
 * `pattern`; WebSearch carries `query` (or the first `queries[]` entry);
 * WebFetch a `url`; shell tools a `command`. Anything else is `none` and the
 * caller shows the tool's display name alone.
 */
export function stepDetail(toolName: string, input: unknown): StepDetail {
  if (!input || typeof input !== "object") return { kind: "none" };
  const obj = input as Record<string, unknown>;
  const kind = stepKind(toolName);

  if (kind === "command") {
    // `shellSummary` already prefers a model description and strips the
    // `cd … && … node x.mjs "…"` wrapper, so the sentence is the command's
    // payload rather than its boilerplate. It also masks credentials.
    const command = shellSummary(obj);
    return command ? { kind: "command", value: command } : { kind: "none" };
  }
  if (kind === "read" || kind === "write") {
    const path = str(obj, "file_path", "path");
    return path ? { kind: "file", value: fileLabel(path) } : { kind: "none" };
  }
  if (GREP.has(toolName)) {
    const pattern = str(obj, "pattern", "query");
    return pattern ? { kind: "pattern", value: pattern } : { kind: "none" };
  }
  if (GLOB.has(toolName)) {
    const pattern = str(obj, "pattern", "query");
    if (pattern) return { kind: "glob", value: pattern };
    // Pi's `ls` has no pattern; its subject is the directory it lists.
    const path = str(obj, "path");
    return path ? { kind: "path", value: path } : { kind: "none" };
  }
  if (toolName === "WebSearch" || toolName === "mario_web_search" || toolName === "mcp__mariocode-web__mario_web_search") {
    const queries = Array.isArray(obj.queries) ? obj.queries : [];
    const query = str(obj, "query") || (typeof queries[0] === "string" ? queries[0].trim() : "");
    return query ? { kind: "query", value: query } : { kind: "none" };
  }
  if (toolName === "WebFetch" || toolName === "mario_web_fetch" || toolName === "mcp__mariocode-web__mario_web_fetch") {
    const url = str(obj, "url");
    return url ? { kind: "url", value: url } : { kind: "none" };
  }
  return { kind: "none" };
}

/** Pieces of a command line, for the `$ command` box of the expansion layer.
 *  Three kinds only: plain text, quoted strings, and `-flag`/`--flag` tokens. */
export type CmdPiece = { text: string; kind: "plain" | "string" | "flag" };

/**
 * Tokenize a command for highlighting: quoted strings are coloured whole (a
 * `-flag` INSIDE quotes is part of the string, e.g. `grep -oP '(?<=\| …)'`),
 * and outside quotes only `-x` / `--xyz` tokens are coloured.
 */
export function highlightCommand(command: string): CmdPiece[] {
  const pieces: CmdPiece[] = [];
  // Keep the delimiters in the split parts so the whole quoted run survives:
  // alternating [text, "'a b'", text, '"c"', …]. The double-quote branch allows
  // escaped characters so `"a \"b\" c"` is one string.
  const parts = String(command ?? "").split(/('(?:[^']*)'|"(?:[^"\\]|\\.)*")/g);
  for (const part of parts) {
    if (!part) continue;
    if (part[0] === "'" || part[0] === '"') {
      pieces.push({ text: part, kind: "string" });
      continue;
    }
    const flag = /(^|\s)(--?[A-Za-z][\w-]*)/g;
    let last = 0;
    let match: RegExpExecArray | null;
    while ((match = flag.exec(part)) !== null) {
      const start = match.index + match[1].length;
      if (start > last) pieces.push({ text: part.slice(last, start), kind: "plain" });
      pieces.push({ text: match[2], kind: "flag" });
      last = start + match[2].length;
    }
    if (last < part.length) pieces.push({ text: part.slice(last), kind: "plain" });
  }
  return pieces;
}

/** Non-empty line count of a tool result (Read content, list output). */
export function lineCount(text: string): number {
  const value = String(text ?? "");
  if (!value) return 0;
  const lines = value.replace(/\n+$/, "").split("\n");
  return lines.length === 1 && lines[0] === "" ? 0 : lines.length;
}

/**
 * Match totals from a Grep result. Claude reports either `Found N files` or a
 * `path:line:content` list; Pi reports a bare list. Both counts are offered
 * because they mean different things and the row labels them differently
 * (「N 处匹配」 vs 「N 个文件」).
 */
export function grepTotals(result: string): { matches: number | null; files: number | null } {
  const text = String(result ?? "");
  if (!text) return { matches: null, files: null };
  const found = /^Found (\d+) files?/im.exec(text);
  const list = text.split("\n").filter((line) => /^[^\s:][^:]*:\d+:/.test(line));
  return {
    matches: list.length > 0 ? list.length : null,
    files: found ? Number(found[1]) : null,
  };
}

/**
 * Command text for the `$` box: the full command (not the summary — here the
 * exact text is the point), with credential VALUES masked. Display-only: the
 * copy button writes the real command, since a copied command is meant to be
 * run, while a rendered one ends up in screenshots and bug reports.
 */
export function displayCommand(command: string): string {
  return redactCommandSecrets(String(command ?? ""));
}
