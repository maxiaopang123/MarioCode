/**
 * 画布工作台离线冒烟(TODO-033/041 + TODO-049)。
 *
 * 覆盖:
 *  - canvas_images 表迁移存在;
 *  - storeGenerated / storeDerived / importFiles 的入库与范围过滤;
 *  - 派生链(parentId / chainId / descendants)与连带删除(文件进 .trash);
 *  - cropImage 的越界选区钳制(不抛错,正常入库);
 *  - registerSessionImage:会话生成图登记进项目图库且不复制文件;
 *  - imageApi:文生图请求体字段、edit 的 multipart(带/不带 mask)、
 *    上游 HTTP 错误翻成中文 ImageApiError。
 *
 * 运行环境:ELECTRON_RUN_AS_NODE=1 的 electron(node 语义 + Electron ABI,
 * 与 better-sqlite3 的 Electron 预编译匹配)。nativeImage 是 IHDR 桩,不断言
 * 真实像素。
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.SMOKE_USER_DATA = mkdtempSync(join(tmpdir(), "mc-canvas-ud-"));
process.env.SMOKE_PICTURES = mkdtempSync(join(tmpdir(), "mc-canvas-pic-"));

const { initDb, closeDb, getDb } = await import("../../src/main/store/db.js");
const canvasStore = await import("../../src/main/canvas/canvasStore.js");
const imageApi = await import("../../src/main/canvas/imageApi.js");

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    passed++;
    console.log(`  ok ${name}`);
  } else {
    failed++;
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

/** 最小 PNG 头(IHDR 宽高可被桩读出;内容不是合法位图,像素无关)。 */
function fakePng(w: number, h: number): Buffer {
  const buf = Buffer.alloc(33);
  buf.write("\x89PNG\r\n\x1a\n", 0, "binary");
  buf.writeUInt32BE(13, 8);
  buf.write("IHDR", 12, "ascii");
  buf.writeUInt32BE(w, 16);
  buf.writeUInt32BE(h, 20);
  return buf;
}

await initDb();

/* ── 迁移与仓储 ── */
console.log("canvas_images schema + repo");
{
  const cols = getDb().prepare("PRAGMA table_info(canvas_images)").all() as Array<{ name: string }>;
  const names = new Set(cols.map((c) => c.name));
  check(
    "canvas_images 表含全部列",
    ["id", "name", "kind", "scope", "project_id", "parent_id", "chain_id", "prompt", "file_path", "width", "height", "deleted_at", "created_at"].every((c) =>
      names.has(c),
    ),
  );
  getDb()
    .prepare("INSERT INTO projects (id, name, path, archived, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)")
    .run("p1", "项目一", "C:/proj/one", 1, 1);
  getDb()
    .prepare(
      "INSERT INTO sessions (id, project_id, provider_id, title, status, model, permission_mode, created_at, updated_at) VALUES (?, ?, 'claude-sdk', ?, 'idle', 'm', 'default', 1, 1)",
    )
    .run("s1", "p1", "会话一");
}

/* ── 入库与范围过滤 ── */
console.log("store / scope / chain");
const genGlobal = canvasStore.storeGenerated("global", null, fakePng(64, 32), "image/png", "一只在雨里的猫");
check("文生图入库:名字取提示词截断", genGlobal.name === "一只在雨里的猫");
check("文生图入库:尺寸读自 IHDR", genGlobal.width === 64 && genGlobal.height === 32);
check("文生图入库:chainId = 自身", genGlobal.chainId === genGlobal.id);
check("文生图入库:文件落盘", existsSync(genGlobal.filePath));

const genProj = canvasStore.storeGenerated("project", "p1", fakePng(32, 32), "image/png", "项目图");
check("独立图库只看 global", canvasStore.CanvasImageRepo.list("global", null).length === 1);
check("项目图库按 projectId 过滤", canvasStore.CanvasImageRepo.list("project", "p1").length === 1);
check("项目图库不含其它项目", canvasStore.CanvasImageRepo.list("project", "nope").length === 0);

const derived = canvasStore.storeDerived(genGlobal, fakePng(64, 32), "image/png", "把天空变红", "局部重绘");
check("派生版本:parentId / chainId 继承", derived.parentId === genGlobal.id && derived.chainId === genGlobal.chainId);
check("派生版本:名字带后缀", derived.name.includes("局部重绘") && derived.name.includes(genGlobal.name));
check("派生版本:kind = derived", derived.kind === "derived");
const derived2 = canvasStore.storeDerived(derived, fakePng(16, 16), "image/png", "切图 16×16", "切图");
const desc = canvasStore.CanvasImageRepo.descendants(genGlobal.id).map((i) => i.id);
check("后代递归:两代都在", desc.includes(derived.id) && desc.includes(derived2.id));

/* ── 切图钳制 ── */
console.log("crop");
{
  const png = canvasStore.cropImage(genGlobal, { x: -5, y: 10, width: 9999, height: 20 });
  const cropped = canvasStore.storeDerived(genGlobal, png, "image/png", "切图", "切图");
  check("越界选区钳制后正常入库", cropped.parentId === genGlobal.id);
}

/* ── 导入 ── */
console.log("import");
{
  const srcDir = mkdtempSync(join(tmpdir(), "mc-canvas-src-"));
  const pngPath = join(srcDir, "photo.png");
  writeFileSync(pngPath, fakePng(100, 50));
  const txtPath = join(srcDir, "note.txt");
  writeFileSync(txtPath, "not an image");
  const imported = canvasStore.importFiles("global", null, [pngPath, txtPath]);
  check("导入:只收图片扩展名", imported.length === 1);
  check("导入:复制进图库,源文件不动", existsSync(pngPath) && imported[0].filePath !== pngPath && existsSync(imported[0].filePath));
  check("导入:kind = imported,提示词空", imported[0].kind === "imported" && imported[0].prompt === "");
  rmSync(srcDir, { recursive: true, force: true });
}

/* ── 会话图片登记 ── */
console.log("session image registration");
{
  const sessionImgPath = join(process.env.SMOKE_PICTURES, "session-turn.png");
  writeFileSync(sessionImgPath, fakePng(80, 80));
  canvasStore.registerSessionImage("s1", sessionImgPath, "会话里生成的图");
  const projList = canvasStore.CanvasImageRepo.list("project", "p1");
  const row = projList.find((i) => i.filePath === sessionImgPath);
  check("会话图进项目图库", !!row && row.scope === "project" && row.projectId === "p1");
  check("会话图不复制文件(指向原路径)", !!row && row.filePath === sessionImgPath);
  check("未知会话静默跳过", (canvasStore.registerSessionImage("nope", sessionImgPath, "x"), projList.length === 2));
}

/* ── 连带删除 ── */
console.log("delete with descendants");
{
  const before = canvasStore.CanvasImageRepo.list("global", null).length;
  canvasStore.deleteWithDescendants(genGlobal.id);
  const after = canvasStore.CanvasImageRepo.list("global", null);
  check("删除连带全部后代", after.length === before - 4, `before=${before} after=${after.length}`);
  const trashDir = join(process.env.SMOKE_PICTURES, "MarioCode-Gallery", ".trash");
  check("原图文件移入 .trash", !existsSync(genGlobal.filePath) && existsSync(join(trashDir, `img_${genGlobal.id}.png`)));
  check("get 过滤已删行", canvasStore.CanvasImageRepo.get(genGlobal.id) === null);
}

/* ── 重命名 ── */
canvasStore.CanvasImageRepo.rename(genProj.id, "新名字");
check("重命名", canvasStore.CanvasImageRepo.get(genProj.id)?.name === "新名字");

/* ── imageApi:文生图 / 编辑 / 错误 ── */
console.log("imageApi");
{
  const requests: Array<{ url: string; body: Buffer; contentType: string }> = [];
  const png8 = fakePng(8, 8);
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      requests.push({
        url: req.url ?? "",
        body: Buffer.concat(chunks),
        contentType: String(req.headers["content-type"] ?? ""),
      });
      if (req.url?.includes("fail")) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "model not found" } }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ b64_json: png8.toString("base64"), revised_prompt: "改写后的提示词" }] }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  process.env.SMOKE_IMAGE_BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const gen = await imageApi.canvasGenerateImage("a cat", "1024x1024");
  check("文生图:返回字节与 mime", gen.buf.equals(png8) && gen.mimeType === "image/png");
  const genReq = requests.find((r) => r.url.endsWith("/images/generations"));
  const genJson = JSON.parse(genReq?.body.toString("utf8") ?? "{}") as Record<string, unknown>;
  check(
    "文生图:请求体字段",
    !!genReq && genJson.model === "smoke-image-1" && genJson.prompt === "a cat" && genJson.n === 1 && genJson.size === "1024x1024",
  );
  check("文生图:revised_prompt 透传", gen.revisedPrompt === "改写后的提示词");

  const imgPng = fakePng(64, 64);
  const maskPng = fakePng(64, 64);
  await imageApi.canvasEditImage("make it red", imgPng, maskPng);
  const editReq = requests.find((r) => r.url.endsWith("/images/edits"));
  const editBody = editReq?.body.toString("latin1") ?? "";
  check("编辑:multipart 编码", !!editReq && editReq.contentType.startsWith("multipart/form-data; boundary="));
  check("编辑:带 mask 时有 mask 文件字段", editBody.includes('name="mask"') && editBody.includes('name="image"') && editBody.includes('name="prompt"'));

  await imageApi.canvasEditImage("make it blue", imgPng, null);
  const editReq2 = requests.filter((r) => r.url.endsWith("/images/edits"))[1];
  const editBody2 = editReq2?.body.toString("latin1") ?? "";
  check("编辑:整图变换不带 mask", !!editReq2 && !editBody2.includes('name="mask"') && editBody2.includes('name="image"'));

  let errMsg = "";
  try {
    process.env.SMOKE_IMAGE_BASE = `${process.env.SMOKE_IMAGE_BASE}/fail`;
    await imageApi.canvasGenerateImage("boom");
  } catch (err) {
    errMsg = err instanceof Error ? err.message : String(err);
  }
  check("上游 400 翻成中文错误", errMsg.includes("HTTP 400") && errMsg.includes("model not found"), errMsg);

  server.close();
}

closeDb();
rmSync(process.env.SMOKE_USER_DATA, { recursive: true, force: true });
rmSync(process.env.SMOKE_PICTURES, { recursive: true, force: true });

console.log(`\n${failed === 0 ? "PASS" : "FAIL"} — ${passed} 通过,${failed} 失败`);
process.exit(failed === 0 ? 0 : 1);
