/**
 * Sidebar quick actions — the Codex-style nav list docked under the sidebar's
 * top strip, one 30px row per entry:
 *
 *   新建会话     — starts a new thread in the active project.
 *   搜索         — opens the unified Ctrl+K search palette.
 *   定时任务     — opens Settings → 定时任务.
 *   插件与技能   — opens Settings → 插件.
 *   连接手机     — LAN pairing / remote relay dialog.
 *
 * Rows rest neutral (no accent) and only fill on hover. 新建会话 / 搜索 carry
 * a trailing `<Kbd>` keycap built from the effective shortcut (user override
 * ?? default), revealed on hover, so the hint always matches what the
 * keyboard actually does. "新建会话" is disabled when there is no active
 * project (mirrors the `session.new` command's `available` guard).
 *
 * The list sits above the view switch so the most-used workspace entry
 * points are always visible without scrolling, regardless of how long the
 * session list grows.
 *
 * `showSearch` / `showConnectPhone` drop the matching entries — the mobile
 * drawer hides both: there is no Ctrl+K on a phone, and its visitor is
 * already on the phone.
 */
import { cn } from "@renderer/lib/cn.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import {
  resolveShortcut,
  acceleratorToDisplayTokens,
} from "@renderer/lib/shortcuts.js";
import { IconCalendar, IconEdit, IconGitFork, IconPuzzle, IconSearch } from "@renderer/lib/icons.js";
import { Kbd } from "@renderer/components/ui/index.js";
import { MobileConnectButton } from "@renderer/components/layout/MobileConnectDialog.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { SIDEBAR_NAV_ITEM } from "./SidebarShared.js";

/** Trailing keyboard badge, consistent with the command palette. Subscribes to
 *  overrides so it updates live when the user rebinds in settings. */
function ShortcutBadge({ commandId }: { commandId: string }) {
  const overrides = useSessionStore((s) => s.shortcutOverrides);
  const accel = resolveShortcut(commandId, overrides);
  if (!accel) return null;
  return (
    <Kbd
      keys={acceleratorToDisplayTokens(accel)}
      size="xs"
      className="opacity-0 transition-opacity group-hover/nav:opacity-100"
    />
  );
}

const NAV_ROW = cn(SIDEBAR_NAV_ITEM, "text-content hover:bg-surface-hover");
const NAV_ICON = "shrink-0 text-content-muted";

export function SidebarQuickActions({
  showSearch = true,
  showConnectPhone = true,
  newSessionOverride,
  newSessionOverrideTitle,
}: {
  /** Hide the 搜索 entry (mobile drawer: no keyboard to trigger Ctrl+K). */
  showSearch?: boolean;
  /** Hide the 连接手机 entry (mobile drawer: the visitor is already the phone). */
  showConnectPhone?: boolean;
  /** When set, 新建会话 dispatches here instead of the default
   *  active-project start (stream view scoped to a worktree: spawn the
   *  session in THAT checkout; scoped to a plain project: spawn it under
   *  THAT project). Title flips to the override wording unless
   *  `newSessionOverrideTitle` says otherwise. */
  newSessionOverride?: () => void;
  /** Already-translated tooltip for the override state (defaults to the
   *  worktree wording — the original override case). */
  newSessionOverrideTitle?: string;
} = {}) {
  const { t } = useI18n();
  const startSession = useSessionStore((s) => s.startSession);
  const setCommandPaletteOpen = useSessionStore((s) => s.setCommandPaletteOpen);
  const setSettingsOpen = useSessionStore((s) => s.setSettingsOpen);
  const activeProjectId = useSessionStore((s) => s.activeProjectId);

  const canNewSession = newSessionOverride != null || activeProjectId !== null;

  return (
    <nav className="flex flex-col gap-px">
      <button
        type="button"
        onClick={() => {
          if (newSessionOverride) newSessionOverride();
          else if (canNewSession) void startSession();
        }}
        disabled={!canNewSession}
        title={
          newSessionOverride
            ? newSessionOverrideTitle ?? t("layout.newSessionInWorktree")
            : canNewSession
              ? t("layout.newSessionInProject")
              : t("layout.needProject")
        }
        className={cn(
          SIDEBAR_NAV_ITEM,
          canNewSession
            ? "text-content hover:bg-surface-hover"
            : "cursor-not-allowed text-content-subtle opacity-50",
        )}
      >
        {newSessionOverride ? (
          <IconGitFork size={16} className={NAV_ICON} />
        ) : (
          <IconEdit size={16} className={NAV_ICON} />
        )}
        <span className="flex-1 truncate text-left">{t("layout.newSession")}</span>
        <ShortcutBadge commandId="session.new" />
      </button>

      {showSearch && (
        <button
          type="button"
          onClick={() => setCommandPaletteOpen(true)}
          title={t("layout.palette.placeholder.all")}
          className={NAV_ROW}
        >
          <IconSearch size={16} className={NAV_ICON} />
          <span className="flex-1 truncate text-left">{t("common.search")}</span>
          <ShortcutBadge commandId="command.palette" />
        </button>
      )}

      <button
        type="button"
        onClick={() => setSettingsOpen(true, "scheduled-tasks")}
        className={NAV_ROW}
      >
        <IconCalendar size={16} className={NAV_ICON} />
        <span className="flex-1 truncate text-left">{t("layout.scheduledTasks")}</span>
      </button>

      <button
        type="button"
        onClick={() => setSettingsOpen(true, "plugins")}
        className={NAV_ROW}
      >
        <IconPuzzle size={16} className={NAV_ICON} />
        <span className="flex-1 truncate text-left">{t("layout.pluginsAndSkills")}</span>
      </button>

      {/* 连接手机 — a self-contained trigger + dialog so the sidebar just
          hosts it; its trigger uses the same row shape. */}
      {showConnectPhone && <MobileConnectButton />}
    </nav>
  );
}
