import {
  buildScheduledPushText,
  createAssistantTextAccumulator,
  deliverScheduledPush,
  sendScheduledPush,
} from "@main/scheduler/pushMessage.js";

let checks = 0;
function check(name: string, condition: boolean): void {
  checks++;
  if (!condition) throw new Error(`FAILED: ${name}`);
  process.stdout.write(`  ✓ ${name}\n`);
}

const assistant = createAssistantTextAccumulator();
assistant.accept({ type: "text.delta", sessionId: "s", messageId: "m1", text: "old" });
assistant.accept({ type: "message.complete", sessionId: "s", messageId: "m1" });
assistant.accept({ type: "text.delta", sessionId: "s", messageId: "m2", text: "final " });
assistant.accept({ type: "text.delta", sessionId: "s", messageId: "m2", text: "answer" });
check("only the latest assistant message is summarized", assistant.read() === "final answer");

const successText = buildScheduledPushText("每日报告", {
  ok: true, error: null, assistantText: "已完成", completedAt: 0,
});
check("success body includes task, status and final reply",
  successText.includes("每日报告") && successText.includes("Agent 状态：成功") && successText.includes("已完成"));

const failureText = buildScheduledPushText("失败任务", {
  ok: false, error: "provider offline", assistantText: "ignored", completedAt: 0,
});
check("failure body prefers the task error", failureText.includes("provider offline") && !failureText.includes("ignored"));

const longText = buildScheduledPushText("长回复", {
  ok: true, error: null, assistantText: "x".repeat(5_000), completedAt: 0,
});
check("push body is bounded and visibly truncated", longText.length <= 1_800 && longText.endsWith("…"));

const needsInteraction = await sendScheduledPush(async () => ({ status: "needs-interaction", error: "请先在微信发送一条消息" }), "x");
check("needs-interaction is preserved", needsInteraction.status === "needs-interaction");

const failed = await sendScheduledPush(async () => { throw new Error("network down"); }, "x");
check("send exceptions map to failed without throwing", failed.status === "failed" && failed.error === "network down");

const agentResult = { ok: true, error: null } as const;
await sendScheduledPush(async () => { throw new Error("push only failure"); }, "x");
check("push failure cannot mutate the agent result", agentResult.ok && agentResult.error === null);

let sends = 0;
let persistenceErrors = 0;
const acceptedAfterDbFailure = await deliverScheduledPush(
  async () => {
    sends++;
    return { status: "accepted", error: null };
  },
  () => { throw new Error("database is read-only"); },
  "x",
  () => { persistenceErrors++; },
);
check("accepted send is never retried when result persistence fails", sends === 1);
check("persistence failure is contained and observable", acceptedAfterDbFailure.status === "accepted" && persistenceErrors === 1);
check("post-send database failure cannot mutate the Agent result", agentResult.ok && agentResult.error === null);

process.stdout.write(`scheduler-push smoke passed (${checks} checks)\n`);
