/**
 * Small "copy" affordance shared by the two block chromes that need one:
 * highlighted code blocks (Markdown.tsx) and mermaid diagrams
 * (MermaidBlock.tsx). Kept in its own module rather than exported from
 * Markdown.tsx so the diagram component does not have to import its parent
 * (a cycle that would make the module graph order-dependent).
 */
import { useState } from "react";
import { cn } from "@renderer/lib/cn.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { IconCheck, IconCopy } from "@renderer/lib/icons.js";

export function CopyButton({
  text,
  className,
  iconOnly = false,
  title,
}: {
  /** Plain text written to the clipboard (never the HTML). */
  text: string;
  className?: string;
  /** Icon-only affordance for tight rows (the `$ command` box of a tool
   *  card), where a text label would eat the command's own width. */
  iconOnly?: boolean;
  /** Overrides the default "copy code" tooltip — e.g. 「复制命令（含未打码
   *  参数）」 when the visible text is masked but the copy is not. */
  title?: string;
}) {
  const [copied, setCopied] = useState(false);
  const { t } = useI18n();
  return (
    <button
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        });
      }}
      className={cn(
        "inline-flex items-center gap-1 rounded transition-colors",
        iconOnly ? "shrink-0 p-0.5" : "px-1.5 py-0.5",
        "text-content-subtle hover:bg-surface-hover/60 hover:text-content-muted",
        className,
      )}
      title={title ?? t("chatStream.copyCode")}
    >
      {iconOnly ? (
        copied ? <IconCheck size={11} className="text-success" /> : <IconCopy size={11} />
      ) : copied ? (
        <><IconCheck size={10} /> {t("common.copied")}</>
      ) : (
        <><IconCopy size={10} /> {t("common.copy")}</>
      )}
    </button>
  );
}
