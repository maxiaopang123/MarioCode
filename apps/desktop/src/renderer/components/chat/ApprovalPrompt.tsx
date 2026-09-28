import { useEffect, useRef, useState } from "react";
import { cn } from "@renderer/lib/cn.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { Button } from "@renderer/components/ui/index.js";
import { IconChevronDown, IconShield } from "@renderer/lib/icons.js";
import { toolDisplayName } from "@renderer/lib/builtinToolNames.js";
import {
  DOCK_BODY,
  DOCK_BUTTON,
  DOCK_CARD,
  DOCK_FOOT,
  DOCK_HEAD,
  DOCK_HEAD_ICON,
  DOCK_KBD,
  DOCK_MUTED,
  DOCK_SECONDARY,
  DOCK_WELL,
} from "./dockStyles.js";

/**
 * Composer-area tool-approval card.
 *
 * Rendered in-flow inside the composer's width-constrained column (see
 * ChatPane), directly above the input box - mirroring PlanApprovalPrompt.
 * Because it participates in the ChatPane's vertical flex layout (rather
 * than overlaying it absolutely), the card pushes the message stream up to
 * make room instead of covering the streaming data. The composer stays
 * visible below but is locked (`textareaLocked`) while a decision is
 * pending, so the user can't type a competing prompt.
 *
 * Styling is the shared dock frame (dockStyles.ts, ui-refresh prototype
 * `.dock`) shared with QuestionPrompt and PlanApprovalPrompt: header with a
 * neutral shield, the tool name + summary in an inset well, and a footer
 * holding the always-allow check and the 拒绝 / 允许 pair with their key
 * hints. The only accent is the primary 允许 button and the check mark.
 *
 * Queuing: when several approval.request events arrive in quick succession
 * (e.g. the model wants to run three Bash commands in one turn), the store
 * keeps them in a queue and the head — index 0 — is what this card renders.
 * The header shows "n / total" only when total > 1 so a single approval
 * stays visually quiet.
 *
 * Keyboard: Enter allows the head, Esc denies. The "允许" button auto-focuses
 * on mount so Enter works without an extra click. This is one-shot — when
 * the queue shifts, this card unmounts and the next one auto-focuses its
 * own button via the same effect.
 */
export function ApprovalPrompt({
  toolName,
  input,
  description,
  queuePosition,
  queueTotal,
  onDecide,
}: {
  toolName: string;
  input: unknown;
  description?: string;
  /** 1-based index of this card in the queue. */
  queuePosition: number;
  /** Total cards in the queue; 1 means "no queue" (chip stays quiet). */
  queueTotal: number;
  /** granted=true → allow (with `always` if checked); granted=false → deny. */
  onDecide: (granted: boolean, always?: boolean) => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [always, setAlways] = useState(false);
  const allowRef = useRef<HTMLButtonElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);

  // One-line hint mirroring MessageBlocks.toolSummary so the user sees what
  // the tool is about without expanding.
  const summary = summarizeTool(toolName, input);

  // Auto-focus the "允许" button on mount (and on every queue head shift),
  // so Enter confirms without an extra click. Also bring the whole card
  // into view in case the queue scrolled it out.
  useEffect(() => {
    allowRef.current?.focus();
    cardRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [toolName, queuePosition]);

  // Local keyboard: Esc denies, Enter allows (the focused button already
  // handles Enter natively, so this is just the Esc shortcut).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onDecide(false);
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [onDecide]);

  const decide = (granted: boolean) => {
    onDecide(granted, granted ? always : undefined);
  };

  // Rendered in-flow above the composer (see ChatPane).
  return (
    <div ref={cardRef} role="alertdialog" aria-label={t("chat.approval.aria")} className={DOCK_CARD}>
      <div className={DOCK_HEAD}>
        <IconShield size={14} className={DOCK_HEAD_ICON} />
        <span className="truncate">{t("chat.approval.title")}</span>
        {queueTotal > 1 && (
          <span
            className={cn(DOCK_MUTED, "shrink-0 tabular-nums")}
            title={t("chat.approval.queueTitle", { n: queueTotal - queuePosition })}
          >
            {queuePosition} / {queueTotal}
          </span>
        )}
        <Button
          variant="ghost"
          onClick={() => setOpen((v) => !v)}
          className={cn(DOCK_BUTTON, "ml-auto shrink-0")}
          title={open ? t("chat.approval.collapseTitle") : t("chat.approval.expandTitle")}
        >
          {open ? t("chat.approval.collapse") : t("chat.approval.details")}
          <IconChevronDown
            size={12}
            className={cn("transition-transform", open && "rotate-180")}
          />
        </Button>
      </div>

      <div className={DOCK_BODY}>
        {/* Tool name + one-line summary of what it will do */}
        <div className={cn(DOCK_WELL, "flex items-baseline gap-2.5 px-3 py-2.5")}>
          <span className="shrink-0 text-xs font-medium text-content-subtle">{toolDisplayName(toolName)}</span>
          {summary && (
            <span className="line-clamp-2 min-w-0 break-all font-mono text-[12.5px] leading-relaxed">
              {summary}
            </span>
          )}
        </div>
        {description && (
          <p className="mx-0.5 mt-2 text-xs leading-relaxed text-content-muted">{description}</p>
        )}
        {open && (
          <pre
            className={cn(
              DOCK_WELL,
              "mt-2 max-h-40 overflow-auto px-3 py-2.5 font-mono text-xs leading-relaxed text-content-muted",
            )}
          >
            {safeStringify(input)}
          </pre>
        )}
      </div>

      {/* Footer: always-allow check + the decision pair, one row. */}
      <div className={DOCK_FOOT}>
        <label className="flex min-w-0 cursor-pointer items-center gap-2 text-xs text-content-muted">
          <input
            type="checkbox"
            checked={always}
            onChange={(e) => setAlways(e.target.checked)}
            className="h-3.5 w-3.5 shrink-0 cursor-pointer accent-accent"
          />
          <span className="truncate">{t("chat.approval.alwaysAllow", { tool: toolName })}</span>
        </label>
        <div className="ml-auto flex shrink-0 items-center gap-2">
          <Button
            onClick={() => decide(false)}
            title={t("chat.approval.denyTitle")}
            className={cn(DOCK_BUTTON, DOCK_SECONDARY)}
          >
            {t("chat.approval.deny")}
            <kbd className={DOCK_KBD}>Esc</kbd>
          </Button>
          <Button
            ref={allowRef}
            variant="primary"
            onClick={() => decide(true)}
            title={t("chat.approval.allowTitle")}
            className={cn(DOCK_BUTTON, "focus-visible:ring-2 focus-visible:ring-accent/50")}
          >
            {t("chat.approval.allow")}
            <kbd className={DOCK_KBD}>Enter</kbd>
          </Button>
        </div>
      </div>
    </div>
  );
}

/* ──────────────────────────── helpers ──────────────────────────── */

/** One-line hint for common tools. Mirrors MessageBlocks.toolSummary but kept
 * local to avoid a cross-module import for a pure display helper. */
function summarizeTool(name: string, input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const obj = input as Record<string, unknown>;
  switch (name) {
    case "Read":
    case "Write":
    case "Edit":
      return String(obj.file_path ?? "");
    case "Bash":
    case "PowerShell":
      return String(obj.command ?? obj.description ?? "");
    case "Glob":
      return String(obj.pattern ?? "");
    case "Grep":
      return String(obj.pattern ?? "");
    case "TodoWrite":
      return "todos";
    default:
      return Object.values(obj).slice(0, 1).map(String).join("").slice(0, 60);
  }
}

function safeStringify(v: unknown): string {
  try {
    return typeof v === "string" ? v : JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}
