/**
 * SessionOverview — the body of 「本会话」, shared by the docked right column.
 *
 * History: this used to be the inside of SessionFloat's floating card. The card
 * is gone (it covered the transcript); the panel that replaces it is a real
 * sibling column beside the chat (see SessionPanel). 任务 moved out a second
 * time — it now lives in the task dock directly above the composer
 * (SessionTasks), the classic place for a checklist — so this file holds the
 * remaining five sections: 子代理 / 计划 / 书签 / 缓存与速度 / 用量.
 *
 * `useSessionStats` is exported so the closed-state pill and the panel render
 * from ONE computation instead of two copies of the same selectors.
 */
import { useMemo, type ReactNode } from "react";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { IconBookmark, IconCheck, IconListCheck, IconLoader2, IconTrash, IconX } from "@renderer/lib/icons.js";
import { useSessionStore, type ChatMessage } from "@renderer/stores/sessionStore.js";
import { useSessionUsageHistory } from "@renderer/hooks/useSessionUsageHistory.js";
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
import { cn } from "@renderer/lib/cn.js";
import type { PlanBlock } from "./activityShared.js";

const EMPTY_MESSAGES: ChatMessage[] = [];

/** mm:ss for subagent elapsed time. */
function shortDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/** Section wrapper: 11.5px label + optional trailing slot. */
export function Sec({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
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

/** Thin progress bar used by the task fraction (summary pill + task dock). */
export function MiniBar({ pct, className }: { pct: number; className?: string }) {
  return (
    <span className={cn("inline-block h-[3px] w-[34px] overflow-hidden rounded-full bg-edge", className)} aria-hidden>
      <i className="block h-full rounded-full bg-accent" style={{ width: `${pct}%` }} />
    </span>
  );
}

/** Conic context ring (same visual language as the composer's ContextRing). */
export function Ring({ pct, size = 12 }: { pct: number; size?: number }) {
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

/**
 * Everything the summary pill and the panel body read from the session:
 * usage history, context snapshot, tool/file tallies and the turn count.
 * Selectors are per-session slices, so this is cheap to call twice (pill +
 * panel) — the expensive bits are the memos below.
 */
export function useSessionStats(sessionId: string) {
  const messages = useSessionStore((s) => s.messagesBySession[sessionId] ?? EMPTY_MESSAGES);
  const snapshot = useSessionStore((s) => s.contextSnapshotBySession[sessionId]);
  const history = useSessionUsageHistory(sessionId);
  const turnGens = useSessionStore((s) => s.turnGenBySession[sessionId]);
  const running = useSessionStore((s) => !!s.runningBySession[sessionId]);

  const gens = turnGens ?? [];
  const lastTurn = history[history.length - 1];
  const lastGen = gens.find((g) => g.endedAt === lastTurn?.endedAt);
  const ctxPct = snapshot?.pct ?? 0;

  // Navigation belongs to MessageTimeline; the overview only needs a count
  // when this session has no persisted usage history yet.
  const userTurnCount = useMemo(() => messages.filter((m) => m.role === "user").length, [messages]);

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
  const turnCount = history.length > 0 ? history.length : userTurnCount;
  const cost = sessionCost(history);

  return {
    messages,
    snapshot,
    history,
    gens,
    lastTurn,
    lastGen,
    running,
    ctxPct,
    userTurnCount,
    toolStats,
    fileStats,
    spark,
    turnCount,
    cost,
  };
}

export type SessionStats = ReturnType<typeof useSessionStats>;

export function SessionOverview({
  stats,
  subagents,
  planBlocks,
  bookmarks,
  isBookmarkStale,
  onPickSubagent,
  onPickPlan,
  onPickBookmark,
  onRemoveBookmark,
  onRenameBookmark,
}: {
  stats: SessionStats;
  subagents: SubagentSnapshot[];
  planBlocks: PlanBlock[];
  bookmarks: SessionBookmark[];
  isBookmarkStale?: (b: SessionBookmark) => boolean;
  onPickSubagent?: (agent: SubagentSnapshot) => void;
  onPickPlan: (plan: string) => void;
  onPickBookmark?: (b: SessionBookmark) => void;
  onRemoveBookmark?: (b: SessionBookmark) => void;
  onRenameBookmark?: (b: SessionBookmark, title: string) => void;
}) {
  const { t } = useI18n();
  const { snapshot, history, gens, lastTurn, lastGen, ctxPct, toolStats, fileStats, spark, cost } = stats;

  return (
    <>
      {/* 子代理 */}
      {subagents.length > 0 && (
        <Sec title={t("chatStream.float.subagents")} aside={<span className="tabular-nums">{subagents.length}</span>}>
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
                  {fmtSpeed(turnSpeed(lastTurn?.outputTokens, lastTurn?.generationMs ?? lastGen?.genMs))}
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
    </>
  );
}
