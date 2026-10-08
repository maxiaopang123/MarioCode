import { protocol, type WebContents, type Session } from "electron";
import { open, realpath } from "node:fs/promises";
import { basename, extname, relative, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { FileHtmlPreviewInput, FileHtmlPreviewResult } from "@contracts/ipc";
import { findContainingWorkspaceRoot, pathWithin } from "./pathGuard.js";

export const HTML_PREVIEW_SCHEME = "mariocode-preview";
const previews = new Map<string, { owner: WebContents; session: Session; root: string; path: string; content: string }>();
const owners = new WeakSet<WebContents>();
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".gif": "image/gif", ".webp": "image/webp", ".avif": "image/avif", ".svg": "image/svg+xml", ".ico": "image/x-icon",
  ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf", ".otf": "font/otf",
};
// Each preview has a random origin in a sandboxed iframe, separate from the app.
// Allow web assets and ordinary page scripts, but no nested frames or workers.
const PAGE_CSP = "default-src 'none'; script-src 'self' https: http: 'unsafe-inline'; style-src 'self' https: http: 'unsafe-inline'; img-src 'self' https: http: data: blob:; font-src 'self' https: http: data:; connect-src 'self' https: http:; media-src https: http: data: blob:; frame-src 'none'; worker-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'";

function revokePreview(token: string): void {
  const preview = previews.get(token);
  if (!preview) return;
  previews.delete(token);
  // Only this random preview origin is cleared, never app/browser storage.
  void preview.session.clearStorageData({ origin: `${HTML_PREVIEW_SCHEME}://${token}`,
    storages: ["localstorage", "indexdb", "cachestorage", "filesystem", "websql"],
  }).catch(() => {});
}

export function registerHtmlPreviewScheme(): void {
  protocol.registerSchemesAsPrivileged([{ scheme: HTML_PREVIEW_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
  }]);
}

async function boundedRead(path: string, limit: number): Promise<Buffer> {
  const handle = await open(path, "r");
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > limit) throw Error("large");
    const data = Buffer.alloc(Math.min(info.size + 1, limit + 1));
    let offset = 0;
    while (offset < data.length) {
      const { bytesRead } = await handle.read(data, offset, data.length - offset, null);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset > info.size || offset > limit) throw Error("large");
    return data.subarray(0, offset);
  } finally { await handle.close(); }
}

export async function createHtmlPreview(owner: WebContents, input: FileHtmlPreviewInput): Promise<FileHtmlPreviewResult> {
  if (!/\.html?$/i.test(input.filePath)) return { ok: false, code: "format" };
  const root = findContainingWorkspaceRoot(resolve(input.filePath));
  if (!root) return { ok: false, code: "outside" };
  try {
    const [actual, actualRoot] = await Promise.all([realpath(input.filePath), realpath(root)]);
    if (!pathWithin(actualRoot, actual)) return { ok: false, code: "outside" };
    const content = input.content ?? (await boundedRead(actual, 2 * 1024 * 1024)).toString("utf8");
    if (Buffer.byteLength(content) > 2 * 1024 * 1024) return { ok: false, code: "large" };
    if (owner.isDestroyed()) return { ok: false, code: "read" };
    // A single editor has one live preview; bound abandoned renderer requests.
    const owned = [...previews].filter(([, preview]) => preview.owner === owner);
    if (owned.length >= 16) revokePreview(owned[0]![0]);
    if (!owners.has(owner)) {
      owners.add(owner);
      owner.once("destroyed", () => { for (const [token, preview] of previews) if (preview.owner === owner) revokePreview(token); });
    }
    const token = randomUUID();
    const path = relative(actualRoot, actual).replace(/\\/g, "/");
    previews.set(token, { owner, session: owner.session, root: actualRoot, path, content });
    return { ok: true, token, url: `${HTML_PREVIEW_SCHEME}://${token}/${path.split("/").map(encodeURIComponent).join("/")}` };
  } catch (error) { return { ok: false, code: error instanceof Error && error.message === "large" ? "large" : "read" }; }
}

export function releaseHtmlPreview(owner: WebContents, token: string): void {
  if (previews.get(token)?.owner === owner) revokePreview(token);
}

export function registerHtmlPreviewProtocol(): void {
  protocol.handle(HTML_PREVIEW_SCHEME, async request => {
    const headers = { "Access-Control-Allow-Origin": "*", "Content-Security-Policy": PAGE_CSP,
      "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" };
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
    if (request.method !== "GET" && request.method !== "HEAD") return new Response(null, { status: 405, headers });
    try {
      const url = new URL(request.url);
      const preview = previews.get(url.hostname);
      if (!preview || preview.owner.isDestroyed() || !findContainingWorkspaceRoot(preview.root)) return new Response(null, { status: 410, headers });
      const path = decodeURIComponent(url.pathname).replace(/^\/+/, "");
      const target = resolve(preview.root, path);
      if (!pathWithin(preview.root, target)) return new Response(null, { status: 403, headers });
      const mime = MIME[extname(target).toLowerCase()];
      if (!mime || !basename(target)) return new Response(null, { status: 403, headers });
      const responseHeaders = { ...headers, "Content-Type": mime };
      if (path === preview.path) return new Response(request.method === "HEAD" ? null : preview.content, { headers: responseHeaders });
      // Explicitly opened documents are allowed; hidden ancillary files are not.
      if (path.split(/[/\\]/).some(segment => segment.startsWith("."))) return new Response(null, { status: 403, headers });
      const actual = await realpath(target);
      if (!pathWithin(preview.root, actual)) return new Response(null, { status: 403, headers });
      if (relative(preview.root, actual).split(/[/\\]/).some(segment => segment.startsWith("."))) return new Response(null, { status: 403, headers });
      const data = await boundedRead(actual, 8 * 1024 * 1024);
      return new Response(request.method === "HEAD" ? null : new Uint8Array(data), { headers: responseHeaders });
    } catch { return new Response(null, { status: 404, headers }); }
  });
}
