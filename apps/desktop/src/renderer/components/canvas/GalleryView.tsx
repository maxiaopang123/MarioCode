/**
 * 图库视图(画布工作台视图三)。
 *
 * 卡片网格:缩略图 + 类型/派生链徽标 + 名称/时间/提示词;hover 出操作
 * (在画布中编辑 / 在文件夹中显示 / 复制提示词 / 删除)。删除走 ConfirmDialog,
 * 主进程把文件移入图库 .trash/(回收站),并连带删派生链上的后续版本。
 * 搜索与排序(最近/最早/派生链分组)在本地对当前列表做——量级是几十到几百张。
 */
import { useMemo, useState } from "react";
import {
  IconCopy,
  IconFolder,
  IconPhoto,
  IconSearch,
  IconSparkles,
  IconTrash,
  IconUpload,
  IconWand,
} from "@renderer/lib/icons.js";
import { cn } from "@renderer/lib/cn.js";
import { api } from "@renderer/lib/api.js";
import { Button, ConfirmDialog, Select } from "@renderer/components/ui/index.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { useToastStore } from "@renderer/stores/toastStore.js";
import type { CanvasImage } from "@contracts/ipc";
import { formatCanvasTime, useCanvasImageUrl, type CanvasScopeSel } from "./canvasShared.js";

type SortMode = "recent" | "oldest" | "chain";

function kindBadgeClass(kind: CanvasImage["kind"]): string {
  if (kind === "imported") return "bg-surface-muted text-content-muted";
  if (kind === "derived") return "bg-accent/15 text-accent";
  return "bg-primary/10 text-content-muted";
}

const KIND_LABEL_KEYS = {
  generated: "canvas.kind.generated",
  imported: "canvas.kind.imported",
  derived: "canvas.kind.derived",
} as const;

function GalleryCard({
  image,
  chainSize,
  projectName,
  onEdit,
  onDelete,
}: {
  image: CanvasImage;
  /** 同一条派生链上的版本总数(>1 时显示「N 版」)。 */
  chainSize: number;
  /** 全局范围且图片归属项目时显示项目名徽标。 */
  projectName: string | null;
  onEdit: (id: string) => void;
  onDelete: (image: CanvasImage) => void;
}) {
  const { t } = useI18n();
  const pushToast = useToastStore((s) => s.push);
  const { url } = useCanvasImageUrl(image.id);

  const copyPrompt = async () => {
    if (!image.prompt) return;
    try {
      await navigator.clipboard.writeText(image.prompt);
      pushToast({ kind: "info", title: t("canvas.toast.promptCopied") });
    } catch {
      /* 剪贴板不可用时静默 */
    }
  };

  return (
    <div className="group flex flex-col overflow-hidden rounded-xl border border-edge bg-surface">
      <div className="relative flex aspect-[4/3] items-center justify-center overflow-hidden bg-surface-muted">
        {url ? (
          <img src={url} alt={image.name} className="h-full w-full object-cover" draggable={false} />
        ) : (
          <IconPhoto size={30} className="text-content-subtle/40" />
        )}
        <div className="absolute top-1.5 left-1.5 flex gap-1">
          <span className={cn("rounded px-1.5 py-0.5 text-[10px]", kindBadgeClass(image.kind))}>
            {t(KIND_LABEL_KEYS[image.kind])}
          </span>
          {chainSize > 1 && (
            <span className="rounded bg-surface/80 px-1.5 py-0.5 text-[10px] text-content-muted">
              {t("canvas.gallery.chainCount", { n: chainSize })}
          </span>
          )}
          {projectName && (
            <span className="rounded bg-accent/15 px-1.5 py-0.5 text-[10px] text-accent">{projectName}</span>
          )}
        </div>
        {/* hover 操作 */}
        <div className="absolute inset-x-0 bottom-0 flex translate-y-1 items-center gap-1 bg-gradient-to-t from-black/55 to-transparent p-2 opacity-0 transition-all group-hover:translate-y-0 group-hover:opacity-100">
          <Button variant="primary" size="sm" onClick={() => onEdit(image.id)} className="h-6 text-[11px]">
            <IconWand size={12} />
            {t("canvas.gallery.editInCanvas")}
          </Button>
          <span className="flex-1" />
          <button
            type="button"
            title={t("canvas.gallery.showInFolder")}
            onClick={() => void api.canvas.showInFolder({ id: image.id })}
            className="grid h-6 w-6 place-items-center rounded-md bg-surface/80 text-content-muted hover:text-content"
          >
            <IconFolder size={13} />
          </button>
          <button
            type="button"
            title={t("canvas.gallery.copyPrompt")}
            onClick={() => void copyPrompt()}
            className="grid h-6 w-6 place-items-center rounded-md bg-surface/80 text-content-muted hover:text-content"
          >
            <IconCopy size={13} />
          </button>
          <button
            type="button"
            title={t("canvas.gallery.delete")}
            onClick={() => onDelete(image)}
            className="grid h-6 w-6 place-items-center rounded-md bg-surface/80 text-content-muted hover:text-danger"
          >
            <IconTrash size={13} />
          </button>
        </div>
      </div>
      <div className="flex flex-col gap-1 px-2.5 py-2">
        <div className="flex items-baseline gap-2 text-xs">
          <b className="truncate font-medium text-content">{image.name}</b>
          <time className="ml-auto shrink-0 text-[10px] text-content-subtle">{formatCanvasTime(image.createdAt)}</time>
        </div>
        {image.prompt && (
          <p className="line-clamp-2 text-[11px] leading-snug text-content-subtle" title={image.prompt}>
            {image.prompt}
          </p>
        )}
        <div className="flex items-center text-[10px] text-content-subtle">
          <span className="font-mono">
            {image.width}×{image.height}
          </span>
          <button
            type="button"
            onClick={() => onEdit(image.id)}
            className="ml-auto text-accent hover:underline"
          >
            {t("canvas.gallery.deriveNew")}
          </button>
        </div>
      </div>
    </div>
  );
}

export function GalleryView({
  images,
  scopeSel,
  projects,
  onChanged,
  onEditImage,
  onGotoT2i,
}: {
  images: CanvasImage[];
  scopeSel: CanvasScopeSel;
  /** 项目 id → 名称(全局范围下给项目图打徽标)。 */
  projects: ReadonlyMap<string, string>;
  onChanged: () => void;
  onEditImage: (id: string) => void;
  onGotoT2i: () => void;
}) {
  const { t } = useI18n();
  const pushToast = useToastStore((s) => s.push);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortMode>("recent");
  const [deleting, setDeleting] = useState<CanvasImage | null>(null);

  const chainSizes = useMemo(() => {
    const m = new Map<string, number>();
    for (const img of images) m.set(img.chainId, (m.get(img.chainId) ?? 0) + 1);
    return m;
  }, [images]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = q
      ? images.filter((i) => i.name.toLowerCase().includes(q) || i.prompt.toLowerCase().includes(q))
      : [...images];
    if (sort === "oldest") filtered.sort((a, b) => a.createdAt - b.createdAt);
    else if (sort === "chain") {
      // 派生链分组:链按最新成员倒序,链内按时间正序(原图在前)。
      const chainLatest = new Map<string, number>();
      for (const img of images) chainLatest.set(img.chainId, Math.max(chainLatest.get(img.chainId) ?? 0, img.createdAt));
      filtered.sort((a, b) => {
        const d = (chainLatest.get(b.chainId) ?? 0) - (chainLatest.get(a.chainId) ?? 0);
        return d !== 0 ? d : a.createdAt - b.createdAt;
      });
    } else filtered.sort((a, b) => b.createdAt - a.createdAt);
    return filtered;
  }, [images, query, sort]);

  const importLocal = async () => {
    const res = await api.canvas.import({
      scope: scopeSel.scope,
      ...(scopeSel.scope === "project" && scopeSel.projectId ? { projectId: scopeSel.projectId } : {}),
    });
    if (res.ok && res.images?.length) {
      pushToast({ kind: "info", title: t("canvas.toast.imported", { n: res.images.length }) });
      onChanged();
    } else if (res.ok) {
      pushToast({ kind: "warning", title: t("canvas.toast.importNone") });
    }
  };

  const confirmDelete = async () => {
    if (!deleting) return;
    const res = await api.canvas.delete({ id: deleting.id });
    setDeleting(null);
    if (res.ok) {
      pushToast({ kind: "info", title: t("canvas.toast.deleted") });
      onChanged();
    } else {
      pushToast({ kind: "error", title: res.error ?? "delete failed" });
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* 工具条 */}
      <div className="flex items-center gap-2 border-b border-edge px-4 py-2.5">
        <div className="flex w-64 items-center gap-1.5 rounded-lg border border-edge-input bg-surface px-2.5 py-1.5">
          <IconSearch size={13} className="shrink-0 text-content-subtle" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("canvas.gallery.searchPlaceholder")}
            className="w-full bg-transparent text-xs text-content outline-none placeholder:text-content-subtle/60"
          />
        </div>
        <Select.Root value={sort} onValueChange={(v) => setSort(v as SortMode)}>
          <Select.Trigger>
            <Select.Value>
              {(v) =>
                v === "oldest"
                  ? t("canvas.gallery.sortOldest")
                  : v === "chain"
                    ? t("canvas.gallery.sortChain")
                    : t("canvas.gallery.sortRecent")
              }
            </Select.Value>
          </Select.Trigger>
          <Select.Portal>
            <Select.Positioner>
              <Select.Popup>
                <Select.List>
                  <Select.Item value="recent">{t("canvas.gallery.sortRecent")}</Select.Item>
                  <Select.Item value="oldest">{t("canvas.gallery.sortOldest")}</Select.Item>
                  <Select.Item value="chain">{t("canvas.gallery.sortChain")}</Select.Item>
                </Select.List>
              </Select.Popup>
            </Select.Positioner>
          </Select.Portal>
        </Select.Root>
        <span className="text-[11px] text-content-subtle">{t("canvas.imageCount", { n: shown.length })}</span>
        <span className="flex-1" />
        <Button variant="secondary" size="sm" onClick={() => void api.canvas.openFolder()}>
          <IconFolder size={13} />
          {t("canvas.gallery.openFolder")}
        </Button>
        <Button variant="secondary" size="sm" onClick={() => void importLocal()}>
          <IconUpload size={13} />
          {t("canvas.gallery.import")}
        </Button>
        <Button variant="primary" size="sm" onClick={onGotoT2i}>
          <IconSparkles size={13} />
          {t("canvas.viewT2i")}
        </Button>
      </div>

      {/* 网格 */}
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {shown.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-content-subtle">
            <IconPhoto size={44} className="opacity-30" />
            <p className="text-xs">
              {images.length === 0 ? t("canvas.gallery.empty") : t("canvas.gallery.noMatch", { query })}
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-3">
            {shown.map((img) => (
              <GalleryCard
                key={img.id}
                image={img}
                chainSize={chainSizes.get(img.chainId) ?? 1}
                projectName={
                  scopeSel.scope === "global" && img.scope === "project" && img.projectId
                    ? (projects.get(img.projectId) ?? null)
                    : null
                }
                onEdit={onEditImage}
                onDelete={setDeleting}
              />
            ))}
          </div>
        )}
      </div>

      <ConfirmDialog
        open={deleting != null}
        danger
        title={t("canvas.gallery.deleteTitle")}
        description={t("canvas.gallery.deleteDesc", { name: deleting?.name ?? "" })}
        confirmText={t("common.delete")}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
        onConfirm={() => void confirmDelete()}
      />
    </div>
  );
}
