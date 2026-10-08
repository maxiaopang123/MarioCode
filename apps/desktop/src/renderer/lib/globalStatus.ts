/**
 * Global (not per-session) status facts the V3 StatusBar showed — proxy mode,
 * today's token / cost total and the enabled scheduled-task count. V4 removed
 * the bar and surfaces them inside the sidebar (settings row subtitle, the
 * 定时任务 row). All three are cheap local IPC reads, refreshed on mount, on
 * window focus, every 60s and whenever the running-turn count changes (a turn
 * just ended → today's usage moved).
 */
import { useCallback, useEffect, useState } from "react";
import { api } from "@renderer/lib/api.js";
import { isElectron } from "@renderer/lib/platform.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import type { NetworkProxyStatus } from "@contracts/ipc";

export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

export interface GlobalStatus {
  proxy: NetworkProxyStatus | null;
  today: { tokens: number; cost: number } | null;
  /** Enabled scheduled tasks (null until the first read lands). */
  scheduled: number | null;
}

export function useGlobalStatus(): GlobalStatus {
  const runningCount = useSessionStore((s) => Object.values(s.runningBySession).filter(Boolean).length);
  const [proxy, setProxy] = useState<NetworkProxyStatus | null>(null);
  const [today, setToday] = useState<{ tokens: number; cost: number } | null>(null);
  const [scheduled, setScheduled] = useState<number | null>(null);

  const refresh = useCallback(() => {
    if (!isElectron) return;
    api.network.proxyStatus().then(setProxy, () => setProxy(null));
    api.usage.stats({ preset: "today" }).then(
      (r) => setToday({ tokens: r.summary.totalTokens, cost: r.summary.costUsd }),
      () => setToday(null),
    );
    api.scheduler.list().then(
      (r) => setScheduled(r.tasks.filter((x) => x.enabled).length),
      () => setScheduled(null),
    );
  }, []);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 60_000);
    window.addEventListener("focus", refresh);
    return () => {
      clearInterval(id);
      window.removeEventListener("focus", refresh);
    };
  }, [refresh]);
  useEffect(() => {
    refresh();
  }, [runningCount, refresh]);

  return { proxy, today, scheduled };
}
