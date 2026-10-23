/**
 * SessionTasks — the running checklist, docked directly above the composer
 * (prototypes/session-panel-docked.html `.taskdock`).
 *
 * Why here and not in 「本会话」: a checklist is an input-adjacent object. It
 * belongs where the user's eye already is while the turn runs (the classic
 * "todo panel above the prompt" placement), and it must NOT move when the
 * session panel opens — it is part of the chat column, not of the panel.
 *
 * States (the header is the toggle):
 *   closed  one line: 任务 2/4 ▬ · <当前任务>
 *   open    the list, capped at 196px with its own scroll
 * `auto` (the default) means: expanded while anything is unfinished, collapsed
 * to one line once every task is done. The predicate is "not all done", not
 * "something is running" — the moment the agent pauses to wait for the user
 * the remaining todos are exactly what you need to see.
 *
 * Height animates with `grid-template-rows: 0fr ↔ 1fr`, so a long list never
 * needs a magic max-height and the closed state costs zero height.
 */
import { useState } from "react";
import { cn } from "@renderer/lib/cn.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { IconCheck, IconChevronUp, IconListCheck, IconLoader2 } from "@renderer/lib/icons.js";
import { useSessionStore, type TodoItem } from "@renderer/stores/sessionStore.js";
import { MiniBar } from "./SessionOverview.js";

export function SessionTasks({ todos }: { todos: TodoItem[] }) {
  const { t } = useI18n();
  const mode = useSessionStore((s) => s.taskDockMode);

  // A manual toggle wins over the setting for the rest of this pane's life.
  // It deliberately does NOT rewrite the setting: the setting is a default,
  // and a default that silently becomes "whatever I clicked last" is a
  // preference the user can no longer find.
  const [override, setOverride] = useState<boolean | null>(null);

  const total = todos.length;
  const done = todos.filter((x) => x.status === "completed").length;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  const current = todos.find((x) => x.status === "in_progress");
  const open = override ?? (mode === "open" ? true : mode === "closed" ? false : done < total);

  if (total === 0) return null;

  // A header click only overrides THIS pane; 设置 › 常规 › 任务条 stays the
  // default for every other session (and for the next one).
  const toggle = () => setOverride(!open);

  const nowText = current
    ? current.content
    : done === total
      ? t("chatStream.tasks.doneThisTurn", { n: total })
      : t("chatStream.tasks.idle");
  const restText = done === total ? t("chatStream.tasks.allDone") : t("chatStream.tasks.rest", { n: total - done });

  return (
    <div className="flex-none px-[var(--chat-gutter)] pb-2" data-task-dock data-open={open ? "true" : "false"}>
      <div className="mx-auto w-full max-w-5xl">
        <div className="overflow-hidden rounded-[11px] border border-edge bg-surface">
          <button
            type="button"
            onClick={toggle}
            aria-expanded={open}
            aria-controls="session-task-list"
            title={t(open ? "chatStream.tasks.fold" : "chatStream.tasks.expand")}
            className="flex w-full items-center gap-1.5 px-2.5 py-[7px] text-left text-[12px] text-content-muted transition-colors hover:bg-surface-hover"
          >
            <IconListCheck size={12} className="shrink-0 text-content-subtle" />
            <b className="shrink-0 font-semibold text-content">{t("chatStream.tasks.title")}</b>
            <span className="shrink-0 tabular-nums text-content-muted">{done}/{total}</span>
            <MiniBar pct={pct} className="w-[30px]" />
            {/* One grid cell, two lines cross-faded: swapping them with
                display:none would relayout the header on every toggle. */}
            <span className="grid min-w-0 flex-1 items-center">
              <span
                className={cn(
                  "col-start-1 row-start-1 truncate transition-opacity duration-200",
                  open ? "opacity-0" : "opacity-100",
                )}
              >
                {nowText}
              </span>
              <span
                className={cn(
                  "col-start-1 row-start-1 truncate transition-opacity duration-200",
                  open ? "opacity-100" : "opacity-0",
                )}
              >
                {restText}
              </span>
            </span>
            <span
              className={cn(
                "flex shrink-0 text-content-subtle transition-transform duration-[240ms] ease-[cubic-bezier(.32,.72,0,1)]",
                open && "rotate-180",
              )}
            >
              <IconChevronUp size={12} />
            </span>
          </button>

          <div
            className="grid transition-[grid-template-rows] duration-[260ms] ease-[cubic-bezier(.32,.72,0,1)] motion-reduce:transition-none"
            style={{ gridTemplateRows: open ? "1fr" : "0fr" }}
          >
            <div className="min-h-0 overflow-hidden">
              <ul
                id="session-task-list"
                aria-label={t("chatStream.tasks.title")}
                className="max-h-[196px] overflow-y-auto border-t border-edge px-2.5 pb-2 pt-1"
              >
                {todos.map((todo, i) => (
                  <li
                    key={`${i}-${todo.content.slice(0, 24)}`}
                    className={cn(
                      "flex items-start gap-2.5 rounded-md px-1 py-1 text-[12.5px] leading-[1.5]",
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
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
