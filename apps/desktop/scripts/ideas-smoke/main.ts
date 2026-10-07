import { app } from "electron";
import { strict as assert } from "node:assert";
import { initDb, closeDb } from "@main/store/db.js";
import { ProjectRepo, SessionRepo, MessageRepo } from "@main/store/repositories.js";
import { forkConversation, readConversationContext } from "@main/lib/sessionBranch.js";
import type { Session } from "@contracts/session";

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
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  closeDb();
  app.exit(process.exitCode ?? 0);
}
}
void main();
