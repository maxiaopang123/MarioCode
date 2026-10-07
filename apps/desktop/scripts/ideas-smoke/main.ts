import { app } from "electron";
import { strict as assert } from "node:assert";
import { initDb, closeDb } from "@main/store/db.js";
import { ProjectRepo, SessionRepo, MessageRepo } from "@main/store/repositories.js";
import { forkConversation, readConversationContext } from "@main/lib/sessionBranch.js";
import type { Session } from "@contracts/session";
import { mkdir, writeFile, symlink } from "node:fs/promises";
import { join } from "node:path";
import { FileSearchSchema } from "@contracts/ipc";
import { searchFilesGuarded } from "@main/ipc/files.js";
import { cachedTreeFiles } from "@main/lib/walkCache.js";

async function main(): Promise<void> {
app.setPath("userData", process.env.MARIOCODE_SMOKE_DATA!);
await app.whenReady();
try {
  const db = await initDb();
  ProjectRepo.create({ id: "project", name: "Test", path: app.getPath("userData"), archived: false, group: null, sortOrder: 0, pinnedAt: null, createdAt: 1, updatedAt: 1 });
  const session: Session = { id: "session", projectId: "project", providerId: "claude-sdk", claudeSessionId: null, kind: "chat", parentSessionId: null, title: "Test", status: "idle", model: "sonnet", effort: "default", permissionMode: "default", customModelId: null, archived: false, pinnedAt: null, contextSnapshot: null, todos: null, subagents: null, planDraft: null, usageHistory: null, turnFiles: null, bookmarks: null, subagentTranscripts: null, createdAt: 1, updatedAt: 1 };
  SessionRepo.create(session);
  assert.equal(SessionRepo.get(session.id)?.lastUsedModel, null);
  assert.equal(SessionRepo.recordUsedModel(session.id, "default"), false);
  assert.equal(SessionRepo.recordUsedModel(session.id, "claude-sonnet-4-6"), true);
  assert.equal(SessionRepo.recordUsedModel(session.id, "claude-sonnet-4-6"), false);
  SessionRepo.updateSettings(session.id, { model: "opus" });
  SessionRepo.setArchived(session.id, true);
  assert.equal(SessionRepo.listByProject("project", { archived: true })[0]?.lastUsedModel, "claude-sonnet-4-6");
  db.pragma("wal_checkpoint(FULL)");
  console.log("PASS: recent model persists independently of selection and archive");
  SessionRepo.setArchived(session.id, false);
  MessageRepo.replaceAll(session.id, [
    { id: "m1", sessionId: session.id, role: "user", content: { blocks: [{ kind: "text", text: "history-marker" }] }, createdAt: 1 },
    { id: "m2", sessionId: session.id, role: "assistant", content: { blocks: [{ kind: "text", text: "history-answer" }, { kind: "tool_use", toolName: "Read", result: "saved-tool-result" }] }, createdAt: 2 },
    { id: "m3", sessionId: session.id, role: "user", content: { blocks: [{ kind: "text", text: "excluded-later-message" }] }, createdAt: 3 },
  ]);
  const original = SessionRepo.get(session.id);
  const fork = forkConversation({ sessionId: session.id, messageId: "m2", title: "Fork" });
  assert.notEqual(fork.id, session.id);
  assert.equal(fork.claudeSessionId, null);
  assert.equal(fork.parentSessionId, null);
  assert.equal(fork.kind, "chat");
  assert.equal(fork.lastUsedModel, original?.lastUsedModel);
  assert.equal(fork.forkedFrom?.sessionId, session.id);
  assert.equal(MessageRepo.listBySession(fork.id).messages.length, 2);
  assert.ok(MessageRepo.listBySession(fork.id).messages.every(m => m.sessionId === fork.id && !["m1", "m2", "m3"].includes(m.id)));
  assert.ok(SessionRepo.forkSeed(fork.id)?.includes("history-marker"));
  assert.ok(!SessionRepo.forkSeed(fork.id)?.includes("excluded-later-message"));
  assert.deepEqual(SessionRepo.get(session.id), original);
  const context = readConversationContext({ sessionId: session.id, messageId: "m2" });
  assert.equal(context.messageCount, 2);
  assert.equal(context.sourceSessionId, session.id);
  assert.ok(context.content.includes("history-answer") && !context.content.includes("excluded-later-message"));
  assert.ok(context.content.includes("[Tool: Read]") && context.content.includes("saved-tool-result"));
  assert.throws(() => forkConversation({ sessionId: session.id, messageId: "missing" }));
  SessionRepo.updateStatus(session.id, "running");
  assert.throws(() => readConversationContext({ sessionId: session.id }, true));
  assert.ok(readConversationContext({ sessionId: session.id }).content.includes("history-marker"), "stale persisted running status cannot block an idle fork");
  SessionRepo.updateStatus(session.id, "idle");
  MessageRepo.replaceAll(fork.id, [{ id: "long", sessionId: fork.id, role: "assistant", content: { blocks: [{ kind: "text", text: "x".repeat(100000) + "end-marker" }] }, createdAt: 1 }]);
  const long = readConversationContext({ sessionId: fork.id });
  assert.ok(long.truncated && long.content.length < 81000 && long.content.includes("end-marker"));
  SessionRepo.delete(fork.id);
  assert.equal(SessionRepo.forkSeed(fork.id), undefined);
  assert.equal(MessageRepo.listBySession(session.id).messages.length, 3);
  console.log("PASS: fork range, independent ids, immutable source, bounded references and cascade cleanup");

  const root = join(app.getPath("userData"), "中文 项目");
  const folder = join(root, "素材 文件夹");
  const empty = join(root, "空目录.png");
  const outside = join(app.getPath("userData"), "outside");
  await mkdir(folder, { recursive: true }); await mkdir(empty); await mkdir(outside);
  await mkdir(join(root, "node_modules", "ignored-folder"), { recursive: true });
  await writeFile(join(folder, "说明 文件.md"), "file-content-must-not-be-injected");
  await writeFile(join(outside, "outside-secret.txt"), "outside");
  await symlink(outside, join(root, "linked-outside"), process.platform === "win32" ? "junction" : "dir");
  ProjectRepo.create({ id: "mentions", name: "中文 项目", path: root, archived: false, group: null, sortOrder: 0, pinnedAt: null, createdAt: 1, updatedAt: 1 });
  const initial = await searchFilesGuarded(FileSearchSchema.parse({ projectPath: root, includeDirectories: true, limit: 100 }));
  assert.ok(initial.files.some(f => f.path === root && f.isDirectory));
  assert.ok(initial.files.some(f => f.path === empty && f.isDirectory));
  assert.ok(initial.files.some(f => f.name === "说明 文件.md" && !f.isDirectory));
  assert.ok(!initial.files.some(f => /node_modules|linked-outside|outside-secret/.test(f.path)));
  const match = await searchFilesGuarded(FileSearchSchema.parse({ projectPath: root, query: "素材 文件夹", includeDirectories: true }));
  assert.equal(match.files[0]?.path, folder); assert.ok(match.files[0]?.isDirectory);
  assert.ok(match.files.every(f => !JSON.stringify(f).includes("file-content-must-not-be-injected")));
  const old = await searchFilesGuarded(FileSearchSchema.parse({ projectPath: root, query: "素材" }));
  assert.ok(old.files.every(f => !f.isDirectory)); assert.ok(old.files.some(f => f.name === "说明 文件.md"));
  const limited = await searchFilesGuarded({ projectPath: root, includeDirectories: true, limit: 1 });
  assert.equal(limited.files.length, 1); assert.ok(limited.truncated);
  assert.equal((await searchFilesGuarded({ projectPath: outside, includeDirectories: true })).files.length, 0);
  const keyCache1 = await cachedTreeFiles(root, new Set(["node_modules"]), true);
  const keyCache2 = await cachedTreeFiles(root, new Set(["node_modules"]), true);
  assert.strictEqual(keyCache1.files, keyCache2.files, "directory metadata is cached across queries");
  await mkdir(join(root, "新建 文件夹"));
  await new Promise(r => setTimeout(r, 150));
  const refreshed = await searchFilesGuarded({ projectPath: root, query: "新建", includeDirectories: true });
  assert.ok(refreshed.files.some(f => f.name === "新建 文件夹" && f.isDirectory), "filesystem changes invalidate cached folder results");
  const worktree = join(app.getPath("userData"), "工作树 路径");
  await mkdir(join(worktree, "树内 文件夹"), { recursive: true });
  SessionRepo.create({ ...session, id: "worktree", worktreePath: worktree });
  assert.ok((await searchFilesGuarded({ projectPath: worktree, query: "树内", includeDirectories: true })).files[0]?.isDirectory);
  console.log("PASS: files/folders/root, Chinese/spaces, empty image-suffix folder, legacy file search, bounded results, ignored/link guards, cache invalidation and registered worktree");
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  closeDb();
  app.exit(process.exitCode ?? 0);
}
}
void main();
