import type { RuntimeEvent } from "@contracts/runtime";

const MAX_ASSISTANT_SUMMARY_CHARS = 1_200;
const MAX_PUSH_BODY_CHARS = 1_800;

export interface ScheduledPushResult {
  ok: boolean;
  error: string | null;
  assistantText: string;
  completedAt: number;
}

export type PushDeliveryResult = {
  status: "accepted" | "needs-interaction" | "failed";
  error: string | null;
};

export async function sendScheduledPush(
  sendText: (text: string) => Promise<PushDeliveryResult>,
  text: string,
): Promise<PushDeliveryResult> {
  try {
    return await sendText(text);
  } catch (error) {
    return { status: "failed", error: (error as Error).message };
  }
}

/** Delivers once, then records that exact outcome. Persistence is best-effort:
 * a database failure must never retry a message the remote API already
 * accepted, nor escape into the Agent result state machine. */
export async function deliverScheduledPush(
  sendText: (text: string) => Promise<PushDeliveryResult>,
  persist: (result: PushDeliveryResult) => void,
  text: string,
  onPersistenceError: (error: Error) => void = () => {},
): Promise<PushDeliveryResult> {
  const result = await sendScheduledPush(sendText, text);
  try {
    persist(result);
  } catch (error) {
    try {
      onPersistenceError(error as Error);
    } catch {
      // Logging/telemetry must be at least as isolated as persistence.
    }
  }
  return result;
}

export function createAssistantTextAccumulator(): {
  accept: (event: RuntimeEvent) => void;
  read: () => string;
} {
  const messages = new Map<string, string>();
  let latestMessageId: string | null = null;
  return {
    accept(event) {
      if (event.type !== "text.delta") return;
      latestMessageId = event.messageId;
      messages.set(event.messageId, `${messages.get(event.messageId) ?? ""}${event.text}`);
    },
    read() {
      return latestMessageId ? (messages.get(latestMessageId) ?? "").trim() : "";
    },
  };
}

function truncate(text: string, max: number): string {
  const normalized = text.replace(/\r\n/g, "\n").trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

export function buildScheduledPushText(taskName: string, result: ScheduledPushResult): string {
  const status = result.ok ? "成功" : "失败";
  const details = result.ok
    ? truncate(result.assistantText, MAX_ASSISTANT_SUMMARY_CHARS) || "Agent 未返回可推送的文本结果。"
    : truncate(result.error ?? "未知错误", MAX_ASSISTANT_SUMMARY_CHARS);
  const body = [
    `MarioCode 定时任务：${taskName}`,
    `Agent 状态：${status}`,
    `完成时间：${new Date(result.completedAt).toLocaleString("zh-CN", { hour12: false })}`,
    result.ok ? `最终回复：${details}` : `错误：${details}`,
  ].join("\n");
  return truncate(body, MAX_PUSH_BODY_CHARS);
}
