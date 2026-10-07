/**
 * StreamSidebar — the session-first left-bar view ("stream" leftBarMode),
 * modeled on T3 Code's current sidebar (apps/web Sidebar.tsx):
 *
 *   [快捷入口: 新建会话 / 搜索 / 定时任务 / 插件与技能 / 连接手机]
 *      (SidebarQuickActions;新建会话在 scope 指向项目/工作树时改道到该处)
 *   [全部会话 | 按项目]        [全部项目 ▾]    (view switch + scope filter;
 *                                              the filter menu also adds projects)
 *   ── pinned cards ── hairline ── live cards ── (flat, each card carries
 *      its project identity + an inline status label; running rows recede)
 *   ── 已归档 shelf (collapsed) ──
 *
 * Key semantics (from the T3 source):
 *  - Status lives IN the row as a colored label — 运行中(sky)+live duration /
 *    等待输入(amber) / 失败(red) / 完成(accent, unseen) — and yields to the
 *    hover action cluster. Rows that need a human stand out; in-flight rows
 *    recede ("working threads aren't your problem yet").
 *  - Worktree is a ROW attribute, not a container: fork + mcode/* branch on
 *    the card's meta line, unmerged dot beside it; the directory-level
 *    actions (merge back / rename / remove / new sibling) live on the row's
 *    context menu (shared SessionContextMenu's worktree group).
 *  - The tree view stays fully responsible for project management; the scope
 *    dropdown only FILTERS (plus an "add project" entry).
 *
 * Data: the same store buckets the tree reads — pinnedSessions for the
 * pinned block, the streamSessions aggregate (session.listAll) for the live
 * list, archivedSessionsByProject for the shelf. Mutations mark streamDirty
 * and this view refetches its first page (see sessionStore).
 */
import { Fragment, memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Menu } from "@base-ui/react/menu";
import {
  IconArchive,
  IconBell,
  IconCheck,
  IconChevronDown,
  IconChevronRight,
  IconDots,
  IconEdit,
  IconFolder,
  IconFolderPlus,
  IconGitBranch,
  IconGitFork,
  IconLayoutSidebarLeftCollapse,
  IconLoader2,
  IconMessages,
  IconSearch,
} from "@renderer/lib/icons.js";
import { cn } from "@renderer/lib/cn.js";
import { isMac } from "@renderer/lib/platform.js";
import { modelDisplayName } from "@renderer/lib/modelAvatar.js";
import { selectArchiveShelf } from "@renderer/lib/archiveScope.js";
import { projectDisplayColor } from "@renderer/lib/projectAvatar.js";
import { formatRelativeTime, formatFullTime } from "@renderer/lib/time.js";
import { normWorktreeKey, worktreeDisplayName } from "@renderer/lib/worktree.js";
import { resolveShortcut, acceleratorToDisplayString, acceleratorToDisplayTokens } from "@renderer/lib/shortcuts.js";
import { jumpToNextAttention, useAttention } from "@renderer/lib/attention.js";
import { ConfirmDialog, Hint, Kbd } from "@renderer/components/ui/index.js";
import { api } from "@renderer/lib/api.js";
import { useCursorAnchor } from "@renderer/hooks/useCursorAnchor.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import { WorktreeMergeBackDialog, WorktreeRemoveDialog } from "@renderer/components/chat/WorktreeMergeBack.js";
import { ProjectManageMenuPopup, type ManageMenuState } from "./ProjectManageMenu.js";
import { ProjectAvatar } from "./ProjectAvatar.js";
import { SessionModelAvatar } from "./SessionModelAvatar.js";
import { findSession } from "./SessionTabs.js";
import {
  ArchivedRow,
  RenameDialog,
  SessionContextMenu,
} from "./SidebarShared.js";
import type { Project, Session } from "@contracts/session";
import type { GitWorktreeInfo } from "@contracts/ipc";
import { useI18n } from "@renderer/lib/i18n/index.js";

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

/* ── Card status model ── */

type StreamStatus =
  | { kind: "working"; startedAt: number }
  | { kind: "approval" }
  | { kind: "question" }
  | { kind: "failed" }
  | { kind: "done" }
  | { kind: "time" };

interface StreamStatusSignals {
  runningBySession: Record<string, boolean>;
  runningTurnStartedAt: Record<string, number>;
  /** Sessions with a pending tool OR plan approval. */
  approvalSessions: Set<string>;
  pendingQuestionBySession: Record<string, unknown>;
  turnErrorBySession: Record<string, boolean>;
  unreadBySession: Record<string, number>;
}

/** Row status. "Needs you" states outrank running: a turn paused on an
 *  approval / question is technically running but waits on the user, and
 *  that is what the row must say (界面焕新 v3). */
function statusOf(s: Session, sig: StreamStatusSignals): StreamStatus {
  if (sig.approvalSessions.has(s.id)) return { kind: "approval" };
  if (sig.pendingQuestionBySession[s.id] != null) return { kind: "question" };
  if (sig.runningBySession[s.id]) {
    return { kind: "working", startedAt: sig.runningTurnStartedAt[s.id] ?? Date.now() };
  }
  if (sig.turnErrorBySession[s.id]) return { kind: "failed" };
  if ((sig.unreadBySession[s.id] ?? 0) > 0) return { kind: "done" };
  return { kind: "time" };
}

/** Last two path segments ("…/Desktop/MarioCode") for the header subline. */
function shortPath(p: string): string {
  const parts = p.split(/[\\/]+/).filter(Boolean);
  return parts.length <= 2 ? p : `…/${parts.slice(-2).join("/")}`;
}

const DRAG = { WebkitAppRegion: "drag" } as React.CSSProperties;
const NO_DRAG = { WebkitAppRegion: "no-drag" } as React.CSSProperties;

/* ── The sidebar ── */

function StreamSidebarBase() {
  const { t } = useI18n();
  const projects = useSessionStore((s) => s.projects);
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const pinnedSessions = useSessionStore((s) => s.pinnedSessions);
  const streamSessions = useSessionStore((s) => s.streamSessions);
  const streamHasMore = useSessionStore((s) => s.streamHasMore);
  const streamTotal = useSessionStore((s) => s.streamTotal);
  const streamDirty = useSessionStore((s) => s.streamDirty);
  const streamScope = useSessionStore((s) => s.streamScope);
  const archivedSessionsByProject = useSessionStore((s) => s.archivedSessionsByProject);
  const runningBySession = useSessionStore((s) => s.runningBySession);
  const runningTurnStartedAt = useSessionStore((s) => s.runningTurnStartedAt);
  const pendingQuestionBySession = useSessionStore((s) => s.pendingQuestionBySession);
  const turnErrorBySession = useSessionStore((s) => s.turnErrorBySession);
  const unreadBySession = useSessionStore((s) => s.unreadBySession);
  const pendingApprovals = useSessionStore((s) => s.pendingApprovals);
  const pendingPlanApprovalBySession = useSessionStore((s) => s.pendingPlanApprovalBySession);
  const sessionsByProject = useSessionStore((s) => s.sessionsByProject);
  const activeProjectId = useSessionStore((s) => s.activeProjectId);
  const setLeftOpen = useSessionStore((s) => s.setLeftOpen);
  const setCommandPaletteOpen = useSessionStore((s) => s.setCommandPaletteOpen);
  const overrides = useSessionStore((s) => s.shortcutOverrides);
  const attention = useAttention();
  const worktreeInfoByRepo = useSessionStore((s) => s.worktreeInfoByRepo);
  const worktreeNames = useSessionStore((s) => s.worktreeNames);
  const projectColors = useSessionStore((s) => s.projectColors);
  const gitChangeVersionByRepo = useSessionStore((s) => s.gitChangeVersionByRepo);

  const loadStreamSessions = useSessionStore((s) => s.loadStreamSessions);
  const loadMoreStreamSessions = useSessionStore((s) => s.loadMoreStreamSessions);
  const ensureWorktreeInfo = useSessionStore((s) => s.ensureWorktreeInfo);
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

  // ── Data lifecycle. The aggregate refetches whenever the dirty flag is
  // set while this view is mounted (send / remote change / pin / archive…).
  // Warm+clean mounts are a no-op. Worktree inventories refresh per repo on
  // mount and whenever any repo's git version bumps.
  useEffect(() => {
    void loadStreamSessions();
  }, [streamScope, streamDirty, loadStreamSessions]);

  useEffect(() => {
    for (const p of projects) void ensureWorktreeInfo(p.path);
  }, [projects, gitChangeVersionByRepo, ensureWorktreeInfo]);

  // ── Project lookup + scope filter. Scope lives in the store (persisted
  // under `ui.streamScope`): null = 全部项目, "g:<name>" = a project group,
  // otherwise a projectId — so the last selected project is still selected
  // the next time the user enters the view.
  const projectById = useMemo(() => {
    const map = new Map<string, Project>();
    for (const p of projects) map.set(p.id, p);
    return map;
  }, [projects]);

  // Store action, aliased to the old local-setter name — every scope menu
  // row writes through it (persisting the choice for the next visit).
  const setScope = useSessionStore((s) => s.setStreamScope);
  const [scopeOpen, setScopeOpen] = useState(false);
  // A persisted scope can go stale (project deleted / archived, group
  // dissolved) between write and read — degrade those to the unfiltered
  // view instead of an empty list. Reactive (not dropped at hydration)
  // because the project list lands AFTER the sidebar's first paint.
  // Worktree scopes pass through: their matcher is safe and the inventory
  // probe may simply not have landed yet.
  const scope = useMemo(() => {
    if (streamScope == null) return null;
    if (streamScope.startsWith("g:")) {
      const name = streamScope.slice(2);
      return projects.some((p) => p.group === name) ? streamScope : null;
    }
    if (streamScope.startsWith("wt:")) return streamScope;
    const project = projectById.get(streamScope);
    return project ? streamScope : null;
  }, [streamScope, projectById]);
  const scopeMatches = useCallback(
    (s: Session) => {
      if (scope == null) return true;
      if (scope.startsWith("g:")) return projectById.get(s.projectId)?.group === scope.slice(2);
      // "wt:<normWorktreeKey>" — sessions bound to that isolated checkout.
      if (scope.startsWith("wt:")) {
        return s.worktreePath != null && normWorktreeKey(s.worktreePath) === scope.slice(3);
      }
      return s.projectId === scope;
    },
    [scope, projectById],
  );

  // Project → its selectable worktrees (non-main, non-missing entries from
  // the per-repo inventory; empty while the probe hasn't landed). Shared by
  // the scope menu rows, the trigger label, and the quick-action override.
  const worktreesByProject = useMemo(() => {
    const map = new Map<
      string,
      { key: string; name: string; path: string; referencedBy: number }[]
    >();
    for (const p of projects) {
      const info = worktreeInfoByRepo[p.path];
      if (!info) continue;
      const wts = info.worktrees
        .filter((w) => !w.main && !w.missing)
        .map((w) => ({
          key: normWorktreeKey(w.path),
          name: worktreeDisplayName(w.path, worktreeNames),
          path: w.path,
          referencedBy: w.referencedBy,
        }));
      if (wts.length > 0) map.set(p.id, wts);
    }
    return map;
  }, [projects, worktreeInfoByRepo, worktreeNames]);

  // The worktree the scope currently points at, if it can host a new
  // session: the main-side bind validation only accepts MANAGED checkout
  // paths (referenced by at least one existing session), so a foreign /
  // orphaned worktree scope falls back to the default new-session behavior.
  const scopedWorktree = useMemo(() => {
    if (!scope?.startsWith("wt:")) return null;
    const key = scope.slice(3);
    for (const [projectId, wts] of worktreesByProject) {
      const hit = wts.find((w) => w.key === key);
      if (hit) return hit.referencedBy > 0 ? { projectId, path: hit.path } : null;
    }
    return null;
  }, [scope, worktreesByProject]);

  // The plain project the scope points at, if any (group / worktree / null
  // scopes don't single one out). The 新建会话 quick action spawns the new
  // thread HERE instead of the active project — the user filtered to this
  // project, so that's where "new session" should land.
  const scopedProjectId =
    scope != null && !scope.startsWith("g:") && !scope.startsWith("wt:") ? scope : null;

  const scopeLabel = useMemo(() => {
    if (scope == null) return t("layout.stream.scopeAll");
    if (scope.startsWith("g:")) return scope.slice(2);
    if (scope.startsWith("wt:")) {
      const key = scope.slice(3);
      for (const wts of worktreesByProject.values()) {
        const hit = wts.find((w) => w.key === key);
        if (hit) return hit.name;
      }
      // Inventory probe not landed (or raced): fall back to any cached
      // session row bound to that checkout before giving up.
      const bound = useSessionStore
        .getState()
        .streamSessions.find((x) => x.worktreePath && normWorktreeKey(x.worktreePath) === key);
      if (bound?.worktreePath) return worktreeDisplayName(bound.worktreePath, worktreeNames);
      return t("layout.stream.scopeWorktree");
    }
    return projectById.get(scope)?.name ?? t("layout.stream.scopeAll");
  }, [scope, worktreesByProject, worktreeNames, t]);

  const knownGroups = useMemo(() => {
    const set = new Set<string>();
    for (const p of projects) if (!p.archived && p.group) set.add(p.group);
    return Array.from(set);
  }, [projects]);

  // Worktree row info (branch / dirty / merged), resolved from the per-repo
  // inventory; null while the probe hasn't landed yet (chip/dot simply hide).
  const worktreeOf = useCallback(
    (s: Session): GitWorktreeInfo | null => {
      if (!s.worktreePath) return null;
      const proj = projectById.get(s.projectId);
      if (!proj) return null;
      const info = worktreeInfoByRepo[proj.path];
      if (!info) return null;
      const key = normWorktreeKey(s.worktreePath);
      return info.worktrees.find((w) => normWorktreeKey(w.path) === key) ?? null;
    },
    [projectById, worktreeInfoByRepo],
  );

  // Local sessions show the PROJECT ROOT's checked-out branch in the meta
  // line (the main worktree's branch; detached HEAD degrades to the short
  // SHA). null while the probe hasn't landed or the project isn't a git
  // repo — the slot simply stays empty, same as worktree chips.
  const localBranchOf = useCallback(
    (s: Session): string | null => {
      if (s.worktreePath) return null;
      const proj = projectById.get(s.projectId);
      if (!proj) return null;
      const info = worktreeInfoByRepo[proj.path];
      if (!info) return null;
      const main = info.worktrees.find((w) => w.main);
      if (!main) return null;
      return main.branch || (main.head ? main.head.slice(0, 7) : null);
    },
    [projectById, worktreeInfoByRepo],
  );

  // ── Live duration ticker: only ticks while something is running.
  const anyRunning = streamSessions.some((s) => runningBySession[s.id]) ||
    pinnedSessions.some((s) => runningBySession[s.id]);
  const [nowTick, setNowTick] = useState(() => Date.now());
  useEffect(() => {
    if (!anyRunning) return;
    const id = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(id);
  }, [anyRunning]);

  const approvalSessions = useMemo(() => {
    const set = new Set<string>();
    for (const a of pendingApprovals) set.add(a.sessionId);
    for (const id of Object.keys(pendingPlanApprovalBySession)) set.add(id);
    return set;
  }, [pendingApprovals, pendingPlanApprovalBySession]);

  const statusSignals: StreamStatusSignals = {
    runningBySession,
    runningTurnStartedAt,
    approvalSessions,
    pendingQuestionBySession,
    turnErrorBySession,
    unreadBySession,
  };

  // ── Archive shelf content: archived projects + archived sessions
  // (flattened across projects, newest first), matching the tree's bin.
  const { projects: archivedProjects, sessions: archivedList, count: archivedCount } = useMemo(
    () => selectArchiveShelf(projects, archivedSessionsByProject, scope),
    [projects, archivedSessionsByProject, scope],
  );
  const [archiveOpen, setArchiveOpen] = useState(false);

  // ── Dialogs / menus (same wiring as the tree view).
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

  // ── Project manage menu (⋯ icon on a scope-dropdown project row) — the
  // same light manager the composer chip shows: rename / group / color.
  const [manageMenu, setManageMenu] = useState<ManageMenuState | null>(null);
  const manageAnchor = useCursorAnchor(manageMenu);
  const openProjectManage = (p: Project, e: React.MouseEvent) => {
    e.stopPropagation();
    setScopeOpen(false);
    setManageMenu({ project: p, x: e.clientX, y: e.clientY });
  };

  // Row-end manage affordance on project rows: faintly visible always, full
  // strength on row hover (matches the chip). stopPropagation keeps the
  // click from switching scope; base-ui never sees it.
  const manageButton = (p: Project) => (
    <button
      type="button"
      onClick={(e) => openProjectManage(p, e)}
      className={cn(
        "-mr-1 flex h-4 w-4 shrink-0 items-center justify-center rounded text-content-subtle opacity-50 transition-opacity",
        "hover:bg-surface-hover hover:text-content group-hover:opacity-100",
      )}
      title={t("layout.projectManageIcon")}
    >
      <IconDots size={12} />
    </button>
  );

  // ── Scroll-to-active (flat version of the tree's locate logic): rows
  // register nodes; when the active row isn't mounted, load pages until it
  // appears (pinned rows are always mounted; archived ones need the shelf).
  const rowNodes = useRef<Map<string, HTMLLIElement>>(new Map());
  const locateVersion = useRef(0);
  const registerNode = useCallback((id: string, el: HTMLLIElement | null) => {
    if (el) rowNodes.current.set(id, el);
    else rowNodes.current.delete(id);
  }, []);

  const locateActiveSession = useCallback((center = false) => {
    const version = ++locateVersion.current;
    const initial = useSessionStore.getState();
    const id = initial.activeSessionId;
    if (!id) return;
    const active = findSession(initial.sessionsByProject, initial.pinnedSessions, initial.streamSessions, id);
    if (active && !scopeMatches(active)) return;
    const isCurrent = () => {
      const s = useSessionStore.getState();
      return version === locateVersion.current && s.activeSessionId === id && s.streamScope === initial.streamScope;
    };
    const waitForRows = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const tryScroll = () => {
      if (!isCurrent()) return false;
      const el = rowNodes.current.get(id);
      if (el) {
        el.scrollIntoView({ block: center ? "center" : "nearest", behavior: "smooth" });
        return true;
      }
      return false;
    };
    if (tryScroll()) return;
    void (async () => {
      await waitForRows();
      if (!isCurrent()) return;
      if (tryScroll()) return;
      const st = useSessionStore.getState();
      if (st.archivedSessionsByProject && Object.values(st.archivedSessionsByProject).some((l) => l.some((x) => x.id === id))) {
        setArchiveOpen(true);
        await waitForRows();
        await waitForRows();
        tryScroll();
        return;
      }
      for (;;) {
        const s = useSessionStore.getState();
        // A dirty stream needs its first page refreshed. loadMore returns
        // immediately in that state; repeatedly awaiting it starves IPC and
        // React commits, leaving the startup shell frozen with zero projects.
        if (!isCurrent() || s.streamDirty || !s.streamHasMore) break;
        const loaded = s.streamSessions.length;
        await s.loadMoreStreamSessions();
        // Let React mount the new rows and let pending IPC/timers run before
        // looking for the active row or requesting another page.
        await waitForRows();
        if (!isCurrent() || useSessionStore.getState().streamDirty) break;
        if (tryScroll()) break;
        // Failed, superseded or empty requests must end this attempt even
        // when hasMore still describes the previous successful page.
        if (useSessionStore.getState().streamSessions.length <= loaded) break;
      }
    })();
  }, [scopeMatches]);

  useEffect(() => {
    if (!activeSessionId) return;
    locateActiveSession();
    return () => { locateVersion.current++; };
  }, [activeSessionId, streamScope, streamDirty, locateActiveSession]);

  // ── Shared card renderer (pinned block + live list).
  const renderCard = useCallback(
    (s: Session, opts: { pinned: boolean }) => {
      const proj = projectById.get(s.projectId);
      const status = statusOf(s, statusSignals);
      const wt = worktreeOf(s);
      const unmerged = wt != null && (wt.dirty || !wt.merged);
      return (
        <StreamRow
          key={s.id}
          session={s}
          projectName={proj?.name ?? "?"}
          projectColor={proj ? projectDisplayColor(proj, projectColors) : "#6f7a76"}
          // A single-project scope already names the project in the header;
          // every other scope (all / group / worktree) tags each row.
          showProject={scopedProjectId == null}
          status={status}
          now={nowTick}
          active={s.id === activeSessionId}
          pinned={opts.pinned}
          worktreeBranch={wt?.branch || null}
          worktreeUnmerged={unmerged}
          localBranch={localBranchOf(s)}
          onSelect={() => void openTab(s.id)}
          onArchive={() => void archiveSession(s.id, true)}
          onContext={(x, y) => setCtxMenu({ session: s, x, y })}
          registerNode={registerNode}
        />
      );
    },
    // statusSignals fields are read inside; they're all store slices this
    // component subscribes to already, so the callback refreshes with them.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [projectById, projectColors, nowTick, activeSessionId, runningBySession, runningTurnStartedAt,
      approvalSessions, pendingQuestionBySession, turnErrorBySession, unreadBySession, worktreeOf,
      localBranchOf, scopedProjectId, openTab, archiveSession, registerNode],
  );

  const liveSessions = useMemo(
    () => streamSessions.filter(scopeMatches),
    [streamSessions, scopeMatches],
  );
  const pinnedList = useMemo(
    () => pinnedSessions.filter(scopeMatches),
    [pinnedSessions, scopeMatches],
  );

  // Pure time order, split at local midnight: 今天 / 更早. Status never
  // reorders rows (a row doesn't jump when it starts waiting) — it only
  // shows inline; the reminder bar above is what pulls attention.
  const { todayList, earlierList } = useMemo(() => {
    const midnight = new Date();
    midnight.setHours(0, 0, 0, 0);
    const cut = midnight.getTime();
    const today: Session[] = [];
    const earlier: Session[] = [];
    for (const s of liveSessions) (s.updatedAt >= cut ? today : earlier).push(s);
    return { todayList: today, earlierList: earlier };
  }, [liveSessions]);

  // Reminder bar: everything that waits on the user, across all projects
  // (the rail's badges break it down per project). Titles resolve through
  // every cached bucket; an unresolved id still counts.
  const attentionTitles = useMemo(
    () =>
      attention
        .map((a) => findSession(sessionsByProject, pinnedSessions, streamSessions, a.sessionId)?.title)
        .filter((x): x is string => !!x),
    [attention, sessionsByProject, pinnedSessions, streamSessions],
  );
  const attentionAccel = resolveShortcut("session.next-attention", overrides);
  const paletteAccel = resolveShortcut("command.palette", overrides);
  const collapseAccel = resolveShortcut("layout.toggle-left", overrides);

  // 新建: scoped to a managed worktree → that checkout; to a plain project →
  // that project; otherwise the active project.
  const canNew = scopedWorktree != null || scopedProjectId != null || activeProjectId != null;
  const handleNew = () => {
    if (scopedWorktree) void startSession(scopedWorktree.projectId, { worktreePath: scopedWorktree.path });
    else if (scopedProjectId) void startSession(scopedProjectId);
    else if (activeProjectId) void startSession();
  };
  const newAccel = resolveShortcut("session.new", overrides);

  // Header identity for the current scope.
  const scopedProject = scopedProjectId ? projectById.get(scopedProjectId) ?? null : null;
  const scopeCount = streamTotal + pinnedList.length;
  const scopeSub = scopedProject
    ? `${t("layout.stream.sessionCount", { n: scopeCount })} · ${shortPath(scopedProject.path)}`
    : scope == null
      ? `${t("layout.stream.projectCount", { n: projects.filter((p) => !p.archived).length })} · ${t("layout.stream.sessionCount", { n: scopeCount })}`
      : t("layout.stream.sessionCount", { n: scopeCount });

  const menuItemClass = cn(
    "flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs outline-none select-none",
    "text-content-muted data-[highlighted]:bg-surface-muted",
  );

  // Worktree filter rows nested under their owning project's entry
  // (`indentClass` deepens one level for grouped projects). Each row filters
  // sessions bound to that checkout.
  const renderWorktreeItems = (projectId: string, indentClass: string) => {
    const wts = worktreesByProject.get(projectId);
    if (!wts) return null;
    return wts.map((w) => (
      <Menu.Item
        key={w.key}
        className={cn(menuItemClass, indentClass)}
        onClick={() => setScope(`wt:${w.key}`)}
      >
        <IconGitFork size={12} className="shrink-0 text-accent/80" />
        <span className="min-w-0 flex-1 truncate" title={w.path}>
          {w.name}
        </span>
        {scope === `wt:${w.key}` && <IconCheck size={13} className="shrink-0 text-accent" />}
      </Menu.Item>
    ));
  };

  return (
    <div className="flex h-full flex-col [font-size:var(--right-panel-font-size)]">
      {/* mac: keep the traffic-light band clear (and draggable). */}
      {isMac && <div className="h-7 shrink-0" style={DRAG} aria-hidden />}

      {/* Header: scope identity (opens the scope menu) + 新建. The band is a
          window drag handle; the controls opt out. */}
      <div className="flex h-[52px] shrink-0 items-center gap-1.5 px-2.5" style={DRAG}>
        <Menu.Root open={scopeOpen} onOpenChange={setScopeOpen}>
          <Menu.Trigger
            className={cn(
              "flex h-10 min-w-0 flex-1 items-center gap-2 rounded-lg pl-1.5 pr-2 text-left transition-colors",
              "hover:bg-surface-hover",
              scopeOpen && "bg-surface-hover",
            )}
            style={NO_DRAG}
            title={t("layout.stream.switchScope")}
          >
            {scopedProject ? (
              <ProjectAvatar
                name={scopedProject.name}
                color={projectDisplayColor(scopedProject, projectColors)}
                size="md"
              />
            ) : (
              <span className="grid h-[22px] w-[22px] shrink-0 place-items-center rounded-md text-content-muted">
                {scope?.startsWith("wt:") ? (
                  <IconGitFork size={16} />
                ) : scope?.startsWith("g:") ? (
                  <IconFolder size={16} />
                ) : (
                  <IconMessages size={17} />
                )}
              </span>
            )}
            <span className="flex min-w-0 flex-1 flex-col leading-[1.3]">
              <span className="truncate text-[14px] font-semibold tracking-[-0.01em] text-content">
                {scopeLabel}
              </span>
              <span className="truncate text-[11.5px] text-content-subtle">{scopeSub}</span>
            </span>
            <IconChevronDown size={12} className="shrink-0 text-content-subtle" />
          </Menu.Trigger>
          <Menu.Portal>
            <Menu.Positioner align="start" sideOffset={4}>
              <Menu.Popup
                className={cn(
                  "z-50 min-w-[200px] origin-top-right rounded-md border border-edge bg-surface py-1 shadow-2xl",
                  "data-[ending-style]:scale-95 data-[ending-style]:opacity-0",
                  "data-[starting-style]:scale-95 data-[starting-style]:opacity-0",
                  "transition-[transform,opacity] duration-100",
                )}
              >
                <Menu.Item className={menuItemClass} onClick={() => setScope(null)}>
                  <IconFolder size={14} className="shrink-0" />
                  <span className="flex-1 truncate">{t("layout.stream.scopeAll")}</span>
                  {scope == null && <IconCheck size={13} className="shrink-0 text-accent" />}
                </Menu.Item>
                {projects
                  .filter((p) => !p.archived && !p.group)
                  .map((p) => (
                    <Fragment key={p.id}>
                      <Menu.Item
                        className={cn(menuItemClass, "group")}
                        onClick={() => setScope(p.id)}
                      >
                        <ProjectAvatar name={p.name} color={projectDisplayColor(p, projectColors)} />
                        <span className="flex-1 truncate">{p.name}</span>
                        {scope === p.id && <IconCheck size={13} className="shrink-0 text-accent" />}
                        {manageButton(p)}
                      </Menu.Item>
                      {renderWorktreeItems(p.id, "pl-7")}
                    </Fragment>
                  ))}
                {knownGroups.length > 0 && (
                  <>
                    <Menu.Separator className="my-1 h-px bg-edge" />
                    <div className="px-3 py-1 text-[11px] uppercase tracking-wide text-content-subtle">
                      {t("layout.stream.scopeGroupCap")}
                    </div>
                    {/* Each group stays directly selectable (filters the
                        whole group), with its member projects listed
                        indented beneath it as their own filter entries. */}
                    {knownGroups.map((g) => {
                      const members = projects.filter((p) => !p.archived && p.group === g);
                      return (
                        <Fragment key={g}>
                          <Menu.Item
                            className={menuItemClass}
                            onClick={() => setScope(`g:${g}`)}
                          >
                            <IconFolder size={14} className="shrink-0" />
                            <span className="flex-1 truncate">{g}</span>
                            {scope === `g:${g}` && <IconCheck size={13} className="shrink-0 text-accent" />}
                          </Menu.Item>
                          {members.map((p) => (
                            <Fragment key={p.id}>
                              <Menu.Item
                                className={cn(menuItemClass, "group", "pl-7")}
                                onClick={() => setScope(p.id)}
                              >
                                <ProjectAvatar name={p.name} color={projectDisplayColor(p, projectColors)} />
                                <span className="flex-1 truncate">{p.name}</span>
                                {scope === p.id && <IconCheck size={13} className="shrink-0 text-accent" />}
                                {manageButton(p)}
                              </Menu.Item>
                              {renderWorktreeItems(p.id, "pl-11")}
                            </Fragment>
                          ))}
                        </Fragment>
                      );
                    })}
                  </>
                )}
                <Menu.Separator className="my-1 h-px bg-edge" />
                <Menu.Item className={menuItemClass} onClick={() => void addProject()}>
                  <IconFolderPlus size={14} className="shrink-0 text-accent" />
                  {t("layout.addProject")}
                </Menu.Item>
              </Menu.Popup>
            </Menu.Positioner>
          </Menu.Portal>
        </Menu.Root>

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
        <Hint label={(scopedProjectId || scopedWorktree ? t("layout.newSessionHere") : t("layout.newSessionInProject")) + (newAccel ? ` (${acceleratorToDisplayString(newAccel)})` : "")}>
          <button
            type="button"
            onClick={handleNew}
            disabled={!canNew}
            className={cn(
              "flex h-[30px] shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg pl-2.5 pr-3 text-[12.5px] font-semibold transition-colors",
              "bg-primary text-primary-on shadow-sm hover:bg-primary-hover",
              "disabled:cursor-not-allowed disabled:opacity-50",
            )}
            style={NO_DRAG}
          >
            {scopedWorktree ? <IconGitFork size={14} /> : <IconEdit size={14} />}
            {t("layout.stream.new")}
          </button>
        </Hint>
      </div>

      {/* Tools: search (opens the Ctrl+K palette) + the 等你处理 reminder. */}
      <div className="flex shrink-0 flex-col gap-2.5 border-b border-edge px-3 pb-2.5 pt-0.5">
        <button
          type="button"
          onClick={() => setCommandPaletteOpen(true)}
          className={cn(
            "flex h-8 items-center gap-2 rounded-lg border border-edge bg-surface pl-2.5 pr-1.5 text-left text-[12.5px] text-content-subtle transition-colors",
            "hover:border-edge-input hover:text-content-muted",
          )}
        >
          <IconSearch size={14} className="shrink-0" />
          <span className="min-w-0 flex-1 truncate">{t("layout.stream.searchPlaceholder")}</span>
          {paletteAccel && <Kbd keys={acceleratorToDisplayTokens(paletteAccel)} size="xs" />}
        </button>
        {attention.length > 0 && (
          <button
            type="button"
            onClick={jumpToNextAttention}
            title={t("lib.commands.nextAttention")}
            className={cn(
              "flex items-center gap-2.5 rounded-[10px] py-2 pl-[9px] pr-2 text-left transition-colors",
              "bg-warning/[0.08] shadow-[inset_0_0_0_1px_rgb(var(--warning)/0.2)] hover:bg-warning/[0.13]",
            )}
          >
            <span className="grid h-[26px] w-[26px] shrink-0 place-items-center rounded-lg bg-warning/15 text-warning">
              <IconBell size={14} />
            </span>
            <span className="flex min-w-0 flex-1 flex-col leading-[1.35]">
              <span className="text-[12.5px] font-semibold text-content">
                {t("layout.stream.attentionTitle", { n: attention.length })}
              </span>
              {attentionTitles.length > 0 && (
                <span className="truncate text-[11.5px] text-content-subtle">
                  {attentionTitles.slice(0, 3).join("、")}
                </span>
              )}
            </span>
            {attentionAccel && <Kbd keys={acceleratorToDisplayTokens(attentionAccel)} size="xs" className="shrink-0" />}
          </button>
        )}
      </div>

      {/* List: 置顶 / 今天 / 更早 — pure time order within each. */}
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {liveSessions.length === 0 && pinnedList.length === 0 ? (
          <div className="px-2 py-8 text-center text-content-subtle [font-size:var(--rp-fs-sm)]">
            {t("layout.stream.empty")}
          </div>
        ) : (
          <ul className="flex flex-col gap-px">
            {pinnedList.length > 0 && <GroupLabel label={t("layout.pinned")} />}
            {pinnedList.map((s) => renderCard(s, { pinned: true }))}
            {todayList.length > 0 && <GroupLabel label={t("layout.stream.groupToday")} />}
            {todayList.map((s) => renderCard(s, { pinned: false }))}
            {earlierList.length > 0 && <GroupLabel label={t("layout.stream.groupEarlier")} />}
            {earlierList.map((s) => renderCard(s, { pinned: false }))}
            {streamHasMore && (
              <li>
                <button
                  onClick={() => void loadMoreStreamSessions()}
                  className={cn(
                    "flex w-full items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-left text-content-subtle transition-colors [font-size:var(--rp-fs-sm)]",
                    "hover:bg-surface-hover hover:text-content",
                  )}
                >
                  <IconChevronDown size={12} className="shrink-0" />
                  {t("layout.stream.showMore", {
                    // streamTotal counts the CURRENT scope's unpinned rows
                    // (the server filters by scope; pinned never counted) —
                    // so the remainder is total minus the loaded live rows.
                    n: Math.max(streamTotal - liveSessions.length, 0),
                  })}
                </button>
              </li>
            )}
          </ul>
        )}

        {/* Archive shelf — collapsed by default (the tree's bin contents). */}
        {archivedCount > 0 && (
          <div className="mt-2">
            <button
              onClick={() => setArchiveOpen(!archiveOpen)}
              className="mb-1 mt-2 flex w-full items-center gap-2 px-1.5 text-left"
            >
              <span className="[font-size:var(--rp-fs-sm)] font-medium text-content-subtle/70">
                {t("layout.archivedCount", { n: archivedCount })}
              </span>
              <span className="h-px flex-1 bg-edge/60" aria-hidden />
              <IconChevronRight
                size={12}
                className={cn(
                  "shrink-0 text-content-subtle/70 transition-transform",
                  archiveOpen && "rotate-90",
                )}
              />
            </button>
            {archiveOpen && (
              <ul className="space-y-0.5">
                {archivedProjects.map((p) => (
                  <ArchivedRow
                    key={p.id}
                    icon={<IconFolder size={14} className="opacity-60" />}
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


      {/* Session context menu — with the worktree action group wired to the
          same dialogs the tree uses. */}
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
          if (s.worktreePath) setRenaming({ id: s.worktreePath, title: s.worktreePath.split(/[/\\/]/).pop() ?? s.worktreePath, kind: "worktree" });
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

      {/* Project manage menu — opened from the ⋯ on a scope-dropdown
          project row; cursor-anchored, independent Menu.Root. */}
      <ProjectManageMenuPopup
        manageMenu={manageMenu}
        anchor={manageAnchor}
        knownGroups={knownGroups}
        projectColors={projectColors}
        onClose={() => setManageMenu(null)}
        onRename={(p) => setRenaming({ id: p.id, title: p.name, kind: "project" })}
        onLeaveGroup={(p) => void setProjectGroup(p.id, null)}
        onJoinGroup={(p, g) => void setProjectGroup(p.id, g)}
        onNewGroup={(p) => setRenaming({ id: p.id, title: "", kind: "group" })}
        onSetColor={(p, hex) => void setProjectColor(p.id, hex)}
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

export const StreamSidebar = memo(StreamSidebarBase);

/** 今天 / 更早 / 置顶 section label. */
function GroupLabel({ label }: { label: string }) {
  return (
    <li className="px-2.5 pb-1.5 pt-3.5 text-[11.5px] font-semibold text-content-subtle first:pt-2" aria-hidden>
      {label}
    </li>
  );
}

/* ── One session row (界面焕新 v3 ②):
 *
 *   [provider] title ……………………… status / time   (hover: archive)
 *              [project] · branch / worktree
 *
 * Status is inline and never reorders rows: 运行中 + live duration (accent),
 * 待审批 / 在提问 (amber tag), 出错 (red tag), unread dot + time, else time.
 * Hover swaps the time for an archive button (running rows keep theirs —
 * archiving a live turn is never a one-click thing). Pin / rename / worktree
 * actions stay on the right-click menu. */
function StreamRow({
  session, projectName, projectColor, showProject, status, now, active, pinned,
  worktreeBranch, worktreeUnmerged, localBranch, onSelect, onArchive, onContext, registerNode,
}: {
  session: Session;
  projectName: string;
  projectColor: string;
  /** Tag the row with its project (every scope except a single project). */
  showProject: boolean;
  status: StreamStatus;
  /** Ticker snapshot for the running duration; only advances while running. */
  now: number;
  active: boolean;
  pinned: boolean;
  /** Checked-out branch (null = detached or probe not landed). */
  worktreeBranch: string | null;
  /** dirty || !merged — the amber "work waiting to land" dot. */
  worktreeUnmerged: boolean;
  /** Project root's checked-out branch for LOCAL sessions. */
  localBranch: string | null;
  onSelect: () => void;
  onArchive: () => void;
  onContext: (x: number, y: number) => void;
  registerNode: (id: string, el: HTMLLIElement | null) => void;
}) {
  const { t } = useI18n();
  const canArchive = status.kind !== "working";
  const unread = status.kind === "done";

  const statusLabel = (() => {
    switch (status.kind) {
      case "working":
        return (
          <span className="flex items-center gap-1 font-semibold tabular-nums text-accent-strong">
            <IconLoader2 size={11} className="animate-spin" />
            {formatRunningDuration(now - status.startedAt)}
          </span>
        );
      case "approval":
        return (
          <span className="rounded-[5px] bg-warning/[0.13] px-1.5 text-[11px] font-semibold leading-[18px] text-warning">
            {t("layout.stream.statusApproval")}
          </span>
        );
      case "question":
        return (
          <span className="rounded-[5px] bg-warning/[0.13] px-1.5 text-[11px] font-semibold leading-[18px] text-warning">
            {t("layout.stream.statusQuestion")}
          </span>
        );
      case "failed":
        return (
          <span className="rounded-[5px] bg-danger/[0.11] px-1.5 text-[11px] font-semibold leading-[18px] text-danger">
            {t("layout.stream.statusFailed")}
          </span>
        );
      case "done":
        return (
          <span className="flex items-center gap-1.5 tabular-nums text-content-subtle" title={t("layout.stream.statusDone")}>
            <i className="h-1.5 w-1.5 rounded-full bg-accent" aria-hidden />
            {formatRelativeTime(session.updatedAt)}
          </span>
        );
      default:
        return <span className="tabular-nums text-content-subtle">{formatRelativeTime(session.updatedAt)}</span>;
    }
  })();

  // Sub line: project tag (multi-project scopes) + branch / worktree.
  const branchNode = session.worktreePath ? (
    <span className="flex min-w-0 items-center gap-1" title={session.worktreePath}>
      <IconGitFork size={11} className="shrink-0 text-content-subtle" aria-label={t("layout.stream.worktree")} />
      <span className="min-w-0 truncate font-mono text-[11px]">
        {worktreeBranch || session.worktreePath.split(/[/\\]/).pop()}
      </span>
      {worktreeUnmerged && (
        <span className="h-[5px] w-[5px] shrink-0 rounded-full bg-warning" title={t("layout.stream.unmerged")} aria-hidden />
      )}
    </span>
  ) : localBranch ? (
    <span className="flex min-w-0 items-center gap-1" title={localBranch}>
      <IconGitBranch size={11} className="shrink-0 text-content-subtle/80" />
      <span className="min-w-0 truncate font-mono text-[11px]">{localBranch}</span>
    </span>
  ) : null;
  const lastModel = modelDisplayName(session.lastUsedModel);
  const hasSub = showProject || branchNode != null || lastModel != null;

  return (
    <li
      ref={(el) => registerNode(session.id, el)}
      onClick={onSelect}
      onMouseEnter={() => void useSessionStore.getState().prefetchSessionMessages(session.id)}
      onContextMenu={(e) => {
        e.preventDefault();
        onContext(e.clientX, e.clientY);
      }}
      title={`${session.title}\n${lastModel ? `${t("layout.lastUsedModel", { model: lastModel })}\n` : ""}${formatFullTime(session.updatedAt)}`}
      className={cn(
        "group relative grid cursor-pointer grid-cols-[22px_minmax(0,1fr)_auto] items-center gap-x-2.5 gap-y-[3px] rounded-[10px] px-2.5 py-[9px] transition-colors",
        active ? "srow-active" : "hover:bg-surface-hover",
      )}
    >
      <span
        className={cn("grid h-[22px] w-[22px] place-items-center self-start", hasSub && "row-span-2")}
      >
        <SessionModelAvatar session={session} />
      </span>

      <span
        className={cn(
          "min-w-0 truncate",
          active || unread ? "font-medium text-content" : "text-content-muted",
        )}
      >
        {session.title}
      </span>

      <span
        className={cn(
          "flex h-[18px] shrink-0 items-center text-[11.5px]",
          canArchive && "group-hover:invisible",
        )}
      >
        {statusLabel}
      </span>

      {hasSub && (
        <span className="col-span-2 flex min-w-0 items-center gap-1.5 overflow-hidden whitespace-nowrap text-[12px] text-content-subtle">
          {showProject && (
            <>
              <ProjectAvatar name={projectName} color={projectColor} />
              <span className="min-w-0 max-w-[45%] shrink-0 truncate">{projectName}</span>
              {branchNode && <span className="shrink-0 text-content-subtle/60">·</span>}
            </>
          )}
          {branchNode}
          {lastModel && (
            <>
              {(showProject || branchNode) && <span className="shrink-0 text-content-subtle/60">·</span>}
              <span className="min-w-0 truncate" title={t("layout.lastUsedModel", { model: lastModel })}>
                {lastModel}
              </span>
            </>
          )}
          {pinned && <span className="sr-only">{t("layout.pinned")}</span>}
        </span>
      )}

      {canArchive && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onArchive();
          }}
          title={t("layout.archive")}
          aria-label={t("layout.archive")}
          className={cn(
            "absolute right-[7px] top-[7px] hidden h-6 w-6 place-items-center rounded-md text-content-subtle group-hover:grid",
            "bg-surface shadow-sm ring-1 ring-inset ring-edge hover:text-content",
          )}
        >
          <IconArchive size={14} />
        </button>
      )}
    </li>
  );
}
