import { useState, useEffect, useRef } from "react";
import { cn } from "@renderer/lib/cn.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { Button, Input } from "@renderer/components/ui/index.js";
import {
  IconCheck,
  IconX,
  IconHelpCircle,
  IconSend2,
  IconChevronLeft,
  IconChevronRight,
} from "@renderer/lib/icons.js";
import type { AskUserQuestionItem } from "@contracts/runtime";
import type { UserInputAnswers } from "@contracts/provider";
import {
  DOCK_BODY,
  DOCK_BUTTON,
  DOCK_CARD,
  DOCK_FOOT,
  DOCK_HEAD,
  DOCK_HEAD_ICON,
  DOCK_MUTED,
} from "./dockStyles.js";

/**
 * Prompt card shown when claude invokes the AskUserQuestion tool.
 *
 * Rendered in-flow inside the composer's width-constrained column (see
 * ChatPane), directly above the input box - mirroring PlanApprovalPrompt.
 * Because it participates in the ChatPane's vertical flex layout (rather
 * than overlaying it absolutely), the card pushes the message stream up to
 * make room instead of covering the streaming data. The composer stays
 * visible below but is locked (`textareaLocked`) while a question is
 * pending, so the user can't type a competing prompt.
 *
 * Layout: a single rounded, bordered, elevated card with three stacked
 * regions — a fixed header (title + step indicator + dismiss), a body that
 * renders ONE question at a time, and a fixed footer (progress + stepper
 * navigation + submit). Instead of stacking every question at once, the card
 * walks through them one-by-one:
 *   - answering a SINGLE-select question auto-advances to the next (option
 *     click on a choice question; Enter / 下一题 for a typed answer);
 *     multi-select questions do NOT auto-advance — the first pick is by
 *     definition partial, so the card stays until the user moves on;
 *   - 上一题 / 下一题 navigate freely — answers already given are kept, so
 *     the user can jump back and revise before submitting;
 *   - the last question shows 提交回答, enabled once every question is
 *     answered. Submit returns the answers as a `UserInputAnswers` map keyed
 *     by question text (matches the SDK's convention); the caller forwards
 *     it to `claude:respondQuestion`, which resolves the provider's pending
 *     user-input Deferred — the SAME turn then continues.
 *
 * Styling is the shared dock frame (dockStyles.ts, ui-refresh prototype
 * `.dock`). A picked option is marked the neutral way — stronger border on
 * the hover fill — and only its radio / check mark carries the accent, as
 * does the primary 下一题 / 提交 button.
 */
export function QuestionPrompt({
  questions,
  onSubmit,
  onDismiss,
}: {
  questions: AskUserQuestionItem[];
  onSubmit: (answers: UserInputAnswers) => void;
  onDismiss: () => void;
}) {
  const { t } = useI18n();
  // answers[i] holds: selected option labels + optional free text.
  const [answers, setAnswers] = useState<Array<{ selected: string[]; text: string }>>(
    questions.map(() => ({ selected: [], text: "" })),
  );
  // Stepper position — one question shown at a time.
  const [step, setStep] = useState(0);

  const isAnswered = (i: number) =>
    answers[i].selected.length > 0 || answers[i].text.trim().length > 0;
  const answeredCount = questions.filter((_, i) => isAnswered(i)).length;
  const allAnswered = answeredCount === questions.length;
  const isLast = step === questions.length - 1;

  /** Toggle an option on question `qi`. Single-select replaces the pick
   *  (toggling the active option clears it); multi-select adds/removes.
   *  Auto-advances to the next question ONLY for single-select questions —
   *  a multi-select pick is by definition partial (the user usually wants
   *  more than one option), so it stays on the question until the user
   *  moves on via 上一题/下一题. */
  const toggle = (qi: number, label: string) => {
    const wasAnswered = isAnswered(qi);
    setAnswers((prev) =>
      prev.map((item, i) => {
        if (i !== qi) return item;
        const q = questions[i];
        if (q.multiSelect) {
          const has = item.selected.includes(label);
          return {
            ...item,
            selected: has ? item.selected.filter((s) => s !== label) : [...item.selected, label],
          };
        }
        return { ...item, selected: item.selected[0] === label ? [] : [label] };
      }),
    );
    if (!wasAnswered && qi === step && !isLast && !questions[qi].multiSelect) {
      setStep((s) => s + 1);
    }
  };

  const setFreeText = (qi: number, text: string) => {
    setAnswers((prev) => prev.map((item, i) => (i === qi ? { ...item, text } : item)));
  };

  const submit = () => {
    // Compose the SDK-shaped answers map: keyed by question text, value is
    // the joined labels (multi-select), the single label (single-select),
    // or the free text. Unanswered questions are omitted.
    const out: UserInputAnswers = {};
    questions.forEach((qq, i) => {
      const aa = answers[i];
      const bits = [...aa.selected];
      if (aa.text.trim()) bits.push(aa.text.trim());
      if (bits.length === 0) return;
      out[qq.question] = qq.multiSelect ? bits : bits.join(", ");
    });
    if (Object.keys(out).length === 0) return;
    onSubmit(out);
  };

  // Esc dismisses. Enter in the free-text input advances to the next question
  // (non-last) or submits on the last one once everything is answered.
  // Shift+Enter is left alone (never used here — single-line Input).
  const submittingRef = useRef(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onDismiss();
      } else if (e.key === "Enter" && !e.shiftKey && !submittingRef.current) {
        const tag = (e.target as HTMLElement)?.tagName;
        if (tag !== "TEXTAREA" && tag !== "INPUT") return;
        if (isLast) {
          if (allAnswered) {
            e.preventDefault();
            submittingRef.current = true;
            submit();
          }
        } else {
          e.preventDefault();
          setStep((s) => Math.min(s + 1, questions.length - 1));
        }
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allAnswered, answers, isLast, onDismiss]);

  const q = questions[step];
  const a = answers[step];

  return (
    // Rendered in-flow above the composer (see ChatPane). `mb-2` lifts the card
    // off the input box below so the rounded corners + shadow read as a floating
    // card, mirroring PlanApprovalPrompt. The card participates in the ChatPane
    // flex column so the message stream shrinks to make room (instead of being
    // overlaid). `max-h-[60vh]` caps growth so the body scrolls internally rather
    // than pushing the stream entirely out of view (vh is used because the
    // in-flow parent has no explicit height, so % wouldn't resolve).
    <div
      role="dialog"
      aria-modal="false"
      aria-label={t("chat.question.aria")}
      className={cn(DOCK_CARD, "max-h-[60vh]")}
    >
        <div className={DOCK_HEAD}>
          <IconHelpCircle size={14} className={DOCK_HEAD_ICON} />
          <span className="truncate">
            {questions.length === 1
              ? t("chat.question.titleOne")
              : t("chat.question.titleN", { n: questions.length })}
          </span>
          {questions.length > 1 && (
            <span className={cn(DOCK_MUTED, "shrink-0 tabular-nums")}>
              {t("chat.question.step", { cur: step + 1, total: questions.length })}
            </span>
          )}
          <button
            type="button"
            onClick={onDismiss}
            title={t("chat.question.dismiss")}
            aria-label={t("chat.question.dismiss")}
            className="ml-auto flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-content-subtle transition-colors hover:bg-surface-hover hover:text-content"
          >
            <IconX size={14} />
          </button>
        </div>

        {/* Body — only the current question renders; the rest is reached via
            the footer stepper (or auto-advance on answering). */}
        <div className="min-h-0 overflow-y-auto">
          <div className={DOCK_BODY}>
            <p className="mb-2.5 text-sm font-medium leading-normal">
              {q.header && <span className="mr-1.5 font-normal text-content-subtle">{q.header}</span>}
              {q.question}
              {q.multiSelect && (
                <span className="ml-1.5 rounded bg-surface-muted px-1.5 py-0.5 text-[11px] font-normal text-content-muted">
                  {t("chat.question.multiSelect")}
                </span>
              )}
            </p>

            <div className="flex flex-col gap-1.5">
              {q.options.map((opt, oi) => {
                const selected = a.selected.includes(opt.label);
                return (
                  <button
                    key={oi}
                    type="button"
                    onClick={() => toggle(step, opt.label)}
                    className={cn(
                      "flex w-full items-start gap-2.5 rounded-lg border px-3 py-2 text-left transition-colors",
                      selected ? "border-edge-input bg-surface-hover" : "border-edge hover:bg-surface-hover",
                    )}
                    title={opt.description}
                  >
                    {/* Radio (single) / check (multi) — the one accent mark. */}
                    <span
                      className={cn(
                        "mt-[3px] flex h-3.5 w-3.5 shrink-0 items-center justify-center border-[1.5px] transition-colors",
                        q.multiSelect ? "rounded" : "rounded-full",
                        selected
                          ? q.multiSelect
                            ? "border-accent bg-accent text-surface"
                            : "border-accent"
                          : "border-edge-input",
                      )}
                    >
                      {selected &&
                        (q.multiSelect ? (
                          <IconCheck size={10} stroke={3} />
                        ) : (
                          <span className="h-1.5 w-1.5 rounded-full bg-accent" />
                        ))}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-[13px] font-medium text-content">
                        {opt.label}
                      </span>
                      {opt.description && (
                        <span className="block text-xs leading-snug text-content-subtle">
                          {opt.description}
                        </span>
                      )}
                    </span>
                  </button>
                );
              })}
            </div>

            <Input
              type="text"
              value={a.text}
              onChange={(e) => setFreeText(step, e.target.value)}
              placeholder={t("chat.question.customAnswer")}
              className="mt-2.5 font-sans"
            />
          </div>
        </div>

        {/* Footer — progress + stepper nav / submit */}
        <div className={DOCK_FOOT}>
          <span className="text-xs tabular-nums text-content-subtle">
            {t("chat.question.answered", { answered: answeredCount, total: questions.length })}
          </span>
          <div className="ml-auto flex items-center gap-2">
            {questions.length > 1 ? (
              <>
                <Button
                  variant="ghost"
                  onClick={() => setStep((s) => Math.max(0, s - 1))}
                  disabled={step === 0}
                  title={t("chat.question.prevTitle")}
                  className={DOCK_BUTTON}
                >
                  <IconChevronLeft size={12} />
                  {t("chat.question.prev")}
                </Button>
                {isLast ? (
                  <Button
                    variant="primary"
                    onClick={submit}
                    disabled={!allAnswered}
                    title={allAnswered ? t("chat.question.submitTitle") : t("chat.question.submitDisabled")}
                    className={DOCK_BUTTON}
                  >
                    <IconSend2 size={12} />
                    {t("chat.question.submit")}
                  </Button>
                ) : (
                  <Button
                    variant="primary"
                    onClick={() => setStep((s) => Math.min(questions.length - 1, s + 1))}
                    title={t("chat.question.nextTitle")}
                    className={DOCK_BUTTON}
                  >
                    {t("chat.question.next")}
                    <IconChevronRight size={12} />
                  </Button>
                )}
              </>
            ) : (
              <Button
                variant="primary"
                onClick={submit}
                disabled={!allAnswered}
                title={allAnswered ? t("chat.question.submitTitle") : t("chat.question.submitDisabled")}
                className={DOCK_BUTTON}
              >
                <IconSend2 size={12} />
                {t("chat.question.submit")}
              </Button>
            )}
          </div>
        </div>
      </div>
  );
}
