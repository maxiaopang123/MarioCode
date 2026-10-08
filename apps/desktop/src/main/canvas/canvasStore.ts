/**
 * 画布工作台的图库存储(文件 + canvas_images 表)。
 *
 * 文件落在图库根目录(设置 `canvas.galleryDir`,空 = 系统「图片」/
 * MarioCode-Gallery)下,按范围分目录:shared/(独立图库)或
 * projects/<projectId>/(项目图库);文件名 `img_<id>.<ext>`,id 即表主键。
 * 删除是软删除:行打 deleted_at、文件移入 `<root>/.trash/`(原图可找回),
 * 列表与读取都过滤已删行。派生链:derived 行的 parentId 指来源图、chainId
 * 指链根(首图为自身 id),删除一张图会连带删掉它的全部后代版本。
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { app, nativeImage } from "electron";
import {
  BROWSER_SCREENSHOT_DIR_SETTING_KEY,
  CANVAS_GALLERY_DIR_SETTING_KEY,
  type CanvasImage,
  type CanvasImageKind,
  type CanvasImageScope,
} from "@contracts/ipc";
import { getDb } from "@main/store/db.js";
import { SessionRepo, SettingRepo } from "@main/store/repositories.js";
import { log } from "@main/lib/logger.js";

/* ── 图库目录 ── */

export function defaultGalleryDir(): string {
  try {
    return join(app.getPath("pictures"), "MarioCode-Gallery");
  } catch {
    // 隔离/精简环境里 known-folder 可能解析不出来(测试 profile 即如此),
    // 退到 userData 下,画布永不因目录解析失败而不可用。
    return join(app.getPath("userData"), "gallery");
  }
}

/** 生效的图库根目录(用户设置优先,空 = 默认)。 */
export function resolveGalleryDir(): string {
  const custom = SettingRepo.get(CANVAS_GALLERY_DIR_SETTING_KEY)?.trim();
  return custom || defaultGalleryDir();
}

function scopeDir(scope: CanvasImageScope, projectId: string | null): string {
  const root = resolveGalleryDir();
  return scope === "project" && projectId
    ? join(root, "projects", projectId.replace(/[^\w.-]/g, "_"))
    : join(root, "shared");
}

function extForMime(mimeType: string): string {
  if (mimeType.includes("jpeg") || mimeType.includes("jpg")) return ".jpg";
  if (mimeType.includes("webp")) return ".webp";
  if (mimeType.includes("gif")) return ".gif";
  return ".png";
}

const IMAGE_EXT_RE = /^\.(png|jpe?g|webp|gif|bmp)$/i;

/* ── canvas_images 表 ── */

interface CanvasImageRow {
  id: string;
  name: string;
  kind: string;
  scope: string;
  project_id: string | null;
  parent_id: string | null;
  chain_id: string;
  prompt: string;
  file_path: string;
  width: number;
  height: number;
  deleted_at: number | null;
  created_at: number;
}

function rowToImage(r: CanvasImageRow): CanvasImage {
  return {
    id: r.id,
    name: r.name,
    kind: r.kind as CanvasImageKind,
    scope: r.scope as CanvasImageScope,
    projectId: r.project_id,
    parentId: r.parent_id,
    chainId: r.chain_id,
    prompt: r.prompt,
    filePath: r.file_path,
    width: r.width,
    height: r.height,
    createdAt: r.created_at,
  };
}

function insertImage(img: CanvasImage): void {
  getDb()
    .prepare(
      `INSERT INTO canvas_images
       (id, name, kind, scope, project_id, parent_id, chain_id, prompt, file_path, width, height, deleted_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
    )
    .run(
      img.id,
      img.name,
      img.kind,
      img.scope,
      img.projectId,
      img.parentId,
      img.chainId,
      img.prompt,
      img.filePath,
      img.width,
      img.height,
      img.createdAt,
    );
}

export const CanvasImageRepo = {
  get(id: string): CanvasImage | null {
    const row = getDb()
      .prepare("SELECT * FROM canvas_images WHERE id = ? AND deleted_at IS NULL")
      .get(id) as CanvasImageRow | undefined;
    return row ? rowToImage(row) : null;
  },

  list(scope: CanvasImageScope, projectId: string | null): CanvasImage[] {
    const rows = (
      scope === "project"
        ? getDb()
            .prepare(
              "SELECT * FROM canvas_images WHERE scope = 'project' AND project_id = ? AND deleted_at IS NULL ORDER BY created_at DESC",
            )
            .all(projectId)
        : getDb()
            .prepare(
              "SELECT * FROM canvas_images WHERE scope = 'global' AND deleted_at IS NULL ORDER BY created_at DESC",
            )
            .all()
    ) as CanvasImageRow[];
    return rows.map(rowToImage);
  },

  /** 该图的全部后代版本(沿 parentId 递归,含跨代)。 */
  descendants(id: string): CanvasImage[] {
    const out: CanvasImage[] = [];
    let frontier = [id];
    while (frontier.length > 0) {
      const marks = frontier.map(() => "?").join(", ");
      const rows = getDb()
        .prepare(`SELECT * FROM canvas_images WHERE parent_id IN (${marks}) AND deleted_at IS NULL`)
        .all(...frontier) as CanvasImageRow[];
      const imgs = rows.map(rowToImage);
      out.push(...imgs);
      frontier = imgs.map((i) => i.id);
    }
    return out;
  },

  softDelete(ids: string[]): void {
    if (ids.length === 0) return;
    const marks = ids.map(() => "?").join(", ");
    getDb()
      .prepare(`UPDATE canvas_images SET deleted_at = ? WHERE id IN (${marks})`)
      .run(Date.now(), ...ids);
  },

  rename(id: string, name: string): void {
    getDb().prepare("UPDATE canvas_images SET name = ? WHERE id = ?").run(name, id);
  },
};

/* ── 文件操作 ── */

function imageDimensions(buf: Buffer): { width: number; height: number } {
  const img = nativeImage.createFromBuffer(buf);
  return img.isEmpty() ? { width: 0, height: 0 } : img.getSize();
}

/** 写入图库并登记一行的公共出口。 */
function storeImage(input: {
  kind: CanvasImageKind;
  scope: CanvasImageScope;
  projectId: string | null;
  parentId: string | null;
  chainId: string | null;
  prompt: string;
  name: string;
  buf: Buffer;
  ext: string;
}): CanvasImage {
  const id = randomUUID();
  const dir = scopeDir(input.scope, input.projectId);
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, `img_${id}${input.ext}`);
  writeFileSync(filePath, input.buf);
  const dims = imageDimensions(input.buf);
  const img: CanvasImage = {
    id,
    name: input.name,
    kind: input.kind,
    scope: input.scope,
    projectId: input.projectId,
    parentId: input.parentId,
    chainId: input.chainId ?? id,
    prompt: input.prompt,
    filePath,
    width: dims.width,
    height: dims.height,
    createdAt: Date.now(),
  };
  insertImage(img);
  return img;
}

/** 文生图产物入库。 */
export function storeGenerated(
  scope: CanvasImageScope,
  projectId: string | null,
  buf: Buffer,
  mimeType: string,
  prompt: string,
): CanvasImage {
  const name = prompt.replace(/\s+/g, " ").trim().slice(0, 24) || "生成图片";
  return storeImage({ kind: "generated", scope, projectId, parentId: null, chainId: null, prompt, name, buf, ext: extForMime(mimeType) });
}

/** 派生新版本(edit / 切图):继承父图的范围与派生链,原图保留。 */
export function storeDerived(parent: CanvasImage, buf: Buffer, mimeType: string, prompt: string, nameSuffix: string): CanvasImage {
  const name = `${parent.name} · ${nameSuffix}`;
  return storeImage({
    kind: "derived",
    scope: parent.scope,
    projectId: parent.projectId,
    parentId: parent.id,
    chainId: parent.chainId,
    prompt,
    name: name.slice(0, 200),
    buf,
    ext: extForMime(mimeType),
  });
}

/** 导入本地图片文件(复制进图库,不动原文件)。非图片扩展名跳过并计数。 */
export function importFiles(scope: CanvasImageScope, projectId: string | null, paths: string[]): CanvasImage[] {
  const out: CanvasImage[] = [];
  for (const src of paths) {
    const ext = extname(src).toLowerCase();
    if (!IMAGE_EXT_RE.test(ext)) continue;
    const id = randomUUID();
    const dir = scopeDir(scope, projectId);
    mkdirSync(dir, { recursive: true });
    const filePath = join(dir, `img_${id}${ext}`);
    try {
      copyFileSync(src, filePath);
    } catch (err) {
      log.warn(`canvas import: copy failed for ${src}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    const dims = imageDimensions(readFileSync(filePath));
    const img: CanvasImage = {
      id,
      name: basename(src, extname(src)).slice(0, 200) || "导入图片",
      kind: "imported",
      scope,
      projectId,
      parentId: null,
      chainId: id,
      prompt: "",
      filePath,
      width: dims.width,
      height: dims.height,
      createdAt: Date.now(),
    };
    insertImage(img);
    out.push(img);
  }
  return out;
}

/** 读出图片文件为 data URL。文件丢失时抛错(行还在 = 指向已消失的磁盘文件)。 */
export function readImageDataUrl(img: CanvasImage): string {
  if (!existsSync(img.filePath)) throw new Error("图片文件已不在磁盘上(可能被移动或删除)");
  const buf = readFileSync(img.filePath);
  const ext = extname(img.filePath).toLowerCase();
  const mime =
    ext === ".jpg" || ext === ".jpeg"
      ? "image/jpeg"
      : ext === ".webp"
        ? "image/webp"
        : ext === ".gif"
          ? "image/gif"
          : "image/png";
  return `data:${mime};base64,${buf.toString("base64")}`;
}

/** 读父图为 PNG 字节(edit 接口的 image 输入)。 */
export function readAsPng(img: CanvasImage): { png: Buffer; width: number; height: number } {
  if (!existsSync(img.filePath)) throw new Error("图片文件已不在磁盘上(可能被移动或删除)");
  const ni = nativeImage.createFromPath(img.filePath);
  if (ni.isEmpty()) throw new Error("图片文件无法解析");
  const { width, height } = ni.getSize();
  return { png: ni.toPNG(), width, height };
}

/** base64(允许 data URL 前缀)→ PNG 字节 + 尺寸(扩图的编辑输入图)。 */
export function decodePngBase64(base64: string): { png: Buffer; width: number; height: number } {
  const raw = base64.replace(/^data:image\/\w+;base64,/, "");
  const ni = nativeImage.createFromBuffer(Buffer.from(raw, "base64"));
  if (ni.isEmpty()) throw new Error("图片数据无法解析");
  const { width, height } = ni.getSize();
  return { png: ni.toPNG(), width, height };
}

/** 蒙版 base64(允许 data URL 前缀)→ 与父图同尺寸的 PNG 字节。 */
export function normalizeMask(maskBase64: string, width: number, height: number): Buffer {
  const raw = maskBase64.replace(/^data:image\/\w+;base64,/, "");
  let ni = nativeImage.createFromBuffer(Buffer.from(raw, "base64"));
  if (ni.isEmpty()) throw new Error("蒙版图片无法解析");
  const size = ni.getSize();
  if (size.width !== width || size.height !== height) {
    ni = ni.resize({ width, height, quality: "good" });
  }
  return ni.toPNG();
}

/** 切图(TODO-049):按父图像素坐标裁出 PNG。 */
export function cropImage(img: CanvasImage, rect: { x: number; y: number; width: number; height: number }): Buffer {
  if (!existsSync(img.filePath)) throw new Error("图片文件已不在磁盘上(可能被移动或删除)");
  const ni = nativeImage.createFromPath(img.filePath);
  if (ni.isEmpty()) throw new Error("图片文件无法解析");
  const { width, height } = ni.getSize();
  const x = Math.max(0, Math.min(rect.x, width - 1));
  const y = Math.max(0, Math.min(rect.y, height - 1));
  const w = Math.max(1, Math.min(rect.width, width - x));
  const h = Math.max(1, Math.min(rect.height, height - y));
  return ni.crop({ x, y, width: w, height: h }).toPNG();
}

/** 删除一张图及其全部后代版本:软删除行 + 文件移入 .trash/(尽力而为)。 */
export function deleteWithDescendants(id: string): void {
  const target = CanvasImageRepo.get(id);
  if (!target) return;
  const all = [target, ...CanvasImageRepo.descendants(id)];
  const trashDir = join(resolveGalleryDir(), ".trash");
  for (const img of all) {
    try {
      if (existsSync(img.filePath)) {
        mkdirSync(trashDir, { recursive: true });
        moveToTrash(img.filePath, join(trashDir, basename(img.filePath)));
      }
    } catch (err) {
      log.warn(`canvas delete: trash move failed for ${img.filePath}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  CanvasImageRepo.softDelete(all.map((i) => i.id));
}

/** rename 跨卷会抛 EXDEV(会话生成的图存在截图目录,可能与图库不同盘),
 *  退回复制 + 删除。 */
function moveToTrash(from: string, to: string): void {
  try {
    renameSync(from, to);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EXDEV") {
      copyFileSync(from, to);
      rmSyncQuiet(from);
    } else {
      throw err;
    }
  }
}

function rmSyncQuiet(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    /* 复制已成功,源删不掉只留一份副本,不阻塞删除 */
  }
}

/**
 * 会话里 mario_image_generate 生成的图登记进项目图库(「会话里生成的图片
 * 会自动进入对应项目图库」):不复制文件,行直接指向截图目录里的原图;
 * 删除走 trash 时经 moveToTrash 跨卷兼容。任何失败只记日志,不影响工具返回。
 */
export function registerSessionImage(sessionId: string, filePath: string, prompt: string): void {
  try {
    const session = SessionRepo.get(sessionId);
    if (!session) return;
    const name = prompt.replace(/\s+/g, " ").trim().slice(0, 24) || "会话生成图片";
    insertProjectGenerated(session.projectId, filePath, name, prompt, Date.now());
  } catch (err) {
    log.warn(`canvas register session image failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/* ── 历史图片回填 ── */

/** 生效的工具输出目录(与 imageGenerate / agentBrowserTools 同源):
 *  设置 `browser.screenshotDir`,空 = 系统「图片」文件夹。 */
function toolOutputBase(): string {
  return SettingRepo.get(BROWSER_SCREENSHOT_DIR_SETTING_KEY)?.trim() || app.getPath("pictures");
}

/** 项目内一张生成图的底层登记(registerSessionImage / backfill 共用)。
 *  不复制文件,行直接指向原路径;文件丢失或解析失败返回 false。 */
function insertProjectGenerated(projectId: string, filePath: string, name: string, prompt: string, createdAt: number): boolean {
  if (!existsSync(filePath)) return false;
  try {
    const dims = imageDimensions(readFileSync(filePath));
    const id = randomUUID();
    insertImage({
      id,
      name,
      kind: "generated",
      scope: "project",
      projectId,
      parentId: null,
      chainId: id,
      prompt: prompt.slice(0, 4000),
      filePath,
      width: dims.width,
      height: dims.height,
      createdAt,
    });
    return true;
  } catch {
    return false;
  }
}

/** 会话输出目录下所有 mario_image_generate 的图片文件。只认文件名里带
 *  `-image-` 标记的条目(imageGenerate 的 `${ts}-image-${toolCallId}.<ext>`
 *  格式);browser_screenshot 的截图(无该标记)与 PDF 刻意不收。只扫会话
 *  下的 turn-* 子目录一层,不递归更深。 */
function listSessionImageFiles(sessionDir: string): string[] {
  if (!existsSync(sessionDir)) return [];
  const out: string[] = [];
  let dirs: string[] = [];
  try {
    dirs = readdirSync(sessionDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => join(sessionDir, e.name));
  } catch (err) {
    log.warn(`canvas backfill: 读取会话目录失败 ${sessionDir}: ${err instanceof Error ? err.message : String(err)}`);
    return out;
  }
  for (const dir of dirs) {
    let files: Array<{ name: string; isFile(): boolean }> = [];
    try {
      files = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue; // 单个回合目录不可读,跳过不影响其余
    }
    for (const f of files) {
      if (!f.isFile() || !f.name.includes("-image-")) continue;
      if (!IMAGE_EXT_RE.test(extname(f.name).toLowerCase())) continue;
      out.push(join(dir, f.name));
    }
  }
  return out;
}

/** 回填某项目历史会话生成的图片到项目图库:扫描它的每个会话的输出目录
 *  (<工具输出目录>/<sessionId>/turn-回合号 子目录),把 mario_image_generate
 *  的产物(文件名带 `-image-` 标记)幂等登记进 canvas_images——行指向原文件,
 *  不复制。画布打开时调用,补上功能上线前(或漏登记)的存量图;重复调用
 *  不产生重复行。返回本次新增的图片数。 */
export function backfillProjectSessionImages(projectId: string): number {
  try {
    const sessions = SessionRepo.listByProject(projectId);
    if (sessions.length === 0) return 0;
    const base = toolOutputBase();
    if (!existsSync(base)) return 0;
    // 已有行的 file_path 集合:同一张图只登记一次(含历史已登记的)。
    const existing = new Set(
      (
        getDb()
          .prepare("SELECT file_path FROM canvas_images WHERE scope = 'project' AND project_id = ? AND deleted_at IS NULL")
          .all(projectId) as Array<{ file_path: string }>
      ).map((r) => r.file_path),
    );
    let added = 0;
    for (const session of sessions) {
      const safeSession = session.id.replace(/[^\w.-]/g, "_");
      for (const filePath of listSessionImageFiles(join(base, safeSession))) {
        if (existing.has(filePath)) continue;
        // 名字取文件名里的时间戳段(2026-10-08-14-32-05 …),没有就回落默认。
        const stem = basename(filePath).replace(/\.\w+$/, "").replace(/-image-.*$/, "");
        const name = (stem ? `${stem} 生成图片` : "会话生成图片").slice(0, 200);
        try {
          if (insertProjectGenerated(projectId, filePath, name, "", statSync(filePath).mtimeMs)) {
            existing.add(filePath);
            added++;
          }
        } catch (err) {
          log.warn(`canvas backfill: 登记失败 ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
    return added;
  } catch (err) {
    log.warn(`canvas backfill failed: ${err instanceof Error ? err.message : String(err)}`);
    return 0;
  }
}
