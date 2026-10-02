/** Provider-normalized per-turn usage for session metrics. Raw persisted
 *  history stays untouched; Claude/Codex records already are per-turn. */
import { useMemo } from "react";
import { EMPTY_USAGE, useSessionStore } from "@renderer/stores/sessionStore.js";
import { normalizeSessionUsageHistory } from "@renderer/lib/sessionMetrics.js";
import { CUMULATIVE_USAGE_PROVIDER_IDS } from "@renderer/lib/turnTokens.js";
import type { TurnUsageRecord } from "@contracts/runtime";

export function useSessionUsageHistory(sessionId: string): readonly TurnUsageRecord[] {
  const history = useSessionStore((s) => s.usageHistoryBySession[sessionId] ?? EMPTY_USAGE);
  const providerId = useSessionStore((s) => {
    for (const list of Object.values(s.sessionsByProject)) {
      const session = list?.find((x) => x.id === sessionId);
      if (session) return session.providerId;
    }
    for (const list of Object.values(s.sideChatsByParent)) {
      const session = list?.find((x) => x.id === sessionId);
      if (session) return session.providerId;
    }
    return s.pinnedSessions.find((x) => x.id === sessionId)?.providerId
      ?? s.streamSessions.find((x) => x.id === sessionId)?.providerId
      ?? null;
  });
  const cumulative = providerId !== null && CUMULATIVE_USAGE_PROVIDER_IDS.has(providerId);
  return useMemo(() => normalizeSessionUsageHistory(history, cumulative), [history, cumulative]);
}
