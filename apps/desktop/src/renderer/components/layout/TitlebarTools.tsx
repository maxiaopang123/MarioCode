/**
 * TitlebarTools — the pane / panel switchers on the title bar's right (V4,
 * TODO-044 step 3; replaces V3's vertical ToolStrip at the window's right
 * edge): 文件 / Git / 浏览器, the bottom terminal, then the right-panel toggle.
 * Clicking the ACTIVE pane while the panel is open closes the panel (the
 * buttons are the panel's handle); any other pane switches to it and opens
 * it. 轮次 / 旁聊 are reached from the panel's own tab header (and their
 * shortcuts), which keeps this cluster short.
 */
import { memo } from "react";
import {
  IconFolder,
  IconGitBranch,
  IconLayoutSidebarRightCollapse,
  IconLayoutSidebarRightExpand,
  IconTerminal2,
  IconWorld,
} from "@renderer/lib/icons.js";
import { Hint } from "@renderer/components/ui/index.js";
import { resolveShortcut, acceleratorToDisplayString } from "@renderer/lib/shortcuts.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import type { RightPanelTab } from "@contracts/ipc";

const NO_DRAG = { WebkitAppRegion: "no-drag" } as React.CSSProperties;

function TitlebarToolsBase() {
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
    { id: "files", label: t("layout.tabFiles"), icon: <IconFolder size={17} /> },
    { id: "git", label: "Git", icon: <IconGitBranch size={17} /> },
    { id: "browser", label: t("layout.tabBrowser"), hint: hintFor("layout.toggle-browser"), icon: <IconWorld size={17} />, badge: browserTabCount },
  ];

  return (
    <nav aria-label={t("layout.strip.aria")} className="flex shrink-0 items-center gap-0.5" style={NO_DRAG}>
      {panes.map((p) => (
        <Hint key={p.id} label={p.label + (p.hint ?? "")}>
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

      <Hint label={t("lib.commands.toggleTerminal") + hintFor("layout.toggle-bottom-terminal")}>
        <button
          type="button"
          onClick={() => setBottomTerminalOpen(!bottomTerminalOpen)}
          aria-pressed={bottomTerminalOpen}
          data-on={bottomTerminalOpen ? "true" : undefined}
          className="strip-btn grid place-items-center"
        >
          <IconTerminal2 size={17} />
        </button>
      </Hint>

      <i className="mx-1 h-4 w-px shrink-0 bg-edge" aria-hidden />

      <Hint label={(rightOpen ? t("layout.hideRightPanel") : t("layout.showRightPanel")) + hintFor("layout.toggle-right")}>
        <button
          type="button"
          onClick={() => setRightOpen(!rightOpen)}
          aria-pressed={rightOpen}
          className="strip-btn grid place-items-center"
        >
          {rightOpen ? <IconLayoutSidebarRightCollapse size={17} /> : <IconLayoutSidebarRightExpand size={17} />}
        </button>
      </Hint>
    </nav>
  );
}

export const TitlebarTools = memo(TitlebarToolsBase);
