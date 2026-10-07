import { app } from "electron";
import { strict as assert } from "node:assert";
import { initDb, closeDb } from "@main/store/db.js";
import { ProjectRepo, SessionRepo } from "@main/store/repositories.js";
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
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  closeDb();
  app.exit(process.exitCode ?? 0);
}
}
void main();
