/**
 * Skill marketplace dialog (TODO-020), opened from the Skills settings panel.
 *
 * Lists every market (builtin anthropics/skills + user-added git / local
 * sources) with the skills found in its materialized tree. Installing copies
 * the skill folder into ~/.mcode/skills (main side), after which the parent
 * panel refreshes its list via `onInstalled`.
 */
import { useCallback, useEffect, useId, useMemo, useState } from "react";
import type { SkillMarketEntry, SkillMarketState } from "@contracts/ipc";
import { api } from "@renderer/lib/api.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { useToastStore } from "@renderer/stores/toastStore.js";
import { Button, ConfirmDialog, Dialog, Input } from "@renderer/components/ui/index.js";
import {
  IconCheck,
  IconDownload,
  IconLoader2,
  IconPlus,
  IconRefresh,
  IconSearch,
  IconTrash,
} from "@renderer/lib/icons.js";

const EMPTY_MARKETS: SkillMarketState[] = [];

function matches(s: SkillMarketEntry, q: string): boolean {
  if (!q) return true;
  return s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q);
}

export function SkillMarketDialog({
  open,
  onOpenChange,
  onInstalled,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onInstalled: () => void;
}) {
  const { t } = useI18n();
  const searchId = useId();
  const addId = useId();
  const [markets, setMarkets] = useState<SkillMarketState[]>(EMPTY_MARKETS);
  const [loading, setLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  /** Market ids currently refreshing. */
  const [refreshing, setRefreshing] = useState<ReadonlySet<string>>(() => new Set());
  /** `${marketId}:${relPath}` keys currently installing. */
  const [installing, setInstalling] = useState<ReadonlySet<string>>(() => new Set());
  const [addUrl, setAddUrl] = useState("");
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [pendingRemove, setPendingRemove] = useState<SkillMarketState | null>(null);

  const reload = useCallback(async () => {
    try {
      const res = await api.skills.marketList({});
      setMarkets(res.markets.length ? res.markets : EMPTY_MARKETS);
      setListError(null);
    } catch (err) {
      setListError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setAddError(null);
    void reload().finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [open, reload]);

  const q = query.trim().toLowerCase();
  const filtered = useMemo(
    () => markets.map((m) => ({ market: m, skills: m.skills.filter((s) => matches(s, q)) })),
    [markets, q],
  );

  const setBusy = (
    setter: React.Dispatch<React.SetStateAction<ReadonlySet<string>>>,
    key: string,
    on: boolean,
  ) =>
    setter((prev) => {
      const next = new Set(prev);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });

  const refresh = async (m: SkillMarketState) => {
    setBusy(setRefreshing, m.id, true);
    try {
      await api.skills.marketRefresh({ id: m.id });
      // Errors are recorded per market main-side and surface via the list.
    } catch (err) {
      setListError((err as Error).message);
    } finally {
      await reload();
      setBusy(setRefreshing, m.id, false);
    }
  };

  const install = async (s: SkillMarketEntry) => {
    const key = `${s.marketId}:${s.relPath}`;
    setBusy(setInstalling, key, true);
    try {
      const res = await api.skills.marketInstall({ marketId: s.marketId, relPath: s.relPath, name: s.name });
      if (res.ok) {
        useToastStore.getState().push({ kind: "info", title: t("settings.skillMarket.installOk", { name: s.name }) });
        onInstalled();
        await reload();
      } else {
        useToastStore.getState().push({
          kind: "warning",
          title: t("settings.skillMarket.installFailed"),
          body: res.error,
        });
      }
    } catch (err) {
      useToastStore.getState().push({
        kind: "warning",
        title: t("settings.skillMarket.installFailed"),
        body: (err as Error).message,
      });
    } finally {
      setBusy(setInstalling, key, false);
    }
  };

  const add = async () => {
    const url = addUrl.trim();
    if (!url) return;
    setAdding(true);
    setAddError(null);
    try {
      const res = await api.skills.marketAdd({ url });
      if (res.ok) {
        setAddUrl("");
        useToastStore.getState().push({ kind: "info", title: t("settings.skillMarket.addOk") });
        await reload();
      } else {
        setAddError(res.error ?? t("settings.saveFailed"));
      }
    } catch (err) {
      setAddError((err as Error).message);
    } finally {
      setAdding(false);
    }
  };

  const confirmRemove = async () => {
    const m = pendingRemove;
    setPendingRemove(null);
    if (!m) return;
    try {
      const res = await api.skills.marketRemove({ id: m.id });
      if (!res.ok) setListError(res.error ?? t("settings.deleteFailed"));
    } catch (err) {
      setListError((err as Error).message);
    } finally {
      await reload();
    }
  };

  return (
    <>
      <Dialog.Root open={open} onOpenChange={onOpenChange}>
        <Dialog.Portal>
          <Dialog.Backdrop />
          <Dialog.Popup className="flex max-h-[80vh] w-[640px] flex-col p-0">
            <Dialog.Title className="px-4 pt-4">{t("settings.skillMarket.title")}</Dialog.Title>
            <Dialog.Description className="px-4 pt-1">{t("settings.skillMarket.desc")}</Dialog.Description>
            <Dialog.Close />

            {/* Search */}
            <div className="px-4 pt-3">
              <label htmlFor={searchId} className="sr-only">
                {t("settings.skillMarket.searchLabel")}
              </label>
              <div className="relative">
                <IconSearch
                  size={13}
                  className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-content-subtle"
                  aria-hidden
                />
                <Input
                  id={searchId}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={t("settings.skillMarket.searchPlaceholder")}
                  className="pl-7"
                  spellCheck={false}
                />
              </div>
            </div>

            {/* Markets */}
            <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3">
              {loading && markets.length === 0 ? (
                <div className="flex items-center justify-center gap-2 py-8 text-[0.7857em] text-content-subtle">
                  <IconLoader2 size={14} className="animate-spin" />
                  {t("settings.skillMarket.loading")}
                </div>
              ) : markets.length === 0 ? (
                <div className="py-8 text-center text-[0.7857em] text-content-subtle">
                  {t("settings.skillMarket.empty")}
                </div>
              ) : (
                filtered.map(({ market: m, skills }) => {
                  const busy = refreshing.has(m.id);
                  const isGithub = /^https:\/\/github\.com\//i.test(m.url);
                  return (
                    <section
                      key={m.id}
                      aria-label={m.name}
                      className="rounded-md border border-edge bg-surface/40"
                    >
                      <header className="flex items-start gap-2 border-b border-edge/60 px-2.5 py-2">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-baseline gap-1.5">
                            <span className="truncate text-[0.8571em] font-medium text-content">{m.name}</span>
                            {m.builtin && (
                              <span className="shrink-0 rounded bg-surface-hover px-1 text-[11px] text-content-subtle">
                                {t("settings.skillMarket.builtin")}
                              </span>
                            )}
                            {m.fetchedAt && (
                              <span className="shrink-0 tabular-nums text-[0.7143em] text-content-subtle">
                                {t("settings.skillMarket.skillCount", { n: m.skills.length })}
                              </span>
                            )}
                          </div>
                          <div className="truncate text-[0.7143em] text-content-subtle" title={m.url}>
                            {m.url}
                          </div>
                          <div className="text-[0.7143em] text-content-subtle">
                            {m.fetchedAt
                              ? t("settings.skillMarket.fetchedAt", { time: new Date(m.fetchedAt).toLocaleString() })
                              : t("settings.skillMarket.notFetched")}
                          </div>
                          {m.error && (
                            <div className="mt-0.5 break-words text-[0.7143em] text-warning">{m.error}</div>
                          )}
                        </div>
                        <div className="flex shrink-0 items-center gap-1">
                          {m.fetchedAt && (
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => void refresh(m)}
                              disabled={busy}
                              aria-label={t("settings.skillMarket.refreshAria", { name: m.name })}
                            >
                              {busy ? (
                                <IconLoader2 size={12} className="animate-spin" />
                              ) : (
                                <IconRefresh size={12} />
                              )}
                              {t("settings.skillMarket.refresh")}
                            </Button>
                          )}
                          {!m.builtin && (
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => setPendingRemove(m)}
                              disabled={busy}
                              aria-label={t("settings.skillMarket.removeAria", { name: m.name })}
                            >
                              <IconTrash size={12} />
                              {t("settings.skillMarket.remove")}
                            </Button>
                          )}
                        </div>
                      </header>

                      {!m.fetchedAt ? (
                        <div className="flex flex-col items-center gap-1.5 px-2.5 py-4">
                          <Button variant="primary" size="sm" onClick={() => void refresh(m)} disabled={busy}>
                            {busy ? (
                              <IconLoader2 size={12} className="animate-spin" />
                            ) : (
                              <IconDownload size={12} />
                            )}
                            {busy ? t("settings.skillMarket.fetching") : t("settings.skillMarket.fetch")}
                          </Button>
                          {isGithub && (
                            <span className="text-[0.7143em] text-content-subtle">
                              {t("settings.skillMarket.githubHint")}
                            </span>
                          )}
                        </div>
                      ) : skills.length === 0 ? (
                        <div className="px-2.5 py-3 text-center text-[0.7143em] text-content-subtle">
                          {m.skills.length === 0 ? t("settings.skillMarket.noSkills") : t("settings.skillMarket.noMatch")}
                        </div>
                      ) : (
                        <ul className="divide-y divide-edge/40">
                          {skills.map((s) => {
                            const key = `${s.marketId}:${s.relPath}`;
                            const isInstalling = installing.has(key);
                            return (
                              <li key={key} className="flex items-start gap-2 px-2.5 py-1.5">
                                <div className="min-w-0 flex-1">
                                  <div className="truncate text-[0.7857em] font-medium text-content" title={s.relPath}>
                                    {s.name}
                                  </div>
                                  <p className="line-clamp-2 text-[0.7143em] leading-relaxed text-content-subtle">
                                    {s.description || t("settings.skills.noDesc")}
                                  </p>
                                </div>
                                {s.installed ? (
                                  <Button variant="ghost" size="sm" disabled className="shrink-0">
                                    <IconCheck size={12} />
                                    {t("settings.skillMarket.installed")}
                                  </Button>
                                ) : (
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    className="shrink-0"
                                    onClick={() => void install(s)}
                                    disabled={isInstalling}
                                    aria-label={t("settings.skillMarket.installAria", { name: s.name })}
                                  >
                                    {isInstalling ? (
                                      <IconLoader2 size={12} className="animate-spin" />
                                    ) : (
                                      <IconDownload size={12} />
                                    )}
                                    {isInstalling ? t("settings.skillMarket.installing") : t("settings.skillMarket.install")}
                                  </Button>
                                )}
                              </li>
                            );
                          })}
                        </ul>
                      )}
                    </section>
                  );
                })
              )}
              {listError && <div className="text-[0.7857em] text-danger">{listError}</div>}
            </div>

            {/* Add source */}
            <div className="border-t border-edge px-4 py-3">
              <label htmlFor={addId} className="mb-1 block text-[0.7857em] font-medium text-content-muted">
                {t("settings.skillMarket.addLabel")}
              </label>
              <form
                className="flex items-center gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  void add();
                }}
              >
                <Input
                  id={addId}
                  value={addUrl}
                  onChange={(e) => setAddUrl(e.target.value)}
                  placeholder={t("settings.skillMarket.addPlaceholder")}
                  className="min-w-0 flex-1 font-mono"
                  spellCheck={false}
                  disabled={adding}
                  error={!!addError}
                />
                <Button type="submit" variant="primary" size="sm" disabled={adding || !addUrl.trim()}>
                  {adding ? <IconLoader2 size={12} className="animate-spin" /> : <IconPlus size={12} />}
                  {adding ? t("settings.skillMarket.adding") : t("settings.skillMarket.add")}
                </Button>
              </form>
              {addError && (
                <div role="alert" className="mt-1 break-words text-[0.7143em] text-danger">
                  {addError}
                </div>
              )}
            </div>
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>

      <ConfirmDialog
        open={pendingRemove != null}
        title={t("settings.skillMarket.removeTitle")}
        danger
        description={t("settings.skillMarket.removeDesc", { name: pendingRemove?.name ?? "" })}
        confirmText={t("settings.skillMarket.remove")}
        onOpenChange={(o) => {
          if (!o) setPendingRemove(null);
        }}
        onConfirm={() => void confirmRemove()}
      />
    </>
  );
}
