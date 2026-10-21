import { useEffect, useState } from "react";
import type { SharedProviderPublic } from "@contracts/sharedProvider";
import {
  BUILTIN_RELAY_ID,
  isBuiltinRelayId,
  type BuiltinRelayStatus,
  type RelayConfig,
} from "@contracts/builtinRelay";
import { api } from "@renderer/lib/api.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { useToastStore } from "@renderer/stores/toastStore.js";
import { Button, Input } from "@renderer/components/ui/index.js";
import {
  IconCheck,
  IconLoader2,
  IconLock,
  IconRefresh,
  IconShieldLock,
  IconBrain,
  IconPhoto,
} from "@renderer/lib/icons.js";
import { cn } from "@renderer/lib/cn.js";

/**
 * 内置「中转站」— the one provider card MarioCode ships with (TODO-074).
 *
 * Deliberately NOT the generic provider form: address, protocols, engines and
 * the model list are all fixed (code constants + remotely published config),
 * so the only editable field is the user's personal API Key. Rendering a
 * disabled copy of the full form would have invited "why can't I edit this"
 * and made the address look user-editable; this is one small, explicit panel.
 */
/** Display names for the fixed engine list (the card never lets you pick). */
const AGENT_LABELS: Record<SharedProviderPublic["enabledAgents"][number], string> = {
  claude: "Claude",
  codex: "Codex",
  pi: "Pi",
};

export function BuiltinRelaySection({
  provider,
  busy,
  onSaved,
}: {
  provider: SharedProviderPublic;
  busy: boolean;
  /** Hands the refreshed provider list back to the panel so its left column,
   *  key indicator and model catalogs stay in sync after a save. */
  onSaved: (providers: SharedProviderPublic[]) => void;
}) {
  const { t } = useI18n();
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<BuiltinRelayStatus | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  /** Status is display-only decoration (source + updatedAt); a transport that
   *  doesn't expose it (mobile web shim) must not break the panel. */
  const loadStatus = () =>
    Promise.resolve()
      .then(() => api.builtinRelay.status())
      .then(setStatus)
      .catch(() => setStatus(null));
  useEffect(() => {
    void loadStatus();
  }, []);

  const config: RelayConfig | null = status?.config ?? null;
  const models = config?.models ?? provider.models;
  const locked = busy || saving || refreshing;
  const keyStored = provider.hasApiKey;
  const canSave = !locked && apiKey.trim().length > 0;

  async function save() {
    if (!canSave) return;
    setSaving(true);
    setError(null);
    setTestResult(null);
    try {
      const result = await api.sharedProviders.save({
        id: provider.id,
        name: provider.name,
        baseUrl: provider.baseUrl,
        protocols: provider.protocols,
        // Sent so the ordinary save path validates; main ignores every field
        // except the key for the built-in relay.
        models: provider.models,
        enabledAgents: provider.enabledAgents,
        apiKey: apiKey.trim(),
      });
      setApiKey("");
      onSaved(result.providers);
      // The key is the only thing that changed, so prove it works while the
      // user is still looking at the field.
      await test();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  async function test() {
    setTestResult(null);
    try {
      const result = await api.sharedProviders.discoverModels({
        id: BUILTIN_RELAY_ID,
        baseUrl: provider.baseUrl,
        protocol: "chat-completions",
      });
      setTestResult({ ok: true, text: t("settings.shared.relay.testOk", { n: result.models.length }) });
    } catch (e) {
      const raw = e instanceof Error ? e.message : String(e);
      const message = raw.replace(/^Error invoking remote method '[^']*':\s*(?:Error:\s*)?/, "");
      setTestResult({ ok: false, text: t("settings.shared.relay.testFailed", { error: message }) });
    }
  }

  async function refreshConfig() {
    setRefreshing(true);
    setError(null);
    try {
      const next = await api.builtinRelay.refresh();
      setStatus(next);
      const providers = await api.sharedProviders.list();
      onSaved(providers.providers);
      useToastStore.getState().push({
        kind: "info",
        title: t("settings.shared.relay.refreshed", { n: next.config.models.length }),
        duration: 4_000,
      });
    } catch (e) {
      const raw = e instanceof Error ? e.message : String(e);
      setError(raw.replace(/^Error invoking remote method '[^']*':\s*(?:Error:\s*)?/, ""));
    } finally {
      setRefreshing(false);
    }
  }

  const sourceLabel = status
    ? t(`settings.shared.relay.source.${status.source}`)
    : t("settings.shared.relay.source.cache");

  return (
    <div className="flex min-w-0 flex-col">
      {/* Header — same shape as the generic provider form. */}
      <div className="flex items-center gap-3 border-b border-edge px-6 py-3.5">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-accent/12 text-accent-strong">
          <IconShieldLock size={18} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <span className="truncate text-[14px] font-semibold text-content">{provider.name}</span>
            <span className="shrink-0 rounded-md bg-accent/12 px-1.5 py-0.5 text-[10.5px] font-medium text-accent-strong">
              {t("settings.shared.relay.badge")}
            </span>
          </span>
          <span className="block truncate font-mono text-[11.5px] text-content-subtle">{provider.baseUrl.replace(/^https?:\/\//, "")}</span>
        </span>
        <Button type="button" variant="ghost" size="sm" disabled={locked} onClick={() => void test()}>
          {t("settings.shared.relay.test")}
        </Button>
        <Button type="button" variant="primary" size="sm" disabled={!canSave} onClick={() => void save()}>
          {saving && <IconLoader2 size={13} className="animate-spin" />}
          {t("settings.shared.relay.saveAndTest")}
        </Button>
      </div>

      <div className="min-w-0 flex-1 space-y-7 p-6">
        {error && <p role="alert" className="break-words rounded-lg bg-danger/10 px-3 py-2.5 text-[13px] text-danger">{error}</p>}
        {testResult && (
          <p
            role="status"
            className={cn(
              "break-words rounded-lg px-3 py-2.5 text-[12.5px]",
              testResult.ok ? "bg-accent/10 text-accent-strong" : "bg-warning/10 text-warning",
            )}
          >
            {testResult.text}
          </p>
        )}

        {/* 你的密钥 — the only editable field. */}
        <section className="space-y-3">
          <h3 className="text-[13px] font-semibold text-content">{t("settings.shared.relay.sectionKey")}</h3>
          <label className="block min-w-0">
            <span className="mb-1.5 block text-[12px] font-medium text-content-muted">{t("settings.shared.relay.apiKey")}</span>
            <div className="relative">
              <IconShieldLock size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-content-subtle" />
              <Input
                type="password"
                autoComplete="new-password"
                spellCheck={false}
                className={cn("pl-8 font-mono", keyStored && "pr-[92px]")}
                value={apiKey}
                disabled={locked}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={t(keyStored ? "settings.shared.relay.keepKey" : "settings.shared.relay.enterKey")}
              />
              {keyStored && (
                <span className="pointer-events-none absolute right-2 top-1/2 flex -translate-y-1/2 items-center gap-1 rounded-md bg-accent/10 px-1.5 py-0.5 text-[11px] font-medium text-accent-strong">
                  <IconCheck size={11} />{t("settings.shared.keyStoredShort")}
                </span>
              )}
            </div>
            <span className="mt-1.5 block text-[11.5px] leading-relaxed text-content-subtle">
              {t("settings.shared.relay.keyHint")}
            </span>
          </label>
        </section>

        {/* 接口与协议 — read-only by design. */}
        <section className="space-y-3">
          <h3 className="text-[13px] font-semibold text-content">{t("settings.shared.relay.sectionEndpoint")}</h3>
          <label className="block min-w-0">
            <span className="mb-1.5 block text-[12px] font-medium text-content-muted">{t("settings.shared.baseUrlShort")}</span>
            <div className="relative">
              <IconLock size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-content-subtle" />
              <Input readOnly disabled value={status?.baseUrl ?? provider.baseUrl} className="pl-8 font-mono" />
            </div>
            <span className="mt-1.5 block text-[11.5px] leading-relaxed text-content-subtle">{t("settings.shared.relay.baseUrlLocked")}</span>
          </label>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <div className="mb-1.5 text-[12px] font-medium text-content-muted">{t("settings.shared.protocols")}</div>
              <div className="flex flex-wrap gap-1.5">
                {provider.protocols.map((protocol) => (
                  <span key={protocol} className="inline-flex h-7 items-center gap-1 rounded-lg border border-edge bg-surface-muted px-2.5 text-[12px] text-content-muted">
                    <IconLock size={11} className="text-content-subtle" />{protocol}
                  </span>
                ))}
              </div>
            </div>
            <div>
              <div className="mb-1.5 text-[12px] font-medium text-content-muted">{t("settings.shared.agents")}</div>
              <div className="flex flex-wrap gap-1.5">
                {provider.enabledAgents.map((agent) => (
                  <span key={agent} className="inline-flex h-7 items-center gap-1 rounded-lg border border-edge bg-surface-muted px-2.5 text-[12px] text-content-muted">
                    <IconLock size={11} className="text-content-subtle" />{AGENT_LABELS[agent]}
                  </span>
                ))}
              </div>
            </div>
          </div>
        </section>

        {/* 模型 — delivered, never edited here. */}
        <section className="space-y-3">
          <div className="flex min-h-7 items-center gap-2">
            <h3 className="text-[13px] font-semibold text-content">{`${t("settings.shared.models")} · ${models.length}`}</h3>
            <span className="ml-auto flex items-center gap-2">
              <span className="text-[11.5px] text-content-subtle">{sourceLabel}</span>
              <Button type="button" size="sm" variant="ghost" disabled={locked} onClick={() => void refreshConfig()}>
                {refreshing ? <IconLoader2 size={13} className="animate-spin" /> : <IconRefresh size={13} />}
                {t("settings.shared.relay.refresh")}
              </Button>
            </span>
          </div>
          <div className="overflow-hidden rounded-lg border border-edge">
            <ul className="divide-y divide-edge">
              {models.map((model) => (
                <li key={model.id} className="flex items-center gap-3 px-3 py-2">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-mono text-[12.5px] text-content">{model.id}</span>
                    <span className="block truncate text-[11.5px] text-content-subtle">
                      {model.label ?? model.id}
                      {model.contextWindow ? ` · ${t("settings.shared.relay.context", { n: Math.round(model.contextWindow / 1000) })}` : ""}
                    </span>
                  </span>
                  <span className="flex shrink-0 items-center gap-1 text-content-subtle">
                    {model.input?.includes("image") && <IconPhoto size={14} aria-label={t("settings.shared.vision")} />}
                    {model.reasoning && <IconBrain size={14} aria-label={t("settings.shared.reasoning")} />}
                  </span>
                </li>
              ))}
            </ul>
          </div>
          <p className="text-[11.5px] leading-relaxed text-content-subtle">{t("settings.shared.relay.modelsHint")}</p>
        </section>

        <p className="rounded-lg bg-accent/[0.06] px-3 py-2.5 text-[11.5px] leading-relaxed text-content-muted">{t("settings.shared.relay.footnote")}</p>
      </div>
    </div>
  );
}

/** True when the given provider id belongs to the built-in relay card. */
export const isRelayProvider = (id: string | undefined): boolean => isBuiltinRelayId(id);
