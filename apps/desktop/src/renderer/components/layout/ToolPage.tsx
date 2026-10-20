/**
 * 工具整页(V4 · TODO-044):「技能与 MCP」「定时任务」不再弹设置浮窗,
 * 而是和画布一样占满主区(App.tsx 里作为 ThreePaneLayout 的兄弟节点,
 * 工作区 CSS 隐藏保活)。
 *
 * 面板本体直接复用设置里的 SkillsPanel / McpPanel / ScheduledTasksPanel,
 * 只换外壳。外壳沿用设置页的容器类名(settings-root / settings-content-
 * container / settings-content),面板里依赖这些类的响应式规则才不会丢。
 *
 * 关闭:右上角 ✕ 或 Esc(子对话框先于整页响应 Esc)。切换会话由 App 根的
 * 订阅统一关闭,和画布一致。
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { cn } from "@renderer/lib/cn.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import { Button } from "@renderer/components/ui/index.js";
import { IconBlocks, IconCalendar, IconX } from "@renderer/lib/icons.js";
import { SkillsPanel } from "@renderer/components/settings/SkillsPanel.js";
import { McpPanel } from "@renderer/components/settings/McpPanel.js";
import { ScheduledTasksPanel } from "@renderer/components/settings/ScheduledTasksPanel.js";

type ExtensionTab = "skills" | "mcp";

export function ToolPage() {
  const { t } = useI18n();
  const page = useSessionStore((s) => s.toolPage);
  const setToolPage = useSessionStore((s) => s.setToolPage);
  const [tab, setTab] = useState<ExtensionTab>("skills");

  // Same width flags the settings shell publishes, so the panels' narrow /
  // compact rules (styles.css .settings-content-container[data-*]) keep working.
  const contentRef = useRef<HTMLDivElement>(null);
  const [contentWidth, setContentWidth] = useState<number | null>(null);
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
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      // Child dialogs dismiss first, without closing the whole page.
      if ([...document.querySelectorAll('[role="dialog"], [role="alertdialog"]')].some((el) => el.getClientRects().length > 0)) return;
      setToolPage(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setToolPage]);

  if (!page) return null;
  const isSkills = page === "skills";
  const Icon = isSkills ? IconBlocks : IconCalendar;

  const tabBtn = (id: ExtensionTab, label: string) => (
    <button
      key={id}
      type="button"
      onClick={() => setTab(id)}
      aria-pressed={tab === id}
      className={cn(
        "h-8 rounded-lg px-3.5 text-[13px] transition-colors",
        tab === id ? "bg-surface-hover font-semibold text-content" : "text-content-muted hover:text-content",
      )}
    >
      {label}
    </button>
  );

  return (
    <div className="settings-root tool-page flex min-w-0 flex-1 flex-col overflow-hidden rounded-2xl border border-edge bg-surface shadow-sm">
      <header className="flex h-12 shrink-0 items-center gap-3 border-b border-edge px-5">
        <Icon size={17} className="text-content-muted" />
        <h2 className="text-sm font-semibold text-content">
          {isSkills ? t("layout.sidebar.skills") : t("layout.scheduledTasks")}
        </h2>
        {isSkills && (
          <div className="ml-2 flex gap-0.5">
            {tabBtn("skills", t("settings.nav.skills"))}
            {tabBtn("mcp", t("settings.nav.mcp"))}
          </div>
        )}
        <span className="flex-1" />
        <Button variant="ghost" size="icon" aria-label={t("common.close")} onClick={() => setToolPage(null)}>
          <IconX size={15} />
        </Button>
      </header>
      <div
        ref={contentRef}
        data-narrow={contentWidth !== null && contentWidth <= 800}
        data-compact={contentWidth !== null && contentWidth <= 560}
        className="settings-content-container flex min-h-0 min-w-0 flex-1 px-6 lg:px-10"
      >
        <main
          key={isSkills ? tab : page}
          data-wide="true"
          className="settings-content min-h-0 min-w-0 flex-1 overflow-y-auto pb-8"
          style={{ fontSize: "var(--right-panel-font-size)" }}
        >
          {isSkills ? (tab === "skills" ? <SkillsPanel /> : <McpPanel />) : <ScheduledTasksPanel />}
        </main>
      </div>
    </div>
  );
}
