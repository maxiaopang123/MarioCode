/**
 * 工具整页真应用冒烟(V4 · TODO-044):隔离 userData 启动真 Electron 应用,
 * 经 CDP 点侧栏「技能与 MCP」「定时任务」,核对整页打开 / 标签切换 / 与画布
 * 和设置浮窗互斥 / 再点或 Esc 关闭,并截图(明暗跟随系统)。运行前需先 `pnpm build`。
 *
 *   node apps/desktop/scripts/test-toolpage-electron.mjs
 */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { electronTest } from "./electron-test-helper.mjs";

await electronTest("toolpage-check", async () => {}, async ({ data, command, evaluate, wait, errors }) => {
  const shot = async (name) => {
    const png = await command("Page.captureScreenshot", { format: "png" });
    await writeFile(join(data, `${name}.png`), Buffer.from(png.data, "base64"));
  };
  const click = (nav) => evaluate(`document.querySelector('[data-nav=${nav}]').click()`);
  const pageTitle = () => evaluate(`document.querySelector('.settings-root h2')?.textContent ?? null`);
  const assert = (cond, msg) => { if (!cond) throw Error(msg); };

  // 技能与 MCP:整页打开,标题正确,不是设置浮窗(没有 role=dialog)。
  await click("skills");
  await wait(`document.querySelector('.settings-root main.settings-content') != null`);
  assert((await pageTitle()) === "技能与 MCP", `skills page title: ${await pageTitle()}`);
  assert(await evaluate(`document.querySelector('[role=dialog].settings-root') == null`), "skills must be a page, not the settings dialog");
  await shot("01-skills");

  // 技能 / MCP 标签切换。
  await evaluate(`[...document.querySelectorAll('.settings-root header button')].find(b => b.textContent.trim() === 'MCP').click()`);
  await wait(`[...document.querySelectorAll('.settings-root header button')].some(b => b.textContent.trim() === 'MCP' && b.getAttribute('aria-pressed') === 'true')`);
  await shot("02-mcp");

  // 再点同一行关闭,回到聊天。
  await click("skills");
  await wait(`document.querySelector('.settings-root') == null`);

  // 定时任务整页;与技能页互斥(同一时刻只有一个整页)。
  await click("scheduled");
  await wait(`document.querySelector('.settings-root h2')?.textContent === '定时任务'`);
  assert(await evaluate(`document.querySelectorAll('.settings-root').length === 1`), "exactly one tool page at a time");
  await shot("03-scheduled");

  // 直接切到技能:替换而不是叠加。
  await click("skills");
  await wait(`document.querySelector('.settings-root h2')?.textContent === '技能与 MCP'`);

  // 打开画布 → 工具整页自动关闭。
  await click("canvas");
  await wait(`document.querySelector('[data-canvas-view]') != null`);
  assert(await evaluate(`document.querySelector('.settings-root') == null`), "canvas must close the tool page");
  await click("canvas");

  // Esc 关闭整页。
  await click("scheduled");
  await wait(`document.querySelector('.settings-root') != null`);
  await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await wait(`document.querySelector('.settings-root') == null`);

  if (errors.length) throw Error(`renderer exceptions: ${errors.join(" | ")}`);
});
