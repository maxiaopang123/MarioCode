/**
 * ToolStrip — the vertical tool strip at the window's right edge (界面焕新
 * v3). Replaces the right panel's top segmented tabs: one cell per pane
 * (文件 / Git / 浏览器 / 轮次 / 旁聊), then the bottom terminal, and the
 * panel toggle at the foot. Clicking the ACTIVE pane while the panel is
 * open closes the panel (the strip is the panel's handle); any other cell
 * switches to that pane and opens it.
 */
import { memo } from "react";
import {
  IconFolder,
  IconGitBranch,
  IconLayoutSidebarRightCollapse,
  IconLayoutSidebarRightExpand,
  IconListDetails,
  IconMessages,
  IconTerminal2,
  IconWorld,
} from "@renderer/lib/icons.js";
import { Hint } from "@renderer/components/ui/index.js";
import { resolveShortcut, acceleratorToDisplayString } from "@renderer/lib/shortcuts.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import type { RightPanelTab } from "@contracts/ipc";

function ToolStripBase() {
  const { t } = useI18n();
  const tab = useSessionStore((s) => s.rightPanelTab);
  const setTab = useSessionStore((s) => s.setRightPanelTab);
  const rightOpen = useSessionStore((s) => s.rightOpen);
  const setRightOpen = useSessionStore((s) => s.setRightOpen);
  const bottomTerminalOpen = useSessionStore((s) => s.bottomTerminalOpen);
  const setBottomTerminalOpen = useSessionStore((s) => s.setBottomTerminalOpen);
  const browserTabCount = useSessionStore((s) => s.browserTabCount);
  const overrides = useSessionStore((s) => s.shortcutOverrides);
  const hintFor = (commandId: string): string => {
    const a = resolveShortcut(commandId, overrides);
    return a ? ` (${acceleratorToDisplayString(a)})` : "";
  };

  const pickPane = (next: RightPanelTab) => {
    if (rightOpen && tab === next) {
      setRightOpen(false);
      return;
    }
    setTab(next);
    setRightOpen(true);
  };

  const panes: { id: RightPanelTab; label: string; hint?: string; icon: React.ReactNode; badge?: number }[] = [
    { id: "files", label: t("layout.tabFiles"), icon: <IconFolder size={18} /> },
    { id: "git", label: "Git", icon: <IconGitBranch size={18} /> },
    { id: "browser", label: t("layout.tabBrowser"), hint: hintFor("layout.toggle-browser"), icon: <IconWorld size={18} />, badge: browserTabCount },
    { id: "turns", label: t("layout.tabTurns"), icon: <IconListDetails size={18} /> },
    { id: "sidechat", label: t("layout.tabSideChat"), hint: hintFor("sidechat.open"), icon: <IconMessages size={18} /> },
  ];

  return (
    <nav
      aria-label={t("layout.strip.aria")}
      className="flex w-11 shrink-0 flex-col items-center gap-1 py-1"
    >
      {panes.map((p) => (
        <Hint key={p.id} label={p.label + (p.hint ?? "")} side="left">
          <button
            type="button"
            onClick={() => pickPane(p.id)}
            aria-pressed={rightOpen && tab === p.id}
            data-on={rightOpen && tab === p.id ? "true" : undefined}
            className="strip-btn grid place-items-center"
          >
            {p.icon}
            {p.badge != null && p.badge > 0 && (
              <span className="absolute -right-0.5 -top-0.5 flex h-[15px] min-w-[15px] items-center justify-center rounded-full bg-accent px-1 text-[9.5px] font-bold leading-none text-primary-on shadow-[0_0_0_2px_rgb(var(--surface-base))]">
                {p.badge > 99 ? "99+" : p.badge}
              </span>
            )}
          </button>
        </Hint>
      ))}

      <i className="my-1.5 h-px w-5 shrink-0 bg-edge" aria-hidden />

      <Hint label={t("lib.commands.toggleTerminal") + hintFor("layout.toggle-bottom-terminal")} side="left">
        <button
          type="button"
          onClick={() => setBottomTerminalOpen(!bottomTerminalOpen)}
          aria-pressed={bottomTerminalOpen}
          data-on={bottomTerminalOpen ? "true" : undefined}
          className="strip-btn grid place-items-center"
        >
          <IconTerminal2 size={18} />
        </button>
      </Hint>

      <span className="flex-1" aria-hidden />

      <Hint label={(rightOpen ? t("layout.hideRightPanel") : t("layout.showRightPanel")) + hintFor("layout.toggle-right")} side="left">
        <button
          type="button"
          onClick={() => setRightOpen(!rightOpen)}
          aria-pressed={rightOpen}
          className="strip-btn grid place-items-center"
        >
          {rightOpen ? <IconLayoutSidebarRightCollapse size={18} /> : <IconLayoutSidebarRightExpand size={18} />}
        </button>
      </Hint>
    </nav>
  );
}

export const ToolStrip = memo(ToolStripBase);
