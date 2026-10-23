/**
 * SessionEntry — the 「本会话」 entry chip at the chat stream's top-right corner.
 *
 * It used to be a floating card that expanded in place (clip-path unfold) and
 * covered the transcript's first reply. That is gone: on desktop the chip now
 * OPENS THE DOCKED PANEL (SessionPanel), which is a real column beside the chat
 * so the messages slide left instead of being hidden. When the panel is open
 * the chip fades out (the panel's own header carries the title), and clicking
 * anywhere else still leaves the panel where it is — a docked column is part
 * of the layout, not a transient popover, so it must not close on a stray
 * click. Esc and the panel's ‹ button close it.
 *
 * Mobile keeps the old shape: a pill that opens the ActivitySheet from the
 * bottom. A 320px side column is a pointer idiom and would eat a phone screen.
 */
import { useState } from "react";
import { cn } from "@renderer/lib/cn.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { isElectron } from "@renderer/lib/platform.js";
import { IconListCheck, IconLoader2 } from "@renderer/lib/icons.js";
import type { TodoItem } from "@renderer/stores/sessionStore.js";
import type { SubagentSnapshot } from "@contracts/runtime";
import type { SessionBookmark } from "@contracts/session";
import { ActivitySheet } from "@renderer/components/mobile/ActivitySheet.js";
import { useActivityTabs, type ActivityNodeKey, type PlanBlock } from "./activityShared.js";
import { MiniBar, Ring, useSessionStats } from "./SessionOverview.js";

export function SessionEntry({
  sessionId,
  subagents,
  todos,
  planBlocks,
  bookmarks,
  waiting,
  isBookmarkStale,
  onPickBookmark,
  onRemoveBookmark,
  onRenameBookmark,
  onPickSubagent,
  onPickPlan,
  bookmarkNodeRef,
  open,
  onOpen,
}: {
  sessionId: string;
  subagents: SubagentSnapshot[];
  todos: TodoItem[];
  planBlocks: PlanBlock[];
  bookmarks: SessionBookmark[];
  /** Turn is paused on an unanswered question — the chip turns amber. */
  waiting?: boolean;
  isBookmarkStale?: (b: SessionBookmark) => boolean;
  onPickBookmark?: (b: SessionBookmark) => void;
  onRemoveBookmark?: (b: SessionBookmark) => void;
  onRenameBookmark?: (b: SessionBookmark, title: string) => void;
  onPickSubagent?: (agent: SubagentSnapshot) => void;
  onPickPlan: (plan: string) => void;
  bookmarkNodeRef?: React.RefObject<HTMLDivElement | null>;
  /** Desktop: the docked panel's open state (the chip is its closed state). */
  open: boolean;
  onOpen: () => void;
}) {
  const { t } = useI18n();
  const [sheetNode, setSheetNode] = useState<ActivityNodeKey | null>(null);
  const { tabs, setTab } = useActivityTabs();
  const stats = useSessionStats(sessionId);

  const done = todos.filter((x) => x.status === "completed").length;
  const taskPct = todos.length > 0 ? Math.round((done / todos.length) * 100) : 0;
  const runningAgents = subagents.filter((a) => a.status === "running");
  const failedAgents = subagents.filter((a) => a.status === "failed");
  const attn = !!waiting || (runningAgents.length === 0 && failedAgents.length > 0);
  const ctxPct = stats.ctxPct;

  // Nothing to report yet: no chip, no panel entry (the panel itself stays
  // mounted so its width animation has something to grow from).
  const hasAny =
    todos.length > 0 || subagents.length > 0 || planBlocks.length > 0 || bookmarks.length > 0
    || stats.history.length > 0 || stats.snapshot != null || stats.userTurnCount > 0;

  // Mobile / web shell: the existing bottom sheet, opened from a plain pill.
  if (!isElectron) {
    if (!hasAny) return null;
    return (
      <>
        <div ref={bookmarkNodeRef} className="pointer-events-none absolute right-5 top-2 z-30 flex items-center">
          <button
            type="button"
            onClick={() => setSheetNode("tasks")}
            className={cn(
              "pointer-events-auto flex h-8 items-center gap-2 rounded-full border bg-surface px-3 text-[11px] shadow-md",
              attn ? "border-warning/60 text-warning" : "border-edge text-content-muted",
            )}
          >
            <IconListCheck size={13} />
            {t("chatStream.float.title")}
          </button>
        </div>
        {sheetNode && (
          <ActivitySheet
            node={sheetNode}
            onPickNode={setSheetNode}
            subagents={subagents}
            todos={todos}
            planBlocks={planBlocks}
            bookmarks={bookmarks}
            isBookmarkStale={isBookmarkStale}
            tabs={tabs}
            onTabChange={setTab}
            onClose={() => setSheetNode(null)}
            onPickPlan={onPickPlan}
            onRemoveBookmark={onRemoveBookmark}
          />
        )}
      </>
    );
  }

  if (!hasAny) return null;

  // Desktop: the chip that opens the dock. `pointer-events-none` on the
  // wrapper so it never blocks the transcript's top-right corner.
  return (
    <div
      className={cn(
        "pointer-events-none absolute right-4 top-3.5 z-[6] flex items-center",
        "transition-[opacity,transform] duration-150",
        open && "pointer-events-none scale-95 opacity-0",
      )}
    >
      <button
        type="button"
        ref={bookmarkNodeRef as unknown as React.RefObject<HTMLButtonElement> | undefined}
        onClick={onOpen}
        aria-expanded={open}
        title={t("chatStream.float.expand")}
        className={cn(
          "pointer-events-auto inline-flex h-7 items-center gap-2 whitespace-nowrap rounded-full border bg-surface pl-2.5 pr-2.5",
          "text-[11.5px] shadow-sm transition-colors hover:bg-surface-hover hover:text-content",
          attn ? "border-warning/60 text-warning" : "border-edge text-content-muted",
        )}
      >
        <IconListCheck size={12} className="shrink-0 text-content-subtle" />
        <b className="font-semibold text-content">{t("chatStream.float.title")}</b>
        {(stats.running || attn || todos.length > 0 || stats.snapshot) && (
          <i className="h-3 w-px shrink-0 bg-edge" aria-hidden />
        )}
        {stats.running && <IconLoader2 size={11} className="shrink-0 animate-spin text-accent-strong" />}
        {attn && !stats.running && (
          <span className="font-semibold text-warning">{t("chatStream.float.needsYou")}</span>
        )}
        {todos.length > 0 && (
          <>
            <span className="tabular-nums">{done}/{todos.length}</span>
            <MiniBar pct={taskPct} className="w-[30px]" />
          </>
        )}
        {runningAgents.length > 0 && (
          <>
            <i className="h-3 w-px shrink-0 bg-edge" aria-hidden />
            <span>{t("chatStream.float.agentsN", { n: runningAgents.length })}</span>
          </>
        )}
        {stats.snapshot && (
          <>
            <i className="h-3 w-px shrink-0 bg-edge" aria-hidden />
            <Ring pct={ctxPct} />
            <span className="tabular-nums">{Math.round(ctxPct)}%</span>
          </>
        )}
      </button>
    </div>
  );
}
