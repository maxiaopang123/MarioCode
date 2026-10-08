export function isDocumentPath(path: string): boolean {
  return /\.(pdf|docx|xlsx|xls|pptx)$/i.test(path);
}
export type OfficePreview =
  | { kind: "word"; html: string }
  | { kind: "sheet"; names: string[]; dimensions: { rows: number; columns: number }[] }
  | { kind: "slides"; parts: Record<string, Uint8Array> };
export interface SheetPage {
  kind: "cells";
  rows: string[][];
  totalRows: number;
  firstColumn: number;
  firstRow: number;
  columns: number;
}
export type OfficeReply = OfficePreview | SheetPage | { kind: "error" };
