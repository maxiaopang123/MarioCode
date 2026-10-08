import { open, realpath } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { DOCUMENT_PREVIEW_MAX_BYTES, type FileReadDocumentResult } from "@contracts/ipc";
import { findContainingWorkspaceRoot, pathWithin } from "./pathGuard.js";

export async function readDocumentPreview(filePath: string): Promise<FileReadDocumentResult> {
  if (!/\.(pdf|docx|xlsx|xls|pptx)$/i.test(extname(filePath))) return { ok: false, code: "format" };
  const root = findContainingWorkspaceRoot(resolve(filePath));
  if (!root) return { ok: false, code: "outside" };
  try {
    const [actual, actualRoot] = await Promise.all([realpath(filePath), realpath(root)]);
    if (!pathWithin(actualRoot, actual)) return { ok: false, code: "outside" };
    const handle = await open(actual, "r");
    try {
      const info = await handle.stat();
      if (!info.isFile()) return { ok: false, code: "read" };
      if (info.size > DOCUMENT_PREVIEW_MAX_BYTES) return { ok: false, code: "large" };
      // Bound the read even if an agent grows the file between stat and read.
      const buffer = Buffer.alloc(Math.min(info.size + 1, DOCUMENT_PREVIEW_MAX_BYTES + 1));
      let offset = 0;
      while (offset < buffer.length) {
        const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, null);
        if (!bytesRead) break;
        offset += bytesRead;
      }
      if (offset > info.size || offset > DOCUMENT_PREVIEW_MAX_BYTES) return { ok: false, code: "large" };
      return { ok: true, data: buffer.subarray(0, offset).toString("base64") };
    } finally { await handle.close(); }
  } catch { return { ok: false, code: "read" }; }
}
