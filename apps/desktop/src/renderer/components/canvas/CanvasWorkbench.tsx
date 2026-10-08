/**
 * 画布工作台外壳(TODO-033/041 + TODO-049)。
 *
 * 主区三视图(文生图 / 画布编辑 / 图库)共享同一份图库状态:范围(独立 /
 * 项目)、当前范围图片列表、正在编辑的图片 id。图片内容按张经
 * canvas.imageData 懒加载(见 canvasShared 的 useCanvasImageUrl)。
 *
 * 挂法:App.tsx 主面板行里,canvasOpen 时作为 ThreePaneLayout 的兄弟节点
 * 渲染(工作区 CSS 隐藏保活);rail 按钮切换,切换会话自动退出(App 根的
 * 订阅负责)。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { IconArrowLeft, IconBrush, IconPalette, IconPhoto, IconSparkles } from "@renderer/lib/icons.js";
import { cn } from "@renderer/lib/cn.js";
import { api } from "@renderer/lib/api.js";
import { CANVAS_GALLERY_DIR_SETTING_KEY, type CanvasImage } from "@contracts/ipc";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import { useToastStore } from "@renderer/stores/toastStore.js";
import { Select } from "@renderer/components/ui/index.js";
import { T2iView } from "./T2iView.js";
import { CanvasEditView } from "./CanvasEditView.js";
import { GalleryView } from "./GalleryView.js";
import type { CanvasScopeSel } from "./canvasShared.js";

type CanvasView = "t2i" | "edit" | "gallery";

export function CanvasWorkbench() {
  const { t } = useI18n();
  const pushToast = useToastStore((s) => s.push);
  const setCanvasOpen = useSessionStore((s) => s.setCanvasOpen);
  const setSettingsOpen = useSessionStore((s) => s.setSettingsOpen);
  const projects = useSessionStore((s) => s.projects);
  const activeProjectId = useSessionStore((s) => s.activeProjectId);

  const [scopeSel, setScopeSel] = useState<CanvasScopeSel>({ scope: "global", projectId: null });
  const [view, setView] = useState<CanvasView>("t2i");
  const [images, setImages] = useState<CanvasImage[]>([]);
  const [activeImageId, setActiveImageId] = useState<string | null>(null);
  const [galleryDir, setGalleryDir] = useState("");
  const [imageIssue, setImageIssue] = useState<string | null>(null);
  const [imageModel, setImageModel] = useState("");

  const liveProjects = useMemo(() => projects.filter((p) => !p.archived), [projects]);
  const projectNames = useMemo(() => new Map(projects.map((p) => [p.id, p.name])), [projects]);

  const reload = useCallback(async () => {
    try {
      // 项目范围:先回填历史会话生成的图片(幂等),再取列表——让画布打开
      // 时补上功能上线前(或漏登记)的存量图。
      if (scopeSel.scope === "project" && scopeSel.projectId) {
        await api.canvas.backfill({ scope: "project", projectId: scopeSel.projectId });
      }
      const res = await api.canvas.list({
        scope: scopeSel.scope,
        ...(scopeSel.scope === "project" && scopeSel.projectId ? { projectId: scopeSel.projectId } : {}),
      });
      setImages(res.images);
    } catch {
      /* DB 未就绪等瞬态:保持旧列表 */
    }
  }, [scopeSel.scope, scopeSel.projectId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    void api.canvas.home().then((h) => setGalleryDir(h.dir));
    void api.builtinTools.get().then((s) => {
      setImageIssue(s.imageIssue);
      setImageModel(s.config.image.model);
    });
  }, []);

  const pickScope = (scope: "global" | "project") => {
    if (scope === "project") {
      const pid = activeProjectId ?? liveProjects[0]?.id ?? null;
      setScopeSel({ scope, projectId: pid });
    } else {
      setScopeSel({ scope, projectId: null });
    }
  };

  const activeImage = images.find((i) => i.id === activeImageId) ?? null;

  const editImage = (id: string) => {
    setActiveImageId(id);
    setView("edit");
  };

  const changeDir = async () => {
    const picked = await api.pickFolder();
    if (!picked.path) return;
    await api.setting.set({ key: CANVAS_GALLERY_DIR_SETTING_KEY, value: picked.path });
    const h = await api.canvas.home();
    setGalleryDir(h.dir);
    pushToast({ kind: "info", title: t("canvas.toast.dirChanged") });
  };

  const viewBtn = (key: CanvasView, label: string, Icon: typeof IconPhoto) => (
    <button
      key={key}
      type="button"
      onClick={() => setView(key)}
      className={cn(
        "flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs transition-colors",
        view === key ? "bg-surface-muted text-content" : "text-content-muted hover:text-content",
      )}
    >
      <Icon size={14} />
      {label}
    </button>
  );

  return (
    <div className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-2xl border border-edge bg-surface shadow-sm">
      {/* 头部 */}
      <header className="flex shrink-0 items-center gap-3 border-b border-edge px-4 py-2.5">
        <IconPalette size={17} className="text-accent" />
        <b className="text-sm">{t("canvas.title")}</b>

        {/* 范围切换 */}
        <div className="flex items-center gap-1.5">
          <div className="flex rounded-lg border border-edge p-0.5">
            {(["global", "project"] as const).map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => pickScope(s)}
                disabled={s === "project" && liveProjects.length === 0}
                className={cn(
                  "rounded-md px-2.5 py-1 text-[11px] transition-colors disabled:opacity-40",
                  scopeSel.scope === s ? "bg-surface-muted text-content" : "text-content-muted hover:text-content",
                )}
              >
                {s === "global" ? t("canvas.scopeGlobal") : t("canvas.scopeProject")}
              </button>
            ))}
          </div>
          {scopeSel.scope === "project" && (
            <Select.Root
              value={scopeSel.projectId ?? ""}
              onValueChange={(v) =>
                setScopeSel({ scope: "project", projectId: typeof v === "string" && v ? v : null })
              }
            >
              <Select.Trigger>
                <Select.Value>{(v) => projectNames.get(v as string) ?? "…"}</Select.Value>
              </Select.Trigger>
              <Select.Portal>
                <Select.Positioner>
                  <Select.Popup>
                    <Select.List>
                      {liveProjects.map((p) => (
                        <Select.Item key={p.id} value={p.id}>
                          {p.name}
                        </Select.Item>
                      ))}
                    </Select.List>
                  </Select.Popup>
                </Select.Positioner>
              </Select.Portal>
            </Select.Root>
          )}
        </div>

        <span className="flex-1" />

        {/* 视图切换 */}
        <div className="flex rounded-lg border border-edge p-0.5">
          {viewBtn("t2i", t("canvas.viewT2i"), IconSparkles)}
          {viewBtn("edit", t("canvas.viewEdit"), IconBrush)}
          {viewBtn("gallery", t("canvas.viewGallery"), IconPhoto)}
        </div>

        <span className="flex-1" />

        <button
          type="button"
          onClick={() => setCanvasOpen(false)}
          className="flex items-center gap-1.5 rounded-lg border border-edge px-2.5 py-1.5 text-[11px] text-content-muted transition-colors hover:bg-surface-muted hover:text-content"
        >
          <IconArrowLeft size={13} />
          {t("canvas.close")}
        </button>
      </header>

      {/* 图片模型未配置引导 */}
      {imageIssue && (
        <div className="flex shrink-0 items-center gap-2 border-b border-edge bg-warning/10 px-4 py-2 text-xs text-content">
          <span>{t("canvas.notConfigured")}</span>
          <button
            type="button"
            onClick={() => setSettingsOpen(true, "builtin-tools")}
            className="font-medium text-accent hover:underline"
          >
            {t("canvas.notConfiguredAction")}
          </button>
        </div>
      )}

      {/* 视图主体 */}
      {view === "t2i" && (
        <div data-canvas-view="t2i" className="flex min-h-0 flex-1">
          <T2iView
            scopeSel={scopeSel}
            imageReady={!imageIssue}
            modelLabel={imageModel}
            onGenerated={() => void reload()}
            onEditImage={editImage}
          />
        </div>
      )}
      {view === "edit" && (
        <div data-canvas-view="edit" className="flex min-h-0 flex-1">
          <CanvasEditView
            image={activeImage}
            images={images}
            scopeSel={scopeSel}
            imageReady={!imageIssue}
            galleryDir={galleryDir}
            onSelectImage={setActiveImageId}
            onDerived={(img) => {
              void reload().then(() => setActiveImageId(img.id));
            }}
            onOpenGallery={() => setView("gallery")}
            onImported={(imgs) => {
              void reload().then(() => setActiveImageId(imgs[0]?.id ?? null));
            }}
            onChangeDir={() => void changeDir()}
          />
        </div>
      )}
      {view === "gallery" && (
        <div data-canvas-view="gallery" className="flex min-h-0 flex-1">
          <GalleryView
            images={images}
            scopeSel={scopeSel}
            projects={projectNames}
            onChanged={() => void reload()}
            onEditImage={editImage}
            onGotoT2i={() => setView("t2i")}
          />
        </div>
      )}
    </div>
  );
}
