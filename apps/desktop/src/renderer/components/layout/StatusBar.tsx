/**
 * StatusBar — the global status bar along the window's bottom edge (界面焕新
 * v3). GLOBAL facts only; per-session numbers (context, cache, speed) live
 * inside each session (composer / activity cluster), never here:
 *
 *   ● Claude 就绪 · 3 个引擎   ⊕ 跟随系统代理   ◌ 1 个运行中
 *                                  ⚠ 3 个等你处理   今日 1.2M tokens · $3.18   ⏰ 定时 2
 *
 * Proxy status, today's usage and the scheduled-task count come from IPC
 * (network.proxyStatus / usage.stats{today} / scheduler.list) and refresh on
 * window focus, when a turn ends, and every 60s — cheap local reads.
 */
import { memo, useCallback, useEffect, useState } from "react";
import { IconAlertTriangle, IconCalendar, IconCoins, IconLoader2, IconWorld } from "@renderer/lib/icons.js";
import { cn } from "@renderer/lib/cn.js";
import { api } from "@renderer/lib/api.js";
import { isElectron } from "@renderer/lib/platform.js";
import { jumpToNextAttention, useAttention } from "@renderer/lib/attention.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import type { NetworkProxyStatus } from "@contracts/ipc";

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

const ITEM = "flex h-full shrink-0 items-center gap-1.5 whitespace-nowrap px-1.5";

function StatusBarBase() {
  const { t } = useI18n();
  const installed = useSessionStore((s) => s.claudeInstalled);
  const providers = useSessionStore((s) => s.providers);
  const runningBySession = useSessionStore((s) => s.runningBySession);
  const setSettingsOpen = useSessionStore((s) => s.setSettingsOpen);
  const attention = useAttention();
  const runningCount = Object.values(runningBySession).filter(Boolean).length;

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

  // Refresh on mount, on focus, every 60s, and when the running count drops
  // (a turn just ended → today's usage moved).
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

  const engineDot =
    installed === false ? "bg-danger" : installed === true ? "bg-accent" : "bg-content-subtle/60";
  const engineText =
    installed === false
      ? t("layout.status.claudeMissing")
      : installed === true
        ? t("layout.status.claudeReady")
        : t("layout.status.claudeChecking");

  const proxyText = proxy
    ? proxy.mode === "direct"
      ? t("layout.status.proxyDirect")
      : proxy.mode === "custom"
        ? t("layout.status.proxyCustom")
        : t("layout.status.proxySystem")
    : null;

  return (
    <footer
      aria-label={t("layout.status.aria")}
      className="flex h-[26px] shrink-0 items-center border-t border-edge bg-surface-base px-2 text-[11.5px] text-content-subtle"
    >
      <button
        type="button"
        onClick={() => setSettingsOpen(true, "runtimes")}
        className={cn(ITEM, "rounded hover:text-content")}
        title={providers.map((p) => p.displayName).join(" · ") || undefined}
      >
        <i className={cn("h-1.5 w-1.5 rounded-full", engineDot)} aria-hidden />
        {engineText}
        {providers.length > 0 && (
          <span className="text-content-subtle/80">· {t("layout.status.engines", { n: providers.length })}</span>
        )}
      </button>

      {proxyText && (
        <button
          type="button"
          onClick={() => setSettingsOpen(true, "network")}
          className={cn(ITEM, "rounded hover:text-content")}
          title={proxy?.proxyUrl ? t("layout.status.proxyVia", { url: proxy.proxyUrl }) : undefined}
        >
          <IconWorld size={12} className="shrink-0" />
          {proxyText}
        </button>
      )}

      {runningCount > 0 && (
        <span className={cn(ITEM, "text-accent-strong")}>
          <IconLoader2 size={11} className="shrink-0 animate-spin" />
          {t("layout.status.running", { n: runningCount })}
        </span>
      )}

      <span className="flex-1" />

      {attention.length > 0 && (
        <button
          type="button"
          onClick={jumpToNextAttention}
          className={cn(ITEM, "rounded font-medium text-warning hover:brightness-110")}
          title={t("lib.commands.nextAttention")}
        >
          <IconAlertTriangle size={12} className="shrink-0" />
          {t("layout.status.waiting", { n: attention.length })}
        </button>
      )}

      {today && today.tokens > 0 && (
        <button
          type="button"
          onClick={() => setSettingsOpen(true, "usage")}
          className={cn(ITEM, "rounded tabular-nums hover:text-content")}
          title={t("layout.status.todayTitle")}
        >
          <IconCoins size={12} className="shrink-0" />
          {t("layout.status.today", { tokens: fmtTokens(today.tokens), cost: `$${today.cost.toFixed(2)}` })}
        </button>
      )}

      {scheduled != null && scheduled > 0 && (
        <button
          type="button"
          onClick={() => setSettingsOpen(true, "scheduled-tasks")}
          className={cn(ITEM, "rounded hover:text-content")}
        >
          <IconCalendar size={12} className="shrink-0" />
          {t("layout.status.scheduled", { n: scheduled })}
        </button>
      )}
    </footer>
  );
}

export const StatusBar = memo(StatusBarBase);
