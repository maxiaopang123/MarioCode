import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import Database from "better-sqlite3";
import { initDb, closeDb, getDb } from "../../src/main/store/db.js";
import { ClawBotConversationRepo, ClawBotInboxRepo, ClawBotOutboxRepo } from "../../src/main/store/repositories.js";

mkdirSync(process.env.CLAWBOT_STORE_SMOKE_DIR! + "/user-data", { recursive: true });
async function main(): Promise<void> {
// Emulate a pre-release preview DB whose legacy sender column was NOT NULL.
const preview = new Database(process.env.CLAWBOT_STORE_SMOKE_DIR! + "/user-data/claude-gui.db");
preview.exec(`
  CREATE TABLE clawbot_conversations (id TEXT PRIMARY KEY, account_id TEXT NOT NULL, peer_key TEXT NOT NULL,
    user_id_ciphertext TEXT NOT NULL, project_id TEXT, session_id TEXT, provider_id TEXT NOT NULL,
    model TEXT NOT NULL, permission_mode TEXT NOT NULL, state TEXT NOT NULL, created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL, UNIQUE(account_id, peer_key));
  CREATE TABLE clawbot_inbox (id TEXT PRIMARY KEY, account_id TEXT NOT NULL, external_message_id TEXT NOT NULL,
    peer_key TEXT NOT NULL, user_id_ciphertext TEXT NOT NULL, context_token_ciphertext TEXT,
    payload_ciphertext TEXT NOT NULL, conversation_id TEXT, status TEXT NOT NULL DEFAULT 'queued', attempt_count INTEGER NOT NULL DEFAULT 0,
    received_at INTEGER NOT NULL, claimed_at INTEGER, completed_at INTEGER, last_error TEXT,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE(account_id, external_message_id));
  CREATE TABLE clawbot_outbox (id TEXT PRIMARY KEY, inbox_id TEXT NOT NULL, conversation_id TEXT NOT NULL,
    client_id TEXT NOT NULL UNIQUE, context_token_ciphertext TEXT, payload_ciphertext TEXT NOT NULL,
    status TEXT NOT NULL, sent_at INTEGER, last_error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
`);
preview.close();
await initDb();
const conversation = ClawBotConversationRepo.getOrCreate({
  id: "conv-1", accountId: "account-1", peerKey: "peer-hash",
  projectId: "project-1", sessionId: null, providerId: "claude-sdk", model: "sonnet",
  permissionMode: "default", state: "active", createdAt: 1, updatedAt: 1,
});
assert.equal(conversation.id, "conv-1");
assert.equal(ClawBotConversationRepo.getOrCreate({ ...conversation, id: "loser" }).id, "conv-1");
assert.equal(ClawBotConversationRepo.updateActiveSession("conv-1", { sessionId: "session-1" })?.sessionId, "session-1");

const input = { id: "in-1", conversationId: "conv-1", accountId: "account-1", externalMessageId: "remote-1", peerKey: "peer-hash",
  replyContextRef: "safe-ref-1", payloadCiphertext: "enc:payload", receivedAt: 10 };
assert.equal(ClawBotInboxRepo.persistNormalizedBatch([input]).length, 1);
assert.equal(ClawBotInboxRepo.persistNormalizedBatch([{ ...input, id: "duplicate" }]).length, 0);
assert.equal((getDb().prepare("SELECT conversation_id FROM clawbot_inbox WHERE id='in-1'").get() as { conversation_id: string }).conversation_id, "conv-1");
const claimed = ClawBotInboxRepo.claimQueued("conv-1", 20);
assert.equal(claimed?.status, "processing");
assert.equal(claimed?.attemptCount, 1);
assert.equal(ClawBotInboxRepo.claimQueued("conv-1"), undefined);
const outgoing = ClawBotInboxRepo.writeTerminal("in-1", "completed", null, {
  id: "out-1", inboxId: "in-1", conversationId: "conv-1", clientId: "stable-client-1",
  replyContextRef: "safe-ref-1", payloadCiphertext: "enc:reply", createdAt: 30,
});
assert.equal(outgoing?.status, "queued");
assert.equal(ClawBotOutboxRepo.setStatus("stable-client-1", "sent", null, 40), true);
assert.equal(ClawBotOutboxRepo.getByClientId("stable-client-1")?.sentAt, 40);

getDb().prepare("UPDATE clawbot_outbox SET status='sending' WHERE id='out-1'").run();
assert.equal(ClawBotOutboxRepo.recoverInterrupted(50), 1, "recover sending outbox");
assert.equal(ClawBotOutboxRepo.getByClientId("stable-client-1")?.status, "needs-review");
assert.match(ClawBotOutboxRepo.getByClientId("stable-client-1")?.lastError ?? "", /result is unknown/);
assert.equal(getDb().prepare("SELECT reply_context_ref, payload_ciphertext FROM clawbot_inbox").get() !== undefined, true);
assert.equal((getDb().prepare("SELECT user_id_ciphertext FROM clawbot_inbox WHERE id='in-1'").get() as { user_id_ciphertext: string }).user_id_ciphertext, "");

assert.equal(ClawBotInboxRepo.persistNormalizedBatch([{ ...input, id: "in-2", externalMessageId: "remote-2" }]).length, 1, "insert second inbox");
assert.equal(ClawBotInboxRepo.claimQueued("conv-1", 60)?.status, "processing");
assert.equal(ClawBotInboxRepo.recoverInterrupted(70), 1, "recover claimed inbox");
assert.equal((getDb().prepare("SELECT status FROM clawbot_inbox WHERE id='in-2'").get() as { status: string }).status, "needs-review");

// Repair a row written by the pre-atomic-link preview implementation.
getDb().prepare(`INSERT INTO clawbot_inbox
  (id, account_id, external_message_id, peer_key, user_id_ciphertext, reply_context_ref,
   payload_ciphertext, conversation_id, status, received_at, created_at, updated_at)
  VALUES ('legacy-null', 'account-1', 'remote-legacy', 'peer-hash', '', 'safe-ref-1',
   'enc:legacy', NULL, 'queued', 80, 80, 80)`).run();
assert.equal(ClawBotInboxRepo.repairUnattachedQueued(), 1);
assert.equal((getDb().prepare("SELECT conversation_id FROM clawbot_inbox WHERE id='legacy-null'").get() as { conversation_id: string }).conversation_id, "conv-1");
assert.equal(ClawBotInboxRepo.claimQueued("conv-1", 90)?.id, "legacy-null");
ClawBotInboxRepo.writeTerminal("legacy-null", "completed", null);

assert.equal(ClawBotInboxRepo.persistNormalizedBatch([
  { ...input, id: "old-queued", externalMessageId: "remote-old", receivedAt: 100 },
  { ...input, id: "new-session", externalMessageId: "remote-new-session", receivedAt: 101 },
]).length, 2);
assert.equal(ClawBotInboxRepo.supersedeQueuedForNewSession("conv-1", "new-session"), 1);
assert.equal((getDb().prepare("SELECT status FROM clawbot_inbox WHERE id='old-queued'").get() as { status: string }).status, "needs-review");
assert.equal((getDb().prepare("SELECT status FROM clawbot_inbox WHERE id='new-session'").get() as { status: string }).status, "queued");
ClawBotConversationRepo.updateActiveSession("conv-1", { state: "needs-review" });
assert.equal(ClawBotConversationRepo.resumeConversation("conv-1")?.state, "active");
assert.equal((getDb().prepare("SELECT status FROM clawbot_inbox WHERE id='old-queued'").get() as { status: string }).status, "needs-review");
const counts = ClawBotConversationRepo.issueCounts("conv-1");
assert.equal(counts.inboxNeedsReview, 2);
assert.equal(counts.outboxNeedsReview, 1);
closeDb();
console.log("ClawBot store smoke passed");
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
