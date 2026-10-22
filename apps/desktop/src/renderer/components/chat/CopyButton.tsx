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
}: {
  /** Plain text written to the clipboard (never the HTML). */
  text: string;
  className?: string;
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
        "inline-flex items-center gap-1 rounded px-1.5 py-0.5 transition-colors",
        "text-content-subtle hover:bg-surface-hover/60 hover:text-content-muted",
        className,
      )}
      title={t("chatStream.copyCode")}
    >
      {copied ? (<><IconCheck size={10} /> {t("common.copied")}</>) : (<><IconCopy size={10} /> {t("common.copy")}</>)}
    </button>
  );
}
