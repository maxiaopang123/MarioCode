/**
 * 画布工作台的底层图片接口(设置 → 内置工具 里配置的共享提供商)。
 *
 * 与 mario_image_generate(tools/imageGenerate.ts)共用 resolveImageEndpoint
 * 的端点解析,但面向图库场景返回原始字节(落盘与展示由 canvasStore 负责),
 * 不带工具结果包装。两个操作:
 *   - generate:POST {baseUrl}/images/generations(文生图)
 *   - edit:POST {baseUrl}/images/edits(multipart;蒙版重绘带 mask 字段,
 *     整图变换不带)
 * multipart 体手工编码(不依赖 FormData):engineFetch 可能走 Chromium 网络栈,
 * 手工边界串在两条路径上行为一致。
 */
import { randomBytes } from "node:crypto";
import { engineFetch } from "@main/network/engineProxy.js";
import { resolveImageEndpoint } from "@main/tools/builtinToolsConfig.js";

const REQUEST_TIMEOUT_MS = 180_000;

export class ImageApiError extends Error {}

/** 调用前的配置检查;失败时给界面可直接展示的中文原因。 */
export function ensureImageEndpoint(): { baseUrl: string; apiKey: string; model: string; size: string } {
  const endpoint = resolveImageEndpoint();
  if (!endpoint.ok) {
    const reason =
      endpoint.issue === "noSource"
        ? "还没有选择图片来源(设置 → 内置工具 → 图片生成)"
        : endpoint.issue === "providerMissing"
          ? "图片来源指向的共享提供商已不存在,请重新选择(设置 → 内置工具)"
          : endpoint.issue === "noModel"
            ? "还没有配置图片模型(设置 → 内置工具 → 图片生成)"
            : "图片来源提供商缺少密钥(设置 → 模型配置)";
    throw new ImageApiError(reason);
  }
  return endpoint;
}

interface ParsedImageResponse {
  buf: Buffer;
  mimeType: string;
  revisedPrompt: string;
}

async function readImageItem(item: Record<string, unknown>): Promise<ParsedImageResponse> {
  const revisedPrompt = typeof item.revised_prompt === "string" ? item.revised_prompt.trim() : "";
  if (typeof item.b64_json === "string" && item.b64_json) {
    const buf = Buffer.from(item.b64_json, "base64");
    const mimeType =
      buf[0] === 0xff && buf[1] === 0xd8
        ? "image/jpeg"
        : buf.subarray(8, 12).toString() === "WEBP"
          ? "image/webp"
          : "image/png";
    return { buf, mimeType, revisedPrompt };
  }
  if (typeof item.url === "string" && /^https?:\/\//.test(item.url)) {
    const res = await engineFetch(item.url, { signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new ImageApiError(`下载生成的图片失败:HTTP ${res.status}`);
    const mimeType = (res.headers.get("content-type") ?? "image/png").split(";")[0]!.trim();
    return { buf: Buffer.from(await res.arrayBuffer()), mimeType, revisedPrompt };
  }
  throw new ImageApiError("接口返回里没有图片(既没有 b64_json 也没有 url)");
}

/** 解析 images API 的 JSON 响应;HTTP 错误与空 data 都翻成中文 ImageApiError。 */
async function parseImagesResponse(res: Response): Promise<ParsedImageResponse> {
  const body = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(body) as Record<string, unknown>;
  } catch {
    /* keep {} */
  }
  if (!res.ok) {
    const err = json.error as Record<string, unknown> | undefined;
    const message = typeof err?.message === "string" ? err.message : body.replace(/\s+/g, " ").slice(0, 200);
    throw new ImageApiError(`图片接口返回 HTTP ${res.status}:${message}`);
  }
  const item = Array.isArray(json.data) ? (json.data[0] as Record<string, unknown> | undefined) : undefined;
  if (!item) throw new ImageApiError("图片接口没有返回图片");
  return readImageItem(item);
}

/** 文生图。size 传 "auto" 或省略时用端点配置的默认尺寸。 */
export async function canvasGenerateImage(
  prompt: string,
  size?: string,
): Promise<ParsedImageResponse> {
  const endpoint = ensureImageEndpoint();
  const effectiveSize = size && size !== "auto" ? size : endpoint.size;
  try {
    const res = await engineFetch(`${endpoint.baseUrl.replace(/\/+$/, "")}/images/generations`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${endpoint.apiKey}` },
      body: JSON.stringify({ model: endpoint.model, prompt, n: 1, size: effectiveSize }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    return await parseImagesResponse(res);
  } catch (err) {
    if (err instanceof ImageApiError) throw err;
    throw new ImageApiError(`请求图片接口失败:${err instanceof Error ? err.message : String(err)}`);
  }
}

/** 手工编码 multipart/form-data(字段顺序:文本字段在前,文件在后)。 */
function encodeMultipart(fields: Array<{ name: string; value: string }>, files: Array<{ name: string; fileName: string; mimeType: string; data: Buffer }>): { contentType: string; body: Buffer } {
  const boundary = `----mariocode-canvas-${randomBytes(12).toString("hex")}`;
  const parts: Buffer[] = [];
  for (const f of fields) {
    parts.push(
      Buffer.from(`--${boundary}\r\ncontent-disposition: form-data; name="${f.name}"\r\n\r\n${f.value}\r\n`),
    );
  }
  for (const f of files) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\ncontent-disposition: form-data; name="${f.name}"; filename="${f.fileName}"\r\ncontent-type: ${f.mimeType}\r\n\r\n`,
      ),
      f.data,
      Buffer.from("\r\n"),
    );
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { contentType: `multipart/form-data; boundary=${boundary}`, body: Buffer.concat(parts) };
}

/** 图片编辑:maskPng 存在 = 蒙版重绘(images/edits 的 mask 字段,透明区为编辑区),
 *  否则 = 整图变换。imagePng 与 maskPng 都必须是 PNG 字节且尺寸一致。 */
export async function canvasEditImage(
  prompt: string,
  imagePng: Buffer,
  maskPng: Buffer | null,
  size?: string,
): Promise<ParsedImageResponse> {
  const endpoint = ensureImageEndpoint();
  const effectiveSize = size && size !== "auto" ? size : endpoint.size;
  const fields = [
    { name: "model", value: endpoint.model },
    { name: "prompt", value: prompt },
    { name: "n", value: "1" },
  ];
  if (effectiveSize && effectiveSize !== "auto") fields.push({ name: "size", value: effectiveSize });
  const files = [{ name: "image", fileName: "image.png", mimeType: "image/png", data: imagePng }];
  if (maskPng) files.push({ name: "mask", fileName: "mask.png", mimeType: "image/png", data: maskPng });
  const { contentType, body } = encodeMultipart(fields, files);
  try {
    const res = await engineFetch(`${endpoint.baseUrl.replace(/\/+$/, "")}/images/edits`, {
      method: "POST",
      headers: { "content-type": contentType, authorization: `Bearer ${endpoint.apiKey}` },
      body,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    return await parseImagesResponse(res);
  } catch (err) {
    if (err instanceof ImageApiError) throw err;
    throw new ImageApiError(`请求图片接口失败:${err instanceof Error ? err.message : String(err)}`);
  }
}
