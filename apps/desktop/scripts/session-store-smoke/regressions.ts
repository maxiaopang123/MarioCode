/** Controlled response ordering for scope races, plus provider usage math. */
import type { Session, Project } from "@contracts/session";
import type { TurnUsageRecord } from "@contracts/runtime";
import type { SessionListAllInput } from "@contracts/ipc";
import { api } from "@renderer/lib/api.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import {
  normalizeSessionUsageHistory,
  sessionTokens,
  sessionCost,
  sessionCacheRate,
  sessionSpeed,
  turnCacheRate,
  cacheSparkline,
} from "@renderer/lib/sessionMetrics.js";

type Check = (name: string, cond: boolean, detail?: unknown) => void;
type ListResult = Awaited<ReturnType<typeof api.session.listAll>>;

export async function runRegressionChecks(
  check: Check,
  mkSession: (id: string, over?: Partial<Session>) => Session,
): Promise<void> {
  console.log("\n[9] scope switches with requests in flight");
  const requests: { input: SessionListAllInput; resolve: (value: ListResult) => void }[] = [];
  const originalSession = api.session;
  Object.defineProperty(api, "session", {
    configurable: true,
    value: {
      listAll: (input: SessionListAllInput): Promise<ListResult> => new Promise((resolve) => {
        requests.push({ input, resolve });
      }),
    },
  });
  const projects: Project[] = ["a", "b", "c"].map((id) => ({
    id, name: id, path: `D:/scope-${id}`, archived: false,
    sortOrder: 0, pinnedAt: null, createdAt: 1, updatedAt: 1,
  }));
  const row = (projectId: string) => mkSession(`${projectId}-session`, { projectId });
  const result = (projectId: string, hasMore = false): ListResult => ({
    sessions: [row(projectId)], hasMore, total: hasMore ? 2 : 1,
  });
  try {
    useSessionStore.setState({ projects, streamScope: "a", streamDirty: true, streamSessions: [row("a")], streamHasMore: true, streamTotal: 2 });
    const first = useSessionStore.getState().loadStreamSessions();
    useSessionStore.getState().setStreamScope("b");
    check("scope change clears old rows and pagination", useSessionStore.getState().streamSessions.length === 0 && !useSessionStore.getState().streamHasMore && useSessionStore.getState().streamTotal === 0);
    // Simulate the sidebar effect on each scope change, even while dirty.
    const second = useSessionStore.getState().loadStreamSessions();
    useSessionStore.getState().setStreamScope("c");
    const third = useSessionStore.getState().loadStreamSessions();
    check("each request uses its selected project", requests.map((r) => r.input.projectIds?.[0]).join() === "a,b,c");
    requests[2]!.resolve(result("c", true));
    await third;
    requests[1]!.resolve(result("b"));
    await second;
    requests[0]!.resolve(result("a"));
    await first;
    check("late A/B results cannot replace C", useSessionStore.getState().streamSessions[0]?.projectId === "c" && !useSessionStore.getState().streamDirty);

    const more = useSessionStore.getState().loadMoreStreamSessions();
    useSessionStore.getState().setStreamScope(null);
    requests[3]!.resolve(result("c"));
    await more;
    check("old page cannot append after scope switch", useSessionStore.getState().streamSessions.length === 0 && useSessionStore.getState().streamDirty);
    const all = useSessionStore.getState().loadStreamSessions();
    check("all-project scope removes project filters", requests[4]!.input.projectIds === undefined);
    requests[4]!.resolve({ sessions: projects.map((p) => row(p.id)), hasMore: true, total: 6 });
    await all;
    check("new scope replaces rather than appends old rows", useSessionStore.getState().streamSessions.length === 3);
    useSessionStore.setState({ streamDirty: true });
    const before = requests.length;
    await useSessionStore.getState().loadMoreStreamSessions();
    check("pagination waits for dirty first page", requests.length === before);

    useSessionStore.getState().setStreamScope("wt:isolated");
    const worktree = useSessionStore.getState().loadStreamSessions();
    check("worktree request uses worktree filter", requests[5]!.input.worktreeKey === "isolated");
    requests[5]!.resolve({ sessions: [], hasMore: false, total: 0 });
    await worktree;
    check("empty scope settles cleanly", !useSessionStore.getState().streamDirty && useSessionStore.getState().streamSessions.length === 0);
    useSessionStore.setState({ projects: [{ ...projects[0]!, archived: true, group: "archived-team" }] });
    useSessionStore.getState().setStreamScope("a");
    const archivedProject = useSessionStore.getState().loadStreamSessions();
    check("archiving selected project never widens to all projects", requests[6]!.input.projectIds?.join() === "a");
    requests[6]!.resolve({ sessions: [], hasMore: false, total: 0 });
    await archivedProject;
    useSessionStore.getState().setStreamScope("g:archived-team");
    const archivedGroup = useSessionStore.getState().loadStreamSessions();
    check("archived-only group retains its project filter", requests[7]!.input.projectIds?.join() === "a");
    requests[7]!.resolve({ sessions: [], hasMore: false, total: 0 });
    await archivedGroup;
  } finally {
    Object.defineProperty(api, "session", { configurable: true, value: originalSession });
  }

  console.log("\n[10] Pi cumulative usage and per-turn providers");
  const history: TurnUsageRecord[] = [
    { endedAt: 1, durationMs: 1000, totalProcessedTokens: 1100, outputTokens: 100, cacheReadTokens: 0, cacheCreationTokens: 100, costUsd: 1, usedTokens: 1000, subagentTokens: 7 },
    { endedAt: 2, durationMs: 1000, totalProcessedTokens: 2200, outputTokens: 200, cacheReadTokens: 1000, cacheCreationTokens: 100, costUsd: 2, usedTokens: 1500, subagentTokens: 3 },
  ];
  const gens = [{ endedAt: 1, genMs: 1000 }, { endedAt: 2, genMs: 1000 }];
  const normalized = normalizeSessionUsageHistory(history, true);
  check("Pi total counts each token and subagent increment once", sessionTokens(normalized) === 2210);
  check("Pi cost uses increments", sessionCost(normalized) === 2);
  check("Pi average output speed excludes earlier outputs", sessionSpeed(normalized, gens) === 100);
  check("Pi average cache rate is token-weighted", sessionCacheRate(normalized) === 0.5);
  check("Pi last-turn cache is an increment", turnCacheRate(normalized[1]) === 1);
  check("Pi cache sparkline shows individual turns", cacheSparkline(normalized).map((x) => x.rate).join() === "0,1");
  check("occupancy and subagent counters remain unchanged", normalized[1]?.usedTokens === 1500 && normalized[1]?.subagentTokens === 3);
  check("normalization does not mutate persisted usage", history[1]?.outputTokens === 200 && history[1]?.totalProcessedTokens === 2200);
  check("Claude/Codex per-turn records keep their reference", normalizeSessionUsageHistory(history, false) === history);
  check("unmeasured turns contribute no speed tokens", sessionSpeed(normalized, [{ endedAt: 1, genMs: 0 }, gens[1]!]) === 100);
  check("reopened history pairs only measured recent turn", sessionSpeed(normalized, [gens[1]!]) === 100);
  const reversed = normalizeSessionUsageHistory([...history].reverse(), true);
  check("chronological increments preserve original record order", reversed[0]?.endedAt === 2 && reversed[0]?.outputTokens === 100 && reversed[1]?.endedAt === 1);
  const reset = normalizeSessionUsageHistory([history[1]!, { ...history[0]!, endedAt: 3, costUsd: undefined }], true);
  check("reset counters clamp instead of going negative", reset[1]?.totalProcessedTokens === 0 && reset[1]?.outputTokens === 0 && reset[1]?.cacheReadTokens === 0 && reset[1]?.cacheCreationTokens === 0);
  check("unknown cost remains unknown", reset[1]?.costUsd === undefined);
  check("empty history has no fabricated metrics", sessionCost([]) === null && sessionCacheRate([]) === null && sessionSpeed([], []) === null);
}
