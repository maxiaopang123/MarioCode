/**
 * ProjectSidebar — the single left column of the V4 layout (TODO-044 step 2,
 * prototypes/ui-refresh-v4.html). It replaces V3's ProjectRail + StreamSidebar:
 *
 *   [logo MarioCode]                                  [收起]
 *   [＋ 新会话]
 *   等你处理 N 个会话 ……………………………………… (warning row)
 *   ┌ 项目 ────────────────────────────── ＋ ┐
 *   │ ▣ MarioCode  5                          │   ← tinted project tile
 *   │ ╎ 修复浏览器面板顶部残留        转圈      │   ← thread rows hang on a
 *   │ ╎ 重构设置页导航              待审批      │     guide line; the active
 *   │ ╎ ⑂ mariocode/xxx  未合并               │     one lights an accent tick
 *   │ ╎ 画布图库回填                  1h       │
 *   │ ▣ prototype-lab 2                       │
 *   └──────────────────────────────────────┘
 *   已归档 12 ›
 *   ┌ 工具 ──────────────┐   技能与 MCP / 画布 / 定时任务 / 连接手机
 *   [设置]                                 [浅/深]
 *
 * Data is the same store the V2 tree and V3 stream view read — per-project
 * pages (`sessionsByProject`, local section + worktree section, `hasMore`),
 * the global pinned block, the archived shelf and the status maps — so no
 * store change is needed. Status stays INLINE on the right of a row and never
 * reorders rows. Project management (rename / group / color / open folder /
 * archive / delete) lives on the project header's right-click menu; the
 * thread right-click menu is the shared SessionContextMenu.
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  IconArchive,
  IconBell,
  IconBlocks,
  IconCalendar,
  IconChevronDown,
  IconChevronRight,
  IconFolderPlus,
  IconGitFork,
  IconLayoutSidebarLeftCollapse,
  IconLoader2,
  IconMoon,
  IconPalette,
  IconPinnedFilled,
  IconPlus,
  IconSettings,
  IconSun,
} from "@renderer/lib/icons.js";
import { cn } from "@renderer/lib/cn.js";
import { isMac } from "@renderer/lib/platform.js";
import { api } from "@renderer/lib/api.js";
import { useTheme, applyThemeClass } from "@renderer/lib/theme.js";
import { modelDisplayName } from "@renderer/lib/modelAvatar.js";
import { selectArchiveShelf } from "@renderer/lib/archiveScope.js";
import { projectDisplayColor } from "@renderer/lib/projectAvatar.js";
import { formatRelativeTime, formatFullTime } from "@renderer/lib/time.js";
import { normWorktreeKey, worktreeDisplayName } from "@renderer/lib/worktree.js";
import { resolveShortcut, acceleratorToDisplayString, acceleratorToDisplayTokens } from "@renderer/lib/shortcuts.js";
import { jumpToNextAttention, useAttention } from "@renderer/lib/attention.js";
import { ConfirmDialog, Hint, Kbd } from "@renderer/components/ui/index.js";
import { useCursorAnchor } from "@renderer/hooks/useCursorAnchor.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import { WorktreeMergeBackDialog, WorktreeRemoveDialog } from "@renderer/components/chat/WorktreeMergeBack.js";
import { ProjectManageMenuPopup, type ManageMenuState } from "./ProjectManageMenu.js";
import { ProjectAvatar } from "./ProjectAvatar.js";
import { SessionModelAvatar } from "./SessionModelAvatar.js";
import { BrandLogo } from "./BrandLogo.js";
import { MobileConnectButton } from "./MobileConnectDialog.js";
import { ArchivedRow, RenameDialog, SessionContextMenu, SIDEBAR_NAV_ITEM } from "./SidebarShared.js";
import type { Project, Session } from "@contracts/session";
import type { GitWorktreeInfo } from "@contracts/ipc";
import { useI18n } from "@renderer/lib/i18n/index.js";

const DRAG = { WebkitAppRegion: "drag" } as React.CSSProperties;
const NO_DRAG = { WebkitAppRegion: "no-drag" } as React.CSSProperties;

/** mm:ss (h:mm:ss past an hour) for the running-turn duration label. */
function formatRunningDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
}

/* ── Row status model (same precedence as the V3 stream view) ── */

type RowStatus =
  | { kind: "working"; startedAt: number }
  | { kind: "approval" }
  | { kind: "question" }
  | { kind: "failed" }
  | { kind: "done" }
  | { kind: "time" };

interface StatusSignals {
  runningBySession: Record<string, boolean>;
  runningTurnStartedAt: Record<string, number>;
  approvalSessions: Set<string>;
  pendingQuestionBySession: Record<string, unknown>;
  turnErrorBySession: Record<string, boolean>;
  unreadBySession: Record<string, number>;
}

/** "Needs you" states outrank running: a turn paused on an approval /
 *  question is technically running but waits on the user. */
function statusOf(s: Session, sig: StatusSignals): RowStatus {
  if (sig.approvalSessions.has(s.id)) return { kind: "approval" };
  if (sig.pendingQuestionBySession[s.id] != null) return { kind: "question" };
  if (sig.runningBySession[s.id]) {
    return { kind: "working", startedAt: sig.runningTurnStartedAt[s.id] ?? Date.now() };
  }
  if (sig.turnErrorBySession[s.id]) return { kind: "failed" };
  if ((sig.unreadBySession[s.id] ?? 0) > 0) return { kind: "done" };
  return { kind: "time" };
}

const EMPTY_SESSIONS: Session[] = [];

function ProjectSidebarBase() {
  const { t } = useI18n();
  const projects = useSessionStore((s) => s.projects);
  const projectColors = useSessionStore((s) => s.projectColors);
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const activeProjectId = useSessionStore((s) => s.activeProjectId);
  const sessionsByProject = useSessionStore((s) => s.sessionsByProject);
  const sessionsHasMoreByProject = useSessionStore((s) => s.sessionsHasMoreByProject);
  const sessionsTotalByProject = useSessionStore((s) => s.sessionsTotalByProject);
  const pinnedSessions = useSessionStore((s) => s.pinnedSessions);
  const archivedSessionsByProject = useSessionStore((s) => s.archivedSessionsByProject);
  const expandedProjects = useSessionStore((s) => s.expandedProjects);
  const expandedWorktrees = useSessionStore((s) => s.expandedWorktrees);
  const runningBySession = useSessionStore((s) => s.runningBySession);
  const runningTurnStartedAt = useSessionStore((s) => s.runningTurnStartedAt);
  const pendingQuestionBySession = useSessionStore((s) => s.pendingQuestionBySession);
  const turnErrorBySession = useSessionStore((s) => s.turnErrorBySession);
  const unreadBySession = useSessionStore((s) => s.unreadBySession);
  const pendingApprovals = useSessionStore((s) => s.pendingApprovals);
  const pendingPlanApprovalBySession = useSessionStore((s) => s.pendingPlanApprovalBySession);
  const worktreeInfoByRepo = useSessionStore((s) => s.worktreeInfoByRepo);
  const worktreeNames = useSessionStore((s) => s.worktreeNames);
  const gitChangeVersionByRepo = useSessionStore((s) => s.gitChangeVersionByRepo);
  const overrides = useSessionStore((s) => s.shortcutOverrides);
  const settingsOpen = useSessionStore((s) => s.settingsOpen);
  const canvasOpen = useSessionStore((s) => s.canvasOpen);
  const streamScope = useSessionStore((s) => s.streamScope);
  const streamDirty = useSessionStore((s) => s.streamDirty);
  const attention = useAttention();

  const setLeftOpen = useSessionStore((s) => s.setLeftOpen);
  const setSettingsOpen = useSessionStore((s) => s.setSettingsOpen);
  const setCanvasOpen = useSessionStore((s) => s.setCanvasOpen);
  const setStreamScope = useSessionStore((s) => s.setStreamScope);
  const loadStreamSessions = useSessionStore((s) => s.loadStreamSessions);
  const ensureWorktreeInfo = useSessionStore((s) => s.ensureWorktreeInfo);
  const toggleProjectExpanded = useSessionStore((s) => s.toggleProjectExpanded);
  const toggleWorktreeExpanded = useSessionStore((s) => s.toggleWorktreeExpanded);
  const loadMoreSessions = useSessionStore((s) => s.loadMoreSessions);
  const openTab = useSessionStore((s) => s.openTab);
  const startSession = useSessionStore((s) => s.startSession);
  const archiveSession = useSessionStore((s) => s.archiveSession);
  const deleteSession = useSessionStore((s) => s.deleteSession);
  const setSessionPinned = useSessionStore((s) => s.setSessionPinned);
  const renameSession = useSessionStore((s) => s.renameSession);
  const renameWorktree = useSessionStore((s) => s.renameWorktree);
  const archiveProject = useSessionStore((s) => s.archiveProject);
  const deleteProject = useSessionStore((s) => s.deleteProject);
  const addProject = useSessionStore((s) => s.addProjectFromFolder);
  const setProjectGroup = useSessionStore((s) => s.setProjectGroup);
  const renameProject = useSessionStore((s) => s.renameProject);
  const setProjectColor = useSessionStore((s) => s.setProjectColor);

  // The V3 scope filter is gone with the rail. A scope persisted by V3 would
  // silently narrow the global fallback cache below, so clear it once.
  useEffect(() => {
    if (streamScope != null) setStreamScope(null);
  }, [streamScope, setStreamScope]);

  // The aggregate (session.listAll) is no longer rendered, but it stays the
  // lookup fallback for sessions beyond a project's first page (palette /
  // phone / tab restore) — keep its first page warm exactly like V3 did.
  useEffect(() => {
    void loadStreamSessions();
  }, [streamDirty, loadStreamSessions]);

  useEffect(() => {
    for (const p of projects) void ensureWorktreeInfo(p.path);
  }, [projects, gitChangeVersionByRepo, ensureWorktreeInfo]);

  const liveProjects = useMemo(() => projects.filter((p) => !p.archived), [projects]);
  const projectById = useMemo(() => new Map(projects.map((p) => [p.id, p])), [projects]);
  const knownGroups = useMemo(() => {
    const set = new Set<string>();
    for (const p of liveProjects) if (p.group) set.add(p.group);
    return Array.from(set);
  }, [liveProjects]);

  // Ungrouped projects first, then each group (label + members), in the order
  // the store keeps them.
  const projectBlocks = useMemo(() => {
    const blocks: { group: string | null; items: Project[] }[] = [];
    const loose = liveProjects.filter((p) => !p.group);
    if (loose.length > 0) blocks.push({ group: null, items: loose });
    for (const g of knownGroups) blocks.push({ group: g, items: liveProjects.filter((p) => p.group === g) });
    return blocks;
  }, [liveProjects, knownGroups]);

  const approvalSessions = useMemo(() => {
    const set = new Set<string>();
    for (const a of pendingApprovals) set.add(a.sessionId);
    for (const id of Object.keys(pendingPlanApprovalBySession)) set.add(id);
    return set;
  }, [pendingApprovals, pendingPlanApprovalBySession]);

  const signals: StatusSignals = {
    runningBySession,
    runningTurnStartedAt,
    approvalSessions,
    pendingQuestionBySession,
    turnErrorBySession,
    unreadBySession,
  };

  // Live duration ticker — only ticks while something is running.
  const anyRunning = Object.values(runningBySession).some(Boolean);
  const [nowTick, setNowTick] = useState(() => Date.now());
  useEffect(() => {
    if (!anyRunning) return;
    const id = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(id);
  }, [anyRunning]);

  // Worktree row info (branch / dirty / merged) from the per-repo inventory;
  // null while the probe hasn't landed (the group header just omits it).
  const worktreeOf = useCallback(
    (s: Session): GitWorktreeInfo | null => {
      if (!s.worktreePath) return null;
      const proj = projectById.get(s.projectId);
      const info = proj ? worktreeInfoByRepo[proj.path] : undefined;
      if (!info) return null;
      const key = normWorktreeKey(s.worktreePath);
      return info.worktrees.find((w) => normWorktreeKey(w.path) === key) ?? null;
    },
    [projectById, worktreeInfoByRepo],
  );

  // Archive shelf — archived projects + archived sessions across projects.
  const { projects: archivedProjects, sessions: archivedList, count: archivedCount } = useMemo(
    () => selectArchiveShelf(projects, archivedSessionsByProject, null),
    [projects, archivedSessionsByProject],
  );
  const [archiveOpen, setArchiveOpen] = useState(false);

  // Dialogs / menus (same wiring the V3 stream view used).
  const [ctxMenu, setCtxMenu] = useState<{ session: Session; x: number; y: number } | null>(null);
  const [renaming, setRenaming] = useState<
    { id: string; title: string; kind: "session" | "project" | "worktree" | "group" } | null
  >(null);
  const [confirmDelete, setConfirmDelete] = useState<
    | { kind: "project"; id: string; name: string }
    | { kind: "session"; id: string; title: string }
    | null
  >(null);
  const [wtMerge, setWtMerge] = useState<{ repoPath: string; worktreePath: string } | null>(null);
  const [wtRemove, setWtRemove] = useState<{ repoPath: string; worktreePath: string } | null>(null);
  const [manageMenu, setManageMenu] = useState<ManageMenuState | null>(null);
  const manageAnchor = useCursorAnchor(manageMenu);
  const menuItemClass = cn(
    "flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs outline-none select-none",
    "text-content-muted data-[highlighted]:bg-surface-muted",
  );

  // Keep the active row in view when the selection moves (palette / tab / phone).
  const rowNodes = useRef<Map<string, HTMLElement>>(new Map());
  const registerNode = useCallback((id: string, el: HTMLElement | null) => {
    if (el) rowNodes.current.set(id, el);
    else rowNodes.current.delete(id);
  }, []);
  useEffect(() => {
    if (!activeSessionId) return;
    const raf = requestAnimationFrame(() => {
      rowNodes.current.get(activeSessionId)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    });
    return () => cancelAnimationFrame(raf);
  }, [activeSessionId, expandedProjects, expandedWorktrees]);

  const attentionTitles = useMemo(() => {
    const byId = new Map<string, string>();
    for (const list of Object.values(sessionsByProject)) for (const s of list) byId.set(s.id, s.title);
    for (const s of pinnedSessions) byId.set(s.id, s.title);
    return attention.map((a) => byId.get(a.sessionId)).filter((x): x is string => !!x);
  }, [attention, sessionsByProject, pinnedSessions]);

  const newAccel = resolveShortcut("session.new", overrides);
  const attentionAccel = resolveShortcut("session.next-attention", overrides);
  const collapseAccel = resolveShortcut("layout.toggle-left", overrides);
  const settingsAccel = resolveShortcut("view.settings", overrides);

  const targetProjectId = activeProjectId ?? liveProjects[0]?.id ?? null;
  const handleNew = () => {
    if (activeProjectId) void startSession();
    else if (targetProjectId) void startSession(targetProjectId);
  };

  const { effective: effectiveTheme } = useTheme();
  const toggleTheme = () => {
    const next = effectiveTheme === "dark" ? "light" : "dark";
    void api.theme.set({ theme: next }).then((s) => applyThemeClass(s.effective));
  };

  /** One thread row (shared by pinned / local / worktree rows). */
  const renderRow = (s: Session, pinned = false) => (
    <ThreadRow
      key={s.id}
      session={s}
      status={statusOf(s, signals)}
      now={nowTick}
      active={s.id === activeSessionId}
      pinned={pinned}
      onSelect={() => void openTab(s.id)}
      onArchive={() => void archiveSession(s.id, true)}
      onContext={(x, y) => setCtxMenu({ session: s, x, y })}
      registerNode={registerNode}
    />
  );

  /** A project: tinted tile header + (when expanded) its thread list hung on
   *  the guide line — pinned, local rows, load-more, then worktree groups. */
  const renderProject = (p: Project) => {
    const list = sessionsByProject[p.id] ?? EMPTY_SESSIONS;
    const live = list.filter((s) => !s.archived);
    const local = live.filter((s) => !s.worktreePath);
    const wtRows = live.filter((s) => s.worktreePath);
    const pinned = pinnedSessions.filter((s) => s.projectId === p.id && !s.archived);
    const expanded = !!expandedProjects[p.id];
    const total = (sessionsTotalByProject[p.id] ?? local.length) + wtRows.length + pinned.length;
    const hasMore = !!sessionsHasMoreByProject[p.id];
    const remaining = Math.max((sessionsTotalByProject[p.id] ?? local.length) - local.length, 0);

    // Collapsed projects still say whether something inside needs you.
    const all = [...pinned, ...live];
    const running = all.some((s) => runningBySession[s.id]);
    const waiting = attention.filter((a) => all.some((s) => s.id === a.sessionId)).length;
    const unread = all.some((s) => (unreadBySession[s.id] ?? 0) > 0);

    // Worktree rows grouped by checkout directory, newest group first.
    const groups = new Map<string, Session[]>();
    for (const s of wtRows) {
      const key = normWorktreeKey(s.worktreePath!);
      const arr = groups.get(key);
      if (arr) arr.push(s);
      else groups.set(key, [s]);
    }

    return (
      <section key={p.id} className="mb-0.5">
        <div className="group/ph relative">
          <button
            type="button"
            onClick={() => toggleProjectExpanded(p.id)}
            onContextMenu={(e) => {
              e.preventDefault();
              setManageMenu({ project: p, x: e.clientX, y: e.clientY });
            }}
            className="flex h-[34px] w-full items-center gap-2.5 rounded-lg px-2 text-left transition-colors hover:bg-surface-hover"
            title={p.path}
            aria-expanded={expanded}
          >
            <ProjectAvatar
              name={p.name}
              color={projectDisplayColor(p, projectColors)}
              size="sm"
              className="h-5 w-5 rounded-md text-[11px]"
            />
            <span className="min-w-0 truncate font-semibold text-content">{p.name}</span>
            <span className="shrink-0 text-[11.5px] tabular-nums text-content-subtle">{total}</span>
            {!expanded && running && (
              <IconLoader2 size={11} className="shrink-0 animate-spin text-accent" aria-label={t("layout.rail.running")} />
            )}
            {!expanded && waiting > 0 && (
              <span className="shrink-0 rounded-full bg-warning/15 px-1.5 text-[10.5px] font-semibold leading-4 text-warning">
                {waiting}
              </span>
            )}
            {!expanded && waiting === 0 && unread && (
              <i className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" aria-label={t("layout.rail.unread")} />
            )}
            <IconChevronDown
              size={13}
              className={cn(
                "ml-auto shrink-0 text-content-subtle transition-[opacity,transform]",
                expanded ? "opacity-0 group-hover/ph:opacity-100" : "-rotate-90",
              )}
            />
          </button>
          <Hint label={t("layout.newSessionHere")}>
            <button
              type="button"
              onClick={() => void startSession(p.id)}
              className="absolute right-7 top-1/2 hidden h-6 w-6 -translate-y-1/2 place-items-center rounded-md text-content-subtle hover:bg-surface-muted hover:text-content group-hover/ph:grid"
              aria-label={t("layout.newSessionHere")}
            >
              <IconPlus size={13} />
            </button>
          </Hint>
        </div>

        {expanded && (
          <div className="mb-1.5 ml-[18px] mt-px border-l border-edge-input pl-3">
            {pinned.map((s) => renderRow(s, true))}
            {local.map((s) => renderRow(s))}
            {hasMore && (
              <button
                type="button"
                onClick={() => void loadMoreSessions(p.id)}
                className="flex h-7 w-full items-center gap-1.5 rounded-lg px-2 text-left text-[12px] text-content-subtle transition-colors hover:bg-surface-hover hover:text-content"
              >
                <IconChevronDown size={12} className="shrink-0" />
                {t("layout.stream.showMore", { n: remaining })}
              </button>
            )}
            {[...groups.entries()].map(([key, rows]) => {
              const first = rows[0];
              const info = worktreeOf(first);
              const unmerged = info != null && (info.dirty || !info.merged);
              const label = info?.branch || worktreeDisplayName(first.worktreePath!, worktreeNames);
              const open = !!expandedWorktrees[key];
              return (
                <div key={key} className="mt-1.5">
                  <button
                    type="button"
                    onClick={() => toggleWorktreeExpanded(first.worktreePath!)}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      setCtxMenu({ session: first, x: e.clientX, y: e.clientY });
                    }}
                    className="flex h-6 w-full items-center gap-1.5 rounded-md px-2 text-left text-content-subtle transition-colors hover:text-content"
                    title={first.worktreePath ?? undefined}
                    aria-expanded={open}
                  >
                    <IconGitFork size={11} className="shrink-0" aria-label={t("layout.stream.worktree")} />
                    <span className="min-w-0 truncate font-mono text-[11px]">{label}</span>
                    {unmerged && (
                      <span className="shrink-0 text-[11px] font-semibold text-warning">{t("layout.stream.unmerged")}</span>
                    )}
                    <IconChevronRight
                      size={11}
                      className={cn("ml-auto shrink-0 transition-transform", open && "rotate-90")}
                    />
                  </button>
                  {open && rows.map((s) => renderRow(s))}
                </div>
              );
            })}
            {local.length === 0 && pinned.length === 0 && wtRows.length === 0 && !hasMore && (
              <div className="px-2 py-1.5 text-[12px] text-content-subtle">{t("layout.stream.empty")}</div>
            )}
          </div>
        )}
      </section>
    );
  };

  return (
    <div className="flex h-full flex-col [font-size:var(--right-panel-font-size)]">
      {/* mac: keep the traffic-light band clear (and draggable). */}
      {isMac && <div className="h-7 shrink-0" style={DRAG} aria-hidden />}

      {/* Brand + collapse. The band is a window drag handle. */}
      <div className="flex h-10 shrink-0 items-center gap-2 pl-3.5 pr-2" style={DRAG}>
        <BrandLogo size={20} />
        <span className="text-[13.5px] font-bold tracking-[-0.01em] text-content">MarioCode</span>
        <span className="flex-1" />
        <Hint label={t("layout.hideLeftPanel") + (collapseAccel ? ` (${acceleratorToDisplayString(collapseAccel)})` : "")}>
          <button
            type="button"
            onClick={() => setLeftOpen(false)}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-content-subtle transition-colors hover:bg-surface-hover hover:text-content"
            style={NO_DRAG}
          >
            <IconLayoutSidebarLeftCollapse size={17} />
          </button>
        </Hint>
      </div>

      {/* 新会话 — the white, hairline-bordered card button. */}
      <div className="shrink-0 px-2.5 pb-2.5 pt-0.5">
        <button
          type="button"
          onClick={handleNew}
          disabled={targetProjectId == null}
          className={cn(
            "flex h-9 w-full items-center gap-2.5 rounded-[11px] border border-edge bg-surface px-3 text-[13.5px] font-semibold text-content shadow-sm transition-colors",
            "hover:border-edge-input disabled:cursor-not-allowed disabled:opacity-50",
          )}
        >
          <IconPlus size={15} className="shrink-0" />
          <span className="flex-1 text-left">{t("layout.sidebar.newSession")}</span>
          {newAccel && <Kbd keys={acceleratorToDisplayTokens(newAccel)} size="xs" />}
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2.5 pb-2">
        {attention.length > 0 && (
          <button
            type="button"
            onClick={jumpToNextAttention}
            title={attentionTitles.slice(0, 3).join("、") || t("lib.commands.nextAttention")}
            className="mb-2 flex h-7 w-full items-center gap-2 rounded-lg px-2.5 text-left text-[12px] text-warning transition-colors hover:bg-warning/[0.1]"
          >
            <IconBell size={13} className="shrink-0" />
            <span className="min-w-0 flex-1 truncate">{t("layout.stream.attentionTitle", { n: attention.length })}</span>
            {attentionAccel && <Kbd keys={acceleratorToDisplayTokens(attentionAccel)} size="xs" className="shrink-0" />}
          </button>
        )}

        {/* 项目 card */}
        <div className="mb-2.5 rounded-[14px] border border-edge bg-surface px-1.5 pb-2 pt-1">
          <div className="flex h-8 items-center px-2 pr-1">
            <span className="text-[11px] font-semibold tracking-[0.08em] text-content-subtle">{t("layout.sidebar.projects")}</span>
            <Hint label={t("layout.addProject")}>
              <button
                type="button"
                onClick={() => void addProject()}
                className="ml-auto grid h-[22px] w-[22px] place-items-center rounded-md text-content-subtle transition-colors hover:bg-surface-hover hover:text-content"
                aria-label={t("layout.addProject")}
              >
                <IconFolderPlus size={14} />
              </button>
            </Hint>
          </div>
          {liveProjects.length === 0 ? (
            <button
              type="button"
              onClick={() => void addProject()}
              className="mx-1 my-1 flex h-9 w-[calc(100%-8px)] items-center justify-center gap-2 rounded-lg border border-dashed border-edge-input text-content-muted transition-colors hover:bg-surface-hover"
            >
              <IconFolderPlus size={15} />
              {t("layout.addProject")}
            </button>
          ) : (
            projectBlocks.map((b) => (
              <div key={b.group ?? "__loose"}>
                {b.group && (
                  <div className="px-2 pb-0.5 pt-2 text-[11px] font-semibold text-content-subtle">{b.group}</div>
                )}
                {b.items.map(renderProject)}
              </div>
            ))
          )}
        </div>

        {/* Archive shelf — collapsed by default. */}
        {archivedCount > 0 && (
          <div className="mb-2.5">
            <button
              type="button"
              onClick={() => setArchiveOpen(!archiveOpen)}
              className="flex h-7 w-full items-center gap-1.5 rounded-lg px-3 text-left text-[12px] text-content-subtle transition-colors hover:bg-surface-hover hover:text-content-muted"
            >
              <IconChevronRight size={12} className={cn("shrink-0 transition-transform", archiveOpen && "rotate-90")} />
              {t("layout.archivedCount", { n: archivedCount })}
            </button>
            {archiveOpen && (
              <ul className="space-y-0.5 px-1">
                {archivedProjects.map((p) => (
                  <ArchivedRow
                    key={p.id}
                    icon={<ProjectAvatar name={p.name} color={projectDisplayColor(p, projectColors)} className="opacity-60" />}
                    title={p.name}
                    onRestore={() => void archiveProject(p.id, false)}
                    onDelete={() => setConfirmDelete({ kind: "project", id: p.id, name: p.name })}
                  />
                ))}
                {archivedList.map((s) => (
                  <ArchivedRow
                    key={s.id}
                    icon={<SessionModelAvatar session={s} className="opacity-60" />}
                    title={s.title}
                    subtitle={modelDisplayName(s.lastUsedModel) ?? undefined}
                    onRestore={() => void archiveSession(s.id, false)}
                    onDelete={() => setConfirmDelete({ kind: "session", id: s.id, title: s.title })}
                  />
                ))}
              </ul>
            )}
          </div>
        )}
      </div>

      {/* 工具 card — the V3 rail's lower cells, now labelled rows. */}
      <div className="shrink-0 px-2.5 pb-1.5">
        <div className="rounded-[14px] border border-edge bg-surface p-1">
          <button
            type="button"
            onClick={() => setSettingsOpen(true, "skills")}
            className={cn(SIDEBAR_NAV_ITEM, "text-content hover:bg-surface-hover")}
          >
            <IconBlocks size={16} className="shrink-0 text-content-muted" />
            <span className="flex-1 truncate text-left">{t("layout.sidebar.skills")}</span>
          </button>
          <button
            type="button"
            onClick={() => setCanvasOpen(!canvasOpen)}
            data-nav="canvas"
            className={cn(SIDEBAR_NAV_ITEM, "text-content hover:bg-surface-hover", canvasOpen && "bg-surface-hover font-semibold")}
          >
            <IconPalette size={16} className="shrink-0 text-content-muted" />
            <span className="flex-1 truncate text-left">{t("layout.sidebar.canvas")}</span>
          </button>
          <button
            type="button"
            onClick={() => setSettingsOpen(true, "scheduled-tasks")}
            className={cn(SIDEBAR_NAV_ITEM, "text-content hover:bg-surface-hover")}
          >
            <IconCalendar size={16} className="shrink-0 text-content-muted" />
            <span className="flex-1 truncate text-left">{t("layout.scheduledTasks")}</span>
          </button>
          <MobileConnectButton />
        </div>
      </div>

      {/* Footer: settings + quick light/dark. */}
      <div className="flex shrink-0 items-center gap-0.5 px-2.5 pb-2.5 pt-0.5">
        <Hint label={t("layout.settings") + (settingsAccel ? ` (${acceleratorToDisplayString(settingsAccel)})` : "")}>
          <button
            type="button"
            onClick={() => setSettingsOpen(!settingsOpen)}
            className={cn(
              "flex h-9 min-w-0 flex-1 items-center gap-2.5 rounded-[9px] px-2 text-left text-content transition-colors hover:bg-surface-hover",
              settingsOpen && "bg-surface-hover",
            )}
          >
            <IconSettings size={16} className="shrink-0 text-content-muted" />
            <span className="truncate font-medium">{t("layout.settings")}</span>
          </button>
        </Hint>
        <Hint label={effectiveTheme === "dark" ? t("layout.themeToLight") : t("layout.themeToDark")}>
          <button
            type="button"
            onClick={toggleTheme}
            className="grid h-9 w-9 shrink-0 place-items-center rounded-[9px] text-content-muted transition-colors hover:bg-surface-hover hover:text-content"
            aria-label={effectiveTheme === "dark" ? t("layout.themeToLight") : t("layout.themeToDark")}
          >
            {effectiveTheme === "dark" ? <IconSun size={16} /> : <IconMoon size={16} />}
          </button>
        </Hint>
      </div>

      {/* Shared dialogs / menus. */}
      <SessionContextMenu
        ctxMenu={ctxMenu}
        onClose={() => setCtxMenu(null)}
        onRename={(s) => { setCtxMenu(null); setRenaming({ id: s.id, title: s.title, kind: "session" }); }}
        onCopyTitle={(s) => { void navigator.clipboard.writeText(s.title); setCtxMenu(null); }}
        onFork={(s) => { setCtxMenu(null); useSessionStore.getState().openConversationAction({ sessionId: s.id, mode: "fork" }); }}
        onReference={(s) => { setCtxMenu(null); useSessionStore.getState().openConversationAction({ sessionId: s.id, mode: "reference" }); }}
        onOpenFolder={(s) => {
          setCtxMenu(null);
          const proj = projectById.get(s.projectId);
          if (proj) void api.shell.openPath({ path: proj.path });
        }}
        onTogglePin={(s) => { setCtxMenu(null); void setSessionPinned(s.id, s.pinnedAt == null); }}
        onNewWorktreeSession={(s) => {
          setCtxMenu(null);
          void startSession(s.projectId, { worktreePath: s.worktreePath ?? undefined });
        }}
        onMergeWorktree={(s) => {
          setCtxMenu(null);
          const proj = projectById.get(s.projectId);
          if (proj && s.worktreePath) setWtMerge({ repoPath: proj.path, worktreePath: s.worktreePath });
        }}
        onRenameWorktree={(s) => {
          setCtxMenu(null);
          if (s.worktreePath) setRenaming({ id: s.worktreePath, title: s.worktreePath.split(/[/\\]/).pop() ?? s.worktreePath, kind: "worktree" });
        }}
        onRemoveWorktree={(s) => {
          setCtxMenu(null);
          const proj = projectById.get(s.projectId);
          if (proj && s.worktreePath) setWtRemove({ repoPath: proj.path, worktreePath: s.worktreePath });
        }}
      />

      <WorktreeRemoveDialog
        open={!!wtRemove}
        onOpenChange={(o) => { if (!o) setWtRemove(null); }}
        repoPath={wtRemove?.repoPath ?? null}
        worktreePath={wtRemove?.worktreePath ?? ""}
      />
      <WorktreeMergeBackDialog
        open={!!wtMerge}
        onOpenChange={(o) => { if (!o) setWtMerge(null); }}
        sessionId={null}
        worktreePath={wtMerge?.worktreePath ?? ""}
        repoPath={wtMerge?.repoPath ?? null}
      />

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
        onArchive={(p) => { setManageMenu(null); void archiveProject(p.id, true); }}
        onDelete={(p) => { setManageMenu(null); setConfirmDelete({ kind: "project", id: p.id, name: p.name }); }}
        menuItemClass={menuItemClass}
      />

      <RenameDialog
        renaming={renaming}
        onClose={() => setRenaming(null)}
        onSubmit={async (id, title, kind) => {
          if (kind === "worktree") await renameWorktree(id, title);
          else if (kind === "project") await renameProject(id, title);
          else if (kind === "group") await setProjectGroup(id, title);
          else await renameSession(id, title);
          setRenaming(null);
        }}
      />

      <ConfirmDialog
        open={confirmDelete != null}
        danger
        title={confirmDelete?.kind === "project" ? t("layout.deleteProject") : t("layout.deleteThread")}
        description={
          confirmDelete?.kind === "project"
            ? t("layout.deleteProjectDesc", { name: confirmDelete.name })
            : t("layout.deleteThreadDesc", { title: confirmDelete?.title ?? "" })
        }
        confirmText={t("common.delete")}
        onOpenChange={(open) => { if (!open) setConfirmDelete(null); }}
        onConfirm={() => {
          if (!confirmDelete) return;
          if (confirmDelete.kind === "project") void deleteProject(confirmDelete.id);
          else void deleteSession(confirmDelete.id);
        }}
      />
    </div>
  );
}

export const ProjectSidebar = memo(ProjectSidebarBase);

/* ── One thread row ──
 *
 *   title ………………………………… status / time      (hover: archive)
 *
 * Status is inline on the right and never reorders rows: 运行中 + live
 * duration (accent), 待审批 / 在提问 (warning text), 出错 (danger text), unread
 * dot + time, else relative time. Hover swaps the status for an archive
 * button (running rows keep theirs — archiving a live turn is never a
 * one-click thing). The active row lights a 2px accent tick on the guide
 * line. The model brand is no longer drawn; it is in the tooltip. */
const ThreadRow = memo(function ThreadRow({
  session, status, now, active, pinned, onSelect, onArchive, onContext, registerNode,
}: {
  session: Session;
  status: RowStatus;
  now: number;
  active: boolean;
  pinned: boolean;
  onSelect: () => void;
  onArchive: () => void;
  onContext: (x: number, y: number) => void;
  registerNode: (id: string, el: HTMLElement | null) => void;
}) {
  const { t } = useI18n();
  const canArchive = status.kind !== "working";
  const lastModel = modelDisplayName(session.lastUsedModel);

  const label = (() => {
    switch (status.kind) {
      case "working":
        return (
          <span className="flex items-center gap-1 font-semibold tabular-nums text-accent-strong">
            <IconLoader2 size={11} className="animate-spin" />
            {formatRunningDuration(now - status.startedAt)}
          </span>
        );
      case "approval":
        return <span className="font-semibold text-warning">{t("layout.stream.statusApproval")}</span>;
      case "question":
        return <span className="font-semibold text-warning">{t("layout.stream.statusQuestion")}</span>;
      case "failed":
        return <span className="font-semibold text-danger">{t("layout.stream.statusFailed")}</span>;
      case "done":
        return (
          <span className="flex items-center gap-1.5 tabular-nums" title={t("layout.stream.statusDone")}>
            <i className="h-1.5 w-1.5 rounded-full bg-accent" aria-hidden />
            {formatRelativeTime(session.updatedAt)}
          </span>
        );
      default:
        return <span className="tabular-nums">{formatRelativeTime(session.updatedAt)}</span>;
    }
  })();

  return (
    <div
      ref={(el) => registerNode(session.id, el)}
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect();
        }
      }}
      onMouseEnter={() => void useSessionStore.getState().prefetchSessionMessages(session.id)}
      onContextMenu={(e) => {
        e.preventDefault();
        onContext(e.clientX, e.clientY);
      }}
      title={`${session.title}\n${lastModel ? `${t("layout.lastUsedModel", { model: lastModel })}\n` : ""}${formatFullTime(session.updatedAt)}`}
      className={cn(
        "group/row relative flex h-8 cursor-pointer items-center gap-2 rounded-lg px-2 transition-colors",
        active
          ? "bg-surface-hover font-semibold text-content before:absolute before:-left-[13px] before:bottom-2 before:top-2 before:w-0.5 before:rounded-full before:bg-accent"
          : "text-content-muted hover:bg-surface-hover hover:text-content",
      )}
    >
      {pinned && <IconPinnedFilled size={11} className="shrink-0 text-content-subtle" aria-label={t("layout.pinned")} />}
      <span className="min-w-0 flex-1 truncate text-[13px]">{session.title}</span>
      <span
        className={cn(
          "flex h-[18px] shrink-0 items-center text-[11.5px] font-normal text-content-subtle",
          canArchive && "group-hover/row:invisible",
        )}
      >
        {label}
      </span>
      {canArchive && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onArchive();
          }}
          title={t("layout.archive")}
          aria-label={t("layout.archive")}
          className="absolute right-1.5 top-1/2 hidden h-6 w-6 -translate-y-1/2 place-items-center rounded-md text-content-subtle hover:bg-surface-muted hover:text-content group-hover/row:grid"
        >
          <IconArchive size={14} />
        </button>
      )}
    </div>
  );
});
