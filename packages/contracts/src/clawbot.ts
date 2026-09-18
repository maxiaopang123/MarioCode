import { z } from "zod";

export const ClawBotStateSchema = z.enum([
  "unbound",
  "binding",
  "bound",
  "needs-interaction",
  "error",
]);
export type ClawBotState = z.infer<typeof ClawBotStateSchema>;

/** Public-only status. Authentication, cursor and context tokens never cross IPC. */
export interface ClawBotStatus {
  state: ClawBotState;
  ready: boolean;
  accountId: string | null;
  userId: string | null;
  boundAt: number | null;
  lastInteractionAt: number | null;
  error: string | null;
}

export interface ClawBotBindingResult {
  status: ClawBotStatus;
  /** URL/content supplied by iLink for rendering the QR code. */
  qrCodeImage: string | null;
  bindingStatus:
    | "wait"
    | "scaned"
    | "confirmed"
    | "expired"
    | "need_verifycode"
    | "verify_code_blocked"
    | "scaned_but_redirect"
    | "binded_redirect"
    | null;
}

export type ClawBotSendStatus = "accepted" | "needs-interaction" | "failed";
export interface ClawBotSendResult {
  status: ClawBotSendStatus;
  error: string | null;
}

export const ClawBotVerifyCodeSchema = z.object({
  code: z.string().trim().regex(/^\d{4,8}$/, "Verification code must contain 4-8 digits"),
});
export type ClawBotVerifyCodeInput = z.infer<typeof ClawBotVerifyCodeSchema>;

export const ClawBotTestPushSchema = z.object({
  text: z.string().trim().min(1).max(4000).optional(),
});
export type ClawBotTestPushInput = z.infer<typeof ClawBotTestPushSchema>;

export const ClawBotChatProviderSchema = z.enum([
  "claude-sdk",
  "codex-sdk",
  "pi-sdk",
]);
export type ClawBotChatProvider = z.infer<typeof ClawBotChatProviderSchema>;

export const ClawBotChatSettingsInputSchema = z.object({
  enabled: z.boolean(),
  providerId: ClawBotChatProviderSchema,
  model: z.string().trim().min(1).max(200),
}).strict();
export type ClawBotChatSettingsInput = z.infer<typeof ClawBotChatSettingsInputSchema>;

/** Public chat configuration and operational summary. No permission mode or message content crosses IPC. */
export const ClawBotChatSettingsSchema = ClawBotChatSettingsInputSchema.extend({
  projectId: z.string().nullable(),
  sessionId: z.string().nullable(),
  queued: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  lastMessageAt: z.number().int().nonnegative().nullable(),
  lastError: z.string().nullable(),
}).strict();
export type ClawBotChatSettings = z.infer<typeof ClawBotChatSettingsSchema>;
