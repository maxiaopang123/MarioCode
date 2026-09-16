import { useEffect, useState, type ReactNode } from "react";
import type { SharedProviderPublic, SharedProviderProtocol, SharedProviderAgent, SharedProviderSaveInput } from "@contracts/sharedProvider";
import { api } from "@renderer/lib/api.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import { Button, Input, ConfirmDialog } from "@renderer/components/ui/index.js";
import { IconPlus, IconTrash, IconLoader2, IconKey } from "@renderer/lib/icons.js";
import { cn } from "@renderer/lib/cn.js";
import { PanelHeader } from "./PanelHeader.js";

const PROTOCOLS: SharedProviderProtocol[] = ["anthropic", "chat-completions", "responses"];
const AGENTS: SharedProviderAgent[] = ["claude", "codex", "pi"];
const LABELS = { anthropic: "Anthropic Messages", "chat-completions": "OpenAI Chat Completions", responses: "OpenAI Responses", claude: "Claude", codex: "Codex", pi: "Pi" };
function supports(agent: SharedProviderAgent, protocols: SharedProviderProtocol[]): boolean {
  return agent === "pi" ? protocols.length > 0 : agent === "codex" ? protocols.includes("responses") : protocols.some((p) => p === "anthropic" || p === "chat-completions");
}
function fresh(): SharedProviderSaveInput {
  return { name: "", baseUrl: "", protocols: ["chat-completions"], models: [{ id: "" }], enabledAgents: ["claude", "pi"], apiKey: "", endpointOverrides: {} };
}
function draftOf(p: SharedProviderPublic): SharedProviderSaveInput {
  return { id: p.id, name: p.name, baseUrl: p.baseUrl, protocols: [...p.protocols], models: p.models.map((m) => ({ ...m })), enabledAgents: [...p.enabledAgents], endpointOverrides: { ...p.endpointOverrides }, apiKey: "" };
}
function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className="block space-y-1.5 text-xs text-content-muted"><span>{label}</span>{children}</label>;
}

export function SharedProvidersPanel() {
  const { t } = useI18n();
  const [providers, setProviders] = useState<SharedProviderPublic[]>([]);
  const [draft, setDraft] = useState<SharedProviderSaveInput | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<SharedProviderPublic | null>(null);
  const [dirty, setDirty] = useState(false);
  const [nextDraft, setNextDraft] = useState<SharedProviderSaveInput | null>(null);
  const [advanced, setAdvanced] = useState(false);
  useEffect(() => {
    let mounted = true;
    api.sharedProviders.list().then((r) => { if (mounted) setProviders(r.providers); })
      .catch((e: unknown) => { if (mounted) setError(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (mounted) setLoading(false); });
    return () => { mounted = false; };
  }, []);
  function select(value: SharedProviderSaveInput) {
    if (dirty) { setNextDraft(value); return; }
    setDraft(value); setError(null); setAdvanced(false);
  }
  function change(patch: Partial<SharedProviderSaveInput>) {
    setDraft((d) => d ? { ...d, ...patch } : d); setDirty(true);
  }
  async function reloadConsumers() {
    // Direct IPC makes refresh failures visible instead of swallowing them in
    // the startup-oriented store reload helpers. Publish one consistent set.
    const [claude, pi, codex] = await Promise.all([
      api.customModel.list(), api.piModels.listAvailable(), api.codexModels.list(),
    ]);
    useSessionStore.setState({
      customModels: claude.models, customModelsLoaded: true,
      piAvailableModels: pi.models, piModelsLoaded: true,
      codexAvailableModels: codex.providers.flatMap((p) => p.models.map((m) => ({
        id: `${p.id}/${m.id}`, label: m.label ?? m.id, hint: m.hint, supplier: p.name,
      }))), codexModelsLoaded: true,
    });
  }
  async function save() {
    if (!draft) return;
    setBusy(true); setError(null);
    try {
      const result = await api.sharedProviders.save({ ...draft,
        models: draft.models.map((model) => ({ ...model, label: model.label?.trim() || undefined })),
      });
      setProviders(result.providers);
      setDraft(null); setDirty(false); // Never keep the submitted key in the form.
      await reloadConsumers();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }
  async function remove(p: SharedProviderPublic) {
    setBusy(true); setError(null);
    try {
      const result = await api.sharedProviders.remove({ id: p.id });
      setProviders(result.providers);
      if (draft?.id === p.id) { setDraft(null); setDirty(false); }
      await reloadConsumers();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }
  function toggleProtocol(protocol: SharedProviderProtocol) {
    if (!draft) return;
    const protocols = draft.protocols.includes(protocol) ? draft.protocols.filter((p) => p !== protocol) : [...draft.protocols, protocol];
    const endpointOverrides = { ...draft.endpointOverrides };
    if (!protocols.includes(protocol)) delete endpointOverrides[protocol];
    change({ protocols, endpointOverrides, enabledAgents: draft.enabledAgents.filter((agent) => supports(agent, protocols)) });
  }
  const selected = providers.find((p) => p.id === draft?.id);
  return (
    <section className="mx-auto w-full max-w-5xl space-y-4">
      <PanelHeader title={t("settings.shared.title")} icon={IconKey} />
      <p className="text-sm text-content-muted">{t("settings.shared.description")}</p>
      {error && <p role="alert" className="break-words rounded bg-danger/10 p-3 text-sm text-danger">{error}</p>}
      <div className="grid min-h-[360px] grid-cols-[220px_minmax(0,1fr)] overflow-hidden rounded-xl border border-edge bg-surface">
        <aside className="space-y-2 border-r border-edge bg-surface-muted/30 p-3">
          <Button size="sm" variant="outline" disabled={busy} onClick={() => select(fresh())}><IconPlus size={14} />{t("settings.shared.add")}</Button>
          {loading && <IconLoader2 size={18} className="animate-spin text-content-subtle" />}
          {!loading && providers.length === 0 && <p className="py-3 text-xs text-content-subtle">{t("settings.shared.empty")}</p>}
          {providers.map((p) => <button key={p.id} disabled={busy} onClick={() => select(draftOf(p))}
            className={cn("block w-full rounded-lg p-2 text-left hover:bg-surface-hover", draft?.id === p.id && "bg-accent/10")}>
            <span className="block truncate text-sm font-medium text-content">{p.name}</span>
            <span className="block text-xs text-content-subtle">{p.enabledAgents.map((a) => LABELS[a]).join(" · ")}</span>
            <span className="text-xs text-content-subtle">{t(p.hasApiKey ? "settings.shared.keyStored" : "settings.shared.noKey")}</span>
          </button>)}
        </aside>
        {!draft ? <div className="flex items-center justify-center p-8 text-sm text-content-subtle">{t("settings.shared.selectHint")}</div> : (
          <form className="min-w-0 space-y-4 p-5" onSubmit={(e) => { e.preventDefault(); void save(); }}>
            <Field label={t("settings.shared.name")}><Input required value={draft.name} disabled={busy} onChange={(e) => change({ name: e.target.value })} /></Field>
            <Field label={t("settings.shared.baseUrl")}><Input required type="url" spellCheck={false} value={draft.baseUrl} disabled={busy} onChange={(e) => change({ baseUrl: e.target.value })} placeholder="https://api.example.com/v1" /></Field>
            <Field label={t("settings.shared.apiKey")}><Input type="password" autoComplete="new-password" spellCheck={false} value={draft.apiKey ?? ""} disabled={busy} onChange={(e) => change({ apiKey: e.target.value })} placeholder={t(selected?.hasApiKey ? "settings.shared.keepKey" : "settings.shared.enterKey")} /></Field>
            <fieldset className="space-y-2"><legend className="mb-2 text-xs text-content-muted">{t("settings.shared.protocols")}</legend>
              {PROTOCOLS.map((p) => <label key={p} className="mr-4 inline-flex items-center gap-2 text-xs text-content">
                <input type="checkbox" checked={draft.protocols.includes(p)} disabled={busy} onChange={() => toggleProtocol(p)} />{LABELS[p]}
              </label>)}
              <p className="text-xs text-content-subtle">{t("settings.shared.protocolHint")}</p>
            </fieldset>
            <fieldset className="space-y-2"><legend className="mb-2 text-xs text-content-muted">{t("settings.shared.agents")}</legend>
              {AGENTS.map((agent) => <label key={agent} className={cn("mr-4 inline-flex items-center gap-2 text-sm", supports(agent, draft.protocols) ? "text-content" : "text-content-subtle opacity-60")}>
                <input type="checkbox" checked={draft.enabledAgents.includes(agent)} disabled={busy || !supports(agent, draft.protocols)}
                  onChange={() => change({ enabledAgents: draft.enabledAgents.includes(agent) ? draft.enabledAgents.filter((a) => a !== agent) : [...draft.enabledAgents, agent] })} />{LABELS[agent]}
              </label>)}
              <p className="text-xs text-content-subtle">{t("settings.shared.compatibilityHint")}</p>
            </fieldset>
            <div className="space-y-2">
              <div className="flex items-center justify-between"><span className="text-xs text-content-muted">{t("settings.shared.models")}</span>
                <Button size="sm" variant="ghost" type="button" disabled={busy} onClick={() => change({ models: [...draft.models, { id: "" }] })}><IconPlus size={12} />{t("settings.shared.addModel")}</Button>
              </div>
              {draft.models.map((model, index) => <div key={index} className="space-y-2 rounded border border-edge p-3">
                <div className="flex gap-2">
                  <Input required aria-label={t("settings.shared.modelId")} placeholder={t("settings.shared.modelId")} value={model.id} disabled={busy}
                    onChange={(e) => change({ models: draft.models.map((m, i) => i === index ? { ...m, id: e.target.value } : m) })} />
                  <Input aria-label={t("settings.shared.modelLabel")} placeholder={t("settings.shared.modelLabel")} value={model.label ?? ""} disabled={busy}
                    onChange={(e) => change({ models: draft.models.map((m, i) => i === index ? { ...m, label: e.target.value } : m) })} />
                  <Button variant="ghost" size="sm" type="button" title={t("settings.shared.removeModel")} disabled={busy || draft.models.length === 1}
                    onClick={() => change({ models: draft.models.filter((_, i) => i !== index) })}><IconTrash size={14} /></Button>
                </div>
                <div className="flex flex-wrap gap-4 text-xs text-content-muted">
                  <label className="flex items-center gap-1"><input type="checkbox" checked={model.input?.includes("image") ?? false} disabled={busy}
                    onChange={(e) => change({ models: draft.models.map((m, i) => i === index ? { ...m, input: e.target.checked ? ["text", "image"] : ["text"] } : m) })} />{t("settings.shared.vision")}</label>
                  <label className="flex items-center gap-1"><input type="checkbox" checked={model.reasoning ?? false} disabled={busy}
                    onChange={(e) => change({ models: draft.models.map((m, i) => i === index ? { ...m, reasoning: e.target.checked } : m) })} />{t("settings.shared.reasoning")}</label>
                </div>
                {advanced && <div className="grid grid-cols-2 gap-2">
                  <Field label={t("settings.shared.contextWindow")}><Input type="number" min={1} step={1} value={model.contextWindow ?? ""} disabled={busy}
                    onChange={(e) => change({ models: draft.models.map((m, i) => i === index ? { ...m, contextWindow: e.target.value ? Number(e.target.value) : undefined } : m) })} /></Field>
                  <Field label={t("settings.shared.maxTokens")}><Input type="number" min={1} step={1} value={model.maxTokens ?? ""} disabled={busy}
                    onChange={(e) => change({ models: draft.models.map((m, i) => i === index ? { ...m, maxTokens: e.target.value ? Number(e.target.value) : undefined } : m) })} /></Field>
                </div>}
              </div>)}
            </div>
            <Button type="button" variant="ghost" size="sm" onClick={() => setAdvanced(!advanced)}>{t("settings.shared.advanced")}</Button>
            {advanced && <div className="space-y-3 rounded bg-surface-muted/30 p-3">
              <p className="text-xs text-content-subtle">{t("settings.shared.overrideHint")}</p>
              {draft.protocols.map((protocol) => <Field key={protocol} label={LABELS[protocol]}>
                <Input type="url" value={draft.endpointOverrides?.[protocol] ?? ""} disabled={busy} placeholder={draft.baseUrl}
                  onChange={(e) => {
                    const endpointOverrides = { ...draft.endpointOverrides };
                    if (e.target.value) endpointOverrides[protocol] = e.target.value;
                    else delete endpointOverrides[protocol];
                    change({ endpointOverrides });
                  }} />
              </Field>)}
            </div>}
            <p className="rounded bg-accent/5 p-3 text-xs text-content-muted">{t("settings.shared.isolation")}</p>
            <div className="flex items-center gap-2">
              <Button type="submit" variant="primary" size="sm" disabled={busy || !draft.protocols.length || !draft.enabledAgents.length}>
                {busy && <IconLoader2 size={12} className="animate-spin" />}{t("settings.shared.save")}
              </Button>
              {selected && <Button type="button" variant="danger" size="sm" disabled={busy} onClick={() => setPendingDelete(selected)}>{t("settings.shared.delete")}</Button>}
            </div>
          </form>
        )}
      </div>
      <ConfirmDialog open={pendingDelete !== null} title={t("settings.shared.deleteTitle")} description={t("settings.shared.deleteHint")}
        danger onOpenChange={(open) => { if (!open) setPendingDelete(null); }} onConfirm={() => { if (pendingDelete) void remove(pendingDelete); }} />
      <ConfirmDialog open={nextDraft !== null} title={t("settings.shared.unsavedTitle")} description={t("settings.shared.unsavedHint")}
        onOpenChange={(open) => { if (!open) setNextDraft(null); }} onConfirm={() => { setDraft(nextDraft); setNextDraft(null); setDirty(false); setError(null); }} />
    </section>
  );
}
