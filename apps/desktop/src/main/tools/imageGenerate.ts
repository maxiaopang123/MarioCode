/**
 * image_generate — one image from an OpenAI-compatible `images/generations`
 * endpoint: a shared provider's (its key reused) or a custom one saved on the
 * built-in tools page. Works with any engine, unlike Codex's native image
 * tool, which needs an OpenAI-shaped provider.
 *
 * The original bytes are saved beside the browser screenshots
 * (`<screenshot dir>/<session>/turn-<N>/`) and registered as an image
 * artifact; the conversation and the model get one JPEG copy at full
 * resolution (a PNG can run to several MB of base64). Both copies map to the
 * saved file, so the lightbox's "show in folder" lands on the original.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { app, nativeImage } from "electron";
import { BROWSER_SCREENSHOT_DIR_SETTING_KEY, IMAGE_SIZE_RE } from "@contracts/ipc";
import { engineFetch } from "@main/network/engineProxy.js";
import { registerImageArtifact } from "@main/lib/imageArtifacts.js";
import { log } from "@main/lib/logger.js";
import { SettingRepo } from "@main/store/repositories.js";
import { resolveImageEndpoint } from "./builtinToolsConfig.js";
import type { BuiltinToolResult } from "./builtinToolSpecs.js";

const REQUEST_TIMEOUT_MS = 180_000;
const MAX_PROMPT_CHARS = 4000;

export interface ImageToolContext {
  toolCallId: string;
  sessionId?: string;
  turnNumber?: number;
  /** Pi / Codex: attach the image to the tool card (Claude renders the
   *  image block of the tool result instead). */
  onImage?: (info: { toolCallId: string; data: string; mimeType: "image/jpeg" | "image/png" }) => void;
}

function errorResult(msg: string): BuiltinToolResult {
  return { content: [{ type: "text", text: `❌ ${msg}` }] };
}

function extFor(mimeType: string): string {
  if (mimeType.includes("jpeg") || mimeType.includes("jpg")) return "jpg";
  if (mimeType.includes("webp")) return "webp";
  return "png";
}

function saveImage(buf: Buffer, mimeType: string, ctx: ImageToolContext): string | null {
  const base = SettingRepo.get(BROWSER_SCREENSHOT_DIR_SETTING_KEY)?.trim() || app.getPath("pictures");
  const dir = ctx.sessionId
    ? join(base, ctx.sessionId.replace(/[^\w.-]/g, "_"), `turn-${ctx.turnNumber ?? 0}`)
    : join(base, "images");
  try {
    mkdirSync(dir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, "-").replace("T", "-").slice(0, 19);
    const file = join(dir, `${ts}-image-${ctx.toolCallId.replace(/[^\w.-]/g, "_").slice(0, 40)}.${extFor(mimeType)}`);
    writeFileSync(file, buf);
    return file;
  } catch (err) {
    log.warn(`image_generate: save failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/** The image as returned in `data[0]`: inline base64, or a URL to download. */
async function readImage(item: Record<string, unknown>): Promise<{ buf: Buffer; mimeType: string }> {
  if (typeof item.b64_json === "string" && item.b64_json) {
    const buf = Buffer.from(item.b64_json, "base64");
    const mimeType = buf[0] === 0xff && buf[1] === 0xd8 ? "image/jpeg" : buf.subarray(8, 12).toString() === "WEBP" ? "image/webp" : "image/png";
    return { buf, mimeType };
  }
  if (typeof item.url === "string" && /^https?:\/\//.test(item.url)) {
    const res = await engineFetch(item.url, { signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new Error(`下载生成的图片失败:HTTP ${res.status}`);
    const mimeType = (res.headers.get("content-type") ?? "image/png").split(";")[0]!.trim();
    return { buf: Buffer.from(await res.arrayBuffer()), mimeType };
  }
  throw new Error("接口返回里没有图片(既没有 b64_json 也没有 url)");
}

/** The image_generate tool. */
export async function imageGenerate(
  args: { prompt?: unknown; size?: unknown },
  ctx: ImageToolContext,
): Promise<BuiltinToolResult> {
  const prompt = typeof args.prompt === "string" ? args.prompt.trim().slice(0, MAX_PROMPT_CHARS) : "";
  if (!prompt) return errorResult("prompt 不能为空");
  const endpoint = resolveImageEndpoint();
  if (!endpoint.ok) return errorResult("图片生成还没有配置好(设置 → 内置工具),请告诉用户先配置图片模型");
  const size = typeof args.size === "string" && IMAGE_SIZE_RE.test(args.size.trim()) ? args.size.trim() : endpoint.size;

  let json: Record<string, unknown>;
  try {
    const res = await engineFetch(`${endpoint.baseUrl.replace(/\/+$/, "")}/images/generations`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${endpoint.apiKey}` },
      body: JSON.stringify({ model: endpoint.model, prompt, n: 1, size }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const body = await res.text();
    try {
      json = JSON.parse(body) as Record<string, unknown>;
    } catch {
      json = {};
    }
    if (!res.ok) {
      const err = json.error as Record<string, unknown> | undefined;
      const message = typeof err?.message === "string" ? err.message : body.replace(/\s+/g, " ").slice(0, 200);
      return errorResult(`图片接口返回 HTTP ${res.status}:${message}`);
    }
  } catch (err) {
    return errorResult(`请求图片接口失败:${err instanceof Error ? err.message : String(err)}`);
  }

  const item = Array.isArray(json.data) ? (json.data[0] as Record<string, unknown> | undefined) : undefined;
  if (!item) return errorResult("图片接口没有返回图片");
  let image: { buf: Buffer; mimeType: string };
  try {
    image = await readImage(item);
  } catch (err) {
    return errorResult(err instanceof Error ? err.message : String(err));
  }

  const savedPath = saveImage(image.buf, image.mimeType, ctx);
  const original = image.buf.toString("base64");
  const decoded = nativeImage.createFromBuffer(image.buf);
  const display = decoded.isEmpty()
    ? { data: original, mimeType: image.mimeType === "image/jpeg" ? ("image/jpeg" as const) : ("image/png" as const) }
    : { data: decoded.toJPEG(90).toString("base64"), mimeType: "image/jpeg" as const };
  if (savedPath) {
    registerImageArtifact(original, savedPath);
    registerImageArtifact(display.data, savedPath);
  }
  ctx.onImage?.({ toolCallId: ctx.toolCallId, data: display.data, mimeType: display.mimeType });
  log.info(`image_generate: ${endpoint.model} ${size} → ${savedPath ?? "(not saved)"}`);

  const revised = typeof item.revised_prompt === "string" ? item.revised_prompt.trim() : "";
  const dims = decoded.isEmpty() ? size : `${decoded.getSize().width}x${decoded.getSize().height}`;
  return {
    content: [
      {
        type: "text",
        text:
          `已生成图片(${endpoint.model},${dims}),已显示给用户。` +
          (savedPath ? `\n已保存到: ${savedPath}` : "\n(保存到本地失败,图片只在对话里)") +
          (revised ? `\n模型改写后的提示词: ${revised}` : ""),
      },
      { type: "image", data: display.data, mimeType: display.mimeType },
    ],
  };
}
