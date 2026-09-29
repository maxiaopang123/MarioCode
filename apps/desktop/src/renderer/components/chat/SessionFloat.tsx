/**
 * SessionFloat — 「本会话」 the session overview floating at the chat stream's
 * top-right corner (prototypes/ui-refresh-v3.html). Replaces the old
 * ActivityCluster pill + ActivityConsole dropdown pair on desktop.
 *
 * One card, two states:
 *   folded   → a pill showing the summary that matters while work runs
 *              (spinner + task fraction + mini bar | N subagents | context %)
 *   expanded → the same card, sections stacked in one scroll column:
 *              任务 / 子代理 / 计划 / 书签 / 大纲 / 缓存与速度 / 用量
 *
 * Only `clip-path` animates between the two (see .fsess in styles.css): the
 * card's size and inner layout are identical in both states, so folding never
 * reflows or re-wraps text. Sections with no data don't render at all, so a
 * fresh session shows a short card rather than a wall of "—".
 *
 * Deviation from the prototype (deliberate): the prototype's card has five
 * sections and leaves plans/bookmarks to other surfaces. Those lists only
 * existed in the console this component replaces, so they are kept here as
 * their own sections — dropping them would have silently removed the only way
 * to rename or remove a bookmark.
 *
 * Mobile keeps the bottom-sheet path (ActivitySheet): a 300px card pinned to a
 * corner is a pointer idiom.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { cn } from "@renderer/lib/cn.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { isElectron } from "@renderer/lib/platform.js";
import {
  IconBookmark,
  IconCheck,
  IconChevronDown,
  IconListCheck,
  IconLoader2,
  IconMessage,
  IconTrash,
  IconX,
} from "@renderer/lib/icons.js";
import { useSessionStore, type ChatMessage, type TodoItem } from "@renderer/stores/sessionStore.js";
import {
  cacheSparkline,
  fmtPct,
  fmtSpeed,
  fmtTokens,
  sessionCacheRate,
  sessionCost,
  sessionSpeed,
  sessionTokens,
  turnCacheRate,
  turnSpeed,
} from "@renderer/lib/sessionMetrics.js";
import type { SubagentSnapshot } from "@contracts/runtime";
import type { SessionBookmark } from "@contracts/session";
import { ActivitySheet } from "@renderer/components/mobile/ActivitySheet.js";
import { useActivityTabs, type ActivityNodeKey, type PlanBlock } from "./activityShared.js";

/** One outline entry: a user message, or one step line under it. */
interface OutlineItem {
  id: string;
  /** Message to scroll to when clicked. */
  messageId: string;
  kind: "turn" | "step";
  text: string;
  time?: string;
}

const EMPTY_MESSAGES: ChatMessage[] = [];

/** mm:ss for subagent elapsed time. */
function shortDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

function clockOf(ts: number | undefined): string | undefined {
  if (!ts) return undefined;
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** Section wrapper: 11.5px uppercase-ish label + optional trailing slot. */
function Sec({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="border-b border-edge px-3.5 pb-2.5 pt-3 last:border-b-0">
      <h4 className="mb-2 flex items-center gap-2 text-[11.5px] font-semibold text-content-subtle">
        {title}
        {aside && <span className="ml-auto flex items-center gap-2">{aside}</span>}
      </h4>
      {children}
    </section>
  );
}

/** Thin progress bar used by the task fraction (header + section). */
function MiniBar({ pct, className }: { pct: number; className?: string }) {
  return (
    <span className={cn("inline-block h-[3px] w-[34px] overflow-hidden rounded-full bg-edge", className)} aria-hidden>
      <i className="block h-full rounded-full bg-accent" style={{ width: `${pct}%` }} />
    </span>
  );
}

/** Conic context ring (same visual language as the composer's ContextRing). */
function Ring({ pct, size = 12 }: { pct: number; size?: number }) {
  return (
    <span
      aria-hidden
      className="inline-block shrink-0 rounded-full"
      style={{
        width: size,
        height: size,
        background: `conic-gradient(rgb(var(--accent)) ${pct}%, rgb(var(--edge)) 0)`,
        mask: "radial-gradient(farthest-side, transparent calc(100% - 3px), #000 0)",
        WebkitMask: "radial-gradient(farthest-side, transparent calc(100% - 3px), #000 0)",
      }}
    />
  );
}

export function SessionFloat({
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
  onJumpToMessage,
  bookmarkNodeRef,
}: {
  sessionId: string;
  subagents: SubagentSnapshot[];
  todos: TodoItem[];
  planBlocks: PlanBlock[];
  bookmarks: SessionBookmark[];
  /** Turn is paused on an unanswered question — the pill turns amber. */
  waiting?: boolean;
  isBookmarkStale?: (b: SessionBookmark) => boolean;
  onPickBookmark?: (b: SessionBookmark) => void;
  onRemoveBookmark?: (b: SessionBookmark) => void;
  onRenameBookmark?: (b: SessionBookmark, title: string) => void;
  onPickSubagent?: (agent: SubagentSnapshot) => void;
  onPickPlan: (plan: string) => void;
  /** Scroll the stream to a message (outline / bookmark clicks). */
  onJumpToMessage?: (messageId: string) => void;
  bookmarkNodeRef?: RefObject<HTMLDivElement | null>;
}) {
  const { t } = useI18n();
  // Folded is the resting state: the card must not cover the first reply until
  // the user asks for it.
  const [folded, setFolded] = useState(true);
  const [sheetNode, setSheetNode] = useState<ActivityNodeKey | null>(null);
  const { tabs, setTab } = useActivityTabs();
  const rootRef = useRef<HTMLDivElement>(null);
  const openedBySession = useRef<string | null>(null);

  const messages = useSessionStore((s) => s.messagesBySession[sessionId] ?? EMPTY_MESSAGES);
  const snapshot = useSessionStore((s) => s.contextSnapshotBySession[sessionId]);
  const usageHistory = useSessionStore((s) => s.usageHistoryBySession[sessionId]);
  const turnGens = useSessionStore((s) => s.turnGenBySession[sessionId]);
  const running = useSessionStore((s) => !!s.runningBySession[sessionId]);
  const expandNonce = useSessionStore((s) => s.sessionFloatOpenNonce);

  // Switching sessions resets to folded (the card is per-session state).
  useEffect(() => {
    if (openedBySession.current !== sessionId) {
      openedBySession.current = sessionId;
      setFolded(true);
    }
  }, [sessionId]);

  // The composer's metrics group asks for the card (store nonce, so it can
  // reach across the pane without prop drilling).
  useEffect(() => {
    if (expandNonce > 0) setFolded(false);
  }, [expandNonce]);

  // Escape / outside press folds it back.
  useEffect(() => {
    if (folded) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setFolded(true);
    };
    const onDown = (e: PointerEvent) => {
      const target = e.target as Node | null;
      if (target && rootRef.current?.contains(target)) return;
      setFolded(true);
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("pointerdown", onDown, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("pointerdown", onDown, true);
    };
  }, [folded]);

  const history = usageHistory ?? [];
  const gens = turnGens ?? [];
  const lastTurn = history[history.length - 1];
  const lastGen = gens[gens.length - 1];

  const done = todos.filter((x) => x.status === "completed").length;
  const taskPct = todos.length > 0 ? Math.round((done / todos.length) * 100) : 0;
  const runningAgents = subagents.filter((a) => a.status === "running");
  const failedAgents = subagents.filter((a) => a.status === "failed");
  const attn = !!waiting || (runningAgents.length === 0 && failedAgents.length > 0);
  const ctxPct = snapshot?.pct ?? 0;

  // ── Outline: one row per user message, with the turn's step lines under it.
  const outline = useMemo<OutlineItem[]>(() => {
    const items: OutlineItem[] = [];
    let tools = 0;
    let adds = 0;
    let dels = 0;
    let anchor: ChatMessage | null = null;
    const flush = () => {
      if (!anchor) return;
      if (tools > 0) {
        items.push({
          id: `${anchor.id}:steps`,
          messageId: anchor.id,
          kind: "step",
          text: t("chatStream.float.outlineSteps", { n: tools }),
        });
      }
      if (adds > 0 || dels > 0) {
        items.push({
          id: `${anchor.id}:files`,
          messageId: anchor.id,
          kind: "step",
          text: t("chatStream.float.outlineFiles", { add: adds, del: dels }),
        });
      }
      tools = 0;
      adds = 0;
      dels = 0;
    };
    for (const m of messages) {
      if (m.role === "user") {
        flush();
        const text = m.blocks
          .map((b) => (b.kind === "text" ? b.text : ""))
          .join(" ")
          .trim();
        items.push({
          id: m.id,
          messageId: m.id,
          kind: "turn",
          text: text.split("\n")[0]?.slice(0, 80) || t("chatStream.float.outlineUntitled"),
          time: clockOf(m.createdAt),
        });
        anchor = m;
        continue;
      }
      for (const b of m.blocks) {
        if (b.kind === "tool_use") tools += 1;
        if (b.kind === "turn-files" && !b.rewound) {
          for (const f of b.files) {
            adds += f.adds;
            dels += f.dels;
          }
        }
      }
    }
    flush();
    return items;
  }, [messages, t]);

  // ── Usage: tool calls + failures come from the rendered stream (the only
  // place that knows which tool results errored).
  const toolStats = useMemo(() => {
    let calls = 0;
    let failed = 0;
    for (const m of messages) {
      for (const b of m.blocks) {
        if (b.kind !== "tool_use") continue;
        calls += 1;
        if (b.status === "error") failed += 1;
      }
    }
    return { calls, failed };
  }, [messages]);

  const fileStats = useMemo(() => {
    let adds = 0;
    let dels = 0;
    for (const m of messages) {
      for (const b of m.blocks) {
        if (b.kind === "turn-files" && !b.rewound) {
          for (const f of b.files) {
            adds += f.adds;
            dels += f.dels;
          }
        }
      }
    }
    return { adds, dels };
  }, [messages]);

  const spark = useMemo(() => cacheSparkline(history), [history]);
  const turnCount = history.length > 0 ? history.length : outline.filter((o) => o.kind === "turn").length;
  const cost = sessionCost(history);

  const hasAny =
    todos.length > 0 || subagents.length > 0 || planBlocks.length > 0 || bookmarks.length > 0
    || history.length > 0 || snapshot != null || outline.length > 0;
  if (!hasAny) return null;

  // Mobile / web shell: the existing bottom sheet, opened from a plain pill.
  if (!isElectron) {
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

  return (
    <div
      ref={rootRef}
      data-folded={folded ? "true" : "false"}
      className="fsess pointer-events-none absolute right-4 top-3.5 z-[6] flex w-[300px] max-h-[calc(100%-150px)]"
    >
      {/* min-w-0: without it the flex item's min-content (a long, nowrap
          outline row) widens the card past the 300px shell, shoving the
          right-anchored pill out of the chat pane. */}
      <div className="fs-card pointer-events-auto flex min-h-0 min-w-0 flex-1 flex-col bg-surface">
        {/* Header = the pill when folded. Its height is --pill-h. */}
        <button
          type="button"
          ref={bookmarkNodeRef as unknown as RefObject<HTMLButtonElement> | undefined}
          onClick={() => setFolded(!folded)}
          aria-expanded={!folded}
          title={t(folded ? "chatStream.float.expand" : "chatStream.float.fold")}
          className={cn(
            "flex h-[34px] shrink-0 items-center gap-2 whitespace-nowrap pl-3 pr-2.5 text-[12.5px] transition-colors",
            "text-content-muted hover:bg-surface-hover active:bg-surface-hover",
            attn && "text-warning",
          )}
        >
          <span className="fs-swap grid min-w-0 flex-1 items-center">
            <span className="fs-title inline-flex items-center gap-2">
              <IconListCheck size={13} className="shrink-0" />
              <b className="font-semibold text-content">{t("chatStream.float.title")}</b>
              {turnCount > 0 && (
                <span className="tabular-nums text-content-subtle">
                  {t("chatStream.float.turnN", { n: turnCount })}
                </span>
              )}
            </span>
            {/* Folded summary: what you need while it works. */}
            <span className="fs-sum inline-flex items-center gap-2">
              {running && <IconLoader2 size={11} className="shrink-0 animate-spin text-accent-strong" />}
              {attn && !running && <span className="font-semibold text-warning">{t("chatStream.float.needsYou")}</span>}
              {todos.length > 0 && (
                <>
                  <b className="font-semibold tabular-nums text-content">
                    {t("chatStream.float.taskFrac", { done, total: todos.length })}
                  </b>
                  <MiniBar pct={taskPct} />
                </>
              )}
              {runningAgents.length > 0 && (
                <>
                  <i className="h-3 w-px shrink-0 bg-edge" aria-hidden />
                  <span>{t("chatStream.float.agentsN", { n: runningAgents.length })}</span>
                </>
              )}
              {snapshot && (
                <>
                  <i className="h-3 w-px shrink-0 bg-edge" aria-hidden />
                  <Ring pct={ctxPct} />
                  <span className="tabular-nums">{Math.round(ctxPct)}%</span>
                </>
              )}
              {/* Nothing live to summarize (idle session, no tasks / agents /
                  context snapshot yet): show the title so the pill is never an
                  empty white bar. */}
              {!running && !attn && todos.length === 0 && runningAgents.length === 0 && !snapshot && (
                <>
                  <IconListCheck size={13} className="shrink-0" />
                  <b className="font-semibold text-content">{t("chatStream.float.title")}</b>
                  {turnCount > 0 && (
                    <span className="tabular-nums text-content-subtle">
                      {t("chatStream.float.turnN", { n: turnCount })}
                    </span>
                  )}
                </>
              )}
            </span>
          </span>
          <IconChevronDown size={12} className="fs-chev shrink-0 text-content-subtle" />
        </button>

        <div className="fs-body min-h-0 flex-1 overflow-y-auto border-t border-edge">
          {/* 任务 */}
          {todos.length > 0 && (
            <Sec
              title={t("chatStream.float.tasks")}
              aside={
                <>
                  <span className="tabular-nums">{t("chatStream.float.taskFrac", { done, total: todos.length })}</span>
                  <MiniBar pct={taskPct} />
                </>
              }
            >
              <ul className="space-y-0.5">
                {todos.map((todo, i) => (
                  <li
                    key={`${i}-${todo.content.slice(0, 24)}`}
                    className={cn(
                      "flex items-start gap-2.5 py-1 text-[12.5px] leading-[1.5]",
                      todo.status === "completed" && "text-content-subtle",
                      todo.status === "in_progress" && "font-medium text-content",
                      todo.status === "pending" && "text-content-muted",
                    )}
                  >
                    <span className="mt-[1px] grid h-4 w-4 shrink-0 place-items-center">
                      {todo.status === "completed" ? (
                        <IconCheck size={13} className="text-accent-strong" />
                      ) : todo.status === "in_progress" ? (
                        <IconLoader2 size={12} className="animate-spin text-accent-strong" />
                      ) : (
                        <i className="h-3 w-3 rounded-full border-[1.5px] border-edge-input" aria-hidden />
                      )}
                    </span>
                    <span className={cn("min-w-0", todo.status === "completed" && "line-through decoration-content-subtle/45")}>
                      {todo.content}
                    </span>
                  </li>
                ))}
              </ul>
            </Sec>
          )}

          {/* 子代理 */}
          {subagents.length > 0 && (
            <Sec
              title={t("chatStream.float.subagents")}
              aside={<span className="tabular-nums">{subagents.length}</span>}
            >
              <ul className="space-y-0.5">
                {subagents.map((a) => (
                  <li key={a.taskId}>
                    <button
                      type="button"
                      onClick={() => onPickSubagent?.(a)}
                      className="flex w-full items-center gap-2.5 rounded-md py-1 pl-0 pr-1 text-left text-[12.5px] hover:bg-surface-hover"
                    >
                      <span className="grid h-4 w-4 shrink-0 place-items-center">
                        {a.status === "running" ? (
                          <IconLoader2 size={12} className="animate-spin text-accent-strong" />
                        ) : a.status === "completed" ? (
                          <IconCheck size={13} className="text-accent-strong" />
                        ) : (
                          <IconX size={12} className="text-danger" />
                        )}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-content-muted">
                        {a.subagentType ? `${a.subagentType} · ` : ""}
                        {a.description}
                      </span>
                      {a.durationMs != null && (
                        <span className="shrink-0 tabular-nums text-[11px] text-content-subtle">
                          {shortDuration(a.durationMs)}
                        </span>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            </Sec>
          )}

          {/* 计划 */}
          {planBlocks.length > 0 && (
            <Sec title={t("chatStream.float.plans")} aside={<span className="tabular-nums">{planBlocks.length}</span>}>
              <ul className="space-y-0.5">
                {planBlocks.map((p, i) => (
                  <li key={`${i}-${p.plan.slice(0, 24)}`}>
                    <button
                      type="button"
                      onClick={() => onPickPlan(p.plan)}
                      className="flex w-full items-center gap-2 rounded-md px-1 py-1 text-left text-[12.5px] text-content-muted hover:bg-surface-hover hover:text-content"
                    >
                      <IconListCheck size={12} className="shrink-0 text-content-subtle" />
                      <span className="min-w-0 flex-1 truncate">
                        {p.plan.split("\n").find((l) => l.trim())?.replace(/^#+\s*/, "") ?? t("chatStream.float.planUntitled")}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </Sec>
          )}

          {/* 书签 */}
          {bookmarks.length > 0 && (
            <Sec title={t("chatStream.float.bookmarks")} aside={<span className="tabular-nums">{bookmarks.length}</span>}>
              <ul className="space-y-0.5">
                {bookmarks.map((b) => {
                  const stale = isBookmarkStale?.(b) ?? false;
                  return (
                    <li key={b.id} className="group flex items-center gap-1">
                      <button
                        type="button"
                        disabled={stale}
                        onClick={() => onPickBookmark?.(b)}
                        onDoubleClick={() => {
                          const next = window.prompt(t("chatStream.float.renameBookmark"), b.title ?? b.excerpt);
                          if (next != null && next.trim()) onRenameBookmark?.(b, next.trim());
                        }}
                        className={cn(
                          "flex min-w-0 flex-1 items-center gap-2 rounded-md px-1 py-1 text-left text-[12.5px]",
                          stale ? "cursor-default text-content-subtle/60" : "text-content-muted hover:bg-surface-hover hover:text-content",
                        )}
                        title={stale ? t("chatStream.float.bookmarkStale") : b.excerpt}
                      >
                        <IconBookmark size={12} className="shrink-0 text-warning" />
                        <span className="min-w-0 flex-1 truncate">{b.title?.trim() || b.excerpt}</span>
                      </button>
                      {onRemoveBookmark && (
                        <button
                          type="button"
                          onClick={() => onRemoveBookmark(b)}
                          title={t("common.delete")}
                          className="grid h-6 w-6 shrink-0 place-items-center rounded-md text-content-subtle opacity-0 hover:bg-danger/10 hover:text-danger group-hover:opacity-100"
                        >
                          <IconTrash size={12} />
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
            </Sec>
          )}

          {/* 大纲 */}
          {outline.length > 0 && (
            <Sec title={t("chatStream.float.outline")}>
              <ul>
                {outline.map((o) => (
                  <li key={o.id}>
                    <button
                      type="button"
                      onClick={() => onJumpToMessage?.(o.messageId)}
                      className={cn(
                        "flex h-7 w-full items-center gap-2 rounded-md px-1 text-left text-[12.5px]",
                        o.kind === "turn"
                          ? "text-content-muted hover:bg-surface-hover hover:text-content"
                          : "pl-[26px] text-content-subtle hover:bg-surface-hover hover:text-content-muted",
                      )}
                    >
                      {o.kind === "turn" && <IconMessage size={11} className="shrink-0 text-content-subtle" />}
                      <span className="min-w-0 flex-1 truncate">{o.text}</span>
                      {o.time && <span className="shrink-0 tabular-nums text-[11px] text-content-subtle">{o.time}</span>}
                    </button>
                  </li>
                ))}
              </ul>
            </Sec>
          )}

          {/* 缓存与速度 */}
          {history.length > 0 && (
            <Sec title={t("chatStream.float.perf")}>
              <div className="grid grid-cols-2 gap-2">
                <div
                  className="flex flex-col gap-0.5 rounded-[10px] border border-edge bg-surface-muted px-2.5 py-2"
                  title={t("chatStream.float.cacheHelp")}
                >
                  <span className="text-[11.5px] text-content-subtle">{t("chatStream.float.cacheHit")}</span>
                  <span className="flex items-baseline gap-1">
                    <b className="text-[20px] font-[650] leading-none tracking-[-0.02em] text-content tabular-nums">
                      {fmtPct(turnCacheRate(lastTurn))}
                    </b>
                    <em className="not-italic text-[11.5px] text-content-subtle">{t("chatStream.float.thisTurn")}</em>
                  </span>
                  <span className="text-[11.5px] text-content-subtle">
                    {t("chatStream.float.avg")} <b className="font-semibold text-content-muted tabular-nums">{fmtPct(sessionCacheRate(history))}</b>
                  </span>
                </div>
                <div
                  className="flex flex-col gap-0.5 rounded-[10px] border border-edge bg-surface-muted px-2.5 py-2"
                  title={t("chatStream.float.speedHelp")}
                >
                  <span className="text-[11.5px] text-content-subtle">{t("chatStream.float.speed")}</span>
                  <span className="flex items-baseline gap-1">
                    <b className="text-[20px] font-[650] leading-none tracking-[-0.02em] text-content tabular-nums">
                      {fmtSpeed(turnSpeed(lastTurn?.outputTokens, lastGen?.genMs))}
                    </b>
                    <em className="not-italic text-[11.5px] text-content-subtle">tok/s</em>
                  </span>
                  <span className="text-[11.5px] text-content-subtle">
                    {t("chatStream.float.avg")}{" "}
                    <b className="font-semibold text-content-muted tabular-nums">{fmtSpeed(sessionSpeed(history, gens))}</b> tok/s
                  </span>
                </div>
              </div>
              {spark.length > 1 && (
                <div className="mt-2.5 flex items-end gap-2.5">
                  <span className="shrink-0 text-[11.5px] text-content-subtle">{t("chatStream.float.perTurnCache")}</span>
                  <span className="fs-spark flex h-7 flex-1 items-end gap-1" aria-label={t("chatStream.float.perTurnCache")}>
                    {spark.map((s, i) => (
                      <i
                        key={s.endedAt}
                        style={{ ["--h" as string]: `${Math.round(s.rate * 100)}%` }}
                        data-cur={i === spark.length - 1 ? "true" : undefined}
                        data-low={s.rate < 0.5 ? "true" : undefined}
                        title={t("chatStream.float.turnCache", { n: history.length - spark.length + i + 1, pct: fmtPct(s.rate) })}
                      />
                    ))}
                  </span>
                </div>
              )}
            </Sec>
          )}

          {/* 用量 */}
          {(snapshot || history.length > 0 || toolStats.calls > 0) && (
            <Sec title={t("chatStream.float.usage")}>
              <div className="grid grid-cols-[1fr_auto] gap-y-[7px] text-[12.5px] text-content-subtle">
                {snapshot && (
                  <>
                    <span>{t("chatStream.float.context")}</span>
                    <b className="text-right font-medium text-content tabular-nums">
                      {fmtTokens(snapshot.usedTokens)} / {fmtTokens(snapshot.maxTokens)} · {Math.round(ctxPct)}%
                    </b>
                    <span className="col-span-2 mb-[3px] h-1.5 overflow-hidden rounded-full bg-edge">
                      <i className="block h-full rounded-full bg-accent" style={{ width: `${Math.min(100, ctxPct)}%` }} />
                    </span>
                  </>
                )}
                {history.length > 0 && (
                  <>
                    <span>{t("chatStream.float.sessionTokens")}</span>
                    <b className="text-right font-medium text-content tabular-nums">{fmtTokens(sessionTokens(history))}</b>
                  </>
                )}
                {toolStats.calls > 0 && (
                  <>
                    <span>{t("chatStream.float.toolCalls")}</span>
                    <b className="text-right font-medium text-content tabular-nums">
                      {toolStats.failed > 0
                        ? t("chatStream.float.toolCallsVal", { n: toolStats.calls, failed: toolStats.failed })
                        : t("chatStream.float.toolCallsOk", { n: toolStats.calls })}
                    </b>
                  </>
                )}
                {(fileStats.adds > 0 || fileStats.dels > 0) && (
                  <>
                    <span>{t("chatStream.float.fileChanges")}</span>
                    <b className="text-right font-medium tabular-nums">
                      <span className="text-success">+{fileStats.adds}</span>{" "}
                      <span className="text-danger">−{fileStats.dels}</span>
                    </b>
                  </>
                )}
                {cost != null && (
                  <>
                    <span>{t("chatStream.float.cost")}</span>
                    <b className="text-right font-medium text-content tabular-nums">${cost.toFixed(2)}</b>
                  </>
                )}
              </div>
            </Sec>
          )}
        </div>
      </div>
    </div>
  );
}
