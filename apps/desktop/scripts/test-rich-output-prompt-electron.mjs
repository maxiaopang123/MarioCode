/**
 * The rich-output guide (LaTeX / Mermaid / inline HTML) must reach ALL THREE
 * engines, in the same slot, byte-for-byte identical.
 *
 * The renderer test (`test:markdown-render-electron`) proves the capabilities
 * exist; this one proves the model is actually TOLD about them. They are
 * separate failure modes: a prompt that never ships means the features stay
 * invisible, and a prompt that ships to only one engine means the other two
 * keep writing bare text.
 *
 * The check runs through `systemPrompt.preview` — the settings panel's own
 * endpoint — because each provider reaches its prompt text a different way:
 * Claude via `options.systemPrompt.append`, Pi via the `before_agent_start`
 * extension, Codex via a generated `CODEX_HOME/AGENTS.md`. The preview reads
 * those exact constants/files, so it is the one place where all three can be
 * inspected without starting a turn against a real model.
 *
 * Ordering matters too: the guide has to sit AFTER the identity and AFTER the
 * user's standing instructions, else a user who writes "answer in plain text"
 * in 设置 → 系统提示词 gets contradicted by a rule that arrives later.
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { electronTest } from "./electron-test-helper.mjs";

// Markers, one per promise the prompt makes, chosen to be text that cannot
// appear by accident in an unrelated section.
const MARKERS = [
  "## 回复排版与可视化",
  "$...$", // inline math
  "$$", // display math
  "```mermaid", // the fence the renderer switches on
  "handDrawn", // Mermaid look can be selected without opening themeVariables
  "classDef", // the only place the model is allowed to write a diagram colour
  "xychart-beta", // data charts are named outright, not left to paraphrase
  "```html", // visual cards are fenced and rendered as previews
  "<details>", // collapsible raw HTML
  "z-index", // the property the sanitizer drops — the prompt must say so
];

await electronTest(
  "rich-output-prompt",
  async (data) => {
    const db = new DatabaseSync(join(data, "claude-gui.db"));
    db.exec("CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL)");
    for (const [key, value] of Object.entries({
      "mobile.enabled": "0",
      "network.proxy": JSON.stringify({ mode: "direct", customUrl: "" }),
      "ui.titleGenEnabled": "0",
    })) {
      db.prepare("INSERT INTO settings VALUES (?,?)").run(key, value);
    }
    db.close();
  },
  async ({ evaluate }) => {
    const preview = (providerId) =>
      evaluate(
        `window.api.systemPrompt.preview({providerId:${JSON.stringify(providerId)},projectPath:null})`,
      );
    const sectionAt = (result, id) => {
      const index = result.sections.findIndex((section) => section.id === id);
      assert.notEqual(index, -1, `${result.providerId}: no ${id} layer (got ${result.sections.map((s) => s.id).join(",")})`);
      return { index, text: result.sections[index].text };
    };

    /* ── Claude: own layer, in the identity→tool-guides slot ───────────── */
    // Position is asserted by ORDER, not by arithmetic: the two user layers
    // (`user.global` / `user.project`) always occupy slots even when unset —
    // their text is null — so "identity + 1" would be the empty user layer,
    // not the guide.
    const claude = await preview("claude-sdk");
    const claudeFormat = sectionAt(claude, "output.format");
    const claudeIdentity = sectionAt(claude, "identity");
    const claudePlan = sectionAt(claude, "claude.planNudge");
    assert.ok(
      claudeFormat.index > claudeIdentity.index,
      "Claude: the guide comes after the identity",
    );
    assert.ok(
      claudeFormat.index < claudePlan.index,
      "Claude: the guide comes before the plan-mode / tool guidance",
    );
    for (const marker of MARKERS) {
      assert.ok(claudeFormat.text.includes(marker), `Claude guide mentions ${JSON.stringify(marker)}`);
    }

    /* ── Pi: same layer, same text ─────────────────────────────────────── */
    const pi = await preview("pi-sdk");
    const piFormat = sectionAt(pi, "output.format");
    const piIdentity = sectionAt(pi, "identity");
    const piPlan = sectionAt(pi, "pi.plan");
    assert.ok(piFormat.index > piIdentity.index, "Pi: the guide comes after the identity");
    assert.ok(piFormat.index < piPlan.index, "Pi: the guide comes before the plan tool guide");
    assert.equal(piFormat.text, claudeFormat.text, "Pi and Claude inject the identical guide");

    /* ── Codex: baked into AGENTS.md, not a separate layer ─────────────── */
    const codex = await preview("codex-sdk");
    const agents = sectionAt(codex, "codex.agentsHome");
    for (const marker of MARKERS) {
      assert.ok(agents.text.includes(marker), `Codex AGENTS.md mentions ${JSON.stringify(marker)}`);
    }
    // Position inside the generated file: after the identity heading, before
    // the plan-mode tool guide.
    const at = (needle) => {
      const index = agents.text.indexOf(needle);
      assert.notEqual(index, -1, `Codex AGENTS.md is missing ${JSON.stringify(needle)}`);
      return index;
    };
    assert.ok(at("## 你的身份") < at("## 回复排版与可视化"), "Codex: guide comes after the identity");
    assert.ok(at("## 回复排版与可视化") < at("## 计划模式工具"), "Codex: guide comes before the tool guides");
    assert.equal(
      agents.text.includes(claudeFormat.text),
      true,
      "Codex embeds the very same section text",
    );
  },
);
