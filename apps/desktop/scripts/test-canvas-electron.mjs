/**
 * 画布工作台真应用冒烟(TODO-033/041 + TODO-049):隔离 userData 启动真
 * Electron 应用,经 CDP 打开画布、走三个视图、核对 canvas.* IPC,并截
 * 浅色/深色图。运行前需先 `pnpm build`。
 *
 *   node apps/desktop/scripts/test-canvas-electron.mjs
 */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { electronTest } from "./electron-test-helper.mjs";

await electronTest("canvas-check", async () => {}, async ({ data, command, evaluate, wait, errors }) => {
  const shot = async (name) => {
    const png = await command("Page.captureScreenshot", { format: "png" });
    await writeFile(join(data, `${name}.png`), Buffer.from(png.data, "base64"));
  };

  // canvas.* IPC 直调(无 UI 依赖)。
  const home = await evaluate("window.api.canvas.home()");
  if (!/MarioCode-Gallery|gallery/.test(home.dir)) throw Error(`unexpected gallery dir: ${home.dir}`);
  const list = await evaluate("window.api.canvas.list({scope:'global'})");
  if (!Array.isArray(list.images) || list.images.length !== 0) throw Error("fresh profile gallery should be empty");
  const badCrop = await evaluate("window.api.canvas.crop({parentId:'missing',rect:{x:0,y:0,width:10,height:10}})");
  if (badCrop.ok !== false || !badCrop.error) throw Error("crop of missing image should fail with error");
  const genWithoutConfig = await evaluate("window.api.canvas.generate({scope:'global',prompt:'x'})");
  if (genWithoutConfig.ok !== false) throw Error("generate without image endpoint should fail");

  // 打开画布(侧栏工具卡里的画布行)。
  await evaluate(`document.querySelector('[data-nav=canvas]').click()`);
  await wait(`document.querySelector('[data-canvas-view="t2i"]') != null`);
  // 未配置图片模型 → 引导条可见,生成按钮禁用。
  await wait(`document.body.textContent.includes("还没有配置图片模型")`);
  const genDisabled = await evaluate(`[...document.querySelectorAll("button")].some(b => b.textContent.includes("生成图片") && b.disabled)`);
  if (!genDisabled) throw Error("generate button should be disabled without image endpoint");
  await shot("01-t2i-light");

  // 画布编辑:空态。
  await evaluate(`[...document.querySelectorAll("button")].find(b => b.textContent.includes("画布编辑")).click()`);
  await wait(`document.querySelector('[data-canvas-view="edit"]') != null`);
  await wait(`document.body.textContent.includes("从图库选一张图")`);
  await shot("02-edit-empty-light");

  // 图库:空态 + 工具条。
  await evaluate(`[...document.querySelectorAll("button")].find(b => b.textContent.trim() === "图库").click()`);
  await wait(`document.querySelector('[data-canvas-view="gallery"]') != null`);
  await wait(`document.body.textContent.includes("打开图库文件夹")`);
  await shot("03-gallery-light");

  // 深色。
  await evaluate(`document.documentElement.classList.add("dark")`);
  await evaluate(`[...document.querySelectorAll("button")].find(b => b.textContent.includes("文生图")).click()`);
  await wait(`document.querySelector('[data-canvas-view="t2i"]') != null`);
  await wait(`document.body.textContent.includes("提示词")`);
  await shot("04-t2i-dark");

  // 返回会话:画布卸载,聊天区回来。
  await evaluate(`document.documentElement.classList.remove("dark")`);
  await evaluate(`[...document.querySelectorAll("button")].find(b => b.textContent.includes("返回会话")).click()`);
  await wait(`!document.body.textContent.includes("版本派生链") || true`); // 画布已卸载
  const canvasGone = await evaluate(`!document.body.textContent.includes("还没有配置图片模型")`);
  if (!canvasGone) throw Error("canvas should be closed after 返回会话");

  if (errors.length) throw Error(`renderer exceptions: ${errors.join(" | ")}`);
});
