/**
 * 画布工作台端到端冒烟(TODO-033/041 + TODO-049):隔离 userData 启动真
 * Electron 应用 + 本地 mock images API(纯 JS 编码真实 PNG),走通:
 * 配置共享提供商与图片工具 → 文生图(count=2)→ 图库出现 → 画布编辑 →
 * 真实鼠标涂抹蒙版 → 蒙版重绘(images/edits multipart)→ 切图(真实裁剪)
 * → 派生链 → 图库删除(确认对话框)。
 *
 *   node apps/desktop/scripts/test-canvas-electron-e2e.mjs
 */
import { createServer } from "node:http";
import { deflateSync } from "node:zlib";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { electronTest } from "./electron-test-helper.mjs";

/* ── 纯 JS PNG 编码(真实可解码位图,渐变填色) ── */
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function makePng(w, h, rgb) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type RGB
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    const row = y * (w * 3 + 1);
    raw[row] = 0;
    for (let x = 0; x < w; x++) {
      const o = row + 1 + x * 3;
      raw[o] = (rgb[0] + x) % 256;
      raw[o + 1] = (rgb[1] + y) % 256;
      raw[o + 2] = rgb[2];
    }
  }
  return Buffer.concat([
    Buffer.from("\x89PNG\r\n\x1a\n", "binary"),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

const genPng = makePng(256, 160, [40, 90, 140]);
const editPng = makePng(256, 160, [140, 60, 40]);

const server = createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const isEdit = (req.url ?? "").endsWith("/images/edits");
    const png = isEdit ? editPng : genPng;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: [{ b64_json: png.toString("base64") }] }));
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;

try {
  await electronTest("canvas-e2e", async () => {}, async ({ data, command, evaluate, wait, errors }) => {
    const shot = async (name) => {
      const png = await command("Page.captureScreenshot", { format: "png" });
      await writeFile(join(data, `${name}.png`), Buffer.from(png.data, "base64"));
    };
    const mouse = (type, x, y) =>
      command("Input.dispatchMouseEvent", {
        type, x, y, button: "left",
        buttons: type === "mouseReleased" ? 0 : 1,
        clickCount: type === "mouseMoved" ? 0 : 1,
        pointerType: "mouse",
      });

    // ① 配置:共享提供商(mock server)+ 内置工具图片来源。
    const saved = await evaluate(`window.api.sharedProviders.save({
      name: "Mock Images", baseUrl: "http://127.0.0.1:${port}",
      protocols: ["chat-completions"],
      models: [{ id: "mock-image", imageGeneration: true }],
      enabledAgents: ["claude"], apiKey: "k",
    })`);
    const providerId = saved.providers.find((p) => p.name === "Mock Images")?.id;
    if (!providerId) throw Error("provider save failed");
    const tools = await evaluate(`window.api.builtinTools.save({ config: {
      search: { backend: "bing", maxResults: 5 },
      fetch: { maxChars: 5000 },
      image: { source: "${providerId}", model: "mock-image", size: "1024x1024" },
    } })`);
    if (!tools.ok || tools.state.imageIssue) throw Error(`image endpoint not ready: ${tools.state?.imageIssue}`);

    // ② 打开画布 → 文生图 2 张。
    await evaluate(`document.querySelector('nav[aria-label] button:has(.tabler-icon-palette)').click()`);
    await wait(`document.querySelector('[data-canvas-view="t2i"]') != null`);
    await wait(`!document.body.textContent.includes("还没有配置图片模型")`); // 配置后引导条消失
    await evaluate(`(() => {
      const ta = document.querySelector('[data-canvas-view="t2i"] textarea');
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
      setter.call(ta, "一只在雨里的猫");
      ta.dispatchEvent(new Event("input", { bubbles: true }));
      [...document.querySelectorAll('[data-canvas-view="t2i"] button')].find(b => b.textContent.trim() === "2").click();
    })()`);
    await evaluate(`[...document.querySelectorAll('[data-canvas-view="t2i"] button')].find(b => b.textContent.includes("生成图片")).click()`);
    await wait(`document.querySelectorAll('[data-canvas-view="t2i"] img').length >= 2`);
    const listAfterGen = await evaluate(`window.api.canvas.list({ scope: "global" })`);
    if (listAfterGen.images.length !== 2) throw Error(`expected 2 images, got ${listAfterGen.images.length}`);
    await shot("01-t2i-results");

    // ③ 点结果图 → 画布编辑。
    await evaluate(`document.querySelector('[data-canvas-view="t2i"] .group').click()`);
    await wait(`document.querySelector('[data-canvas-view="edit"] img') != null`);

    // ④ 真实鼠标在蒙版画布上涂抹一笔。
    const box = await evaluate(`(() => {
      const r = document.querySelector('[data-canvas-view="edit"] canvas').getBoundingClientRect();
      return { x: r.left, y: r.top, w: r.width, h: r.height };
    })()`);
    await mouse("mousePressed", box.x + box.w * 0.4, box.y + box.h * 0.4);
    await mouse("mouseMoved", box.x + box.w * 0.5, box.y + box.h * 0.5);
    await mouse("mouseMoved", box.x + box.w * 0.6, box.y + box.h * 0.6);
    await mouse("mouseReleased", box.x + box.w * 0.6, box.y + box.h * 0.6);
    const maskCount = await evaluate(`document.body.textContent.includes("已涂抹 1 处")`);
    if (!maskCount) throw Error("paint stroke did not register (已涂抹 1 处 missing)");
    await shot("02-edit-mask");

    // ⑤ 填编辑提示词 → 蒙版重绘(multipart images/edits)。
    await evaluate(`(() => {
      const ta = document.querySelector('[data-canvas-view="edit"] aside textarea');
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
      setter.call(ta, "把天空改成火烧云");
      ta.dispatchEvent(new Event("input", { bubbles: true }));
    })()`);
    await evaluate(`[...document.querySelectorAll('[data-canvas-view="edit"] button')].find(b => b.textContent.includes("生成编辑结果")).click()`);
    await wait(`window.api.canvas.list({ scope: "global" }).then(r => r.images.length === 3)`);
    await shot("03-edit-inpaint-done");

    // ⑥ 切图:进切图模式 → 应用(默认居中 70% 选框)。
    await evaluate(`[...document.querySelectorAll('[data-canvas-view="edit"] button')].find(b => b.title.includes("切图")).click()`);
    await wait(`[...document.querySelectorAll("button")].some(b => b.textContent.includes("应用切图"))`);
    await evaluate(`[...document.querySelectorAll("button")].find(b => b.textContent.includes("应用切图")).click()`);
    await wait(`window.api.canvas.list({ scope: "global" }).then(r => r.images.length === 4)`);
    const afterCrop = await evaluate(`window.api.canvas.list({ scope: "global" })`);
    const cropRow = afterCrop.images.find((i) => i.prompt.startsWith("切图"));
    if (!cropRow) throw Error("crop-derived image missing");
    // 256×160 的 70% ≈ 179×112(nativeImage 真实裁剪,与显示缩放换算一致)。
    if (cropRow.width < 170 || cropRow.width > 190 || cropRow.height < 100 || cropRow.height > 125) {
      throw Error(`unexpected crop dims ${cropRow.width}x${cropRow.height}`);
    }
    if (cropRow.kind !== "derived") throw Error("crop row should be derived");
    // 派生链:原图 + 重绘 + 切图同链。
    const chainIds = new Set(afterCrop.images.filter((i) => i.kind === "derived").map((i) => i.chainId));
    if (chainIds.size !== 1) throw Error("derived images should share one chain");
    await shot("04-edit-crop-done");

    // ⑦ 图库:4 张卡 + 删除确认。
    await evaluate(`[...document.querySelectorAll("button")].find(b => b.textContent.trim() === "图库").click()`);
    await wait(`document.querySelectorAll('[data-canvas-view="gallery"] .group').length >= 4`);
    await shot("05-gallery");
    // 第一张卡 = 最新(切图派生),无后代 → 删后剩 3 张。
    await evaluate(`[...document.querySelectorAll('[data-canvas-view="gallery"] button')].find(b => b.title.includes("删除")).click()`);
    await wait(`document.body.textContent.includes("及其派生链上的全部后续版本")`);
    await shot("06-delete-confirm");
    await evaluate(`(() => {
      const btns = [...document.querySelectorAll("button")].filter(b => b.textContent.trim() === "删除");
      btns[btns.length - 1].click();
    })()`);
    await wait(`window.api.canvas.list({ scope: "global" }).then(r => r.images.length === 3)`);

    if (errors.length) throw Error(`renderer exceptions: ${errors.join(" | ")}`);
  });
} finally {
  server.close();
}
