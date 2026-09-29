/**
 * ProjectRail — the 60px column at the window's far left (界面焕新 v3,
 * prototypes/ui-refresh-v3.html ①):
 *
 *   [logo]
 *   [全部会话]
 *   ── project avatars (tinted) — pip: running / unread, count: 等你处理 ──
 *   [+ 添加项目]
 *   ⋮
 *   [定时任务] [技能] [连接手机]
 *   ── [浅/深] [设置]
 *
 * Every cell is 36×36 r10 with a ~28px visual block (logo 28, avatar 28,
 * line icons 18px stroke 1.6; phone 19 / blocks 17 for optical balance).
 * Picking a cell only sets the session column's scope (same persisted
 * `ui.streamScope` the column's own menu writes) — it never resets tabs.
 *
 * Only mounted in the stream left-bar mode; the classic tree keeps its own
 * header/footer as the fallback view.
 */
import { memo, useMemo, useState } from "react";
import {
  IconBlocks,
  IconCalendar,
  IconMessages,
  IconMoon,
  IconPlus,
  IconSettings,
  IconSun,
} from "@renderer/lib/icons.js";
import { cn } from "@renderer/lib/cn.js";
import { isMac } from "@renderer/lib/platform.js";
import { api } from "@renderer/lib/api.js";
import { useTheme, applyThemeClass } from "@renderer/lib/theme.js";
import { projectDisplayColor } from "@renderer/lib/projectAvatar.js";
import { resolveShortcut, acceleratorToDisplayString } from "@renderer/lib/shortcuts.js";
import { useAttention } from "@renderer/lib/attention.js";
import { ConfirmDialog, Hint } from "@renderer/components/ui/index.js";
import { useCursorAnchor } from "@renderer/hooks/useCursorAnchor.js";
import { ProjectManageMenuPopup, type ManageMenuState } from "./ProjectManageMenu.js";
import { RenameDialog } from "./SidebarShared.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import type { Session } from "@contracts/session";
import { BrandLogo } from "./BrandLogo.js";
import { ProjectAvatar } from "./ProjectAvatar.js";
import { MobileConnectButton } from "./MobileConnectDialog.js";

const noDrag = { WebkitAppRegion: "no-drag" } as React.CSSProperties;

function ProjectRailBase() {
  const { t } = useI18n();
  const projects = useSessionStore((s) => s.projects);
  const projectColors = useSessionStore((s) => s.projectColors);
  const streamScope = useSessionStore((s) => s.streamScope);
  const setStreamScope = useSessionStore((s) => s.setStreamScope);
  const setLeftOpen = useSessionStore((s) => s.setLeftOpen);
  const setSettingsOpen = useSessionStore((s) => s.setSettingsOpen);
  const addProject = useSessionStore((s) => s.addProjectFromFolder);
  const settingsOpen = useSessionStore((s) => s.settingsOpen);
  const runningBySession = useSessionStore((s) => s.runningBySession);
  const unreadBySession = useSessionStore((s) => s.unreadBySession);
  const sessionsByProject = useSessionStore((s) => s.sessionsByProject);
  const pinnedSessions = useSessionStore((s) => s.pinnedSessions);
  const streamSessions = useSessionStore((s) => s.streamSessions);
  const overrides = useSessionStore((s) => s.shortcutOverrides);
  const renameProject = useSessionStore((s) => s.renameProject);
  const setProjectGroup = useSessionStore((s) => s.setProjectGroup);
  const setProjectColor = useSessionStore((s) => s.setProjectColor);
  const archiveProject = useSessionStore((s) => s.archiveProject);
  const deleteProject = useSessionStore((s) => s.deleteProject);
  const attention = useAttention();

  const liveProjects = useMemo(() => projects.filter((p) => !p.archived), [projects]);
  const knownGroups = useMemo(() => {
    const set = new Set<string>();
    for (const p of projects) if (!p.archived && p.group) set.add(p.group);
    return Array.from(set);
  }, [projects]);

  // Project management (the removed tree view's job): right-click an avatar
  // → rename / group / color / open folder / archive / delete.
  const [manageMenu, setManageMenu] = useState<ManageMenuState | null>(null);
  const manageAnchor = useCursorAnchor(manageMenu);
  const [renaming, setRenaming] = useState<
    { id: string; title: string; kind: "project" | "group" } | null
  >(null);
  const [confirmDelete, setConfirmDelete] = useState<{ id: string; name: string } | null>(null);
  const menuItemClass = cn(
    "flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs outline-none select-none",
    "text-content-muted data-[highlighted]:bg-surface-muted",
  );

  // sessionId → projectId over every cached bucket (per-project pages, the
  // pinned block and the stream aggregate), so indicators resolve for rows
  // loaded by either view.
  const projectOfSession = useMemo(() => {
    const map = new Map<string, string>();
    const add = (list: Session[] | undefined) => {
      if (!list) return;
      for (const s of list) map.set(s.id, s.projectId);
    };
    for (const list of Object.values(sessionsByProject)) add(list);
    add(pinnedSessions);
    add(streamSessions);
    return map;
  }, [sessionsByProject, pinnedSessions, streamSessions]);

  // Per-project indicators: waiting count, any running, any unread.
  const indicators = useMemo(() => {
    const out = new Map<string, { waiting: number; running: boolean; unread: boolean }>();
    const bucket = (pid: string) => {
      let b = out.get(pid);
      if (!b) {
        b = { waiting: 0, running: false, unread: false };
        out.set(pid, b);
      }
      return b;
    };
    for (const a of attention) {
      const pid = projectOfSession.get(a.sessionId);
      if (pid) bucket(pid).waiting += 1;
    }
    for (const [sid, on] of Object.entries(runningBySession)) {
      if (!on) continue;
      const pid = projectOfSession.get(sid);
      if (pid) bucket(pid).running = true;
    }
    for (const [sid, n] of Object.entries(unreadBySession)) {
      if (!n) continue;
      const pid = projectOfSession.get(sid);
      if (pid) bucket(pid).unread = true;
    }
    return out;
  }, [attention, runningBySession, unreadBySession, projectOfSession]);

  // Which cell is "on". Group / worktree scopes light their owning project
  // when one can be singled out; otherwise nothing is lit but 全部 stays off.
  const scope = streamScope ?? null;
  const allOn = scope == null || !liveProjects.some((p) => p.id === scope) && !scope.startsWith("g:") && !scope.startsWith("wt:");

  const pick = (next: string | null) => {
    setStreamScope(next);
    setLeftOpen(true);
  };

  const { effective: effectiveTheme } = useTheme();
  const toggleTheme = () => {
    const next = effectiveTheme === "dark" ? "light" : "dark";
    void api.theme.set({ theme: next }).then((s) => applyThemeClass(s.effective));
  };
  const settingsAccel = resolveShortcut("view.settings", overrides);

  return (
    <nav
      aria-label={t("layout.rail.aria")}
      className={cn(
        "flex h-full w-[60px] shrink-0 flex-col items-center gap-1 border-r border-edge bg-rail pb-2.5",
        // mac: the traffic lights own the top-left band.
        isMac ? "pt-10" : "pt-2.5",
      )}
      style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
    >
      {!isMac && (
        <span className="mb-1.5 mt-1 flex h-7 items-center" title="MarioCode">
          <BrandLogo size={28} />
        </span>
      )}

      <Hint label={t("layout.rail.allSessions")} side="right">
        <button
          type="button"
          onClick={() => pick(null)}
          data-on={allOn && !settingsOpen ? "true" : undefined}
          className="rail-btn grid place-items-center"
          style={noDrag}
        >
          <IconMessages size={18} />
        </button>
      </Hint>

      <i className="my-1.5 h-px w-5 shrink-0 bg-edge" aria-hidden />

      <div className="flex min-h-0 flex-col items-center gap-1 overflow-y-auto overflow-x-visible px-3 [scrollbar-width:none]" style={noDrag}>
        {liveProjects.map((p) => {
          const ind = indicators.get(p.id);
          const on = scope === p.id && !settingsOpen;
          const hintParts = [p.name];
          if (ind?.running) hintParts.push(t("layout.rail.running"));
          if (ind && ind.waiting > 0) hintParts.push(t("layout.rail.waiting", { n: ind.waiting }));
          else if (ind?.unread) hintParts.push(t("layout.rail.unread"));
          return (
            <Hint key={p.id} label={`${hintParts.join(" · ")}（${t("layout.rail.manageHint")}）`} side="right">
              <button
                type="button"
                onClick={() => pick(p.id)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setManageMenu({ project: p, x: e.clientX, y: e.clientY });
                }}
                data-on={on ? "true" : undefined}
                className="rail-btn grid place-items-center"
              >
                <ProjectAvatar name={p.name} color={projectDisplayColor(p, projectColors)} size="lg" />
                {ind?.running ? (
                  <i className="rail-pip" data-run="true" aria-hidden />
                ) : ind?.unread ? (
                  <i className="rail-pip" aria-hidden />
                ) : null}
                {ind && ind.waiting > 0 && (
                  <i className="rail-cnt not-italic" aria-hidden>
                    {ind.waiting > 9 ? "9+" : ind.waiting}
                  </i>
                )}
              </button>
            </Hint>
          );
        })}
        <Hint label={t("layout.addProject")} side="right">
          <button
            type="button"
            onClick={() => void addProject()}
            className="rail-btn grid place-items-center text-content-subtle/80"
          >
            <IconPlus size={16} />
          </button>
        </Hint>
      </div>

      <span className="min-h-2 flex-1" aria-hidden />

      <div className="flex flex-col items-center gap-1" style={noDrag}>
        <Hint label={t("layout.scheduledTasks")} side="right">
          <button
            type="button"
            onClick={() => setSettingsOpen(true, "scheduled-tasks")}
            className="rail-btn grid place-items-center"
          >
            <IconCalendar size={18} />
          </button>
        </Hint>
        <Hint label={t("layout.skills")} side="right">
          <button
            type="button"
            onClick={() => setSettingsOpen(true, "skills")}
            className="rail-btn grid place-items-center"
          >
            <IconBlocks size={17} />
          </button>
        </Hint>
        <MobileConnectButton variant="rail" />

        <i className="my-1.5 h-px w-5 shrink-0 bg-edge" aria-hidden />

        <Hint label={effectiveTheme === "dark" ? t("layout.themeToLight") : t("layout.themeToDark")} side="right">
          <button type="button" onClick={toggleTheme} className="rail-btn grid place-items-center">
            {effectiveTheme === "dark" ? <IconSun size={18} /> : <IconMoon size={18} />}
          </button>
        </Hint>
        <Hint
          label={t("layout.settings") + (settingsAccel ? ` (${acceleratorToDisplayString(settingsAccel)})` : "")}
          side="right"
        >
          <button
            type="button"
            onClick={() => setSettingsOpen(!settingsOpen)}
            data-on={settingsOpen ? "true" : undefined}
            className="rail-btn grid place-items-center"
          >
            <IconSettings size={18} />
          </button>
        </Hint>
      </div>

      <ProjectManageMenuPopup
        manageMenu={manageMenu}
        anchor={manageAnchor}
        knownGroups={knownGroups}
        projectColors={projectColors}
        onClose={() => setManageMenu(null)}
        onRename={(p) => { setManageMenu(null); setRenaming({ id: p.id, title: p.name, kind: "project" }); }}
        onLeaveGroup={(p) => { setManageMenu(null); void setProjectGroup(p.id, null); }}
        onJoinGroup={(p, g) => { setManageMenu(null); void setProjectGroup(p.id, g); }}
        onNewGroup={(p) => { setManageMenu(null); setRenaming({ id: p.id, title: "", kind: "group" }); }}
        onSetColor={(p, hex) => void setProjectColor(p.id, hex)}
        onOpenFolder={(p) => { setManageMenu(null); void api.shell.openPath({ path: p.path }); }}
        onArchive={(p) => {
          setManageMenu(null);
          if (streamScope === p.id) setStreamScope(null);
          void archiveProject(p.id, true);
        }}
        onDelete={(p) => { setManageMenu(null); setConfirmDelete({ id: p.id, name: p.name }); }}
        menuItemClass={menuItemClass}
      />

      <RenameDialog
        renaming={renaming}
        onClose={() => setRenaming(null)}
        onSubmit={async (id, title, kind) => {
          if (kind === "group") await setProjectGroup(id, title);
          else await renameProject(id, title);
          setRenaming(null);
        }}
      />

      <ConfirmDialog
        open={confirmDelete != null}
        danger
        title={t("layout.deleteProject")}
        description={t("layout.deleteProjectDesc", { name: confirmDelete?.name ?? "" })}
        confirmText={t("common.delete")}
        onOpenChange={(open) => { if (!open) setConfirmDelete(null); }}
        onConfirm={() => {
          if (!confirmDelete) return;
          if (streamScope === confirmDelete.id) setStreamScope(null);
          void deleteProject(confirmDelete.id);
        }}
      />
    </nav>
  );
}

export const ProjectRail = memo(ProjectRailBase);
