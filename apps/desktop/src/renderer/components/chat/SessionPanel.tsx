/**
 * SessionPanel — 「本会话」 as a docked right column beside the chat
 * (prototypes/session-panel-docked.html, chosen variant: 整高右列).
 *
 * The whole point of the redesign: the panel is a REAL sibling of the chat
 * column, not an overlay. Opening it animates ITS WIDTH from 0 to N; the chat
 * column is `flex-1 min-w-0`, so the available width shrinks and the centered
 * message column slides left by half the panel width — no separate transform
 * on the content. (A `translateX` on the content and a width change at the end
 * makes the text re-flow in one jump; animating the width re-flows every frame
 * instead, which reads as a smooth slide.)
 *
 * Motion (same numbers as the approved prototype):
 *   open  320ms cubic-bezier(.32,.72,0,1)   fast start, long soft tail
 *   close 230ms cubic-bezier(.4,0,.8,.6)    shorter and decisive — a drawer
 * The inner column also translates 22px + fades so the widening shell reveals
 * content that is already moving, instead of a hard clip edge crawling over it.
 *
 * Narrow panes (editor open, small window): a 320px column would squeeze the
 * composer to nothing, so the panel falls back to an overlay with a hairline
 * shadow and a 「覆盖显示」 hint. Same component, same animation.
 */
import { useEffect, useRef, useState } from "react";
import { cn } from "@renderer/lib/cn.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { IconAlertTriangle, IconChevronLeft, IconLayoutSidebarRight } from "@renderer/lib/icons.js";
import {
  clampSessionPanelWidth,
  useSessionStore,
  type TodoItem,
} from "@renderer/stores/sessionStore.js";
import type { SubagentSnapshot } from "@contracts/runtime";
import type { SessionBookmark } from "@contracts/session";
import type { PlanBlock } from "./activityShared.js";
import { SessionOverview, useSessionStats } from "./SessionOverview.js";

/** Below this chat-pane width the dock covers instead of squeezing. 760 ≈ the
 *  point where a 320px column would leave the 5xl message column under ~440. */
const NARROW_PANE_PX = 760;

const EASE_OPEN = "cubic-bezier(.32,.72,0,1)";
const EASE_CLOSE = "cubic-bezier(.4,0,.8,.6)";

export function SessionPanel({
  sessionId,
  open,
  onClose,
  subagents,
  planBlocks,
  bookmarks,
  isBookmarkStale,
  onPickSubagent,
  onPickPlan,
  onPickBookmark,
  onRemoveBookmark,
  onRenameBookmark,
  todos,
}: {
  sessionId: string;
  open: boolean;
  onClose: () => void;
  subagents: SubagentSnapshot[];
  planBlocks: PlanBlock[];
  bookmarks: SessionBookmark[];
  isBookmarkStale?: (b: SessionBookmark) => boolean;
  onPickSubagent?: (agent: SubagentSnapshot) => void;
  onPickPlan: (plan: string) => void;
  onPickBookmark?: (b: SessionBookmark) => void;
  onRemoveBookmark?: (b: SessionBookmark) => void;
  onRenameBookmark?: (b: SessionBookmark, title: string) => void;
  /** Only for the header's turn/task read-out. */
  todos: TodoItem[];
}) {
  const { t } = useI18n();
  const stats = useSessionStats(sessionId);
  const width = useSessionStore((s) => s.sessionPanelWidth);
  const setWidth = useSessionStore((s) => s.setSessionPanelWidth);

  // Live width while dragging (§ don't persist every pointermove frame — the
  // DB write happens once, on release).
  const [dragW, setDragW] = useState<number | null>(null);
  const dragWRef = useRef<number | null>(null);
  const [narrow, setNarrow] = useState(false);
  const shellRef = useRef<HTMLElement>(null);

  // Narrow = the CHAT PANE is narrow, so measure the parent (this aside is
  // out of flow in narrow mode, which would otherwise feed back on itself).
  useEffect(() => {
    const parent = shellRef.current?.parentElement;
    if (!parent) return;
    const apply = () => setNarrow(parent.clientWidth < NARROW_PANE_PX);
    const ro = new ResizeObserver(apply);
    ro.observe(parent);
    apply();
    return () => ro.disconnect();
  }, []);

  // Esc folds it back (same affordance the floating card had).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, onClose]);

  /** Drag the left edge to resize (260–460px, persisted on release). */
  const startResize = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const el = e.currentTarget;
    const startX = e.clientX;
    const startW = width;
    el.setPointerCapture(e.pointerId);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    const move = (ev: PointerEvent) => {
      const w = clampSessionPanelWidth(startW + (startX - ev.clientX));
      dragWRef.current = w;
      setDragW(w);
    };
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      const w = dragWRef.current;
      dragWRef.current = null;
      setDragW(null);
      if (w != null) void setWidth(w);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  };

  const w = dragW ?? width;

  return (
    <aside
      ref={shellRef}
      aria-label={t("chatStream.float.title")}
      aria-hidden={!open}
      inert={!open}
      data-open={open ? "true" : "false"}
      className={cn(
        "relative flex h-full shrink-0 overflow-hidden bg-surface motion-reduce:transition-none",
        narrow && "absolute inset-y-0 right-0 z-30 shadow-[-18px_0_40px_rgb(0_0_0_/_0.18)]",
      )}
      style={{
        width: open ? w : 0,
        borderLeft: open ? "1px solid rgb(var(--edge))" : "none",
        // No width transition while dragging — the pointer IS the animation.
        transition:
          dragW != null
            ? "none"
            : open
              ? `width 320ms ${EASE_OPEN}`
              : `width 230ms ${EASE_CLOSE}`,
        willChange: "width",
      }}
    >
      {/* Fixed-width inner column: the shell clips US, so the content never
          squishes during the width animation. */}
      <div
        className="flex h-full flex-none flex-col motion-reduce:transition-none"
        style={{
          width: w,
          transform: open ? "none" : "translateX(22px)",
          opacity: open ? 1 : 0,
          transition: `transform 320ms ${EASE_OPEN}, opacity 256ms ease`,
        }}
      >
        {/* Drag handle — 9px of hit area on the seam, accent hairline on hover. */}
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label={t("chatStream.panel.resize")}
          title={t("chatStream.panel.resize")}
          onPointerDown={startResize}
          className={cn(
            "group/resizer absolute inset-y-0 left-0 z-[3] w-[9px] cursor-col-resize",
            !open && "pointer-events-none",
          )}
        >
          <span className="absolute inset-y-0 left-0 w-px bg-transparent transition-colors group-hover/resizer:bg-accent/60" />
        </div>

        <header className="flex h-11 shrink-0 items-center gap-2 border-b border-edge pl-3.5 pr-2.5">
          <h3 className="flex min-w-0 items-center gap-1.5 text-[12.5px] font-semibold text-content">
            <IconLayoutSidebarRight size={13} className="shrink-0 text-content-subtle" />
            <span className="truncate">{t("chatStream.float.title")}</span>
            {stats.turnCount > 0 && (
              <span className="shrink-0 text-[11.5px] font-normal tabular-nums text-content-subtle">
                {t("chatStream.float.turnN", { n: stats.turnCount })}
              </span>
            )}
          </h3>
          <span className="ml-auto flex shrink-0 items-center gap-1">
            {narrow && (
              <span
                title={t("chatStream.panel.narrow")}
                className="flex items-center gap-1 rounded-md border border-warning/50 px-1.5 py-0.5 text-[10.5px] text-warning"
              >
                <IconAlertTriangle size={11} />
                {t("chatStream.panel.narrowChip")}
              </span>
            )}
            <button
              type="button"
              onClick={onClose}
              title={t("chatStream.panel.close")}
              aria-label={t("chatStream.panel.close")}
              className="grid h-6 w-6 place-items-center rounded-md text-content-subtle transition-colors hover:bg-surface-hover hover:text-content"
            >
              <IconChevronLeft size={14} />
            </button>
          </span>
        </header>

        <div
          className="min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]"
          style={{
            // Soft cut at the bottom edge instead of a hard slice through the
            // last row when the sections overflow.
            maskImage: "linear-gradient(to bottom, #000 calc(100% - 18px), rgb(0 0 0 / 0.25))",
            WebkitMaskImage: "linear-gradient(to bottom, #000 calc(100% - 18px), rgb(0 0 0 / 0.25))",
          }}
        >
          <SessionOverview
            stats={stats}
            subagents={subagents}
            planBlocks={planBlocks}
            bookmarks={bookmarks}
            isBookmarkStale={isBookmarkStale}
            onPickSubagent={onPickSubagent}
            onPickPlan={onPickPlan}
            onPickBookmark={onPickBookmark}
            onRemoveBookmark={onRemoveBookmark}
            onRenameBookmark={onRenameBookmark}
          />
          {/* Nothing but tasks: 任务 now lives in the dock above the composer,
              so an early session can legitimately have an empty body here. */}
          {todos.length === 0 &&
            subagents.length === 0 &&
            planBlocks.length === 0 &&
            bookmarks.length === 0 &&
            stats.history.length === 0 &&
            !stats.snapshot && (
              <p className="px-3.5 py-4 text-[12.5px] text-content-subtle">
                {t("chatStream.panel.empty")}
              </p>
            )}
        </div>
      </div>
    </aside>
  );
}
