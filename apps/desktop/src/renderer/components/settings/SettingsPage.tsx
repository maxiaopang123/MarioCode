import { useEffect, useLayoutEffect, useRef, useState, type ComponentType } from "react";
import { cn } from "@renderer/lib/cn.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import { useI18n, type MessageId } from "@renderer/lib/i18n/index.js";
import { Button, Input } from "@renderer/components/ui/index.js";
import {
  IconSettings,
  IconPalette,
  IconKeyboard,
  IconRobot,
  IconSparkles,
  IconBell,
  IconBrandGit,
  IconTerminal2,
  IconWorld,
  IconInfoCircle,
  IconChartBar,
  IconMicrophone,
  IconHandMove,
  IconPackage,
  IconCalendar,
  IconMessageChatbot,
  IconPlugConnected,
  IconWorldSearch,
  IconChevronDown,
  IconSearch,
  IconX,
  McpIcon,
  type TablerIconProps,
} from "@renderer/lib/icons.js";
import { SharedProvidersPanel } from "./SharedProvidersPanel.js";
import { RuntimesPanel } from "./RuntimesPanel.js";
import { NetworkPanel } from "./NetworkPanel.js";
import { SkillsPanel } from "./SkillsPanel.js";
import { McpPanel } from "./McpPanel.js";
import { BuiltinToolsPanel } from "./BuiltinToolsPanel.js";
import { AppearancePanel } from "./AppearancePanel.js";
import { ShortcutsPanel } from "./ShortcutsPanel.js";
import { GesturesPanel } from "./GesturesPanel.js";
import { GeneralPanel } from "./GeneralPanel.js";
import { GitPanel } from "./GitPanel.js";
import { TerminalPanel } from "./TerminalPanel.js";
import { BrowserPanel } from "./BrowserPanel.js";
import { LspLanguagesPanel } from "./LspLanguagesPanel.js";
import { NotificationsPanel } from "./NotificationsPanel.js";
import { VoicePanel } from "./VoicePanel.js";
import { UsagePanel } from "./UsagePanel.js";
import { AboutPanel } from "./AboutPanel.js";
import { ScheduledTasksPanel } from "./ScheduledTasksPanel.js";
import { SystemPromptPanel } from "./SystemPromptPanel.js";

/**
 * Settings page with a left functional menu + right content panel layout.
 *
 * Mounted inside SettingsDialog, with an independent flat two-column shell.
 * The workspace remains mounted underneath, preserving terminals and chats.
 *
 * The nav is grouped into 5 labeled clusters (通用 → AI 能力 → 输入与提醒 →
 * 工作台 → 系统). Only the active category expands on initial open; search
 * reveals matching entries across all categories. Deep links via
 * `setSettingsOpen(true, sectionId)` still address individual items.
 *
 * Note: the legacy “Claude CLI 路径” panel was removed - the Agent SDK bundles
 * its own claude binary, so an externally-configured path is no longer used.
 */
type SectionId = "general" | "runtimes" | "network" | "custom-models" | "system-prompt" | "skills" | "mcp" | "builtin-tools" | "appearance" | "shortcuts" | "gestures" | "voice" | "notifications" | "scheduled-tasks" | "git" | "terminal" | "browser" | "lsp-languages" | "usage" | "about";

interface NavItem {
  id: SectionId;
  labelKey: MessageId;
  icon: ComponentType<TablerIconProps>;
}

interface NavGroup {
  labelKey: MessageId;
  items: NavItem[];
}

/** Settings navigation owns its width independently of the workspace. */
const SETTINGS_NAV_WIDTH = 216;

const NAV_GROUPS: NavGroup[] = [
  {
    labelKey: "settings.navGroup.general",
    items: [
      { id: "general", labelKey: "settings.nav.general", icon: IconSettings },
      { id: "appearance", labelKey: "settings.nav.appearance", icon: IconPalette },
    ],
  },
  {
    labelKey: "settings.navGroup.ai",
    items: [
      { id: "custom-models", labelKey: "settings.nav.customModels", icon: IconRobot },
      { id: "system-prompt", labelKey: "settings.nav.systemPrompt", icon: IconMessageChatbot },
      { id: "runtimes", labelKey: "settings.nav.runtimes", icon: IconPackage },
      { id: "network", labelKey: "settings.nav.network", icon: IconPlugConnected },
      { id: "skills", labelKey: "settings.nav.skills", icon: IconSparkles },
      { id: "mcp", labelKey: "settings.nav.mcp", icon: McpIcon },
      { id: "builtin-tools", labelKey: "settings.nav.builtinTools", icon: IconWorldSearch },
    ],
  },
  {
    labelKey: "settings.navGroup.input",
    items: [
      { id: "voice", labelKey: "settings.nav.voice", icon: IconMicrophone },
      { id: "shortcuts", labelKey: "settings.nav.shortcuts", icon: IconKeyboard },
      { id: "gestures", labelKey: "settings.nav.gestures", icon: IconHandMove },
      { id: "notifications", labelKey: "settings.nav.notifications", icon: IconBell },
    ],
  },
  {
    labelKey: "settings.navGroup.workbench",
    items: [
      { id: "scheduled-tasks", labelKey: "settings.nav.scheduledTasks", icon: IconCalendar },
      { id: "git", labelKey: "settings.nav.git", icon: IconBrandGit },
      { id: "terminal", labelKey: "settings.nav.terminal", icon: IconTerminal2 },
      { id: "browser", labelKey: "settings.nav.browser", icon: IconWorld },
      // LSP (语言服务器) nav entry hidden for now (2026-09-28): the user drives
      // code changes through the agent and only reviews diffs, so editor
      // language features aren't needed. The panel and deep-link
      // (setSettingsOpen(true, "lsp-languages")) still work — re-add this
      // line to bring it back.
      // { id: "lsp-languages", labelKey: "settings.nav.lsp", icon: IconCode }, (re-import IconCode)
    ],
  },
  {
    labelKey: "settings.navGroup.system",
    items: [
      { id: "usage", labelKey: "settings.nav.usage", icon: IconChartBar },
      { id: "about", labelKey: "settings.nav.about", icon: IconInfoCircle },
    ],
  },
];

/** Flat nav items (group order preserved) — used to validate deep-link ids. */
const NAV_ITEMS: NavItem[] = NAV_GROUPS.flatMap((g) => g.items);

export function SettingsPage() {
  const { t } = useI18n();
  const setSettingsOpen = useSessionStore((s) => s.setSettingsOpen);
  // SettingsPage mounts fresh each time the modal opens (App.tsx conditionally
  // renders it on `settingsOpen`), so this useState reads the requested
  // section on initial open, then follows new deep-link requests. Callers pass a section via setSettingsOpen(true, id)
  // — e.g. the composer's "管理模型…" entry targets "custom-models" / "pi-models".
  // A plain gear click (no section) lands on the first nav item ("常规") — the
  // default must NOT be "custom-models", or every plain open would jump to
  // the model-config tab.
  const settingsSection = useSessionStore((s) => s.settingsSection);
  const [active, setActive] = useState<SectionId>(
    () =>
      (settingsSection && (NAV_ITEMS.some((n) => n.id === settingsSection) || settingsSection === "lsp-languages")
        ? settingsSection
        : NAV_ITEMS[0].id) as SectionId,
  );
  const [query, setQuery] = useState("");
  const navRef = useRef<HTMLElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [contentWidth, setContentWidth] = useState<number | null>(null);
  const [expandedGroups, setExpandedGroups] = useState<ReadonlySet<MessageId>>(() => new Set([
    NAV_GROUPS.find((group) => group.items.some((item) => item.id === active))?.labelKey ?? NAV_GROUPS[0].labelKey,
  ]));
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const filteredGroups = NAV_GROUPS.map((group) => ({
    ...group,
    items: group.items.filter((item) => !normalizedQuery || `${t(item.labelKey)} ${item.id} ${t(group.labelKey)}`.toLocaleLowerCase().includes(normalizedQuery)),
  })).filter((group) => group.items.length > 0);
  const isWidePanel = ["custom-models", "skills", "mcp", "system-prompt", "scheduled-tasks", "usage"].includes(active);

  const selectSection = (id: SectionId) => {
    setActive(id);
    setQuery("");
    const group = NAV_GROUPS.find((entry) => entry.items.some((item) => item.id === id));
    if (group) setExpandedGroups((current) => new Set([...current, group.labelKey]));
  };

  // Observe available content width without CSS size containment. Chromium
  // can blank the whole window when contained Select panels are remounted;
  // width-only flags retain responsive settings without that rendering path.
  useLayoutEffect(() => {
    const element = contentRef.current;
    if (!element) return;
    const style = getComputedStyle(element);
    setContentWidth(element.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight));
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setContentWidth(entry.contentRect.width);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!settingsSection || (!NAV_ITEMS.some((item) => item.id === settingsSection) && settingsSection !== "lsp-languages")) return;
    setActive(settingsSection as SectionId);
    setQuery("");
    const group = NAV_GROUPS.find((entry) => entry.items.some((item) => item.id === settingsSection));
    if (group) setExpandedGroups((current) => current.has(group.labelKey) ? current : new Set([...current, group.labelKey]));
  }, [settingsSection]);

  useEffect(() => {
    navRef.current?.querySelector('[aria-current="page"]')?.scrollIntoView({ block: "nearest" });
  }, [active]);

  // Esc returns to the workspace (preserves the modal's keyboard shortcut).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      // Child dialogs dismiss first, without closing the entire settings window.
      if ([...document.querySelectorAll('[role="dialog"], [role="alertdialog"]')].some((element) => !element.classList.contains("settings-root") && element.getClientRects().length > 0)) return;
      if (query) setQuery("");
      else setSettingsOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setSettingsOpen, query]);

  return (
    <div className="flex h-full min-h-0 w-full" style={{ fontSize: "var(--right-panel-font-size)" }}>
      <aside className="flex min-h-0 shrink-0 flex-col border-r border-edge bg-surface-base" style={{ width: SETTINGS_NAV_WIDTH }}>
        <div className="px-4 pb-4 pt-5">
          <label className="relative block">
            <span className="sr-only">{t("settings.shell.search")}</span>
            <IconSearch size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-content-subtle" />
            <Input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("settings.shell.search")} className="h-9 rounded-lg pl-8 pr-8" />
            {query && <Button variant="ghost" size="icon" aria-label={t("settings.shell.clearSearch")} onClick={() => setQuery("")} className="absolute right-1 top-1/2 -translate-y-1/2"><IconX size={12} /></Button>}
          </label>
        </div>
        <nav ref={navRef} aria-label={t("layout.settings")} className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 pb-6">
          {filteredGroups.map((group) => {
            const expanded = !!normalizedQuery || expandedGroups.has(group.labelKey);
            const groupId = `settings-${group.labelKey.split(".").at(-1)}`;
            return <div key={group.labelKey}>
              <Button variant="ghost" size="md" aria-expanded={expanded} aria-controls={groupId} onClick={() => setExpandedGroups((current) => {
                const next = new Set(current);
                if (next.has(group.labelKey)) next.delete(group.labelKey);
                else next.add(group.labelKey);
                return next;
              })} className="h-9 w-full justify-between rounded-lg px-3 text-xs font-medium text-content-muted">
                {t(group.labelKey)}
                <IconChevronDown size={13} className={cn("transition-transform", !expanded && "-rotate-90")} />
              </Button>
              {expanded && <div id={groupId} className="mt-1 space-y-1">
                {group.items.map((item) => {
                  const isActive = item.id === active;
                  const Icon = item.icon;
                  return (
                    <Button
                      variant="ghost"
                      size="md"
                      key={item.id}
                      onClick={() => selectSection(item.id)}
                      aria-current={isActive ? "page" : undefined}
                      className={cn(
                        "relative h-10 w-full justify-start gap-3 rounded-lg px-3 text-[0.9286em] font-normal text-content-muted",
                        isActive && "bg-surface-hover font-medium text-content",
                      )}
                    >
                      {isActive && (
                        <span className="absolute left-[3px] top-1/2 h-3 w-[3px] -translate-y-1/2 rounded-full bg-accent" />
                      )}
                      <Icon size={16} className="shrink-0 text-content-muted" />
                      <span className="truncate">{t(item.labelKey)}</span>
                    </Button>
                  );
                })}
              </div>}
            </div>;
          })}
          {filteredGroups.length === 0 && <p role="status" className="px-3 py-6 text-xs leading-relaxed text-content-subtle">{t("settings.shell.noResults")}</p>}
        </nav>
      </aside>
        <div ref={contentRef}
          data-narrow={contentWidth !== null && contentWidth <= 800}
          data-compact={contentWidth !== null && contentWidth <= 560}
          className="settings-content-container flex min-h-0 min-w-0 flex-1 px-6 lg:px-10">
        <main
          // Keep a definite height for panels that scroll internally. No top
          // padding: the sticky toolbar must meet the top of the scrollport.
          key={active}
          aria-label={t(NAV_ITEMS.find((item) => item.id === active)?.labelKey ?? "layout.settings")}
          data-wide={isWidePanel}
          className="settings-content min-h-0 min-w-0 flex-1 overflow-y-auto pb-8"
        >
          {active === "general" && <GeneralPanel />}
          {active === "appearance" && <AppearancePanel />}
          {/* 模型配置 = the shared provider hub only; the legacy per-engine
              editor (CustomModelsPanel) was removed 2026-09-28. */}
          {active === "custom-models" && <SharedProvidersPanel />}
          {active === "system-prompt" && <SystemPromptPanel />}
          {active === "shortcuts" && <ShortcutsPanel />}
          {active === "gestures" && <GesturesPanel />}
          {active === "voice" && <VoicePanel />}
          {active === "skills" && <SkillsPanel />}
          {active === "runtimes" && <RuntimesPanel />}
          {active === "network" && <NetworkPanel />}
          {active === "mcp" && <McpPanel />}
          {active === "builtin-tools" && <BuiltinToolsPanel />}
          {active === "notifications" && <NotificationsPanel />}
          {active === "scheduled-tasks" && <ScheduledTasksPanel />}
          {active === "git" && <GitPanel />}
          {active === "terminal" && <TerminalPanel />}
          {active === "browser" && <BrowserPanel />}
          {active === "lsp-languages" && <LspLanguagesPanel />}
          {active === "usage" && <UsagePanel />}
          {active === "about" && <AboutPanel />}
        </main>
        </div>
    </div>
  );
}
