/**
 * One-line, human-readable summaries for shell tool calls.
 *
 * Why this exists: a Bash card used to render `input.command` verbatim. Real
 * agent commands are mostly boilerplate — `cd "C:\…\skills\ssh-yiliyun\scripts"
 * && MC_SSH_PASS='…' node run.mjs "echo '=== 找 octopus…'"` — so the collapsed
 * row showed the same 60-character prefix three times and ellipsized away the
 * only part that told the operations apart. The card is a *status line*, not an
 * audit log: it should answer "what is this operation doing", and the exact
 * command stays available one click away in the expanded input pane.
 *
 * Two hard rules:
 *  1. A model-written `description` always wins — it is a sentence about the
 *     intent, which no string surgery on the command can reconstruct.
 *  2. Nothing that looks like a credential is ever rendered. Tool rows are
 *     screenshotted, screen-shared and pasted into issues; a `PASS=` value in
 *     the summary is a leak, not a detail.
 *
 * Pure functions, no imports: the renderer imports them, and
 * `scripts/tool-summary-smoke/run.mjs` imports this file directly under Node's
 * type stripping, so the heuristics are testable without booting Electron.
 */

/** Env-var names whose VALUE must never reach the screen. Matched on the name
 *  only (`MC_SSH_PASS`, `GITHUB_TOKEN`, `AWS_SECRET_ACCESS_KEY`, …); a variable
 *  called `PATH` or `TARGET` keeps its value. */
const SECRET_NAME = /^[A-Za-z0-9_]*(?:PASS(?:WORD|WD)?|TOKEN|SECRET|API[_-]?KEY|ACCESS[_-]?KEY|PRIVATE[_-]?KEY|CREDENTIALS?)[A-Za-z0-9_]*$/i;

/** `NAME=value` anywhere in the command, value optionally quoted. The leading
 *  delimiter is captured so the replacement can put it back. */
const ENV_ASSIGNMENT = /(^|[\s;&|(])([A-Za-z_][A-Za-z0-9_]*)=('[^']*'|"[^"]*"|[^\s;&|)]+)/g;

/** `--password VALUE`, `--token=VALUE`, … — same idea for argv flags. */
const SECRET_FLAG = /(--(?:password|passwd|token|secret|api-key|apikey)(?:=|\s+))("[^"]*"|'[^']*'|[^\s;&|]+)/gi;

/** A value token as it appears in a command: bare, or single/double quoted. */
const VALUE_TOKEN = /^('[^']*'|"[^"]*"|\S+)$/;

/** Segments that carry no information about *what* is being done. `cd` is a
 *  setup step (and is repeated on every call of a session), bare env
 *  assignments are configuration, `true`/`:` are no-ops. */
const BOILERPLATE = [
  /^cd(?:\s|$)/,
  /^(?:[A-Za-z_][A-Za-z0-9_]*=(?:'[^']*'|"[^"]*"|\S+)\s*)+$/,
  /^(?:true|:)$/,
];

/** `<runner> <script> <tail>` — `node run.mjs "echo '…'"`, `bash -lc "…"`.
 *  When the tail is one quoted argument, the interesting text is inside it. */
const RUNNER_WRAPPER = /^(?:node|npx|tsx|ts-node|deno|bun|python3?|bash|sh|zsh|pwsh|powershell|cmd)(?:\.exe)?\s+(?:"[^"]*"|'[^']*'|\S+)\s+(.+)$/i;

/** `echo '…'` / `printf '…'` — the outermost layer of many one-liners. */
const ECHO_WRAPPER = /^(?:echo|printf)\s+(.+)$/i;

/** Longest summary the row carries. The row ellipsizes with CSS anyway; this
 *  keeps the string (and its DOM text node) from carrying a 4 KB one-liner. */
const MAX_SUMMARY = 120;

/** Blank out every credential value in `command`, keeping the name so the row
 *  still says *which* secret was passed. Safe on any string. */
export function redactCommandSecrets(command: string): string {
  if (!command) return "";
  return command
    .replace(ENV_ASSIGNMENT, (match, lead: string, name: string) =>
      SECRET_NAME.test(name) ? `${lead}${name}=***` : match,
    )
    .replace(SECRET_FLAG, "$1***");
}

/**
 * Split on top-level `&&`, `||`, `;` and newlines, ignoring separators inside
 * quotes. A naive `split("&&")` would cut an ssh payload
 * (`node run.mjs "cd /srv && ls"`) in half and leave unbalanced quotes behind.
 */
export function splitTopLevel(command: string): string[] {
  const out: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote) {
      current += ch;
      // Inside double quotes a backslash still escapes (e.g. \").
      if (ch === "\\" && quote === '"' && i + 1 < command.length) current += command[++i];
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === "\n") {
      out.push(current);
      current = "";
      continue;
    }
    if ((ch === "&" || ch === "|") && command[i + 1] === ch) {
      out.push(current);
      current = "";
      i++;
      continue;
    }
    if (ch === ";") {
      out.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  out.push(current);
  return out;
}

/** Strip quotes from a token that is entirely one quoted string. */
function unquote(token: string): string {
  const t = token.trim();
  if (t.length >= 2 && (t[0] === '"' || t[0] === "'") && t[t.length - 1] === t[0] && !t.slice(1, -1).includes(t[0])) {
    return t.slice(1, -1);
  }
  return t;
}

/** Remove leading `NAME=value` tokens from a single segment. */
function stripLeadingEnv(segment: string): string {
  let rest = segment.trim();
  for (;;) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=('[^']*'|"[^"]*"|\S+)\s+/.exec(rest);
    if (!m) return rest;
    rest = rest.slice(m[0].length);
  }
}

/** Peel `node run.mjs "echo '…'"` down to `…`. Returns "" when the shape
 *  doesn't match, so callers can keep the original. */
function unwrapRunner(segment: string): string {
  const wrapper = RUNNER_WRAPPER.exec(segment.trim());
  if (!wrapper) return "";
  const tail = wrapper[1].trim();
  if (!VALUE_TOKEN.test(tail)) return "";
  let inner = unquote(tail);
  const echo = ECHO_WRAPPER.exec(inner);
  if (echo) inner = unquote(echo[1]);
  return inner.trim();
}

/**
 * A display summary for a shell command: boilerplate dropped, secrets masked,
 * one line, bounded length. Falls back to the (redacted) command itself when
 * every segment looked like boilerplate, and never throws on odd input.
 */
export function summarizeCommand(command: string): string {
  const flat = String(command ?? "").replace(/\s+/g, " ").trim();
  if (!flat) return "";
  const redacted = redactCommandSecrets(flat);
  const segments = splitTopLevel(redacted)
    .map((s) => s.trim())
    .filter(Boolean)
    // Drop setup segments; keep at least one so the row is never empty.
    .filter((s, _i, all) => all.length === 1 || !BOILERPLATE.some((re) => re.test(s)));
  const first = segments[0] ?? redacted;
  const stripped = stripLeadingEnv(first) || first;
  const unwrapped = unwrapRunner(stripped);
  const summary = (unwrapped || stripped).trim();
  return summary.length > MAX_SUMMARY ? `${summary.slice(0, MAX_SUMMARY - 1)}…` : summary;
}

/**
 * The Bash/PowerShell row summary: `description` first (intent, in words),
 * otherwise the cleaned command. A description that merely repeats the command
 * is not more informative, so it loses to the summary.
 */
export function shellSummary(input: Record<string, unknown>): string {
  const command = typeof input.command === "string" ? input.command : "";
  const description = typeof input.description === "string" ? input.description.trim() : "";
  const summary = summarizeCommand(command);
  if (description && description !== command) {
    return description.length > MAX_SUMMARY ? `${description.slice(0, MAX_SUMMARY - 1)}…` : description;
  }
  return summary;
}
