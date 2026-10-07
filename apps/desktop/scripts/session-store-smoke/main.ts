/**
 * Headless smoke for the renderer session store's `session.changed` reducer —
 * specifically the TWO-SECTION routing of the per-project thread cache
 * (local list / worktree-bound list, see splitSessionSections).
 *
 * Regression anchor: removing a git worktree degenerates every referencing
 * session back to local (main's `removeWorktree` PATCHes worktreePath=NULL and
 * broadcasts one `session.changed` per row). The reducer used to materialize
 * the degraded row at the head of the local section while leaving the stale
 * worktree-bound copy in place — the same id twice in one cache array. The
 * left bar buckets its tree by `session.worktreePath`, so the ghost row kept
 * the removed worktree's group on screen ("删除工作树后工作树还在").
 *
 * Run: scripts/session-store-smoke/run.sh
 */
import "./prelude.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import { normWorktreeKey } from "@renderer/lib/worktree.js";
import type { ContextSnapshot, Session } from "@contracts/session";
import type { SessionListEntry } from "@contracts/runtime";
import { runRegressionChecks } from "./regressions.js";
import { selectArchiveShelf } from "@renderer/lib/archiveScope.js";
import type { Project } from "@contracts/session";
import { api } from "@renderer/lib/api.js";

const PROJECT = "p1";
const WT_OLD = "D:\\proj\\.worktrees\\wt-1";
const WT_OTHER = "D:\\proj\\.worktrees\\wt-2";
const WT_NEW = "D:\\proj\\.worktrees\\wt-3";

let failures = 0;
let checks = 0;

function check(name: string, cond: boolean, detail?: unknown): void {
  checks++;
  if (cond) {
    console.log(`  ok   ${name}`);
    return;
  }
  failures++;
  console.log(`  FAIL ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
}

let seq = 0;
function mkSession(id: string, over: Partial<Session> = {}): Session {
  return {
    id,
    projectId: PROJECT,
    providerId: "claude-sdk",
    claudeSessionId: null,
    kind: "chat",
    parentSessionId: null,
    title: id,
    status: "idle",
    model: "default",
    effort: "default",
    permissionMode: "default",
    customModelId: null,
    archived: false,
    pinnedAt: null,
    contextSnapshot: null,
    todos: null,
    subagents: null,
    planDraft: null,
    usageHistory: null,
    turnFiles: null,
    bookmarks: null,
    subagentTranscripts: null,
    createdAt: 1,
    updatedAt: 1 + seq++,
    ...over,
  };
}

/** Mirror of main's `toSessionListEntry` — the wire row carries NO heavy
 *  payloads, which is exactly what makes the merge-over-cache path load-bearing. */
function toListEntry(s: Session): SessionListEntry {
  const {
    contextSnapshot: _cs,
    todos: _td,
    subagents: _sa,
    planDraft: _pd,
    usageHistory: _uh,
    turnFiles: _tf,
    bookmarks: _bm,
    subagentTranscripts: _st,
    ...entry
  } = s;
  return entry;
}

function ingest(session: Session | SessionListEntry): void {
  useSessionStore.getState().ingestEvent({
    type: "session.changed",
    sessionId: session.id,
    session: session as SessionListEntry,
  });
}

function cache(project = PROJECT): Session[] {
  return useSessionStore.getState().sessionsByProject[project] ?? [];
}

/** LeftBar's bucketing (components/layout/LeftBar.tsx) verbatim: the tree's
 *  worktree groups are derived from cached rows that still carry a path. */
function worktreeGroups(project = PROJECT): string[] {
  const keys = new Set<string>();
  for (const s of cache(project)) {
    if (s.worktreePath) keys.add(normWorktreeKey(s.worktreePath));
  }
  return [...keys];
}

function rowsOf(id: string, project = PROJECT): Session[] {
  return cache(project).filter((s) => s.id === id);
}

function seed(sessions: Session[], opts: { total?: number; worktreeView?: boolean } = {}): void {
  useSessionStore.setState({
    activeProjectId: PROJECT,
    activeSessionId: null,
    sessionsByProject: { [PROJECT]: sessions },
    sessions,
    sessionsTotalByProject: {
      [PROJECT]: opts.total ?? sessions.filter((s) => !s.worktreePath).length,
    },
    sessionsHasMoreByProject: { [PROJECT]: false },
    pinnedSessions: [],
    archivedSessionsByProject: {},
    worktreeViewByProject: opts.worktreeView ? { [PROJECT]: true } : {},
  });
}

// ── 1. Worktree removal degenerates its sessions back to local ────────────
console.log("\n[1] worktree removal → degraded local row");
{
  const snapshot = { used: 42, total: 200_000 } as unknown as ContextSnapshot;
  const wt = mkSession("wt1", { worktreePath: WT_OLD, contextSnapshot: snapshot });
  const local = mkSession("loc1");
  seed([local, wt], { total: 1 });

  ingest(toListEntry(mkSession("wt1", { worktreePath: null })));

  check("no duplicate row for the degraded session", rowsOf("wt1").length === 1, cache().map((s) => s.id));
  check("degraded row sits in the local section (prepended)", cache()[0]?.id === "wt1");
  check("degraded row lost its worktreePath", cache()[0]?.worktreePath == null);
  check("no stale worktree-bound row remains", cache().every((s) => !s.worktreePath));
  check("left-bar worktree group is gone", worktreeGroups().length === 0, worktreeGroups());
  check(
    "heavy payload survives the degradation (merged over the cached row)",
    cache()[0]?.contextSnapshot === snapshot,
  );
  check("local total grows by one", useSessionStore.getState().sessionsTotalByProject[PROJECT] === 2);
  check("derived `sessions` alias is refreshed", useSessionStore.getState().sessions[0]?.id === "wt1");
}

// ── 2. Degrading the LAST worktree row falls the view back to local ───────
console.log("\n[2] last worktree row degrades → view flip");
{
  seed([mkSession("loc1"), mkSession("wt1", { worktreePath: WT_OLD })], { total: 1, worktreeView: true });
  ingest(toListEntry(mkSession("wt1", { worktreePath: null })));
  check("worktree view flipped back to local", useSessionStore.getState().worktreeViewByProject[PROJECT] !== true);
}

// ── 3. A sibling worktree survives its neighbour's removal ────────────────
console.log("\n[3] one worktree removed, another untouched");
{
  seed(
    [
      mkSession("loc1"),
      mkSession("wt1", { worktreePath: WT_OLD }),
      mkSession("wt2", { worktreePath: WT_OTHER }),
    ],
    { total: 1, worktreeView: true },
  );
  ingest(toListEntry(mkSession("wt1", { worktreePath: null })));
  const groups = worktreeGroups();
  check("only the removed worktree's group disappears", groups.length === 1 && groups[0] === normWorktreeKey(WT_OTHER), groups);
  check("sibling row is still worktree-bound", rowsOf("wt2")[0]?.worktreePath === WT_OTHER);
  check("view stays in the fork view", useSessionStore.getState().worktreeViewByProject[PROJECT] === true);
}

// ── 4. Materialize (local → worktree) still moves the row out of local ────
console.log("\n[4] worktree materialize");
{
  seed([mkSession("loc1"), mkSession("loc2")], { total: 2 });
  ingest(toListEntry(mkSession("loc1", { worktreePath: WT_NEW })));
  check("no duplicate row after materialize", rowsOf("loc1").length === 1, cache().map((s) => s.id));
  check("row left the local section", cache().every((s) => s.id !== "loc1" || !!s.worktreePath));
  check("worktree group appears", worktreeGroups()[0] === normWorktreeKey(WT_NEW), worktreeGroups());
  check("local total shrinks back to one", useSessionStore.getState().sessionsTotalByProject[PROJECT] === 1);
}

// ── 5. Plain local update (rename / settings) keeps the row in place ──────
console.log("\n[5] local row update");
{
  const snapshot = { used: 7, total: 100 } as unknown as ContextSnapshot;
  seed([mkSession("loc1", { contextSnapshot: snapshot }), mkSession("loc2")], { total: 2 });
  ingest(toListEntry(mkSession("loc1", { title: "renamed" })));
  check("row is updated in place", rowsOf("loc1")[0]?.title === "renamed");
  check("row count unchanged", cache().length === 2);
  check("heavy payload preserved", rowsOf("loc1")[0]?.contextSnapshot === snapshot);
  check("local total unchanged", useSessionStore.getState().sessionsTotalByProject[PROJECT] === 2);
}

// ── 6. A session created on another client lands in the local section ─────
console.log("\n[6] remote-created local session");
{
  seed([mkSession("loc1")], { total: 1 });
  ingest(toListEntry(mkSession("brand-new")));
  check("new row prepended exactly once", rowsOf("brand-new").length === 1 && cache()[0]?.id === "brand-new");
  check("local total grows", useSessionStore.getState().sessionsTotalByProject[PROJECT] === 2);
}

// ── 7. Archiving a worktree row drops it from both sections ───────────────
console.log("\n[7] archive a worktree row");
{
  seed([mkSession("loc1"), mkSession("wt1", { worktreePath: WT_OLD })], { total: 1 });
  ingest(toListEntry(mkSession("wt1", { worktreePath: WT_OLD, archived: true })));
  check("archived row leaves the cache entirely", rowsOf("wt1").length === 0, cache().map((s) => s.id));
  check("no worktree group left behind", worktreeGroups().length === 0);
  check("sibling local row survives", rowsOf("loc1").length === 1);
}

// ── 8. Events for an unloaded project are ignored ────────────────────────
console.log("\n[8] unloaded project");
{
  seed([mkSession("loc1")], { total: 1 });
  ingest(toListEntry(mkSession("other", { projectId: "p2", worktreePath: WT_OLD })));
  check("no cache bucket materialized for p2", useSessionStore.getState().sessionsByProject["p2"] === undefined);
  check("p1 untouched", cache().length === 1);
}

{
  const used = mkSession("model-history", { model: "next-model", lastUsedModel: "claude-sonnet-4-6" });
  seed([used]);
  ingest(toListEntry({ ...used, model: "gpt-5.4" }));
  check("changing next model preserves last used model", rowsOf(used.id)[0]?.lastUsedModel === "claude-sonnet-4-6");
  useSessionStore.setState({ archivedSessionsByProject: { [PROJECT]: [{ ...used, archived: true, lastUsedModel: null }] } });
  ingest(toListEntry({ ...used, archived: true }));
  check("archived row retains last used model", useSessionStore.getState().archivedSessionsByProject[PROJECT]?.find(s => s.id === used.id)?.lastUsedModel === used.lastUsedModel);
}

await runRegressionChecks(check, mkSession);

{
  const project = (id: string, group: string | null, archived = false): Project => ({ id, name: id, path: `D:/${id}`, group, archived, pinnedAt: null, sortOrder: 0, createdAt: 1, updatedAt: 1 });
  const projects = [project("p1", "Team"), project("p2", "Team", true), project("p3", null)];
  const a = mkSession("a", { archived: true });
  const b = mkSession("b", { projectId: "p2", archived: true, worktreePath: WT_OLD });
  const c = mkSession("c", { projectId: "p3", archived: true });
  const buckets = { p1: [a, a], p2: [b], p3: [c] };
  for (const [scope, count] of [[null, 4], ["p1", 1], ["g:Team", 3], [`wt:${normWorktreeKey(WT_OLD)}`, 1], ["p3", 1], ["missing", 0]] as const) {
    const shelf = selectArchiveShelf(projects, buckets, scope);
    check(`archive scope ${scope} matches count and rows`, shelf.count === count && shelf.count === shelf.sessions.length + shelf.projects.length);
  }
  seed([mkSession("a")]);
  ingest(toListEntry(a));
  check("remote archive immediately enters unloaded archive shelf", useSessionStore.getState().archivedSessionsByProject[PROJECT]?.[0]?.id === "a");
  ingest(toListEntry(a));
  check("repeated archive event does not duplicate row", useSessionStore.getState().archivedSessionsByProject[PROJECT]?.length === 1);
  ingest(toListEntry({ ...a, archived: false }));
  check("remote restore removes archived row", (useSessionStore.getState().archivedSessionsByProject[PROJECT]?.length ?? 0) === 0);
}

{
  const source = mkSession("reference-source");
  const target = mkSession("reference-target");
  seed([source, target]);
  useSessionStore.setState({ historyLoadedBySession: { [target.id]: true }, chatContextQueueBySession: {}, activeSessionId: source.id });
  const originalSessionApi = api.session;
  Object.defineProperty(api, "session", { configurable: true, value: { context: async () => ({ sourceSessionId: source.id, sourceTitle: "Source", throughMessageId: "boundary", messageCount: 2, createdAt: 1, content: "historical-context", truncated: false }) } });
  try {
    await useSessionStore.getState().referenceConversation(source.id, target, "boundary");
    check("reference navigates to target without sending a turn", useSessionStore.getState().activeSessionId === target.id && !useSessionStore.getState().runningBySession[target.id]);
    const tags = useSessionStore.getState().drainChatContextQueue(target.id);
    check("reference carries source and selected boundary", tags[0]?.kind === "conversation" && tags[0]?.sourceSessionId === source.id && tags[0]?.sourceMessageId === "boundary");
    check("context queue is consumed once", useSessionStore.getState().drainChatContextQueue(target.id).length === 0);
    check("referencing a conversation into itself is rejected", await useSessionStore.getState().referenceConversation(source.id, source).then(() => false, () => true));
  } finally { Object.defineProperty(api, "session", { configurable: true, value: originalSessionApi }); }
}

{
  const { appendUniqueFileTags, makeFileTag, isImageFile, composePromptWithTags, restoreAttachmentTag } = await import("@renderer/lib/contentTag.js");
  const { findComposerTrigger } = await import("@renderer/lib/composerTrigger.js");
  const folder = makeFileTag("C:\\中文 项目\\空目录.png", undefined, true);
  check("image-suffix folders never load an image preview", !isImageFile(folder));
  const restoredFolder = restoreAttachmentTag("queued", { ...folder, attachmentKind: "file" });
  check("queue/history editing restores a folder without reading image bytes", restoredFolder.isDirectory === true && !isImageFile(restoredFolder));
  const reference = restoreAttachmentTag("ref", { preview: "source", content: "historical-context", contextSource: { sessionId: "source", messageId: "boundary" } });
  check("queue/history editing preserves context source and its reference format", reference.sourceMessageId === "boundary" && composePromptWithTags("", [reference]) === "historical-context");
  const tags = appendUniqueFileTags([folder], [{ path: "c:/中文 项目/空目录.png/", isDirectory: true }, { path: "C:\\中文 项目\\说明 文件.md", isDirectory: false }]);
  check("folder references deduplicate Windows slash and casing variants", tags.length === 2);
  const prompt = composePromptWithTags("请检查", tags);
  check("directory prompt preserves quoted Chinese/spaces and requests only relevant files", prompt.includes(JSON.stringify(folder.filePath)) && prompt.includes("Read relevant files") && prompt.includes("@C:\\中文 项目\\说明 文件.md"));
  useSessionStore.getState().saveComposerDraft("mention-draft", { text: "draft", html: "", tags });
  check("draft retains directory type and reference after switching chats", useSessionStore.getState().composerDraftBySession["mention-draft"]?.tags[0]?.isDirectory === true);
  useSessionStore.getState().clearComposerDraft("mention-draft");
  check("removing the draft clears directory references", !useSessionStore.getState().composerDraftBySession["mention-draft"]);
  check("active mention searches spaces in folder names", findComposerTrigger("@素材 文件夹", 7, [], 0)?.query === "素材 文件夹");
  check("fullwidth at sign opens the file/folder picker", findComposerTrigger("＠素材", 3, [], null)?.kind === "mention");
  check("email addresses do not open the picker", findComposerTrigger("name@example.com", 16, [], null) === null);
  check("newline closes an active mention", findComposerTrigger("@素材\n文本", 6, [], 0) === null);
  check("slash commands keep their token boundary", findComposerTrigger("/skill next", 11, [], null) === null);
  check("atomic command pills cannot open another picker", findComposerTrigger("/skill", 6, [[0, 6]], null) === null);
}

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) {
  console.error(`${failures} check(s) failed`);
  process.exit(1);
}
