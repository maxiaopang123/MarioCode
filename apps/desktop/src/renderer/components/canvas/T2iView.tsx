/**
 * 文生图视图(画布工作台视图一)。
 *
 * 表单:提示词 + 风格 chips(多选,生成时以文本追加)+ 负面提示词(同样以
 * 文本并入——OpenAI images 接口没有这些参数,不做撒谎的 UI)+ 画幅 + 数量。
 * 结果进当前范围图库,同时展示在右侧结果区;点击结果图送入画布编辑。
 */
import { useMemo, useState } from "react";
import { IconPhoto, IconSparkles } from "@renderer/lib/icons.js";
import { cn } from "@renderer/lib/cn.js";
import { api } from "@renderer/lib/api.js";
import { Button } from "@renderer/components/ui/index.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import type { MessageId } from "@renderer/lib/i18n/index.js";
import { useToastStore } from "@renderer/stores/toastStore.js";
import type { CanvasImage } from "@contracts/ipc";
import { useCanvasImageUrl, type CanvasScopeSel } from "./canvasShared.js";

const STYLE_KEYS: MessageId[] = [
  "canvas.t2i.style.cinematic",
  "canvas.t2i.style.minimal",
  "canvas.t2i.style.watercolor",
  "canvas.t2i.style.pixel",
  "canvas.t2i.style.isometric",
  "canvas.t2i.style.cyberpunk",
];

/** 画幅选项 → images/generations 的 size 参数(auto = 用端点默认)。 */
const SIZE_OPTIONS = [
  { key: "auto", label: null, size: undefined },
  { key: "1:1", label: "1:1", size: "1024x1024" },
  { key: "3:2", label: "3:2", size: "1536x1024" },
  { key: "9:16", label: "9:16", size: "1024x1536" },
] as const;

const COUNT_OPTIONS = [1, 2, 4] as const;

function ResultThumb({ image, onEdit }: { image: CanvasImage; onEdit: (id: string) => void }) {
  const { url } = useCanvasImageUrl(image.id);
  const { t } = useI18n();
  return (
    <button
      type="button"
      onClick={() => onEdit(image.id)}
      title={t("canvas.gallery.editInCanvas")}
      className="group relative flex flex-col overflow-hidden rounded-xl border border-edge bg-surface-muted text-left transition-colors hover:border-accent/50"
    >
      <div className="flex aspect-[4/3] items-center justify-center overflow-hidden">
        {url ? (
          <img src={url} alt={image.name} className="h-full w-full object-cover" />
        ) : (
          <IconPhoto size={28} className="text-content-subtle/40" />
        )}
      </div>
      <div className="flex items-center gap-1.5 px-2 py-1.5 text-[11px] text-content-muted">
        <span className="truncate">{image.name}</span>
        <span className="ml-auto shrink-0 font-mono text-content-subtle">
          {image.width}×{image.height}
        </span>
      </div>
    </button>
  );
}

export function T2iView({
  scopeSel,
  imageReady,
  modelLabel,
  onGenerated,
  onEditImage,
}: {
  scopeSel: CanvasScopeSel;
  /** 图片端点已配置(设置 → 内置工具);false 时禁用生成。 */
  imageReady: boolean;
  /** 展示用:当前图片模型名(未知时为空串)。 */
  modelLabel: string;
  onGenerated: (images: CanvasImage[]) => void;
  onEditImage: (id: string) => void;
}) {
  const { t } = useI18n();
  const pushToast = useToastStore((s) => s.push);
  const [prompt, setPrompt] = useState("");
  const [negative, setNegative] = useState("");
  const [styles, setStyles] = useState<ReadonlySet<MessageId>>(new Set());
  const [sizeKey, setSizeKey] = useState<string>("auto");
  const [count, setCount] = useState<number>(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [batch, setBatch] = useState<CanvasImage[]>([]);

  const sizeOpt = useMemo(() => SIZE_OPTIONS.find((o) => o.key === sizeKey) ?? SIZE_OPTIONS[0], [sizeKey]);

  const toggleStyle = (key: MessageId) => {
    setStyles((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const generate = async () => {
    const text = prompt.trim();
    if (!text || busy) return;
    setBusy(true);
    setError(null);
    try {
      // 风格与负面提示词以文本并入(images API 没有独立参数)。
      const styleText = [...styles].map((k) => t(k)).join(", ");
      let full = styleText ? `${text}, ${styleText}` : text;
      const neg = negative.trim();
      if (neg) full = `${full}\n避免:${neg}`;
      const res = await api.canvas.generate({
        scope: scopeSel.scope,
        ...(scopeSel.scope === "project" && scopeSel.projectId ? { projectId: scopeSel.projectId } : {}),
        prompt: full,
        ...(sizeOpt.size ? { size: sizeOpt.size } : {}),
        count,
      });
      if (!res.ok || !res.images?.length) {
        setError(res.error ?? t("canvas.t2i.failed"));
        return;
      }
      setBatch(res.images);
      onGenerated(res.images);
      pushToast({ kind: "info", title: t("canvas.toast.generated", { n: res.images.length }) });
      // 数量 >1 时可能部分成功:把失败原因告诉用户,但不盖掉已出的图。
      if (res.error) setError(t("canvas.t2i.partialFail", { error: res.error }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-0 flex-1">
      {/* 左:表单 */}
      <div className="flex w-[380px] shrink-0 flex-col gap-4 overflow-y-auto border-r border-edge p-5">
        <div>
          <label className="mb-1.5 block text-xs font-medium text-content">
            {t("canvas.t2i.promptLabel")}
            <span className="ml-2 font-normal text-content-subtle">{t("canvas.t2i.promptHint")}</span>
          </label>
          <div className="relative">
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              maxLength={4000}
              rows={5}
              placeholder={t("canvas.t2i.promptPlaceholder")}
              className="w-full resize-y rounded-lg border border-edge-input bg-surface px-3 py-2 text-sm text-content outline-none placeholder:text-content-subtle/60 focus-visible:border-accent/60 focus-visible:ring-[3px] focus-visible:ring-accent/15"
            />
            <span className="pointer-events-none absolute right-2 bottom-2 text-[10px] text-content-subtle">
              {prompt.length} / 4000
            </span>
          </div>
        </div>

        <div>
          <label className="mb-1.5 block text-xs font-medium text-content">
            {t("canvas.t2i.stylesLabel")}
            <span className="ml-2 font-normal text-content-subtle">{t("canvas.t2i.stylesHint")}</span>
          </label>
          <div className="flex flex-wrap gap-1.5">
            {STYLE_KEYS.map((key) => (
              <button
                key={key}
                type="button"
                onClick={() => toggleStyle(key)}
                className={cn(
                  "rounded-full border px-2.5 py-1 text-[11px] transition-colors",
                  styles.has(key)
                    ? "border-accent/60 bg-accent/10 text-accent"
                    : "border-edge bg-surface text-content-muted hover:bg-surface-muted",
                )}
              >
                {t(key)}
              </button>
            ))}
          </div>
        </div>

        <div>
          <label className="mb-1.5 block text-xs font-medium text-content">
            {t("canvas.t2i.negativeLabel")}
            <span className="ml-2 font-normal text-content-subtle">{t("canvas.t2i.negativeHint")}</span>
          </label>
          <input
            value={negative}
            onChange={(e) => setNegative(e.target.value)}
            placeholder={t("canvas.t2i.negativePlaceholder")}
            className="w-full rounded-lg border border-edge-input bg-surface px-3 py-1.5 text-sm text-content outline-none placeholder:text-content-subtle/60 focus-visible:border-accent/60 focus-visible:ring-[3px] focus-visible:ring-accent/15"
          />
        </div>

        <div className="flex gap-4">
          <div>
            <label className="mb-1.5 block text-xs font-medium text-content">{t("canvas.t2i.sizeLabel")}</label>
            <div className="flex rounded-lg border border-edge p-0.5">
              {SIZE_OPTIONS.map((o) => (
                <button
                  key={o.key}
                  type="button"
                  onClick={() => setSizeKey(o.key)}
                  className={cn(
                    "rounded-md px-2.5 py-1 text-[11px] transition-colors",
                    sizeKey === o.key ? "bg-surface-muted text-content" : "text-content-muted hover:text-content",
                  )}
                >
                  {o.label ?? t("canvas.t2i.sizeAuto")}
                </button>
              ))}
            </div>
          </div>
          <div>
            <label className="mb-1.5 block text-xs font-medium text-content">{t("canvas.t2i.countLabel")}</label>
            <div className="flex rounded-lg border border-edge p-0.5">
              {COUNT_OPTIONS.map((n) => (
                <button
                  key={n}
                  type="button"
                  onClick={() => setCount(n)}
                  className={cn(
                    "rounded-md px-2.5 py-1 text-[11px] transition-colors",
                    count === n ? "bg-surface-muted text-content" : "text-content-muted hover:text-content",
                  )}
                >
                  {n}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="mt-auto flex flex-col gap-2 pt-2">
          <Button
            variant="primary"
            size="md"
            onClick={() => void generate()}
            disabled={busy || !imageReady || !prompt.trim()}
            className="w-full"
          >
            <IconSparkles size={15} />
            {busy ? t("canvas.t2i.generating") : t("canvas.t2i.generate")}
          </Button>
          {modelLabel && (
            <div className="text-center text-[11px] text-content-subtle">{t("canvas.t2i.viaModel", { model: modelLabel })}</div>
          )}
          {error && <div className="rounded-lg bg-danger/10 px-3 py-2 text-xs text-danger">{error}</div>}
        </div>
      </div>

      {/* 右:结果区 */}
      <div className="flex min-w-0 flex-1 flex-col overflow-y-auto p-5">
        {batch.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 text-content-subtle">
            <IconPhoto size={44} className="opacity-30" />
            <p className="max-w-72 text-center text-xs">{t("canvas.t2i.resultEmpty")}</p>
          </div>
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-3">
            {batch.map((img) => (
              <ResultThumb key={img.id} image={img} onEdit={onEditImage} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
