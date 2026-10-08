import { cn } from "@renderer/lib/cn.js";
import { Hint } from "@renderer/components/ui/index.js";
import {
  IconFolder,
  IconGitBranch,
  IconWorld,
  IconListDetails,
  IconMessages,
  IconArrowsMaximize,
  IconArrowsMinimize,
} from "@renderer/lib/icons.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import { resolveShortcut, acceleratorToDisplayString } from "@renderer/lib/shortcuts.js";
import { FilesPanel } from "@renderer/components/ide/FilesPanel.js";
import { GitPanel } from "@renderer/components/ide/GitPanel.js";
import { TurnFlowPanel } from "@renderer/components/ide/TurnFlowPanel.js";
import { BrowserPanel } from "@renderer/components/browser/BrowserPanel.js";
import { SideChatPanel } from "@renderer/components/chat/SideChatPanel.js";
import { useI18n } from "@renderer/lib/i18n/index.js";

/** Right panel: a tab header docked at the top + a main panel area
 *  (IDE-style). The header is a segmented control (ui-refresh prototype
 *  `.insp-head`) with five tabs, plus the wide-mode toggle at its far right:
 *    - Files     → shows FilesPanel in the main area
 *    - Git       → shows GitPanel in the main area
 *    - Browser   → toggles an embedded browser panel in the main area
 *      (sidebar mode, desktop-sized pages by default). Clicking again closes
 *      it. The PC-fullscreen overlay is a separate container rendered at the
 *      App root; while that overlay is open the right panel isn't visible at
 *      all.
 *    - Turn flow → TurnFlowPanel
 *    - Side chat → SideChatPanel
 *  Tab labels give way to icons as the card narrows (.rp-tabs in styles.css).
 *
 *  The active panel (files / git) is read from / written to the session store
 *  (persisted in the settings table), so it survives restarts. The browser tab
 *  is session-only (hydrate ignores a persisted "browser" value so the browser
 *  never auto-opens at boot). The browser tab shows a badge with the open-tab
 *  count. */
/** Wide-panel (3:7) mode toggle — hide the left sidebar + center editor and
 *  split the workspace into this right panel (7/10) + the chat column
 *  (3/10). Maximize when entering, minimize (restore) when already wide. */
function WideToggle() {
  const { t } = useI18n();
  const widePanelOpen = useSessionStore((s) => s.widePanelOpen);
  const setWidePanelOpen = useSessionStore((s) => s.setWidePanelOpen);
  const overrides = useSessionStore((s) => s.shortcutOverrides);
  const a = resolveShortcut("layout.toggle-wide-panel", overrides);
  const hint = a ? ` (${acceleratorToDisplayString(a)})` : "";
  return (
    <Hint label={(widePanelOpen ? t("layout.exitWideMode") : t("layout.wideMode")) + hint}>
      <button
        type="button"
        aria-pressed={widePanelOpen}
        onClick={() => setWidePanelOpen(!widePanelOpen)}
        className={cn(
          "ml-auto flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition-colors",
          widePanelOpen
            ? "bg-surface-hover text-content"
            : "text-content-subtle hover:bg-surface-hover hover:text-content",
        )}
      >
        {widePanelOpen ? (
          <IconArrowsMinimize size={15} className="shrink-0" />
        ) : (
          <IconArrowsMaximize size={15} className="shrink-0" />
        )}
      </button>
    </Hint>
  );
}

export function RightPanel({ legacyTabs = true }: { legacyTabs?: boolean } = {}) {
  const { t } = useI18n();
  const tab = useSessionStore((s) => s.rightPanelTab);
  const setTab = useSessionStore((s) => s.setRightPanelTab);
  const browserTabCount = useSessionStore((s) => s.browserTabCount);

  // Append the effective shortcut for a command's tooltip (same pattern as the
  // Titlebar's hintFor; cheap - a handful of lookups per render).
  const overrides = useSessionStore((s) => s.shortcutOverrides);
  const hintFor = (commandId: string): string => {
    const a = resolveShortcut(commandId, overrides);
    return a ? ` (${acceleratorToDisplayString(a)})` : "";
  };

  /** Toggle the embedded sidebar browser: open it if another tab is active,
   *  or close it (fall back to files) if it's already showing. */
  const toggleBrowser = () => {
    setTab(tab === "browser" ? "files" : "browser");
  };

  // V4: the segmented tab header is back inside the panel (it carries all
  // five panes incl. 轮次 / 旁聊) because V3's vertical ToolStrip is gone; the
  // title-bar buttons (TitlebarTools) open / close the panel and pick the
  // main panes. `legacyTabs={false}` keeps the V3 title-only header for any
  // surface that mounts the panel with its own switcher.
  const activeProjectName = useSessionStore((s) => {
    const pid = s.activeProjectId;
    return pid ? s.projects.find((p) => p.id === pid)?.name ?? null : null;
  });
  const title =
    tab === "files"
      ? t("layout.tabFiles")
      : tab === "git"
        ? "Git"
        : tab === "browser"
          ? t("layout.tabBrowser")
          : tab === "turns"
            ? t("layout.tabTurns")
            : t("layout.tabSideChat");

  return (
    <div className="flex h-full flex-col">
      {!legacyTabs && (
        <div className="flex h-11 shrink-0 items-center gap-2 border-b border-edge pl-3.5 pr-2">
          <span className="shrink-0 text-[13px] font-semibold text-content">{title}</span>
          {activeProjectName && (tab === "files" || tab === "git") && (
            <span className="min-w-0 truncate text-[12px] text-content-subtle">{activeProjectName}</span>
          )}
          {tab === "browser" && browserTabCount > 0 && (
            <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-accent/15 px-1 text-[11px] font-semibold leading-none text-accent-strong">
              {browserTabCount}
            </span>
          )}
          <WideToggle />
        </div>
      )}
      {legacyTabs && (
      <div className="rp-tabs flex shrink-0 items-center gap-1 border-b border-edge p-2 [font-size:var(--rp-fs-sm)]">
        <div role="tablist" className="flex shrink-0 items-center rounded-lg bg-surface-muted p-0.5">
          <PanelTab
            active={tab === "files"}
            onClick={() => setTab("files")}
            icon={<IconFolder size={14} className="shrink-0" />}
            label={t("layout.tabFiles")}
          />
          <PanelTab
            active={tab === "git"}
            onClick={() => setTab("git")}
            icon={<IconGitBranch size={14} className="shrink-0" />}
            label="Git" /* brand name */
          />
          {/* Browser — toggles the embedded sidebar (mobile-first). */}
          <PanelTab
            active={tab === "browser"}
            onClick={toggleBrowser}
            icon={<IconWorld size={14} className="shrink-0" />}
            label={t("layout.tabBrowser")}
            hint={tab === "browser" ? t("layout.closeSidebarBrowser") : t("layout.openBrowser")}
            badge={browserTabCount}
          />
          {/* Turn flow — per-turn visualization of the model's work process
              (prompt → actions → reply → token cost) from the message stream. */}
          <PanelTab
            active={tab === "turns"}
            onClick={() => setTab("turns")}
            icon={<IconListDetails size={14} className="shrink-0" />}
            label={t("layout.tabTurns")}
            extra
          />
          {/* Side chat — quick Q&A beside the running main session. */}
          <PanelTab
            active={tab === "sidechat"}
            onClick={() => setTab("sidechat")}
            icon={<IconMessages size={14} className="shrink-0" />}
            label={t("layout.tabSideChat")}
            hint={t("layout.tabSideChat") + hintFor("sidechat.open")}
            extra
          />
        </div>
        <WideToggle />
      </div>
      )}

      {/* Main panel area — must NOT scroll itself (children own height /
          overflow). Renders the panel matching the active tab. The browser
          sidebar (mobile-first) renders inline here; the PC-fullscreen overlay
          is rendered at the App root and covers the whole workspace. */}
      <div className="relative min-h-0 flex-1 overflow-hidden">
        {tab === "files" && <FilesPanel />}
        {tab === "git" && <GitPanel />}
        {tab === "turns" && <TurnFlowPanel />}
        {tab === "sidechat" && <SideChatPanel />}
        {tab === "browser" && <BrowserPanel mode="sidebar" />}
      </div>
    </div>
  );
}

/** One segment of the tab header. Its label's display and its horizontal
 *  padding are owned by the .rp-tabs container queries (no display / padding
 *  utility here); `extra` tabs are the first to drop to icon-only. The hint
 *  names the tab whenever only its icon shows. */
function PanelTab({
  active,
  onClick,
  icon,
  label,
  hint,
  badge = 0,
  extra = false,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  /** Tooltip text; defaults to the label. */
  hint?: string;
  /** Count shown after the label; hidden at 0. */
  badge?: number;
  /** Secondary tab — keeps its label only on the widest tier. */
  extra?: boolean;
}) {
  return (
    <Hint label={hint ?? label}>
      <button
        type="button"
        role="tab"
        aria-selected={active}
        aria-label={label}
        onClick={onClick}
        className={cn(
          "rp-tab flex h-[26px] shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md transition-colors",
          active
            ? "bg-surface font-medium text-content shadow-sm dark:bg-surface-hover"
            : "text-content-muted hover:text-content",
        )}
      >
        {icon}
        <span className={extra ? "rp-tab-label-extra" : "rp-tab-label"}>{label}</span>
        {badge > 0 && (
          <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-accent/15 px-1 text-[11px] font-semibold leading-none text-accent-strong">
            {badge}
          </span>
        )}
      </button>
    </Hint>
  );
}
