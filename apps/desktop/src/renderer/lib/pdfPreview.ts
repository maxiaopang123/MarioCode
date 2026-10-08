// Electron 33 uses Chromium 130; PDF.js' legacy entry supplies newer Promise
// APIs in both the UI and worker, instead of leaving a worker request hanging.
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import PdfWorker from "pdfjs-dist/legacy/build/pdf.worker.mjs?worker";

// Every support file is bundled as a data URL. file:// previews, installers
// and offline use must not depend on a CDN or browser fetch of local files.
const cmaps = import.meta.glob("../../../node_modules/pdfjs-dist/cmaps/*.bcmap", { eager: true, query: "?inline", import: "default" });
const fonts = import.meta.glob(["../../../node_modules/pdfjs-dist/standard_fonts/*.pfb", "../../../node_modules/pdfjs-dist/standard_fonts/*.ttf"], { eager: true, query: "?inline", import: "default" });
function supportFile(files: Record<string, unknown>, name: string): Promise<Uint8Array> {
  const key = Object.keys(files).find(path => path.endsWith(`/${name}`));
  const data = key ? files[key] : undefined;
  if (typeof data !== "string" || !data.startsWith("data:")) return Promise.reject(Error("PDF support file missing"));
  const comma = data.indexOf(",");
  const decoded = atob(data.slice(comma + 1));
  return Promise.resolve(Uint8Array.from(decoded, character => character.charCodeAt(0)));
}
class CMaps {
  async fetch({ name }: { name: string }) { return { cMapData: await supportFile(cmaps, `${name}.bcmap`), compressionType: 1 }; }
}
class StandardFonts {
  fetch({ filename }: { filename: string }) { return supportFile(fonts, filename); }
}
pdfjs.GlobalWorkerOptions.workerPort = new PdfWorker();
export function loadPdf(bytes: Uint8Array) {
  return pdfjs.getDocument({ data: bytes, isEvalSupported: false, useWasm: false, useSystemFonts: true,
    useWorkerFetch: false, CMapReaderFactory: CMaps, StandardFontDataFactory: StandardFonts,
  });
}
export type { PDFDocumentProxy, RenderTask } from "pdfjs-dist";
