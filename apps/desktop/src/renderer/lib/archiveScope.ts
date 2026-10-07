import type { Project, Session } from "@contracts/session";
import { normWorktreeKey } from "./worktree.js";

/** One selection drives both the archive shelf and its displayed count. */
export function selectArchiveShelf(projects: Project[], buckets: Record<string, Session[]>, scope: string | null) {
  const projectById = new Map(projects.map(p => [p.id, p]));
  const projectMatches = (p: Project) => scope == null || (scope.startsWith("g:") ? p.group === scope.slice(2) : p.id === scope);
  const archivedProjects = projects.filter(p => p.archived && projectMatches(p));
  const unique = new Map<string, Session>();
  for (const list of Object.values(buckets)) {
    for (const session of list) {
      const project = projectById.get(session.projectId);
      if (!project || !session.archived) continue;
      const matches = scope?.startsWith("wt:")
        ? session.worktreePath != null && normWorktreeKey(session.worktreePath) === scope.slice(3)
        : projectMatches(project);
      if (matches) unique.set(session.id, session);
    }
  }
  const archivedSessions = [...unique.values()].sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
  return { projects: archivedProjects, sessions: archivedSessions, count: archivedProjects.length + archivedSessions.length };
}
