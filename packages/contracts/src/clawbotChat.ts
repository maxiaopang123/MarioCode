/** Persistence-only contracts for the ClawBot owner-DM text pipeline. */
export type ClawBotInboxStatus =
  | "queued"
  | "processing"
  | "completed"
  | "failed"
  | "needs-review";

export type ClawBotOutboxStatus = "queued" | "sending" | "sent" | "failed" | "needs-review";

export type ClawBotConversationState = "active" | "paused" | "needs-review" | "closed";

export interface ClawBotConversation {
  id: string;
  accountId: string;
  /** Stable, non-reversible lookup key derived by the gateway from the remote user id. */
  peerKey: string;
  projectId: string | null;
  sessionId: string | null;
  providerId: string;
  model: string;
  permissionMode: string;
  state: ClawBotConversationState;
  createdAt: number;
  updatedAt: number;
}

export interface ClawBotConversationCreateInput extends ClawBotConversation {}

export interface ClawBotConversationPatch {
  projectId?: string | null;
  sessionId?: string | null;
  providerId?: string;
  model?: string;
  permissionMode?: string;
  state?: ClawBotConversationState;
}

export interface ClawBotInboundMessage {
  id: string;
  conversationId: string;
  accountId: string;
  externalMessageId: string;
  peerKey: string;
  /** Opaque key into ClawBotCredentialStore; never contains sender/context-token material. */
  replyContextRef: string;
  payloadCiphertext: string;
  receivedAt: number;
}

export interface ClawBotInboxItem extends Omit<ClawBotInboundMessage, "conversationId"> {
  /** Nullable only while reading rows written by the pre-atomic-link preview build. */
  conversationId: string | null;
  status: ClawBotInboxStatus;
  attemptCount: number;
  claimedAt: number | null;
  completedAt: number | null;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface ClawBotOutboxWrite {
  id: string;
  inboxId: string;
  conversationId: string;
  clientId: string;
  replyContextRef: string;
  payloadCiphertext: string;
  status?: ClawBotOutboxStatus;
  createdAt: number;
}

export interface ClawBotOutboxItem extends ClawBotOutboxWrite {
  status: ClawBotOutboxStatus;
  sentAt: number | null;
  lastError: string | null;
  updatedAt: number;
}

export interface ClawBotConversationIssueCounts {
  inboxFailed: number;
  inboxNeedsReview: number;
  outboxFailed: number;
  outboxNeedsReview: number;
}
