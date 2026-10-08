/**
 * 画布工作台的 IPC(TODO-033/041 + TODO-049)。
 *
 * 图库元数据在 canvas_images 表、文件在图库目录(canvasStore);文生图与
 * 编辑走 imageApi(共用 设置 → 内置工具 的图片端点);切图是纯本地裁剪,
 * 不调接口。所有 handler 入参先过 zod;失败一律 { ok:false, error } 返回
 * 可展示的中文原因,不往 renderer 抛异常。
 */
import { mkdirSync } from "node:fs";
import type { IpcMain } from "electron";
import { dialog, shell } from "electron";
import { existsSync } from "node:fs";
import {
  CanvasCropSchema,
  CanvasDeleteSchema,
  CanvasEditSchema,
  CanvasGenerateSchema,
  CanvasImageDataSchema,
  CanvasImportSchema,
  CanvasListSchema,
  CanvasRenameSchema,
  IPC,
  type CanvasImage,
  type CanvasMutationResult,
} from "@contracts/ipc";
import { ProjectRepo } from "@main/store/repositories.js";
import { getMainWindow } from "@main/window.js";
import {
  CanvasImageRepo,
  cropImage,
  decodePngBase64,
  defaultGalleryDir,
  deleteWithDescendants,
  importFiles,
  normalizeMask,
  readAsPng,
  readImageDataUrl,
  resolveGalleryDir,
  storeDerived,
  storeGenerated,
} from "@main/canvas/canvasStore.js";
import { canvasEditImage, canvasGenerateImage } from "@main/canvas/imageApi.js";

function fail(err: unknown): { ok: false; error: string } {
  return { ok: false, error: err instanceof Error ? err.message : String(err) };
}

/** scope = "project" 时 projectId 必填且指向已知项目。 */
function resolveScope(input: { scope: "global" | "project"; projectId?: string }): { projectId: string | null } {
  if (input.scope !== "project") return { projectId: null };
  const projectId = input.projectId?.trim() ?? "";
  if (!projectId) throw new Error("项目图库需要指定项目");
  if (!ProjectRepo.get(projectId)) throw new Error("项目不存在或已删除");
  return { projectId };
}

export function registerCanvasHandlers(ipcMain: IpcMain): void {
  ipcMain.handle(IPC.CANVAS_HOME, () => ({ dir: resolveGalleryDir(), defaultDir: defaultGalleryDir() }));

  ipcMain.handle(IPC.CANVAS_LIST, (_evt, raw): { images: CanvasImage[] } => {
    const input = CanvasListSchema.parse(raw);
    const { projectId } = resolveScope(input);
    return { images: CanvasImageRepo.list(input.scope, projectId) };
  });

  ipcMain.handle(IPC.CANVAS_IMAGE_DATA, (_evt, raw) => {
    try {
      const { id } = CanvasImageDataSchema.parse(raw);
      const img = CanvasImageRepo.get(id);
      if (!img) return { ok: false, error: "图片不存在或已删除" };
      return { ok: true, dataUrl: readImageDataUrl(img) };
    } catch (err) {
      return fail(err);
    }
  });

  ipcMain.handle(IPC.CANVAS_GENERATE, async (_evt, raw) => {
    const input = CanvasGenerateSchema.parse(raw);
    let projectId: string | null;
    try {
      projectId = resolveScope(input).projectId;
    } catch (err) {
      return fail(err);
    }
    const count = input.count ?? 1;
    const images: CanvasImage[] = [];
    let lastError: string | null = null;
    for (let i = 0; i < count; i++) {
      try {
        const r = await canvasGenerateImage(input.prompt, input.size);
        images.push(storeGenerated(input.scope, projectId, r.buf, r.mimeType, input.prompt));
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        break; // 配置/网络类错误重试无意义,已出的图仍然保留
      }
    }
    if (images.length === 0) return { ok: false, error: lastError ?? "生成失败" };
    return { ok: true, images, ...(lastError ? { error: lastError } : {}) };
  });

  ipcMain.handle(IPC.CANVAS_EDIT, async (_evt, raw) => {
    try {
      const input = CanvasEditSchema.parse(raw);
      const parent = CanvasImageRepo.get(input.parentId);
      if (!parent) return { ok: false, error: "原图不存在或已删除" };
      const src = input.imageBase64 ? decodePngBase64(input.imageBase64) : readAsPng(parent);
      const mask = input.maskBase64 ? normalizeMask(input.maskBase64, src.width, src.height) : null;
      const r = await canvasEditImage(input.prompt, src.png, mask, input.size);
      const suffix = input.imageBase64 ? "扩图" : mask ? "局部重绘" : "整图变换";
      const image = storeDerived(parent, r.buf, r.mimeType, input.prompt, suffix);
      return { ok: true, image };
    } catch (err) {
      return fail(err);
    }
  });

  ipcMain.handle(IPC.CANVAS_CROP, (_evt, raw) => {
    try {
      const input = CanvasCropSchema.parse(raw);
      const parent = CanvasImageRepo.get(input.parentId);
      if (!parent) return { ok: false, error: "原图不存在或已删除" };
      const png = cropImage(parent, input.rect);
      const image = storeDerived(parent, png, "image/png", `切图 ${input.rect.width}×${input.rect.height}`, input.name ?? "切图");
      return { ok: true, image };
    } catch (err) {
      return fail(err);
    }
  });

  ipcMain.handle(IPC.CANVAS_IMPORT, async (_evt, raw) => {
    try {
      const input = CanvasImportSchema.parse(raw);
      const { projectId } = resolveScope(input);
      const win = getMainWindow();
      const result = await (win
        ? dialog.showOpenDialog(win, {
            title: "导入图片",
            properties: ["openFile", "multiSelections"],
            filters: [{ name: "图片", extensions: ["png", "jpg", "jpeg", "webp", "gif", "bmp"] }],
          })
        : dialog.showOpenDialog({
            title: "导入图片",
            properties: ["openFile", "multiSelections"],
            filters: [{ name: "图片", extensions: ["png", "jpg", "jpeg", "webp", "gif", "bmp"] }],
          }));
      if (result.canceled || result.filePaths.length === 0) return { ok: true, images: [] };
      return { ok: true, images: importFiles(input.scope, projectId, result.filePaths) };
    } catch (err) {
      return fail(err);
    }
  });

  ipcMain.handle(IPC.CANVAS_DELETE, (_evt, raw): CanvasMutationResult => {
    try {
      const { id } = CanvasDeleteSchema.parse(raw);
      deleteWithDescendants(id);
      return { ok: true };
    } catch (err) {
      return fail(err);
    }
  });

  ipcMain.handle(IPC.CANVAS_RENAME, (_evt, raw): CanvasMutationResult => {
    try {
      const input = CanvasRenameSchema.parse(raw);
      if (!CanvasImageRepo.get(input.id)) return { ok: false, error: "图片不存在或已删除" };
      CanvasImageRepo.rename(input.id, input.name);
      return { ok: true };
    } catch (err) {
      return fail(err);
    }
  });

  ipcMain.handle(IPC.CANVAS_SHOW_IN_FOLDER, (_evt, raw): CanvasMutationResult => {
    try {
      const { id } = CanvasImageDataSchema.parse(raw);
      const img = CanvasImageRepo.get(id);
      if (!img) return { ok: false, error: "图片不存在或已删除" };
      if (!existsSync(img.filePath)) return { ok: false, error: "图片文件已不在磁盘上" };
      shell.showItemInFolder(img.filePath);
      return { ok: true };
    } catch (err) {
      return fail(err);
    }
  });

  // 打开图库根目录本身(目录由 main 解析,renderer 不提供路径)。
  ipcMain.handle(IPC.CANVAS_OPEN_FOLDER, (): CanvasMutationResult => {
    try {
      const dir = resolveGalleryDir();
      mkdirSync(dir, { recursive: true });
      shell.openPath(dir);
      return { ok: true };
    } catch (err) {
      return fail(err);
    }
  });
}
