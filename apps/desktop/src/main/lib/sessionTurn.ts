import type { Project, Session } from "@contracts/session";
import type { SendTurnInput } from "@contracts/ipc";
import { ProjectRepo, SessionRepo } from "@main/store/repositories.js";
import { runtimeManager } from "@main/claude/RuntimeManager.js";
import { broadcastSessionChanged } from "@main/lib/sessionSync.js";
import { log } from "@main/lib/logger.js";
import { createBranchedWorktree, createDetachedWorktree, nextWorktreeDir } from "@main/lib/worktreeOps.js";
import { stat } from "node:fs/promises";
import { join } from "node:path";

const materializing = new Map<string, Promise<string>>();

async function materializeWorktreeSession(session: Session, project: Project): Promise<string> {
  const hasGit = await stat(join(project.path, ".git")).then(() => true).catch(() => false);
  if (!hasGit) {
    log.warn(`worktree intent for session ${session.id} dropped — project root is not a git repo (${project.path}); running locally`);
    SessionRepo.updateSettings(session.id, { envMode: "local", wtStyle: null });
    broadcastSessionChanged(SessionRepo.get(session.id) ?? { ...session, envMode: "local" as const });
    return project.path;
  }
  const branchStyle = session.wtStyle === "branch";
  const target = await nextWorktreeDir(project.path, session.id, { branchStyle });
  const result = branchStyle
    ? await createBranchedWorktree(project.path, target)
    : await createDetachedWorktree(project.path, target);
  if (!result.ok) throw new Error(`创建隔离工作树失败:${result.error}`);
  SessionRepo.updateWorktreePath(session.id, target);
  broadcastSessionChanged(SessionRepo.get(session.id) ?? session);
  log.info(`worktree session materialized: ${session.id} -> ${target}`);
  return target;
}

export async function resolveSessionCwd(session: Session, project: Project): Promise<string> {
  if (session.envMode !== "worktree") return project.path;
  if (session.worktreePath) {
    const exists = await stat(session.worktreePath).then(() => true).catch(() => false);
    if (!exists) throw new Error(`会话的工作树目录已不存在:${session.worktreePath}(可能被手动删除)。请在 Git 面板清理后新建会话。`);
    return session.worktreePath;
  }
  const existing = materializing.get(session.id);
  if (existing) return existing;
  const pending = materializeWorktreeSession(session, project).finally(() => materializing.delete(session.id));
  materializing.set(session.id, pending);
  return pending;
}

/** Shared main-process path for renderer, mobile and scheduled turns. */
export async function executeSessionTurn(input: SendTurnInput): Promise<{ session: Session; isFirstMessage: boolean }> {
  const session = SessionRepo.get(input.sessionId);
  if (!session) throw new Error(`session not found: ${input.sessionId}`);
  const project = ProjectRepo.get(session.projectId);
  if (!project) throw new Error(`project not found for session ${input.sessionId}`);

  let updated = session;
  const placeholder = session.kind === "side" ? "Quick ask" : "New session";
  const isFirstMessage = session.title === placeholder && input.prompt.trim().length > 0;
  if (isFirstMessage) {
    const trimmed = input.prompt.trim();
    const title = trimmed.slice(0, 40) + (trimmed.length > 40 ? "…" : "");
    SessionRepo.updateTitle(session.id, title);
    updated = { ...updated, title };
    if (session.kind !== "side") broadcastSessionChanged(updated);
  }
  if (input.model !== undefined) updated = { ...updated, model: input.model };
  if (input.effort !== undefined) updated = { ...updated, effort: input.effort };
  if (input.permissionMode !== undefined) updated = { ...updated, permissionMode: input.permissionMode };
  if (input.customModelId !== undefined) updated = { ...updated, customModelId: input.customModelId };
  if (input.providerId !== undefined) updated = { ...updated, providerId: input.providerId };

  SessionRepo.updateStatus(session.id, "running");
  try {
    const cwd = await resolveSessionCwd(updated, project);
    if (updated.envMode === "worktree" && !updated.worktreePath) {
      updated = SessionRepo.get(session.id) ?? updated;
    }
    runtimeManager.bindSession(updated);
    await runtimeManager.sendTurn(updated, {
      prompt: input.prompt,
      cwd,
      skills: input.skills,
      images: input.images,
      userMessage: input.userMessage,
    });
    return { session: updated, isFirstMessage };
  } catch (error) {
    SessionRepo.updateStatus(session.id, "errored");
    throw error;
  }
}
