import { useEffect, useMemo, useRef, useState } from "react";
import DOMPurify from "dompurify";
import OfficeWorker from "@renderer/lib/officePreview.worker.ts?worker";
import { api } from "@renderer/lib/api.js";
import { extname } from "@renderer/lib/path.js";
import { cn } from "@renderer/lib/cn.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { Button } from "../ui/index.js";
import { IconLoader2, IconArrowLeft, IconArrowRight, IconPlus, IconMinus } from "@renderer/lib/icons.js";
import { presentationPages, presentationSlide } from "@renderer/lib/pptxPreview.js";
import type { OfficePreview, OfficeReply, SheetPage } from "@renderer/lib/documentTypes.js";
import type { PDFDocumentProxy, RenderTask } from "@renderer/lib/pdfPreview.js";
import "./documentPreview.css";

export function DocumentPreview({ filePath }: { filePath: string }) {
  const { t } = useI18n();
  const [reload, setReload] = useState(0);
  const [error, setError] = useState<"outside" | "large" | "format" | "read" | "parse" | null>(null);
  const [office, setOffice] = useState<OfficePreview | null>(null);
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [cells, setCells] = useState<SheetPage | null>(null);
  const [sheet, setSheet] = useState(0);
  const [page, setPage] = useState(0);
  const [columnPage, setColumnPage] = useState(0);
  const workerRef = useRef<Worker | null>(null);
  const requestRef = useRef(0);
  useEffect(() => {
    let disposed = false;
    let document: PDFDocumentProxy | null = null;
    let worker: Worker | null = null;
    let abortPdf: (() => void) | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setError(null); setOffice(null); setPdf(null); setCells(null); setPage(0); setSheet(0); setColumnPage(0);
    void (async () => {
      const result = await api.file.readDocument({ filePath });
      if (disposed) return;
      if (!result.ok) { setError(result.code); return; }
      const bytes = Uint8Array.from(atob(result.data), character => character.charCodeAt(0));
      if (extname(filePath) === ".pdf") {
        const { loadPdf } = await import("@renderer/lib/pdfPreview.js");
        if (disposed) return;
        const task = loadPdf(bytes);
        abortPdf = () => { void task.destroy().catch(() => {}); };
        timer = setTimeout(() => { if (!disposed) setError("parse"); abortPdf?.(); }, 30000);
        document = await task.promise;
        clearTimeout(timer);
        if (!disposed) setPdf(document);
        else void document.destroy();
      } else {
        worker = new OfficeWorker(); workerRef.current = worker;
        worker.onmessage = (event: MessageEvent<OfficeReply & { id: number }>) => {
          if (disposed || event.data.id !== requestRef.current) return;
          clearTimeout(timer);
          const reply = event.data;
          if (reply.kind === "error") setError("parse");
          else if (reply.kind === "cells") setCells(reply);
          else setOffice(reply);
        };
        worker.onerror = () => { if (!disposed) setError("parse"); clearTimeout(timer); };
        timer = setTimeout(() => { worker?.terminate(); if (!disposed) setError("parse"); }, 20000);
        worker.postMessage({ id: ++requestRef.current, bytes, extension: extname(filePath) }, [bytes.buffer]);
      }
    })().catch(error => { clearTimeout(timer); if (!disposed) { console.warn("Document preview failed", error); setError("parse"); } });
    return () => { disposed = true; worker?.terminate(); workerRef.current = null; clearTimeout(timer); abortPdf?.(); };
  }, [filePath, reload]);
  useEffect(() => {
    if (office?.kind !== "sheet") return;
    setCells(null);
    workerRef.current?.postMessage({ id: ++requestRef.current, sheet, offset: page * 200, columnOffset: columnPage * 100 });
  }, [office, sheet, page, columnPage]);
  const pages = useMemo(() => {
    if (office?.kind !== "slides") return [];
    try { return presentationPages(office.parts); } catch { return []; }
  }, [office]);
  const total = pdf?.numPages ?? (office?.kind === "slides" ? pages.length : office?.kind === "sheet" ? Math.ceil((office.dimensions[sheet]?.rows ?? 1) / 200) : 1);
  const columnTotal = office?.kind === "sheet" ? Math.ceil((office.dimensions[sheet]?.columns ?? 1) / 100) : 1;
  const invalidSlides = office?.kind === "slides" && pages.length === 0;
  return (
    <div className="flex h-full flex-col bg-surface" data-document-preview={extname(filePath)}>
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-edge px-3 py-1.5">
        <span className="text-xs text-content-subtle">{t("ide.document.readOnly")}</span>
        {office?.kind === "sheet" && (
          <select className="max-w-48 rounded border border-edge bg-surface px-2 py-1 text-xs text-content" aria-label={t("ide.document.sheet")}
            value={sheet} onChange={event => { setSheet(Number(event.target.value)); setPage(0); setColumnPage(0); }}>
            {office.names.map((name, index) => <option key={index} value={index}>{name}</option>)}
          </select>
        )}
        {total > 1 && <>
          <Button variant="ghost" size="icon" aria-label={t("ide.document.previous")} disabled={page <= 0} onClick={() => setPage(page - 1)}><IconArrowLeft size={14} /></Button>
          <span className="text-xs text-content-muted" aria-live="polite">{t("ide.document.page", { n: page + 1, total })}</span>
          <Button variant="ghost" size="icon" aria-label={t("ide.document.next")} disabled={page >= total - 1} onClick={() => setPage(page + 1)}><IconArrowRight size={14} /></Button>
        </>}
        {columnTotal > 1 && <>
          <Button variant="ghost" size="icon" aria-label={t("ide.document.previousColumns")} disabled={columnPage <= 0} onClick={() => setColumnPage(columnPage - 1)}><IconArrowLeft size={14} /></Button>
          <span className="text-xs text-content-subtle">{t("ide.document.columnPage", { n: columnPage + 1, total: columnTotal })}</span>
          <Button variant="ghost" size="icon" aria-label={t("ide.document.nextColumns")} disabled={columnPage >= columnTotal - 1} onClick={() => setColumnPage(columnPage + 1)}><IconArrowRight size={14} /></Button>
        </>}
        <Button variant="ghost" className="ml-auto" onClick={() => setReload(reload + 1)}>{t("common.refresh")}</Button>
        <Button variant="ghost" onClick={() => { void api.shell.openFile({ path: filePath }); }}>{t("ide.document.openExternal")}</Button>
      </div>
      {(error || invalidSlides) ? (
        <div role="alert" className="flex flex-1 items-center justify-center p-6 text-sm text-content-muted">{t(`ide.document.error.${error ?? "parse"}`)}</div>
      ) : pdf ? <PdfPage pdf={pdf} page={page + 1} /> : office?.kind === "word" ? <WordPage html={office.html} />
        : office?.kind === "slides" ? <SlidePage parts={office.parts} path={pages[page]!} />
        : cells ? <SheetTable cells={cells} />
        : <div className="flex flex-1 items-center justify-center gap-2 text-xs text-content-subtle"><IconLoader2 size={14} className="animate-spin" />{t("ide.editor.readingFile")}</div>}
      {office && office.kind !== "sheet" && <div className="border-t border-edge px-3 py-1 text-[11px] text-content-subtle">{t("ide.document.readingLayout")}</div>}
    </div>
  );
}

function WordPage({ html }: { html: string }) {
  const sanitized = useMemo(() => DOMPurify.sanitize(html, { USE_PROFILES: { html: true },
    FORBID_TAGS: ["style", "form", "input", "button", "iframe"], FORBID_ATTR: ["style", "srcset"],
    ALLOWED_URI_REGEXP: /^(?:#|data:image\/(?:png|jpeg|gif|webp|bmp);base64,)/i,
  }), [html]);
  return <div className="min-h-0 flex-1 overflow-auto p-4"><article className="document-reading mx-auto" dangerouslySetInnerHTML={{ __html: sanitized }} /></div>;
}
function SheetTable({ cells }: { cells: SheetPage }) {
  const { t } = useI18n();
  const column = (index: number) => { let value = index + 1, label = ""; while (value > 0) { value--; label = String.fromCharCode(65 + value % 26) + label; value = Math.floor(value / 26); } return label; };
  return <div className="min-h-0 flex-1 overflow-auto">
    <table className="document-sheet w-full text-xs"><thead><tr><th aria-label={t("ide.document.row")} />{Array.from({ length: cells.columns }, (_, index) => <th key={index}>{column(cells.firstColumn + index)}</th>)}</tr></thead>
      <tbody>{cells.rows.map((row, index) => <tr key={index}><th>{cells.firstRow + index + 1}</th>{Array.from({ length: cells.columns }, (_, column) => <td key={column}>{row[column] ?? ""}</td>)}</tr>)}</tbody>
    </table>
  </div>;
}
function SlidePage({ parts, path }: { parts: Record<string, Uint8Array>; path: string }) {
  const { t } = useI18n();
  const blocks = useMemo(() => { try { return presentationSlide(parts, path); } catch { return null; } }, [parts, path]);
  return <div className="min-h-0 flex-1 overflow-auto p-4"><article className="document-reading mx-auto" data-slide-content>
    {blocks === null ? <p role="alert">{t("ide.document.error.parse")}</p> : blocks.length ? blocks.map((block, index) => block.kind === "text"
      ? <section key={index}>{block.paragraphs.map((text, line) => index === 0 && line === 0 ? <h1 key={line}>{text}</h1> : <p key={line}>{text}</p>)}</section>
      : block.kind === "image" ? <img key={index} src={block.src} alt={t("ide.document.slideImage")} />
      : <table key={index}><tbody>{block.rows.map((row, r) => <tr key={r}>{row.map((text, c) => <td key={c}>{text}</td>)}</tr>)}</tbody></table>) : <p>{t("ide.document.emptySlide")}</p>}
  </article></div>;
}
function PdfPage({ pdf, page }: { pdf: PDFDocumentProxy; page: number }) {
  const { t } = useI18n();
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [width, setWidth] = useState(600);
  const [zoom, setZoom] = useState(1);
  const [text, setText] = useState("");
  const [error, setError] = useState(false);
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const observer = new ResizeObserver(() => setWidth(Math.max(100, host.clientWidth - 32)));
    observer.observe(host); return () => observer.disconnect();
  }, []);
  useEffect(() => {
    let cancelled = false;
    let task: RenderTask | undefined;
    setText(""); setError(false);
    void (async () => {
      const current = await pdf.getPage(page);
      if (cancelled || !canvasRef.current) return;
      const base = current.getViewport({ scale: 1 });
      const scale = Math.min(width / base.width, 1.5) * zoom;
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      const viewport = current.getViewport({ scale: scale * ratio });
      const canvas = canvasRef.current;
      canvas.width = Math.round(viewport.width); canvas.height = Math.round(viewport.height);
      canvas.style.width = `${viewport.width / ratio}px`; canvas.style.height = `${viewport.height / ratio}px`;
      task = current.render({ canvas, viewport });
      await task.promise;
      const content = await current.getTextContent();
      if (!cancelled) setText(content.items.map(item => "str" in item ? item.str + (item.hasEOL ? "\n" : " ") : "").join(""));
    })().catch(error => { if (!cancelled) { console.warn("PDF page render failed", error); setError(true); } });
    return () => { cancelled = true; task?.cancel(); };
  }, [pdf, page, width, zoom]);
  return <div ref={hostRef} className="min-h-0 flex-1 overflow-auto p-4" data-pdf-page={page}>
    <div className="mb-3 flex justify-center gap-2"><Button size="sm" aria-label={t("ide.document.zoomOut")} disabled={zoom <= 0.5} onClick={() => setZoom(Math.max(0.5, zoom - 0.25))}><IconMinus size={14} /></Button>
      <span className="text-xs text-content-subtle">{Math.round(zoom * 100)}%</span>
      <Button size="sm" aria-label={t("ide.document.zoomIn")} disabled={zoom >= 2} onClick={() => setZoom(Math.min(2, zoom + 0.25))}><IconPlus size={14} /></Button></div>
    {error && <p role="alert" className="text-sm text-content-muted">{t("ide.document.error.parse")}</p>}
    <canvas ref={canvasRef} className={cn("mx-auto bg-white shadow-sm", error && "hidden")} aria-label={t("ide.document.page", { n: page, total: pdf.numPages })} />
    {text && <details className="mx-auto mt-4 max-w-3xl text-xs text-content-muted"><summary className="cursor-pointer">{t("ide.document.pageText")}</summary><pre className="whitespace-pre-wrap py-2 font-sans" data-pdf-text>{text}</pre></details>}
  </div>;
}
