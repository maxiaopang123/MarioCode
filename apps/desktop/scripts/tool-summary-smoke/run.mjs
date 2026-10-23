/**
 * Command-summary smoke test — the heuristics behind the operation row's
 * one-line summary (`lib/commandSummary.ts`).
 *
 * No Electron: Node's built-in type stripping imports the renderer module
 * directly, so this runs in well under a second and can be run on every tweak
 * to the regexes. The regression it guards is visual and easy to reintroduce:
 * a Bash row that echoes the boilerplate prefix (`cd "…" && PASS=… node x.mjs
 * "echo '…'"`) instead of what the operation actually does.
 */
import assert from "node:assert/strict";
import { summarizeCommand, shellSummary, redactCommandSecrets, splitTopLevel } from "../../src/renderer/lib/commandSummary.ts";
import {
  displayCommand,
  fileLabel,
  grepTotals,
  groupCounts,
  highlightCommand,
  lineCount,
  modelDescription,
  stepDetail,
  stepKind,
} from "../../src/renderer/lib/stepSummary.ts";

/** The shape from the user's screenshot, with a placeholder credential. */
const SSH = `cd "C:\\Users\\MI\\mariocode\\skills\\ssh-yiliyun\\scripts" && MC_SSH_PASS='s3cret' node run.mjs "echo '=== 找 octopus 中转站的 axonhub 探针配置 ==='"`;

// 1. Credentials never reach the summary, but the variable name survives.
const redacted = redactCommandSecrets(SSH);
assert.ok(!redacted.includes("s3cret"), "secret value is masked");
assert.ok(redacted.includes("MC_SSH_PASS=***"), "secret variable keeps its name");

// 2. A non-credential variable is not touched (PATH/TARGET are diagnostics).
assert.equal(redactCommandSecrets("TARGET=prod npm run build"), "TARGET=prod npm run build");
assert.equal(redactCommandSecrets("node app.js --token=abc123"), "node app.js --token=***");
assert.equal(redactCommandSecrets("node app.js --token 'abc123'"), "node app.js --token ***");

// 3. The row reads as the payload, not as the wrapper.
assert.equal(summarizeCommand(SSH), "=== 找 octopus 中转站的 axonhub 探针配置 ===");

// 4. Three sibling calls now render as three different rows (the bug: all three
//    used to start with the same 60 characters and ellipsize identically).
const variants = ["=== 找 octopus ===", "=== octopus 配置 ===", "=== 运行时 ==="].map((payload) =>
  summarizeCommand(SSH.replace("=== 找 octopus 中转站的 axonhub 探针配置 ===", payload)),
);
assert.equal(new Set(variants).size, 3, "sibling rows stay distinguishable");
assert.deepEqual(variants, ["=== 找 octopus ===", "=== octopus 配置 ===", "=== 运行时 ==="]);

// 5. A model-written description beats any string surgery on the command.
assert.equal(shellSummary({ command: "git status --porcelain", description: "查看工作区改动" }), "查看工作区改动");
assert.equal(shellSummary({ command: "git status --porcelain" }), "git status --porcelain");
// A description that just repeats the command adds nothing.
assert.equal(shellSummary({ command: "ls", description: "ls" }), "ls");

// 6. Ordinary commands pass through unchanged.
assert.equal(summarizeCommand("pnpm -C apps/desktop run build"), "pnpm -C apps/desktop run build");
assert.equal(summarizeCommand("cd /srv && docker compose up -d"), "docker compose up -d");
assert.equal(summarizeCommand("cd /srv"), "cd /srv", "an all-boilerplate command still renders something");

// 7. Quoted separators are not top-level: an ssh payload keeps its `&&`.
assert.deepEqual(splitTopLevel(`node run.mjs "cd /srv && ls" ; echo ok`), [`node run.mjs "cd /srv && ls" `, " echo ok"]);
assert.equal(summarizeCommand(`node run.mjs "cd /srv && ls"`), "cd /srv && ls");

// 8. Bounded length — a 4 KB one-liner must not become a 4 KB text node.
const long = summarizeCommand(`echo ${"x".repeat(2000)}`);
assert.ok(long.length <= 120 && long.endsWith("…"), "long summaries are capped");

// 9. Never throws on junk input.
for (const junk of ["", "   ", "\n\n", undefined, null, 42]) {
  assert.equal(typeof summarizeCommand(junk), "string");
}

/* ── 一步一行：句子层（原型 exec-steps-claude-style，答案 A 规则映射）── */

// 10. Every tool lands in exactly one bucket, both naming conventions.
assert.equal(stepKind("Read"), "read");
assert.equal(stepKind("read"), "read");
assert.equal(stepKind("Bash"), "command");
assert.equal(stepKind("bash"), "command");
assert.equal(stepKind("Grep"), "search");
assert.equal(stepKind("Glob"), "search");
assert.equal(stepKind("find"), "search");
assert.equal(stepKind("Edit"), "write");
assert.equal(stepKind("write"), "write");
assert.equal(stepKind("WebSearch"), "web");
assert.equal(stepKind("TodoWrite"), "tasks");
assert.equal(stepKind("mcp__some-server__do_thing"), "other");

// 11. The group header sentence is built from ordered buckets — two runs with
//     the same tools must read the same way, whatever order they ran in.
const mixed = ["Read", "Bash", "Grep", "Read", "Bash", "Glob"];
assert.deepEqual(groupCounts(mixed), [
  { kind: "search", count: 2 },
  { kind: "command", count: 2 },
  { kind: "read", count: 2 },
]);
assert.deepEqual(groupCounts([...mixed].reverse()), groupCounts(mixed));
assert.deepEqual(groupCounts([]), []);

// 12. A row names its subject, not its schema: basename for files, pattern for
//     searches, the command's payload for shell calls.
assert.equal(fileLabel("apps/desktop/src/main/lib/relayAccountStore.ts"), "relayAccountStore.ts");
assert.equal(fileLabel("C:\\Users\\MI\\Desktop\\MarioCode\\a.ts"), "a.ts");
assert.equal(fileLabel("package.json"), "package.json");
assert.equal(stepDetail("Read", { file_path: "a/b/c.ts" }).value, "c.ts");
assert.equal(stepDetail("read", { path: "a/b/c.ts" }).value, "c.ts");
assert.deepEqual(stepDetail("Grep", { pattern: "APIKeyAuth" }), { kind: "pattern", value: "APIKeyAuth" });
assert.deepEqual(stepDetail("Glob", { pattern: "**/*.go" }), { kind: "glob", value: "**/*.go" });
assert.deepEqual(stepDetail("ls", { path: "src/main" }), { kind: "path", value: "src/main" });
assert.deepEqual(stepDetail("WebSearch", { queries: ["electron ipc"] }), { kind: "query", value: "electron ipc" });
assert.deepEqual(stepDetail("WebFetch", { url: "https://example.com" }), { kind: "url", value: "https://example.com" });
// A shell row reuses the summary layer, so the wrapper is gone and the
// credential is masked — the row never carries either.
const shellRow = stepDetail("Bash", { command: SSH });
assert.equal(shellRow.kind, "command");
assert.ok(!shellRow.value.includes("node run.mjs"), "row drops the runner wrapper");
assert.ok(!shellRow.value.includes("s3cret"), "row never shows the secret value");

// 13. Model-written description wins (answer B); blank falls through to A.
assert.equal(modelDescription({ description: "定位报错文案" }), "定位报错文案");
assert.equal(modelDescription({ description: "   " }), "");
assert.equal(modelDescription(undefined), "");
assert.equal(modelDescription("nope"), "");

// 14. The `$ command` box keeps the FULL command (the summary would shorten
//     it) but masks credential values; the copy button gets the real text.
const shown = displayCommand(SSH);
assert.ok(shown.startsWith("cd "), "the full command is shown, not the summary");
assert.ok(shown.includes("node run.mjs"), "including the runner wrapper");
assert.ok(!shown.includes("s3cret"), "…with the credential masked");
assert.equal(displayCommand(SSH).includes("MC_SSH_PASS=***"), true);

// 15. Highlighting: quoted strings stay whole (a -flag inside quotes is part
//     of the string), only bare -x/--xyz tokens are flagged.
const pieces = highlightCommand(`grep -rn "apikey" internal/server --color=never`);
assert.deepEqual(
  pieces.map((p) => `${p.kind}:${p.text}`),
  ["plain:grep ", "flag:-rn", "plain: ", "string:\"apikey\"", "plain: internal/server ", "flag:--color", "plain:=never"],
);
// A regex full of dashes inside quotes must not be picked apart.
const quotedOnly = highlightCommand(`grep -oP '(?<=\\| 密码 \\|).*' SKILL.md`);
assert.equal(quotedOnly.filter((p) => p.kind === "string").length, 1);
assert.ok(quotedOnly.some((p) => p.kind === "flag" && p.text === "-oP"));

// 16. Result counts behind the right-aligned stats.
assert.equal(lineCount("a\nb\nc"), 3);
assert.equal(lineCount("a\nb\n"), 2, "trailing newline is not a line");
assert.equal(lineCount(""), 0);
assert.deepEqual(grepTotals("renderer/a.ts:12: x\nrenderer/b.ts:40: y"), { matches: 2, files: null });
assert.deepEqual(grepTotals("Found 3 files in 12ms"), { matches: null, files: 3 });

console.log("tool-summary-smoke: all assertions passed");
