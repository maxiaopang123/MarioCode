/**
 * 画布编辑视图(画布工作台视图二,TODO-033/041 + TODO-049)。
 *
 * 舞台上是按窗口适配的原图,蒙版用真 canvas 涂抹(画笔/橡皮/笔刷大小/
 * 撤销/重做/清空);三种编辑方式:
 *  - 局部重绘:蒙版透明区 = 重绘区(images/edits 的 mask 字段);
 *  - 整图变换:不带 mask;
 *  - 扩图:渲染端把原图贴进 1.5 倍画布居中,边区造蒙版,扩展画布作为
 *    image 输入(imageBase64 覆盖)。
 * 切图(TODO-049)是纯本地裁剪:选框拖动 + 四角手柄 + 比例约束,应用后按
 * 选区从原图裁出,另存为派生新版本。底部派生链可切换正在编辑的版本。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  IconArrowBackUp,
  IconArrowForwardUp,
  IconBrush,
  IconCrop,
  IconEraser,
  IconPhoto,
  IconTrash,
  IconUpload,
  IconWand,
} from "@renderer/lib/icons.js";
import { cn } from "@renderer/lib/cn.js";
import { api } from "@renderer/lib/api.js";
import { Button } from "@renderer/components/ui/index.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { useToastStore } from "@renderer/stores/toastStore.js";
import type { CanvasImage } from "@contracts/ipc";
import { formatCanvasTime, useCanvasImageUrl, type CanvasScopeSel } from "./canvasShared.js";

/* ── 类型与常量 ── */

type Tool = "brush" | "eraser" | "crop";
type EditMode = "inpaint" | "img2img" | "outpaint";

/** 一笔:frame(CSS 像素)坐标点列 + 笔刷大小 + 是否擦除。 */
interface Stroke {
  erase: boolean;
  size: number;
  pts: [number, number][];
}

/** 切图比例约束:0 = 自由。 */
const CROP_RATIOS = [0, 1, 3 / 2, 16 / 9] as const;
const CROP_RATIO_LABELS = ["canvas.crop.ratioFree", "1:1", "3:2", "16:9"] as const;

const MASK_COLOR = "rgba(96, 165, 130, 0.45)";
const OUTPAINT_SCALE = 1.5;

/* ── 派生链节点 ── */

function LineageNode({
  image,
  active,
  isOriginal,
  versionLabel,
  onSelect,
}: {
  image: CanvasImage;
  active: boolean;
  isOriginal: boolean;
  versionLabel: string;
  onSelect: (id: string) => void;
}) {
  const { url } = useCanvasImageUrl(image.id);
  return (
    <button
      type="button"
      onClick={() => onSelect(image.id)}
      title={image.prompt || image.name}
      className={cn(
        "flex w-[104px] shrink-0 flex-col overflow-hidden rounded-lg border text-left transition-colors",
        active ? "border-accent/60" : "border-edge hover:border-content-subtle/40",
      )}
    >
      <div className="flex h-14 items-center justify-center overflow-hidden bg-surface-muted">
        {url ? (
          <img src={url} alt="" className="h-full w-full object-cover" draggable={false} />
        ) : (
          <IconPhoto size={18} className="text-content-subtle/40" />
        )}
      </div>
      <div className="flex items-center gap-1 px-1.5 py-1 text-[10px] text-content-muted">
        <span
          className={cn(
            "rounded px-1 py-px",
            isOriginal ? "bg-surface-muted text-content-muted" : "bg-accent/15 text-accent",
          )}
        >
          {versionLabel}
        </span>
        <span className="ml-auto font-mono text-content-subtle">{formatCanvasTime(image.createdAt).slice(6)}</span>
      </div>
    </button>
  );
}

/* ── 主视图 ── */

export function CanvasEditView({
  image,
  images,
  scopeSel,
  imageReady,
  galleryDir,
  onSelectImage,
  onDerived,
  onOpenGallery,
  onImported,
  onChangeDir,
}: {
  image: CanvasImage | null;
  images: CanvasImage[];
  scopeSel: CanvasScopeSel;
  imageReady: boolean;
  galleryDir: string;
  onSelectImage: (id: string) => void;
  onDerived: (img: CanvasImage) => void;
  onOpenGallery: () => void;
  onImported: (imgs: CanvasImage[]) => void;
  onChangeDir: () => void;
}) {
  const { t } = useI18n();
  const pushToast = useToastStore((s) => s.push);
  const { url: imageUrl, failed: imageFailed } = useCanvasImageUrl(image?.id ?? null);

  const [tool, setTool] = useState<Tool>("brush");
  const [brushSize, setBrushSize] = useState(32);
  const [editMode, setEditMode] = useState<EditMode>("inpaint");
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 蒙版笔画:完成的笔在 state(撤销/重做/计数),进行中的一笔在 ref(绘制性能)。
  const [strokes, setStrokes] = useState<Stroke[]>([]);
  const [redoStack, setRedoStack] = useState<Stroke[]>([]);

  // 舞台适配:frame = 原图按窗口缩放后的显示尺寸。
  const stageRef = useRef<HTMLDivElement | null>(null);
  const maskCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const [stageSize, setStageSize] = useState({ w: 0, h: 0 });

  // 切图:frame 坐标系下的选框;drag 状态在 ref。
  const [cropRect, setCropRect] = useState<{ l: number; t: number; w: number; h: number } | null>(null);
  const [cropRatioIdx, setCropRatioIdx] = useState(0);
  const cropDragRef = useRef<{
    x: number;
    y: number;
    l: number;
    t: number;
    w: number;
    h: number;
    hd: string | null;
  } | null>(null);

  const natW = image?.width ?? 0;
  const natH = image?.height ?? 0;
  const scale = natW > 0 && stageSize.w > 0 ? Math.min((stageSize.w - 48) / natW, (stageSize.h - 48) / natH, 1) : 0;
  const frameW = Math.max(1, Math.round(natW * scale));
  const frameH = Math.max(1, Math.round(natH * scale));

  // 切图/编辑换图时清蒙版与选框。
  useEffect(() => {
    setStrokes([]);
    setRedoStack([]);
    setCropRect(null);
    setTool("brush");
    setError(null);
  }, [image?.id]);

  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setStageSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setStageSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, [image?.id]);

  /* ── 蒙版绘制 ── */

  const maskCtx = () => maskCanvasRef.current?.getContext("2d") ?? null;

  const drawStroke = useCallback((s: Stroke) => {
    const ctx = maskCtx();
    if (!ctx) return;
    ctx.globalCompositeOperation = s.erase ? "destination-out" : "source-over";
    ctx.strokeStyle = MASK_COLOR;
    ctx.fillStyle = MASK_COLOR;
    ctx.lineWidth = s.size;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    if (s.pts.length === 1) {
      ctx.beginPath();
      ctx.arc(s.pts[0][0], s.pts[0][1], s.size / 2, 0, Math.PI * 2);
      ctx.fill();
      return;
    }
    ctx.beginPath();
    s.pts.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
    ctx.stroke();
  }, []);

  const redrawMask = useCallback(
    (list: Stroke[]) => {
      const ctx = maskCtx();
      const c = maskCanvasRef.current;
      if (!ctx || !c) return;
      ctx.clearRect(0, 0, c.width, c.height);
      for (const s of list) drawStroke(s);
    },
    [drawStroke],
  );

  // 画布尺寸随 frame 变化时重建并重放(尺寸变化会清空位图)。
  useEffect(() => {
    const c = maskCanvasRef.current;
    if (!c || frameW <= 1 || frameH <= 1) return;
    if (c.width !== frameW || c.height !== frameH) {
      c.width = frameW;
      c.height = frameH;
    }
    redrawMask(strokes);
  }, [frameW, frameH, strokes, redrawMask]);

  const framePoint = (e: React.PointerEvent): [number, number] => {
    const c = maskCanvasRef.current!;
    const r = c.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };

  const drawingRef = useRef<Stroke | null>(null);

  const onMaskPointerDown = (e: React.PointerEvent) => {
    if (tool === "crop") return;
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const s: Stroke = { erase: tool === "eraser", size: brushSize, pts: [framePoint(e)] };
    drawingRef.current = s;
    drawStroke(s);
  };
  const onMaskPointerMove = (e: React.PointerEvent) => {
    const s = drawingRef.current;
    if (!s) return;
    s.pts.push(framePoint(e));
    // 只画增量线段,不重放整笔。
    drawStroke({ ...s, pts: s.pts.slice(-2) });
  };
  const onMaskPointerUp = () => {
    const s = drawingRef.current;
    drawingRef.current = null;
    if (!s) return;
    setStrokes((prev) => [...prev, s]);
    setRedoStack([]);
  };

  const undoStroke = () => {
    if (strokes.length === 0) return;
    const next = strokes.slice(0, -1);
    setStrokes(next);
    setRedoStack((prev) => [...prev, strokes[strokes.length - 1]]);
    redrawMask(next);
  };
  const redoStroke = () => {
    if (redoStack.length === 0) return;
    const s = redoStack[redoStack.length - 1];
    const next = [...strokes, s];
    setStrokes(next);
    setRedoStack(redoStack.slice(0, -1));
    redrawMask(next);
  };
  const clearMask = () => {
    setStrokes([]);
    setRedoStack([]);
    redrawMask([]);
  };

  /** 导出自然尺寸的蒙版 PNG:全图不透明 = 保留,画笔区透明 = 重绘。 */
  const buildMaskDataUrl = (): string | null => {
    if (!strokes.some((s) => !s.erase)) return null;
    const c = document.createElement("canvas");
    c.width = natW;
    c.height = natH;
    const ctx = c.getContext("2d")!;
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, natW, natH);
    const k = natW / frameW;
    for (const s of strokes) {
      ctx.globalCompositeOperation = s.erase ? "source-over" : "destination-out";
      ctx.strokeStyle = "#000";
      ctx.fillStyle = "#000";
      ctx.lineWidth = s.size * k;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.beginPath();
      if (s.pts.length === 1) {
        ctx.arc(s.pts[0][0] * k, s.pts[0][1] * k, (s.size * k) / 2, 0, Math.PI * 2);
        ctx.fill();
      } else {
        s.pts.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x * k, y * k) : ctx.lineTo(x * k, y * k)));
        ctx.stroke();
      }
    }
    return c.toDataURL("image/png");
  };

  /* ── 切图 ── */

  const enterCrop = () => {
    setTool("crop");
    const w = Math.round(frameW * 0.7);
    const h = Math.round(frameH * 0.7);
    setCropRect({ l: Math.round((frameW - w) / 2), t: Math.round((frameH - h) / 2), w, h });
  };
  const exitCrop = () => {
    setTool("brush");
    setCropRect(null);
  };

  const clampCrop = (r: { l: number; t: number; w: number; h: number }) => ({
    l: Math.max(0, Math.min(r.l, frameW - r.w)),
    t: Math.max(0, Math.min(r.t, frameH - r.h)),
    w: Math.min(r.w, frameW),
    h: Math.min(r.h, frameH),
  });

  const onCropPointerDown = (e: React.PointerEvent, hd: string | null) => {
    if (!cropRect || e.button !== 0) return;
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    cropDragRef.current = { x: e.clientX, y: e.clientY, ...cropRect, hd };
  };
  const onCropPointerMove = (e: React.PointerEvent) => {
    const d = cropDragRef.current;
    if (!d) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (!d.hd) {
      setCropRect(clampCrop({ l: d.l + dx, t: d.t + dy, w: d.w, h: d.h }));
      return;
    }
    let { w, h } = d;
    if (d.hd.includes("r")) w = d.w + dx;
    if (d.hd.includes("l")) w = d.w - dx;
    if (d.hd.includes("b")) h = d.h + dy;
    if (d.hd.includes("t")) h = d.h - dy;
    w = Math.max(24, w);
    h = Math.max(24, h);
    const r = CROP_RATIOS[cropRatioIdx];
    if (r > 0) {
      // 变化幅度更大的轴为驱动轴,另一轴按比例跟随。
      const wFromH = h * r;
      const hFromW = w / r;
      if (Math.abs(wFromH - d.w) > Math.abs(w - d.w)) w = wFromH;
      else h = hFromW;
    }
    let l = d.l;
    let tt = d.t;
    if (d.hd.includes("l")) l = d.l + d.w - w; // 拖左/上手柄时锚定对边
    if (d.hd.includes("t")) tt = d.t + d.h - h;
    setCropRect(clampCrop({ l, t: tt, w, h }));
  };
  const onCropPointerUp = () => {
    cropDragRef.current = null;
  };

  const applyCrop = async () => {
    if (!cropRect || !image || busy) return;
    const k = natW / frameW;
    const rect = {
      x: Math.round(cropRect.l * k),
      y: Math.round(cropRect.t * k),
      width: Math.max(1, Math.round(cropRect.w * k)),
      height: Math.max(1, Math.round(cropRect.h * k)),
    };
    setBusy(true);
    setError(null);
    try {
      const res = await api.canvas.crop({ parentId: image.id, rect });
      if (!res.ok || !res.image) {
        setError(res.error ?? "crop failed");
        return;
      }
      exitCrop();
      onDerived(res.image);
      pushToast({
        kind: "info",
        title: t("canvas.toast.cropped", { name: res.image.name, w: res.image.width, h: res.image.height }),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  /* ── 键盘:[ ] 笔刷,Esc 退切图 ── */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "TEXTAREA" || target.tagName === "INPUT")) return;
      if (e.key === "[") setBrushSize((v) => Math.max(8, v - 4));
      else if (e.key === "]") setBrushSize((v) => Math.min(80, v + 4));
      else if (e.key === "Escape" && tool === "crop") exitCrop();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tool]);

  /* ── 编辑提交 ── */

  const loadImageEl = (src: string) =>
    new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error("image decode failed"));
      el.src = src;
    });

  const submitEdit = async () => {
    if (!image || busy) return;
    const text = prompt.trim();
    if (!text) {
      setError(t("canvas.edit.promptRequired"));
      return;
    }
    let maskBase64: string | undefined;
    let imageBase64: string | undefined;
    if (editMode === "inpaint") {
      const mask = buildMaskDataUrl();
      if (!mask) {
        setError(t("canvas.edit.maskRequired"));
        return;
      }
      maskBase64 = mask;
    } else if (editMode === "outpaint") {
      if (!imageUrl) return;
      try {
        const el = await loadImageEl(imageUrl);
        const cw = Math.round(natW * OUTPAINT_SCALE);
        const ch = Math.round(natH * OUTPAINT_SCALE);
        const dx = Math.round((cw - natW) / 2);
        const dy = Math.round((ch - natH) / 2);
        const c = document.createElement("canvas");
        c.width = cw;
        c.height = ch;
        c.getContext("2d")!.drawImage(el, dx, dy);
        imageBase64 = c.toDataURL("image/png");
        // 蒙版:中央原图区不透明(保留),新增边区透明(重绘)。
        const m = document.createElement("canvas");
        m.width = cw;
        m.height = ch;
        const mctx = m.getContext("2d")!;
        mctx.fillStyle = "#000";
        mctx.fillRect(0, 0, cw, ch);
        mctx.globalCompositeOperation = "destination-out";
        mctx.beginPath();
        mctx.rect(0, 0, cw, ch);
        mctx.rect(dx, dy, natW, natH);
        mctx.fill("evenodd");
        maskBase64 = m.toDataURL("image/png");
      } catch {
        setError(t("canvas.edit.loadFailed"));
        return;
      }
    }
    setBusy(true);
    setError(null);
    try {
      const res = await api.canvas.edit({
        parentId: image.id,
        prompt: text,
        ...(maskBase64 ? { maskBase64 } : {}),
        ...(imageBase64 ? { imageBase64 } : {}),
      });
      if (!res.ok || !res.image) {
        setError(res.error ?? "edit failed");
        return;
      }
      clearMask();
      onDerived(res.image);
      pushToast({ kind: "info", title: t("canvas.toast.edited") });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  /* ── 导入 ── */
  const importLocal = async () => {
    const res = await api.canvas.import({
      scope: scopeSel.scope,
      ...(scopeSel.scope === "project" && scopeSel.projectId ? { projectId: scopeSel.projectId } : {}),
    });
    if (res.ok && res.images?.length) {
      onImported(res.images);
      pushToast({ kind: "info", title: t("canvas.toast.imported", { n: res.images.length }) });
    } else if (res.ok) {
      pushToast({ kind: "warning", title: t("canvas.toast.importNone") });
    }
  };

  /* ── 派生链 ── */
  const chain = useMemo(
    () =>
      image ? images.filter((i) => i.chainId === image.chainId).sort((a, b) => a.createdAt - b.createdAt) : [],
    [images, image],
  );
  const versionLabel = (img: CanvasImage, idx: number) => (idx === 0 ? t("canvas.versionOriginal") : `v${idx + 1}`);

  /* ── 渲染 ── */

  if (!image) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-4 text-content-subtle">
        <IconPhoto size={44} className="opacity-30" />
        <p className="text-xs">{t("canvas.edit.emptyHint")}</p>
        <div className="flex gap-2">
          <Button variant="secondary" size="md" onClick={onOpenGallery}>
            <IconPhoto size={14} />
            {t("canvas.edit.pickFromGallery")}
          </Button>
          <Button variant="secondary" size="md" onClick={() => void importLocal()}>
            <IconUpload size={14} />
            {t("canvas.edit.import")}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1">
      {/* 舞台 + 派生链 */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* 工具条 */}
        <div className="flex items-center gap-1.5 border-b border-edge px-3 py-2">
          {(
            [
              ["brush", IconBrush, t("canvas.tool.brush")],
              ["eraser", IconEraser, t("canvas.tool.eraser")],
              ["crop", IconCrop, t("canvas.tool.crop")],
            ] as const
          ).map(([key, Icon, label]) => (
            <button
              key={key}
              type="button"
              title={label}
              onClick={() => (key === "crop" ? enterCrop() : (setTool(key), setCropRect(null)))}
              className={cn(
                "grid h-7 w-7 place-items-center rounded-md transition-colors",
                tool === key ? "bg-surface-muted text-content" : "text-content-muted hover:bg-surface-muted/60",
              )}
            >
              <Icon size={16} />
            </button>
          ))}
          <span className="mx-1 h-4 w-px bg-edge" />
          <span
            className="h-3 w-3 shrink-0 rounded-full border border-edge bg-accent/50"
            style={{ width: Math.max(6, Math.min(20, brushSize / 4)), height: Math.max(6, Math.min(20, brushSize / 4)) }}
          />
          <input
            type="range"
            min={8}
            max={80}
            value={brushSize}
            onChange={(e) => setBrushSize(Number(e.target.value))}
            title={t("canvas.tool.brushSize")}
            className="w-24 accent-accent"
          />
          <span className="w-10 text-[11px] text-content-muted">{brushSize}px</span>
          <span className="mx-1 h-4 w-px bg-edge" />
          <Button variant="ghost" size="sm" onClick={undoStroke} disabled={strokes.length === 0} title={t("canvas.tool.undo")}>
            <IconArrowBackUp size={14} />
          </Button>
          <Button variant="ghost" size="sm" onClick={redoStroke} disabled={redoStack.length === 0} title={t("canvas.tool.redo")}>
            <IconArrowForwardUp size={14} />
          </Button>
          <Button variant="ghost" size="sm" onClick={clearMask} title={t("canvas.tool.clearMask")}>
            <IconTrash size={13} />
          </Button>
          <span className="flex-1" />
          <span className="text-[11px] text-content-subtle">
            {image.name} · {natW}×{natH}
          </span>
        </div>

        {/* 舞台 */}
        <div ref={stageRef} className="relative min-h-0 flex-1 overflow-hidden bg-surface-base">
          <div className="grid h-full place-items-center overflow-auto p-6">
            <div className="relative shrink-0" style={{ width: frameW, height: frameH }}>
              {imageUrl && (
                <img
                  src={imageUrl}
                  alt={image.name}
                  draggable={false}
                  className="absolute inset-0 h-full w-full rounded-md object-fill select-none"
                />
              )}
              {imageFailed && (
                <div className="absolute inset-0 grid place-items-center text-xs text-danger">{t("canvas.edit.loadFailed")}</div>
              )}
              <canvas
                ref={maskCanvasRef}
                className={cn("absolute inset-0 h-full w-full", tool === "crop" && "pointer-events-none")}
                style={{ cursor: tool === "crop" ? "default" : "crosshair", touchAction: "none" }}
                onPointerDown={onMaskPointerDown}
                onPointerMove={onMaskPointerMove}
                onPointerUp={onMaskPointerUp}
                onPointerCancel={onMaskPointerUp}
              />
              {/* 切图选框 */}
              {tool === "crop" && cropRect && (
                <div
                  className="absolute cursor-move border-2 border-accent bg-accent/5"
                  style={{ left: cropRect.l, top: cropRect.t, width: cropRect.w, height: cropRect.h, touchAction: "none" }}
                  onPointerDown={(e) => onCropPointerDown(e, null)}
                  onPointerMove={onCropPointerMove}
                  onPointerUp={onCropPointerUp}
                  onPointerCancel={onCropPointerUp}
                >
                  {(["tl", "tr", "bl", "br"] as const).map((hd) => (
                    <span
                      key={hd}
                      onPointerDown={(e) => onCropPointerDown(e, hd)}
                      onPointerMove={onCropPointerMove}
                      onPointerUp={onCropPointerUp}
                      onPointerCancel={onCropPointerUp}
                      className={cn(
                        "absolute h-3 w-3 rounded-sm border border-accent bg-surface",
                        hd === "tl" && "-top-1.5 -left-1.5 cursor-nwse-resize",
                        hd === "tr" && "-top-1.5 -right-1.5 cursor-nesw-resize",
                        hd === "bl" && "-bottom-1.5 -left-1.5 cursor-nesw-resize",
                        hd === "br" && "-right-1.5 -bottom-1.5 cursor-nwse-resize",
                      )}
                      style={{ touchAction: "none" }}
                    />
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* 切图操作条 */}
          {tool === "crop" && cropRect && (
            <div className="absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-2 rounded-xl border border-edge bg-surface px-3 py-2 shadow-lg">
              <IconCrop size={14} className="text-content-muted" />
              <span className="text-[11px] text-content-muted">{t("canvas.crop.tip")}</span>
              <div className="flex rounded-lg border border-edge p-0.5">
                {CROP_RATIOS.map((r, i) => (
                  <button
                    key={i}
                    type="button"
                    onClick={() => setCropRatioIdx(i)}
                    className={cn(
                      "rounded-md px-2 py-0.5 text-[11px] transition-colors",
                      cropRatioIdx === i ? "bg-surface-muted text-content" : "text-content-muted hover:text-content",
                    )}
                  >
                    {i === 0 ? t("canvas.crop.ratioFree") : CROP_RATIO_LABELS[i]}
                  </button>
                ))}
              </div>
              <Button variant="primary" size="sm" onClick={() => void applyCrop()} disabled={busy}>
                {t("canvas.crop.apply")}
              </Button>
              <Button variant="secondary" size="sm" onClick={exitCrop}>
                {t("canvas.crop.cancel")}
              </Button>
            </div>
          )}
        </div>

        {/* 派生链 */}
        {chain.length > 0 && (
          <div className="flex items-center gap-2 overflow-x-auto border-t border-edge px-3 py-2">
            <span className="shrink-0 text-[11px] text-content-subtle">{t("canvas.lineage")}</span>
            {chain.map((img, i) => (
              <div key={img.id} className="flex shrink-0 items-center gap-2">
                {i > 0 && (
                  <span className="text-[10px] text-content-subtle">
                    → {img.prompt.startsWith("切图") ? t("canvas.versionVia.crop") : t("canvas.versionVia.edit")}
                  </span>
                )}
                <LineageNode
                  image={img}
                  active={img.id === image.id}
                  isOriginal={i === 0}
                  versionLabel={versionLabel(img, i)}
                  onSelect={onSelectImage}
                />
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 侧栏 */}
      <aside className="flex w-[300px] shrink-0 flex-col gap-4 overflow-y-auto border-l border-edge p-4">
        <div>
          <div className="flex items-center gap-2">
            <b className="text-xs">{t("canvas.edit.editing")}</b>
            <span className="truncate text-xs text-content-muted">{image.name}</span>
            <span className="ml-auto shrink-0 rounded bg-accent/15 px-1.5 py-0.5 text-[10px] text-accent">
              {versionLabel(image, chain.findIndex((x) => x.id === image.id))}
            </span>
          </div>
          {image.prompt && (
            <p className="mt-1.5 line-clamp-2 text-[11px] text-content-subtle" title={image.prompt}>
              {image.prompt}
            </p>
          )}
        </div>

        <div>
          <label className="mb-1.5 block text-xs font-medium text-content">{t("canvas.edit.modeLabel")}</label>
          <div className="flex rounded-lg border border-edge p-0.5">
            {(
              [
                ["inpaint", t("canvas.edit.modeInpaint"), t("canvas.edit.modeInpaintHint")],
                ["img2img", t("canvas.edit.modeImg2img"), t("canvas.edit.modeImg2imgHint")],
                ["outpaint", t("canvas.edit.modeOutpaint"), t("canvas.edit.modeOutpaintHint")],
              ] as const
            ).map(([key, label, hint]) => (
              <button
                key={key}
                type="button"
                title={hint}
                onClick={() => setEditMode(key)}
                className={cn(
                  "flex-1 rounded-md px-1.5 py-1 text-[11px] transition-colors",
                  editMode === key ? "bg-surface-muted text-content" : "text-content-muted hover:text-content",
                )}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {editMode === "inpaint" && (
          <div className="flex items-center gap-1.5 text-[11px] text-content-muted">
            <IconBrush size={12} className="text-accent" />
            <span>{t("canvas.edit.maskCount", { n: strokes.filter((s) => !s.erase).length })}</span>
            <button type="button" onClick={clearMask} className="ml-auto text-accent hover:underline">
              {t("canvas.edit.maskClear")}
            </button>
          </div>
        )}

        <div>
          <label className="mb-1.5 block text-xs font-medium text-content">
            {t("canvas.edit.promptLabel")}
            <span className="ml-2 font-normal text-content-subtle">{t("canvas.edit.promptHint")}</span>
          </label>
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            rows={3}
            maxLength={4000}
            placeholder={t("canvas.edit.promptPlaceholder")}
            className="w-full resize-y rounded-lg border border-edge-input bg-surface px-3 py-2 text-sm text-content outline-none placeholder:text-content-subtle/60 focus-visible:border-accent/60 focus-visible:ring-[3px] focus-visible:ring-accent/15"
          />
        </div>

        <Button
          variant="primary"
          size="md"
          onClick={() => void submitEdit()}
          disabled={busy || !imageReady}
          className="w-full"
        >
          <IconWand size={14} />
          {busy ? t("canvas.edit.submitting") : t("canvas.edit.submit")}
        </Button>
        <p className="text-[11px] leading-relaxed text-content-subtle">
          {t("canvas.edit.resultNote")}
          <br />
          {t("canvas.saveTo")}:
          <span className="font-mono"> {galleryDir} </span>
          <button type="button" onClick={onChangeDir} className="text-accent hover:underline">
            {t("canvas.saveToChange")}
          </button>
        </p>
        {error && <div className="rounded-lg bg-danger/10 px-3 py-2 text-xs text-danger">{error}</div>}
      </aside>
    </div>
  );
}
