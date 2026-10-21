import { useEffect, useMemo, useState } from "react";
import {
  BUILTIN_RELAY_FALLBACK_CONFIG,
  RELAY_CONFIG_VERSION,
  diffRelayConfigs,
  type BuiltinRelayStatus,
  type RelayConfig,
  type RelayConfigModel,
} from "@contracts/builtinRelay";
import type { SharedProviderProtocol } from "@contracts/sharedProvider";
import { api } from "@renderer/lib/api.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { useToastStore } from "@renderer/stores/toastStore.js";
import { Button, Dialog, Input } from "@renderer/components/ui/index.js";
import {
  IconAlertTriangle,
  IconCheck,
  IconLoader2,
  IconLock,
  IconPlus,
  IconRefresh,
  IconShieldLock,
  IconTrash,
} from "@renderer/lib/icons.js";
import { cn } from "@renderer/lib/cn.js";

/**
 * 中转站管理面板 — the administrator side of TODO-074, shown in 设置 → 关于.
 *
 * Edits the model list that the built-in relay card publishes and pushes it to
 * the relay server, which overwrites the previous document (no history by
 * design). The address is displayed but never editable: it is a code constant,
 * so a compromised admin token cannot repoint anyone's key.
 *
 * Everything the user submits is re-validated in the main process with
 * `RelayConfigSchema`; the local checks here exist only to keep obviously
 * broken drafts from making a round trip.
 */
const PROTOCOLS: SharedProviderProtocol[] = ["anthropic", "chat-completions", "responses"];
const SHORT: Record<SharedProviderProtocol, string> = { anthropic: "Messages", "chat-completions": "Chat", responses: "Responses" };

export function RelayAdminPanel() {
  const { t } = useI18n();
  const [status, setStatus] = useState<BuiltinRelayStatus | null>(null);
  const [name, setName] = useState("");
  const [models, setModels] = useState<RelayConfigModel[]>([]);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState<"load" | "refresh" | "push" | "token" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingPush, setPendingPush] = useState<ReturnType<typeof diffRelayConfigs> | null>(null);

  function adopt(next: BuiltinRelayStatus) {
    setStatus(next);
    setName(next.config.name ?? BUILTIN_RELAY_FALLBACK_CONFIG.name ?? "");
    setModels(next.config.models.map((model) => ({ ...model })));
  }

  useEffect(() => {
    let mounted = true;
    setBusy("load");
    void Promise.resolve()
      .then(() => api.builtinRelay.status())
      .then((next) => {
        if (mounted) adopt(next);
      })
      .catch((e: unknown) => {
        if (mounted) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (mounted) setBusy(null);
      });
    return () => {
      mounted = false;
    };
  }, []);

  /** Build the draft config; null when it cannot be valid (no models, blank or
   *  duplicate ids, a model with no interface). Main validates again. */
  const draftConfig: RelayConfig | null = useMemo(() => {
    const cleaned: RelayConfigModel[] = models
      .map((model) => {
        const next: RelayConfigModel = { ...model, id: model.id.trim() };
        const label = model.label?.trim();
        if (label) next.label = label;
        else delete next.label;
        return next;
      })
      .filter((model) => model.id.length > 0);
    if (cleaned.length === 0) return null;
    if (new Set(cleaned.map((model) => model.id)).size !== cleaned.length) return null;
    if (cleaned.some((model) => model.interfaces !== undefined && model.interfaces.length === 0)) return null;
    return {
      version: RELAY_CONFIG_VERSION,
      ...(name.trim() ? { name: name.trim() } : {}),
      models: cleaned,
    };
  }, [models, name]);

  const diff = useMemo(
    () => (status && draftConfig ? diffRelayConfigs(status.config, draftConfig) : null),
    [status, draftConfig],
  );
  const dirty = !!diff && diff.added.length + diff.changed.length + diff.removed.length > 0;

  function updateModel(index: number, patch: Partial<RelayConfigModel>) {
    setModels((current) => current.map((model, i) => (i === index ? { ...model, ...patch } : model)));
  }

  async function refreshOnline() {
    setBusy("refresh");
    setError(null);
    try {
      adopt(await api.builtinRelay.refresh());
      useToastStore.getState().push({ kind: "info", title: t("settings.about.relay.refreshed"), duration: 4_000 });
    } catch (e) {
      const raw = e instanceof Error ? e.message : String(e);
      setError(raw.replace(/^Error invoking remote method '[^']*':\s*(?:Error:\s*)?/, ""));
    } finally {
      setBusy(null);
    }
  }

  async function saveToken() {
    if (!token.trim()) return;
    setBusy("token");
    setError(null);
    try {
      adopt(await api.builtinRelay.setAdminToken({ token: token.trim() }));
      setToken("");
      useToastStore.getState().push({ kind: "info", title: t("settings.about.relay.tokenSaved"), duration: 4_000 });
    } catch (e) {
      const raw = e instanceof Error ? e.message : String(e);
      setError(raw.replace(/^Error invoking remote method '[^']*':\s*(?:Error:\s*)?/, ""));
    } finally {
      setBusy(null);
    }
  }

  async function clearToken() {
    setBusy("token");
    setError(null);
    try {
      adopt(await api.builtinRelay.clearAdminToken());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function push() {
    if (!draftConfig) return;
    setBusy("push");
    setError(null);
    try {
      const result = await api.builtinRelay.push({ config: draftConfig });
      adopt(result.status);
      setPendingPush(null);
      useToastStore.getState().push({
        kind: "info",
        title: t("settings.about.relay.pushOk", { n: result.status.config.models.length }),
        duration: 5_000,
      });
      // Clients (including this app) read the published document; refresh the
      // shared-provider catalogs so the new list is live without a restart.
      await api.sharedProviders.list();
    } catch (e) {
      const raw = e instanceof Error ? e.message : String(e);
      setError(raw.replace(/^Error invoking remote method '[^']*':\s*(?:Error:\s*)?/, ""));
      setPendingPush(null);
    } finally {
      setBusy(null);
    }
  }

  const locked = busy !== null;

  return (
    <div className="mt-8 w-full max-w-md space-y-3" data-relay-admin>
      <div className="flex items-center gap-2">
        <IconShieldLock size={14} className="shrink-0 text-content-subtle" />
        <h3 className="text-[13px] font-semibold text-content">{t("settings.about.relay.title")}</h3>
        <span className="ml-auto text-[11.5px] text-content-subtle">
          {status ? t(`settings.shared.relay.source.${status.source}`) : ""}
        </span>
      </div>

      {error && (
        <p role="alert" className="break-words rounded-lg bg-danger/10 px-3 py-2 text-[12.5px] text-danger">
          {error}
        </p>
      )}

      {/* Admin token */}
      <div className="rounded-lg border border-edge p-3">
        <div className="mb-2 flex items-center gap-2">
          <span className="text-[12px] font-medium text-content-muted">{t("settings.about.relay.adminToken")}</span>
          <span
            className={cn(
              "h-1.5 w-1.5 rounded-full",
              status?.hasAdminToken ? "bg-accent" : "bg-warning",
            )}
            aria-hidden
          />
          <span className="text-[11.5px] text-content-subtle">
            {t(status?.hasAdminToken ? "settings.about.relay.tokenSet" : "settings.about.relay.tokenMissing")}
          </span>
          {status?.hasAdminToken && (
            <Button type="button" size="sm" variant="ghost" className="ml-auto text-danger hover:bg-danger/10" disabled={locked} onClick={() => void clearToken()}>
              {t("settings.about.relay.tokenClear")}
            </Button>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Input
            type="password"
            autoComplete="new-password"
            spellCheck={false}
            className="min-w-0 flex-1 font-mono"
            value={token}
            disabled={locked}
            placeholder={t("settings.about.relay.tokenPlaceholder")}
            onChange={(e) => setToken(e.target.value)}
          />
          <Button type="button" size="sm" disabled={locked || token.trim().length === 0} onClick={() => void saveToken()}>
            {t("settings.about.relay.tokenSave")}
          </Button>
        </div>
        <p className="mt-2 text-[11.5px] leading-relaxed text-content-subtle">{t("settings.about.relay.tokenHint")}</p>
      </div>

      {/* Address (locked) */}
      <div className="rounded-lg border border-edge p-3">
        <div className="mb-1.5 flex items-center gap-1.5 text-[12px] font-medium text-content-muted">
          <IconLock size={11} className="text-content-subtle" />
          {t("settings.shared.baseUrlShort")}
        </div>
        <div className="break-all rounded-md bg-surface-muted px-2 py-1.5 font-mono text-[12px] text-content-muted">
          {status?.baseUrl ?? "—"}
        </div>
        <p className="mt-2 text-[11.5px] leading-relaxed text-content-subtle">{t("settings.shared.relay.baseUrlLocked")}</p>
      </div>

      {/* Published model list */}
      <div className="rounded-lg border border-edge">
        <div className="flex items-center gap-2 border-b border-edge px-3 py-2">
          <span className="text-[12px] font-medium text-content-muted">
            {t("settings.about.relay.models", { n: models.length })}
          </span>
          <span className="ml-auto flex items-center gap-1">
            <Button type="button" size="sm" variant="ghost" disabled={locked} onClick={() => void refreshOnline()}>
              {busy === "refresh" ? <IconLoader2 size={13} className="animate-spin" /> : <IconRefresh size={13} />}
              {t("settings.about.relay.pullOnline")}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={locked}
              onClick={() => setModels((current) => [...current, { id: "", interfaces: [...PROTOCOLS] }])}
            >
              <IconPlus size={13} />{t("settings.shared.addModel")}
            </Button>
          </span>
        </div>
        <ul className="divide-y divide-edge">
          {models.map((model, index) => (
            <li key={index} className="space-y-2 px-3 py-2">
              <div className="flex items-center gap-2">
                <Input
                  aria-label={t("settings.shared.modelId")}
                  placeholder="gpt-5.1"
                  spellCheck={false}
                  className="min-w-0 flex-1 font-mono"
                  value={model.id}
                  disabled={locked}
                  onChange={(e) => updateModel(index, { id: e.target.value })}
                />
                <Input
                  aria-label={t("settings.shared.modelLabel")}
                  placeholder={t("settings.shared.modelLabelShort")}
                  className="w-[150px] shrink-0"
                  value={model.label ?? ""}
                  disabled={locked}
                  onChange={(e) => updateModel(index, { label: e.target.value })}
                />
                <Input
                  type="number"
                  min={1}
                  step={1000}
                  aria-label={t("settings.shared.contextWindow")}
                  placeholder="200000"
                  className="w-[100px] shrink-0"
                  value={model.contextWindow ?? ""}
                  disabled={locked}
                  onChange={(e) => updateModel(index, { contextWindow: e.target.value ? Number(e.target.value) : undefined })}
                />
                <button
                  type="button"
                  title={t("settings.shared.removeModel")}
                  aria-label={t("settings.shared.removeModel")}
                  disabled={locked}
                  onClick={() => setModels((current) => current.filter((_, i) => i !== index))}
                  className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-content-subtle transition-colors hover:bg-danger/10 hover:text-danger disabled:opacity-40"
                >
                  <IconTrash size={14} />
                </button>
              </div>
              <div className="flex flex-wrap items-center gap-1.5 pl-1 text-[11.5px] text-content-subtle">
                {PROTOCOLS.map((protocol) => {
                  const on = (model.interfaces ?? PROTOCOLS).includes(protocol);
                  return (
                    <button
                      key={protocol}
                      type="button"
                      aria-pressed={on}
                      disabled={locked || (on && (model.interfaces ?? PROTOCOLS).length === 1)}
                      onClick={() =>
                        updateModel(index, {
                          interfaces: on
                            ? (model.interfaces ?? PROTOCOLS).filter((value) => value !== protocol)
                            : [...new Set([...(model.interfaces ?? PROTOCOLS), protocol])],
                        })
                      }
                      className={cn(
                        "h-6 rounded-md border px-2 transition-colors",
                        on ? "border-accent/45 bg-accent/10 text-content" : "border-edge text-content-subtle hover:text-content",
                      )}
                    >
                      {SHORT[protocol]}
                    </button>
                  );
                })}
                <span className="mx-0.5 h-4 w-px bg-edge" aria-hidden />
                <button
                  type="button"
                  aria-pressed={model.reasoning ?? false}
                  disabled={locked}
                  onClick={() => updateModel(index, { reasoning: model.reasoning ? undefined : true })}
                  className={cn(
                    "h-6 rounded-md border px-2 transition-colors",
                    model.reasoning ? "border-accent/45 bg-accent/10 text-content" : "border-edge text-content-subtle hover:text-content",
                  )}
                >
                  {t("settings.shared.reasoning")}
                </button>
                <button
                  type="button"
                  aria-pressed={model.input?.includes("image") ?? false}
                  disabled={locked}
                  onClick={() => updateModel(index, { input: model.input?.includes("image") ? ["text"] : ["text", "image"] })}
                  className={cn(
                    "h-6 rounded-md border px-2 transition-colors",
                    model.input?.includes("image") ? "border-accent/45 bg-accent/10 text-content" : "border-edge text-content-subtle hover:text-content",
                  )}
                >
                  {t("settings.shared.vision")}
                </button>
              </div>
            </li>
          ))}
        </ul>
        <div className="flex items-center gap-2 border-t border-edge px-3 py-2">
          <span className="min-w-0 flex-1 truncate text-[11.5px] text-content-subtle">
            {status?.updatedAt
              ? t("settings.about.relay.onlineAt", { at: new Date(status.updatedAt).toLocaleString() })
              : t("settings.about.relay.neverPublished")}
          </span>
          <Button
            type="button"
            size="sm"
            variant="primary"
            disabled={locked || !draftConfig || !status?.hasAdminToken}
            onClick={() => draftConfig && setPendingPush(diffRelayConfigs(status?.config ?? BUILTIN_RELAY_FALLBACK_CONFIG, draftConfig))}
          >
            {busy === "push" && <IconLoader2 size={13} className="animate-spin" />}
            {t("settings.about.relay.push")}
          </Button>
        </div>
        {dirty && (
          <p className="border-t border-edge px-3 py-2 text-[11.5px] text-warning">{t("settings.about.relay.dirty")}</p>
        )}
      </div>

      <Dialog.Root open={pendingPush !== null} onOpenChange={(open) => { if (!open) setPendingPush(null); }}>
        <Dialog.Portal>
          <Dialog.Backdrop />
          <Dialog.Popup className="w-[520px] max-w-[92vw] p-0">
            <Dialog.Title className="px-4 pt-4">{t("settings.about.relay.diffTitle")}</Dialog.Title>
            <Dialog.Description className="px-4 pt-1">{t("settings.about.relay.diffHint")}</Dialog.Description>
            <Dialog.Close aria-label={t("common.cancel")} />
            <div className="mt-3 max-h-[340px] space-y-1 overflow-y-auto border-y border-edge px-4 py-3 text-[12.5px]">
              {pendingPush && pendingPush.added.length + pendingPush.changed.length + pendingPush.removed.length === 0 && (
                <p className="flex items-center gap-1.5 text-content-subtle">
                  <IconCheck size={13} className="text-accent" />
                  {t("settings.about.relay.diffNone")}
                </p>
              )}
              {pendingPush?.added.map((model) => (
                <p key={`a-${model.id}`} className="flex items-center gap-2">
                  <span className="w-12 shrink-0 text-[11px] font-medium text-accent-strong">+</span>
                  <span className="truncate font-mono">{model.id}</span>
                </p>
              ))}
              {pendingPush?.changed.map((model) => (
                <p key={`c-${model.id}`} className="flex items-center gap-2">
                  <span className="w-12 shrink-0 text-[11px] font-medium text-warning">~</span>
                  <span className="truncate font-mono">{model.id}</span>
                </p>
              ))}
              {pendingPush?.removed.map((model) => (
                <p key={`r-${model.id}`} className="flex items-center gap-2">
                  <span className="w-12 shrink-0 text-[11px] font-medium text-danger">−</span>
                  <span className="truncate font-mono">{model.id}</span>
                </p>
              ))}
              {(pendingPush?.removed.length ?? 0) > 0 && (
                <p className="mt-2 flex items-start gap-1.5 rounded-md bg-warning/10 px-2 py-1.5 text-[11.5px] leading-relaxed text-warning">
                  <IconAlertTriangle size={13} className="mt-[1px] shrink-0" />
                  {t("settings.about.relay.diffRemoved")}
                </p>
              )}
            </div>
            <div className="flex justify-end gap-2 p-4">
              <Button type="button" size="sm" variant="ghost" onClick={() => setPendingPush(null)}>{t("common.cancel")}</Button>
              <Button type="button" size="sm" variant="primary" disabled={busy !== null} onClick={() => void push()}>
                {t("settings.about.relay.diffConfirm")}
              </Button>
            </div>
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}
