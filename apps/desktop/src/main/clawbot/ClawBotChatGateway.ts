import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { safeStorage } from "electron";
import type { ClawBotConversation, ClawBotInboxItem, ClawBotOutboxStatus } from "@contracts/clawbotChat";
import type { Project, Session } from "@contracts/session";
import { runtimeManager } from "@main/claude/RuntimeManager.js";
import { getDb } from "@main/store/db.js";
import { ClawBotConversationRepo, ClawBotInboxRepo, ClawBotOutboxRepo, ProjectRepo, SessionRepo, SettingRepo } from "@main/store/repositories.js";
import { backgroundTurnService } from "@main/lib/BackgroundTurnService.js";
import { log } from "@main/lib/logger.js";
import { uid } from "@main/utils.js";
import type { ClawBotInboundEvent } from "./protocol.js";
import { CLAWBOT_NEW_SESSION_COMMAND, isNewSessionCommand, KeyedSerialQueue, publicChatConfig, resolveSafeChild } from "./chatGatewayHelpers.js";

const PROVIDER_SETTING = "clawbot.chat.providerId";
const MODEL_SETTING = "clawbot.chat.model";
const PERMISSION_SETTING = "clawbot.chat.permissionMode";
const PROJECT_NAME = "MarioCode 微信助手";
const SAFE_PROVIDERS = new Set(["claude-sdk", "codex-sdk", "pi-sdk"]);

export interface ClawBotReplyResult { status: "accepted" | "needs-interaction" | "failed"; error: string | null }
export type ClawBotReply = (replyContextRef: string, text: string, clientId: string) => Promise<ClawBotReplyResult>;
export type ClawBotChatProviderId = "claude-sdk" | "codex-sdk" | "pi-sdk";
export interface ClawBotChatSettings {
  enabled: boolean; providerId: ClawBotChatProviderId; model: string;
  projectId: string | null; sessionId: string | null; queued: number; failed: number;
  lastMessageAt: number | null; lastError: string | null;
}
export interface ClawBotChatTransport {
  registerInboundSink(sink: (batch: readonly ClawBotInboundEvent[]) => Promise<void>): () => void;
  replyTo(replyContextRef: string, text: string, clientId: string): Promise<ClawBotReplyResult>;
}

/** Owner-DM pipeline. Input is already normalized/authenticated by ClawBotService. */
export class ClawBotChatGateway {
  private readonly queue = new KeyedSerialQueue();
  private readonly activeTurns = new Set<AbortController>();
  private readonly activeSessionIds = new Set<string>();
  private readonly activeDrains = new Set<Promise<void>>();
  private readonly activeTasks = new Set<Promise<void>>();
  private generation = 0;
  private stopping = false;

  private userDataPath: string | null = null;
  private reply: ClawBotReply | null = null;
  private unregisterSink: (() => void) | null = null;

  start(userDataPath: string, transport: ClawBotChatTransport): Promise<void> {
    return this.trackTask(this.startInternal(userDataPath, transport));
  }

  private async startInternal(userDataPath: string, transport: ClawBotChatTransport): Promise<void> {
    const generation = ++this.generation;
    this.userDataPath = userDataPath;
    this.reply = (ref, text, clientId) => transport.replyTo(ref, text, clientId);
    this.stopping = false;
    this.unregisterSink?.();
    this.unregisterSink = transport.registerInboundSink((batch) => this.acceptInboundBatch(batch));
    ClawBotInboxRepo.recoverInterrupted();
    ClawBotOutboxRepo.recoverInterrupted();
    ClawBotInboxRepo.repairUnattachedQueued();
    await this.resumeOutbox();
    if (this.stopping || generation !== this.generation) return;
    if (this.getSettings().enabled) this.scheduleResumeQueued();
  }

  getSettings(): ClawBotChatSettings {
    const cfg = this.localConfig();
    const stats = getDb().prepare(`SELECT
      (SELECT COUNT(*) FROM clawbot_inbox WHERE status = 'queued') AS queued,
      ((SELECT COUNT(*) FROM clawbot_inbox WHERE status IN ('failed','needs-review')) +
       (SELECT COUNT(*) FROM clawbot_outbox WHERE status IN ('failed','needs-review'))) AS failed,
      (SELECT MAX(received_at) FROM clawbot_inbox) AS last_message_at`).get() as { queued: number; failed: number; last_message_at: number | null };
    const latest = getDb().prepare("SELECT project_id, session_id FROM clawbot_conversations ORDER BY updated_at DESC LIMIT 1").get() as { project_id: string | null; session_id: string | null } | undefined;
    const failure = getDb().prepare(`SELECT last_error FROM (
      SELECT last_error, updated_at FROM clawbot_inbox WHERE last_error IS NOT NULL
      UNION ALL SELECT last_error, updated_at FROM clawbot_outbox WHERE last_error IS NOT NULL
    ) ORDER BY updated_at DESC LIMIT 1`).get() as { last_error: string } | undefined;
    return { enabled: SettingRepo.get("clawbot.chat.enabled") === "1", ...publicChatConfig(cfg),
      projectId: latest?.project_id ?? null, sessionId: latest?.session_id ?? null,
      queued: stats.queued ?? 0, failed: stats.failed ?? 0, lastMessageAt: stats.last_message_at ?? null,
      lastError: failure?.last_error ?? null };
  }

  refreshSettings(): ClawBotChatSettings {
    return this.getSettings();
  }

  async updateSettings(input: { enabled: boolean; providerId: ClawBotChatProviderId; model: string }): Promise<ClawBotChatSettings> {
    if (!SAFE_PROVIDERS.has(input.providerId)) throw new Error("不支持的 ClawBot provider。");
    SettingRepo.set("clawbot.chat.enabled", input.enabled ? "1" : "0");
    SettingRepo.set(PROVIDER_SETTING, input.providerId);
    SettingRepo.set(MODEL_SETTING, input.model.trim() || "default");
    if (input.enabled) this.scheduleResumeQueued();
    else {
      for (const controller of this.activeTurns) controller.abort();
    }
    return this.getSettings();
  }

  acceptInboundBatch(events: readonly ClawBotInboundEvent[]): Promise<void> {
    return this.trackTask(this.acceptInboundBatchInternal(events));
  }

  private async acceptInboundBatchInternal(events: readonly ClawBotInboundEvent[]): Promise<void> {
    if (this.stopping || events.length === 0) return;
    const generation = this.generation;
    const project = await this.ensureProject();
    if (this.stopping || generation !== this.generation) return;
    const conversations = new Map<string, ClawBotConversation>();
    const prepared = events.map((event) => {
      const key = `${event.accountId}\0${event.conversationKey}`;
      const conversation = conversations.get(key) ?? this.ensureConversation(event.accountId, event.conversationKey, project.id);
      conversations.set(key, conversation);
      return { event, conversation, id: uid("clawin_") };
    });
    const inserted = ClawBotInboxRepo.persistNormalizedBatch(prepared.map(({ event, conversation, id }) => ({
      id, conversationId: conversation.id,
      accountId: event.accountId, externalMessageId: event.messageId,
      peerKey: event.conversationKey, replyContextRef: event.replyContextRef,
      payloadCiphertext: this.encrypt(event.text), receivedAt: event.receivedAt,
    })));
    if (this.stopping || generation !== this.generation) return;
    const insertedIds = new Set(inserted.map((item) => item.id));
    for (const item of prepared) {
      if (!insertedIds.has(item.id) || !isNewSessionCommand(item.event.text)) continue;
      this.recoverWithNewSessionCommand(item.conversation.id, item.id, item.event.receivedAt);
      conversations.set(`${item.event.accountId}\0${item.event.conversationKey}`, { ...item.conversation, state: "active" });
    }
    // Disabled mode still durably acknowledges/persists input, but leaves it
    // queued. Enabling drains once; remote polling can advance without a loop.
    if (!this.getSettings().enabled) return;
    for (const conversation of conversations.values()) this.scheduleConversation(conversation, project.id);
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.generation++;
    for (const controller of this.activeTurns) controller.abort();
    for (const sessionId of this.activeSessionIds) runtimeManager.dispose(sessionId);
    this.unregisterSink?.();
    this.unregisterSink = null;
    await Promise.allSettled([...this.activeDrains, ...this.activeTasks]);
    this.activeTurns.clear();
    this.activeSessionIds.clear();
  }

  resumeConversation(conversationId: string): Promise<ClawBotChatSettings> {
    return this.trackTask(this.resumeConversationInternal(conversationId));
  }

  private async resumeConversationInternal(conversationId: string): Promise<ClawBotChatSettings> {
    const conversation = ClawBotConversationRepo.get(conversationId);
    if (!conversation) throw new Error("ClawBot conversation 不存在。");
    ClawBotConversationRepo.updateActiveSession(conversationId, { state: "active" });
    if (this.getSettings().enabled && this.userDataPath) {
      const project = await this.ensureProject();
      if (!this.stopping) this.scheduleConversation({ ...conversation, state: "active" }, project.id);
    }
    return this.getSettings();
  }

  async resumeLatestConversation(): Promise<ClawBotChatSettings> {
    const row = getDb().prepare("SELECT id FROM clawbot_conversations ORDER BY updated_at DESC LIMIT 1").get() as { id: string } | undefined;
    if (!row) throw new Error("没有可恢复的 ClawBot conversation。");
    return this.resumeConversation(row.id);
  }

  private async drain(initial: ClawBotConversation, projectId: string): Promise<void> {
    let conversation = ClawBotConversationRepo.get(initial.id) ?? initial;
    while (!this.stopping) {
      if (!this.getSettings().enabled || conversation.state !== "active") return;
      const inbox = ClawBotInboxRepo.claimQueued(conversation.id);
      if (!inbox) return;
      let outcome: { ok: boolean; text: string; conversation: ClawBotConversation };
      try {
        outcome = await this.processInbox(inbox, conversation, projectId);
      } catch (error) {
        if (this.stopping) return;
        const message = error instanceof Error ? error.message : "后台消息处理失败。";
        outcome = { ok: false, text: `本次处理未完成：${message}`, conversation };
        ClawBotConversationRepo.updateActiveSession(conversation.id, { state: "needs-review" });
        log.error(`ClawBot inbox ${inbox.id} failed: ${message}`);
      }
      if (this.stopping) return;
      conversation = outcome.conversation;
      const clientId = `mariocode-claw-${inbox.id}`;
      try {
        ClawBotInboxRepo.writeTerminal(inbox.id, outcome.ok ? "completed" : "failed", outcome.ok ? null : outcome.text, {
          id: uid("clawout_"), inboxId: inbox.id, conversationId: conversation.id, clientId,
          replyContextRef: inbox.replyContextRef, payloadCiphertext: this.encrypt(outcome.text), createdAt: Date.now(),
        });
      } catch (error) {
        log.error(`ClawBot inbox ${inbox.id} terminal persistence failed: ${(error as Error).message}`);
        ClawBotConversationRepo.updateActiveSession(conversation.id, { state: "needs-review" });
        return;
      }
      let status: ClawBotOutboxStatus = "failed";
      let sendError: string | null = "ClawBot 回复通道尚未初始化。";
      try {
        ClawBotOutboxRepo.setStatus(clientId, "sending");
        if (!this.reply) throw new Error(sendError);
        const sent = await this.reply(inbox.replyContextRef, outcome.text, clientId);
        if (this.stopping) return;
        status = sent.status === "accepted" ? "sent" : sent.status === "needs-interaction" ? "needs-review" : "failed";
        sendError = sent.error;
      } catch (error) {
        sendError = error instanceof Error ? error.message : "ClawBot 回复失败。";
      }
      if (this.stopping) return;
      ClawBotOutboxRepo.setStatus(clientId, status, sendError);
      if (status !== "sent") {
        ClawBotConversationRepo.updateActiveSession(conversation.id, { state: "needs-review" });
        log.warn(`ClawBot reply ${clientId} failed: ${sendError ?? status}`);
        return;
      }
      if (!outcome.ok) return;
    }
  }

  private async processInbox(inbox: ClawBotInboxItem, conversation: ClawBotConversation, projectId: string): Promise<{ ok: boolean; text: string; conversation: ClawBotConversation }> {
    const text = this.decrypt(inbox.payloadCiphertext);
    if (isNewSessionCommand(text)) {
      const session = this.createSession(projectId, conversation);
      const updated = ClawBotConversationRepo.updateActiveSession(conversation.id, { projectId, sessionId: session.id, state: "active" }) ?? { ...conversation, projectId, sessionId: session.id };
      return { ok: true, text: "已创建新会话。接下来发送的消息会进入这个会话。", conversation: updated };
    }
    let session = conversation.sessionId ? SessionRepo.get(conversation.sessionId) : undefined;
    if (!session || session.archived || session.projectId !== projectId) {
      session = this.createSession(projectId, conversation);
      conversation = ClawBotConversationRepo.updateActiveSession(conversation.id, { projectId, sessionId: session.id, state: "active" }) ?? conversation;
    }
    const controller = new AbortController();
    this.activeTurns.add(controller);
    this.activeSessionIds.add(session.id);
    try {
      const result = await backgroundTurnService.run({ session, prompt: text, signal: controller.signal });
      if (this.stopping) return { ok: false, text: "MarioCode 正在退出，本次处理已取消。", conversation };
      if (!result.ok) {
        ClawBotConversationRepo.updateActiveSession(conversation.id, { state: "needs-review" });
        return { ok: false, text: `本次处理未完成：${result.error}`, conversation };
      }
      return { ok: true, text: result.assistantText, conversation };
    } finally {
      this.activeTurns.delete(controller);
      this.activeSessionIds.delete(session.id);
    }
  }

  private ensureConversation(accountId: string, peerKey: string, projectId: string): ClawBotConversation {
    const config = this.localConfig();
    const now = Date.now();
    return ClawBotConversationRepo.getOrCreate({ id: uid("clawconv_"), accountId, peerKey, projectId, sessionId: null, ...config, state: "active", createdAt: now, updatedAt: now });
  }

  /** Always inserts a distinct row; never reuses a desktop fresh session. */
  private createSession(projectId: string, conversation: ClawBotConversation): Session {
    const config = this.localConfig();
    ClawBotConversationRepo.updateActiveSession(conversation.id, config);
    const now = Date.now();
    const session: Session = {
      id: uid("sess_"), projectId, providerId: config.providerId, claudeSessionId: null, kind: "chat", parentSessionId: null,
      title: `ClawBot ${new Date(now).toLocaleString("zh-CN", { hour12: false })}`, status: "idle", model: config.model,
      effort: "default", permissionMode: config.permissionMode, customModelId: null, envMode: "local", wtStyle: null,
      worktreePath: null, archived: false, pinnedAt: null, contextSnapshot: null, todos: null, subagents: null,
      planDraft: null, turnFiles: null, usageHistory: null, bookmarks: null, subagentTranscripts: null, createdAt: now, updatedAt: now,
    };
    SessionRepo.create(session);
    runtimeManager.bindSession(session);
    return session;
  }

  private async ensureProject(): Promise<Project> {
    if (!this.userDataPath) throw new Error("ClawBot 网关尚未初始化。");
    const generation = this.generation;
    const userData = resolve(this.userDataPath);
    const workspace = resolveSafeChild(userData, "clawbot", "workspace");
    await mkdir(workspace, { recursive: true });
    if (this.stopping || generation !== this.generation) throw new Error("ClawBot 网关已停止。");
    const projectId = `proj_clawbot_${createHash("sha256").update(userData).digest("hex").slice(0, 16)}`;
    const existing = ProjectRepo.get(projectId);
    if (existing) {
      if (resolve(existing.path) !== workspace) throw new Error("ClawBot 专用项目路径与本机安全目录不一致。");
      return existing;
    }
    const now = Date.now();
    const project: Project = { id: projectId, name: PROJECT_NAME, path: workspace, archived: false, group: null, sortOrder: 0, pinnedAt: null, createdAt: now, updatedAt: now };
    ProjectRepo.create(project);
    return ProjectRepo.get(projectId) ?? project;
  }

  private localConfig(): { providerId: ClawBotChatProviderId; model: string; permissionMode: string } {
    const configuredProvider = SettingRepo.get(PROVIDER_SETTING)?.trim() || "claude-sdk";
    const providerId: ClawBotChatProviderId = SAFE_PROVIDERS.has(configuredProvider) ? configuredProvider as ClawBotChatProviderId : "claude-sdk";
    if (providerId !== configuredProvider) log.warn(`ClawBot ignored unknown provider: ${configuredProvider}`);
    const model = SettingRepo.get(MODEL_SETTING)?.trim() || "default";
    const requested = SettingRepo.get(PERMISSION_SETTING)?.trim() || "default";
    if (requested !== "default") log.warn(`ClawBot ignored unsafe background permission mode: ${requested}`);
    return { providerId, model, permissionMode: "default" };
  }

  private encrypt(value: string): string {
    if (!safeStorage.isEncryptionAvailable()) throw new Error("系统安全凭据存储不可用，拒绝处理 ClawBot 私聊。");
    return safeStorage.encryptString(value).toString("base64");
  }
  private decrypt(ciphertext: string): string {
    if (!safeStorage.isEncryptionAvailable()) throw new Error("系统安全凭据存储不可用，无法读取 ClawBot 私聊。");
    return safeStorage.decryptString(Buffer.from(ciphertext, "base64"));
  }

  private async resumeQueued(): Promise<void> {
    if (!this.userDataPath || this.stopping) return;
    const generation = this.generation;
    const project = await this.ensureProject();
    if (this.stopping || generation !== this.generation) return;
    const rows = getDb().prepare(`SELECT DISTINCT conversation_id FROM clawbot_inbox
      WHERE status = 'queued' AND conversation_id IS NOT NULL`).all() as Array<{ conversation_id: string }>;
    for (const { conversation_id } of rows) {
      const conversation = ClawBotConversationRepo.get(conversation_id);
      if (conversation?.state === "active") this.scheduleConversation(conversation, project.id);
    }
  }

  private async resumeOutbox(): Promise<void> {
    if (!this.reply || this.stopping) return;
    const rows = getDb().prepare(`SELECT client_id, reply_context_ref, payload_ciphertext
      FROM clawbot_outbox WHERE status = 'queued' ORDER BY created_at ASC`).all() as Array<{
        client_id: string; reply_context_ref: string; payload_ciphertext: string;
      }>;
    for (const row of rows) {
      if (this.stopping) return;
      let markedSending = false;
      try {
        ClawBotOutboxRepo.setStatus(row.client_id, "sending");
        markedSending = true;
        const sent = await this.reply(row.reply_context_ref, this.decrypt(row.payload_ciphertext), row.client_id);
        if (this.stopping) return;
        const status: ClawBotOutboxStatus = sent.status === "accepted" ? "sent" : sent.status === "needs-interaction" ? "needs-review" : "failed";
        ClawBotOutboxRepo.setStatus(row.client_id, status, sent.error);
      } catch (error) {
        const message = error instanceof Error ? error.message : "ClawBot Outbox 恢复失败。";
        if (!this.stopping && markedSending) {
          try { ClawBotOutboxRepo.setStatus(row.client_id, "needs-review", message); } catch { /* logged below */ }
        }
        log.error(`ClawBot outbox ${row.client_id} recovery failed: ${message}`);
      }
    }
  }

  private scheduleConversation(conversation: ClawBotConversation, projectId: string): void {
    if (this.stopping) return;
    const drain = this.queue.run(conversation.id, () => this.drain(conversation, projectId)).catch((error) => {
      if (this.stopping) return;
      try { ClawBotConversationRepo.updateActiveSession(conversation.id, { state: "needs-review" }); } catch { /* logged below */ }
      log.error(`ClawBot conversation ${conversation.id} background drain failed: ${(error as Error).message}`);
    });
    this.activeDrains.add(drain);
    void drain.finally(() => this.activeDrains.delete(drain));
  }

  private scheduleResumeQueued(): void {
    if (this.stopping) return;
    const generation = this.generation;
    const task = this.resumeQueued().catch((error) => {
      if (!this.stopping) log.error(`ClawBot queued resume failed: ${(error as Error).message}`);
    }).then(() => {
      if (generation !== this.generation) return;
    });
    this.activeTasks.add(task);
    void task.finally(() => this.activeTasks.delete(task));
  }

  private trackTask<T>(task: Promise<T>): Promise<T> {
    const tracked = task.then(() => undefined, () => undefined);
    this.activeTasks.add(tracked);
    void tracked.finally(() => this.activeTasks.delete(tracked));
    return task;
  }

  /** A precise control command is allowed to escape needs-review safely. */
  private recoverWithNewSessionCommand(conversationId: string, commandInboxId: string, receivedAt: number): void {
    const now = Date.now();
    getDb().transaction(() => {
      getDb().prepare(`UPDATE clawbot_inbox SET status = 'needs-review', completed_at = ?,
        last_error = 'Skipped when the owner started a new conversation', updated_at = ?
        WHERE conversation_id = ? AND status = 'queued' AND id <> ? AND received_at < ?`)
        .run(now, now, conversationId, commandInboxId, receivedAt);
      getDb().prepare("UPDATE clawbot_conversations SET state = 'active', updated_at = ? WHERE id = ?")
        .run(now, conversationId);
    })();
  }
}

export { CLAWBOT_NEW_SESSION_COMMAND as NEW_SESSION_COMMAND };
export const clawBotChatGateway = new ClawBotChatGateway();
