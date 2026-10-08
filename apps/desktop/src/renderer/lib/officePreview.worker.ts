import * as XLSX from "xlsx";
import mammoth from "mammoth/mammoth.browser.js";
import { unzipSync } from "fflate";
import type { OfficeReply } from "./documentTypes.js";

let book: XLSX.WorkBook | null = null;
function safeArchive(bytes: Uint8Array): Record<string, Uint8Array> {
  let total = 0;
  let count = 0;
  return unzipSync(bytes, { filter: entry => {
    total += entry.originalSize;
    if (++count > 10000 || total > 64 * 1024 * 1024 || entry.originalSize > 32 * 1024 * 1024) throw Error("Oversized document archive");
    return true;
  } });
}
self.onmessage = async (event: MessageEvent<{ id: number; bytes?: Uint8Array; extension?: string; sheet?: number; offset?: number; columnOffset?: number }>) => {
  try {
    const input = event.data;
    let reply: OfficeReply;
    if (input.bytes) {
      if (input.extension !== ".xls" && !(input.bytes[0] === 0x50 && input.bytes[1] === 0x4b)) throw Error("Invalid Office format");
      if (input.bytes[0] === 0x50 && input.bytes[1] === 0x4b) safeArchive(input.bytes);
      if (input.extension === ".docx") {
        const result = await mammoth.convertToHtml({ arrayBuffer: input.bytes.buffer as ArrayBuffer }, { externalFileAccess: false });
        reply = { kind: "word", html: result.value };
      } else if (input.extension === ".pptx") {
        reply = { kind: "slides", parts: safeArchive(input.bytes) };
      } else {
        book = XLSX.read(input.bytes, { type: "array", cellHTML: false, cellFormula: false, dense: true });
        const dimensions = book.SheetNames.map(name => {
          const range = XLSX.utils.decode_range(book!.Sheets[name]?.["!ref"] ?? "A1:A1");
          return { rows: range.e.r - range.s.r + 1, columns: range.e.c - range.s.c + 1 };
        });
        reply = { kind: "sheet", names: book.SheetNames, dimensions };
      }
    } else {
      if (!book) throw Error("Workbook not loaded");
      const sheet = book.Sheets[book.SheetNames[input.sheet ?? 0]!];
      if (!sheet) throw Error("Worksheet missing");
      const range = XLSX.utils.decode_range(sheet["!ref"] ?? "A1:A1");
      const row = Math.min(range.e.r, range.s.r + (input.offset ?? 0));
      const firstColumn = Math.min(range.e.c, range.s.c + (input.columnOffset ?? 0));
      const columns = Math.min(100, range.e.c - firstColumn + 1);
      const rows = XLSX.utils.sheet_to_json<string[]>(sheet, { header: 1, raw: false, defval: "", blankrows: true,
        range: { s: { r: row, c: firstColumn }, e: { r: Math.min(range.e.r, row + 199), c: firstColumn + columns - 1 } },
      });
      reply = { kind: "cells", rows, totalRows: range.e.r - range.s.r + 1, firstColumn, firstRow: row, columns };
    }
    self.postMessage({ ...reply, id: event.data.id });
  } catch { self.postMessage({ kind: "error", id: event.data.id } satisfies OfficeReply & { id: number }); }
};
