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
import { IconX } from "@renderer/lib/icons.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { SettingsPage } from "./SettingsPage.js";

export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
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
        role="dialog"
        aria-modal="true"
        aria-label={t("layout.settings")}
        className="settings-root relative flex h-[min(860px,calc(100vh-112px))] w-[min(1200px,calc(100vw-176px))] flex-col overflow-hidden rounded-2xl border border-edge bg-surface-base shadow-dialog"
      >
        <div className="flex h-11 shrink-0 items-center gap-2 pl-4 pr-2">
          <h2 className="text-[14px] font-semibold text-content">{t("layout.settings")}</h2>
          <button
            type="button"
            onClick={onClose}
            title={t("common.close")}
            aria-label={t("common.close")}
            className="ml-auto flex h-7 w-7 items-center justify-center rounded-lg text-content-subtle transition-colors hover:bg-surface-hover hover:text-content"
          >
            <IconX size={16} />
          </button>
        </div>
        {/* `flex` is required: SettingsPage reuses ThreePaneLayout, whose
            nav <aside> + content <main> are siblings laid out by a flex
            parent. */}
        <div className="flex min-h-0 flex-1 pb-2 pr-2">
          <SettingsPage />
        </div>
      </div>
    </div>
  );
}
