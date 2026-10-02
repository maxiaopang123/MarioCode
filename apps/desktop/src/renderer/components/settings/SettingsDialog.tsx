/**
 * SettingsDialog — settings as a floating window (2026-09-28): a centered
 * card over a dimmed backdrop instead of a full-bleed overlay on the panel
 * row. The workspace underneath stays mounted (terminals / PTYs survive).
 *
 * Geometry: the card keeps clear of the window's drag regions (titlebar
 * band, session-column header, project rail) — Electron resolves
 * `-webkit-app-region: drag` before DOM stacking, so any part of the card
 * over a drag region would swallow clicks. Hence the ≥56px top margin and
 * the ≥88px side margins.
 *
 * Dismiss: the ✕ button, a click on the backdrop, or Escape (SettingsPage
 * owns the Escape listener). The embedded browser view hides itself while
 * settings is open (BrowserPanel reads settingsOpen), so no native view
 * can paint over the card.
 */
import { useEffect, useRef } from "react";
import { Button } from "@renderer/components/ui/index.js";
import { IconSettings, IconX } from "@renderer/lib/icons.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { SettingsPage } from "./SettingsPage.js";

export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const dialogRef = useRef<HTMLDivElement>(null);
  const previousFocus = useRef(document.activeElement);
  useEffect(() => {
    dialogRef.current?.querySelector<HTMLInputElement>('input[type="search"]')?.focus();
    const previous = previousFocus.current;
    return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, []);
  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/25 animate-[capsule-pop-in_160ms_ease-out] dark:bg-black/45"
      onMouseDown={(e) => {
        // Backdrop only — a press that starts inside the card never closes.
        if (e.target === e.currentTarget) onClose();
      }}
      role="presentation"
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={t("layout.settings")}
        className="settings-root relative flex h-[min(960px,calc(100vh-112px))] w-[min(1440px,calc(100vw-176px))] flex-col overflow-hidden rounded-2xl border border-edge bg-surface shadow-dialog"
        onKeyDown={(event) => {
          if (event.key !== "Tab" || event.defaultPrevented) return;
          // Nested dialogs own their own focus trap.
          if ([...document.querySelectorAll('[role="dialog"], [role="alertdialog"]')].some((element) => element !== dialogRef.current && element.getClientRects().length > 0)) return;
          const elements = [...(dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex="0"]') ?? [])].filter((element) => element.getClientRects().length > 0 && element.tabIndex >= 0);
          const first = elements[0];
          const last = elements.at(-1);
          if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
        }}
      >
        <div className="flex h-16 shrink-0 items-center gap-3 border-b border-edge px-6">
          <IconSettings size={19} className="text-content-muted" />
          <h2 className="text-base font-medium text-content">{t("layout.settings")}</h2>
          <span className="border-l border-edge pl-3 text-xs text-content-subtle">{t("settings.shell.description")}</span>
          <Button
            variant="ghost"
            size="icon"
            onClick={onClose}
            title={t("common.close")}
            aria-label={t("common.close")}
            className="ml-auto h-8 w-8 rounded-lg text-content-subtle"
          >
            <IconX size={16} />
          </Button>
        </div>
        {/* A definite height keeps the navigation and editor scroll areas independent. */}
        <div className="flex min-h-0 flex-1">
          <SettingsPage />
        </div>
      </div>
    </div>
  );
}
