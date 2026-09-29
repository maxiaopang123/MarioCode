/**
 * SessionMetrics — the per-session readout that sits at the composer's right
 * end (prototypes/ui-refresh-v3.html `.sess-metrics`): context occupancy,
 * average cache hit rate, average output speed.
 *
 * It belongs HERE, next to the box you type in, rather than in the window's
 * status bar: every figure is about one session, and the status bar is shared
 * by all of them. Switching sessions switches the numbers.
 *
 * The context ring is the existing ContextRing (it owns the detailed
 * popover); the two metric chips open the 「本会话」 float, where the same
 * numbers appear with per-turn breakdown and the cache sparkline.
 *
 * Narrow hosts (side-chat panel, phone shell) drop the two chips and keep the
 * ring — see .sess-metrics in styles.css.
 */
import { cn } from "@renderer/lib/cn.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { IconBolt, IconGauge } from "@renderer/lib/icons.js";
import { EMPTY_USAGE, useSessionStore } from "@renderer/stores/sessionStore.js";
import {
  fmtPct,
  fmtSpeed,
  fmtTokens,
  sessionCacheRate,
  sessionSpeed,
  turnCacheRate,
  turnSpeed,
  type TurnGenRecord,
} from "@renderer/lib/sessionMetrics.js";
import { ContextRing } from "./ContextRing.js";

const EMPTY_GENS: TurnGenRecord[] = [];

export function SessionMetrics({ sessionId }: { sessionId: string }) {
  const { t } = useI18n();
  const snapshot = useSessionStore((s) => s.contextSnapshotBySession[sessionId]);
  const usageHistory = useSessionStore((s) => s.usageHistoryBySession[sessionId] ?? EMPTY_USAGE);
  const gens = useSessionStore((s) => s.turnGenBySession[sessionId] ?? EMPTY_GENS);
  const openFloat = useSessionStore((s) => s.openSessionFloat);

  const avgCache = sessionCacheRate(usageHistory);
  const avgSpeed = sessionSpeed(usageHistory, gens);
  const last = usageHistory[usageHistory.length - 1];
  const lastGen = gens[gens.length - 1];
  const turnCache = turnCacheRate(last);
  const turnTokPerSec = turnSpeed(last?.outputTokens, lastGen?.genMs);

  // Nothing measured yet → render nothing rather than a row of dashes.
  if (!snapshot && avgCache == null && avgSpeed == null) return null;

  return (
    <span className="sess-metrics flex shrink-0 items-center gap-1.5">
      {snapshot && <ContextRing snapshot={snapshot} history={usageHistory} />}
      {(avgCache != null || avgSpeed != null) && (
        <button
          type="button"
          onClick={openFloat}
          title={t("chatStream.metrics.aria")}
          className={cn(
            "sess-metrics-chips flex h-7 items-center gap-2 rounded-md px-1.5 text-[11.5px] tabular-nums",
            "text-content-subtle transition-colors hover:bg-surface-hover hover:text-content-muted",
          )}
        >
          {avgCache != null && (
            <span
              className="flex items-center gap-1"
              title={t("chatStream.metrics.cache", { avg: fmtPct(avgCache), turn: fmtPct(turnCache) })}
            >
              <IconBolt size={11} className="shrink-0" />
              <b className="font-medium">{fmtPct(avgCache)}</b>
            </span>
          )}
          {avgSpeed != null && (
            <span
              className="flex items-center gap-1"
              title={t("chatStream.metrics.speed", {
                avg: fmtSpeed(avgSpeed),
                turn: fmtSpeed(turnTokPerSec),
              })}
            >
              <IconGauge size={11} className="shrink-0" />
              <b className="font-medium">{fmtSpeed(avgSpeed)}</b>
              <em className="not-italic text-content-subtle/80">tok/s</em>
            </span>
          )}
          {snapshot && (
            <span className="sr-only">
              {t("chatStream.metrics.context", {
                used: fmtTokens(snapshot.usedTokens),
                max: fmtTokens(snapshot.maxTokens),
              })}
            </span>
          )}
        </button>
      )}
    </span>
  );
}
