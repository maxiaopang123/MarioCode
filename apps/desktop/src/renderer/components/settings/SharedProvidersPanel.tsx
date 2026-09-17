import { useEffect, useRef, useState, type ReactNode } from "react";
import type {
  SharedProviderAgent,
  SharedProviderDiscoveredModel,
  SharedProviderProtocol,
  SharedProviderPublic,
  SharedProviderSaveInput,
} from "@contracts/sharedProvider";
import { api } from "@renderer/lib/api.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import { useToastStore } from "@renderer/stores/toastStore.js";
import { Button, Input, ConfirmDialog, Dialog } from "@renderer/components/ui/index.js";
import { IconPlus, IconTrash, IconLoader2, IconKey, IconRefresh } from "@renderer/lib/icons.js";
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
  return { id: p.id, name: p.name, baseUrl: p.baseUrl, modelsEndpoint: p.modelsEndpoint, protocols: [...p.protocols], models: p.models.map((m) => ({ ...m })), enabledAgents: [...p.enabledAgents], endpointOverrides: { ...p.endpointOverrides }, apiKey: "" };
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
  const [discovering, setDiscovering] = useState(false);
  const [selectedModelIndexes, setSelectedModelIndexes] = useState<Set<number>>(() => new Set());
  const [discovered, setDiscovered] = useState<{
    models: SharedProviderDiscoveredModel[];
    selectedIds: string[];
    truncated: boolean;
    partial: boolean;
  } | null>(null);
  const draftRevisionRef = useRef(0);
  useEffect(() => {
    let mounted = true;
    api.sharedProviders.list().then((r) => { if (mounted) setProviders(r.providers); })
      .catch((e: unknown) => { if (mounted) setError(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (mounted) setLoading(false); });
    return () => { mounted = false; };
  }, []);
  function select(value: SharedProviderSaveInput) {
    draftRevisionRef.current++;
    if (discovering) return;
    if (dirty) { setNextDraft(value); return; }
    setDraft(value); setError(null); setAdvanced(false); setSelectedModelIndexes(new Set());
  }
  function change(patch: Partial<SharedProviderSaveInput>) {
    draftRevisionRef.current++;
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
    draftRevisionRef.current++;
    setBusy(true); setError(null);
    try {
      const result = await api.sharedProviders.save({ ...draft,
        models: draft.models.map((model) => ({ ...model, label: model.label?.trim() || undefined })),
      });
      setProviders(result.providers);
      setSelectedModelIndexes(new Set());
      setDraft(null); setDirty(false); // Never keep the submitted key in the form.
      await reloadConsumers();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }
  async function remove(p: SharedProviderPublic) {
    draftRevisionRef.current++;
    setBusy(true); setError(null);
    try {
      const result = await api.sharedProviders.remove({ id: p.id });
      setProviders(result.providers);
      if (draft?.id === p.id) { setDraft(null); setDirty(false); setSelectedModelIndexes(new Set()); }
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
  function toggleModelSelection(index: number, checked: boolean) {
    setSelectedModelIndexes((current) => {
      const next = new Set(current);
      if (checked) next.add(index);
      else next.delete(index);
      return next;
    });
  }
  function removeModel(index: number) {
    if (!draft) return;
    setSelectedModelIndexes((current) => new Set([...current].flatMap((selectedIndex) => {
      if (selectedIndex === index) return [];
      return [selectedIndex > index ? selectedIndex - 1 : selectedIndex];
    })));
    change({ models: draft.models.filter((_, modelIndex) => modelIndex !== index) });
  }
  function updateSelectedModels(update: "vision-on" | "vision-off" | "reasoning-on" | "reasoning-off") {
    if (!draft || busy || discovering || selectedModelIndexes.size === 0) return;
    change({ models: draft.models.map((model, index) => {
      if (!selectedModelIndexes.has(index)) return model;
      if (update === "vision-on") return { ...model, input: ["text", "image"] };
      if (update === "vision-off") return { ...model, input: ["text"] };
      return { ...model, reasoning: update === "reasoning-on" };
    }) });
  }
  async function discoverModels() {
    if (!draft || draft.protocols.length === 0) return;
    const protocol = draft.protocols.includes("chat-completions") ? "chat-completions"
      : draft.protocols.includes("responses") ? "responses" : draft.protocols[0]!;
    const baseUrl = draft.endpointOverrides?.[protocol]?.trim() || draft.baseUrl;
    const revision = draftRevisionRef.current;
    setDiscovering(true); setError(null);
    try {
      const result = await api.sharedProviders.discoverModels({
        ...(draft.id ? { id: draft.id } : {}),
        baseUrl,
        protocol,
        ...(draft.modelsEndpoint?.trim() ? { modelsEndpoint: draft.modelsEndpoint.trim() } : {}),
        ...(draft.apiKey ? { apiKey: draft.apiKey } : {}),
      });
      if (draftRevisionRef.current !== revision) {
        useToastStore.getState().push({ kind: "warning", title: t("settings.shared.discoveryStale"), duration: 5_000 });
        return;
      }
      const existingIds = new Set(draft.models.map((model) => model.id.trim()).filter(Boolean));
      setDiscovered({
        models: result.models,
        selectedIds: result.models.filter((model) => !existingIds.has(model.id)).map((model) => model.id),
        truncated: result.truncated,
        partial: result.partial,
      });
    } catch (e) {
      if (draftRevisionRef.current !== revision) {
        useToastStore.getState().push({ kind: "warning", title: t("settings.shared.discoveryStale"), duration: 5_000 });
        return;
      }
      const message = e instanceof Error ? e.message : String(e);
      setError(t("settings.shared.discoveryFailed", { error: message }));
    } finally {
      setDiscovering(false);
    }
  }
  function mergeDiscoveredModels() {
    if (!draft || !discovered) return;
    const existing = draft.models.filter((model) => model.id.trim());
    const existingIds = new Set(existing.map((model) => model.id.trim()));
    const additions = discovered.models
      .filter((model) => discovered.selectedIds.includes(model.id) && !existingIds.has(model.id))
      .map((model) => ({ id: model.id, label: model.label }));
    if (additions.length > 0) {
      const nextSelection = new Set<number>();
      let keptIndex = 0;
      draft.models.forEach((model, index) => {
        if (!model.id.trim()) return;
        if (selectedModelIndexes.has(index)) nextSelection.add(keptIndex);
        keptIndex++;
      });
      additions.forEach((_, index) => nextSelection.add(existing.length + index));
      setSelectedModelIndexes(nextSelection);
      change({ models: [...existing, ...additions] });
    }
    setDiscovered(null);
    useToastStore.getState().push({
      kind: "info",
      title: t("settings.shared.discoveryMerged", { n: additions.length }),
      duration: 4_000,
    });
  }
  const selected = providers.find((p) => p.id === draft?.id);
  return (
    <section className="mx-auto w-full max-w-5xl space-y-4">
      <PanelHeader title={t("settings.shared.title")} icon={IconKey} />
      <p className="text-sm text-content-muted">{t("settings.shared.description")}</p>
      {error && <p role="alert" className="break-words rounded bg-danger/10 p-3 text-sm text-danger">{error}</p>}
      <div className="grid min-h-[360px] grid-cols-[220px_minmax(0,1fr)] overflow-hidden rounded-xl border border-edge bg-surface">
        <aside className="space-y-2 border-r border-edge bg-surface-muted/30 p-3">
          <Button size="sm" variant="outline" disabled={busy || discovering} onClick={() => select(fresh())}><IconPlus size={14} />{t("settings.shared.add")}</Button>
          {loading && <IconLoader2 size={18} className="animate-spin text-content-subtle" />}
          {!loading && providers.length === 0 && <p className="py-3 text-xs text-content-subtle">{t("settings.shared.empty")}</p>}
          {providers.map((p) => <button key={p.id} disabled={busy || discovering} onClick={() => select(draftOf(p))}
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
                <div className="flex items-center gap-1">
                  <Button size="sm" variant="ghost" type="button" disabled={busy || discovering || !draft.protocols.length} onClick={() => void discoverModels()}>
                    {discovering ? <IconLoader2 size={12} className="animate-spin" /> : <IconRefresh size={12} />}
                    {t(discovering ? "settings.shared.loadingModels" : "settings.shared.loadModels")}
                  </Button>
                  <Button size="sm" variant="ghost" type="button" disabled={busy || discovering} onClick={() => change({ models: [...draft.models, { id: "" }] })}><IconPlus size={12} />{t("settings.shared.addModel")}</Button>
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-1 rounded border border-edge bg-surface-muted/30 p-2">
                <span className="mr-1 text-xs text-content-subtle">{t("settings.shared.selectedCount", { n: selectedModelIndexes.size })}</span>
                <Button type="button" size="sm" variant="ghost" disabled={busy || discovering || selectedModelIndexes.size === draft.models.length}
                  onClick={() => setSelectedModelIndexes(new Set(draft.models.map((_, index) => index)))}>{t("settings.shared.selectAll")}</Button>
                <Button type="button" size="sm" variant="ghost" disabled={busy || discovering || selectedModelIndexes.size === 0}
                  onClick={() => setSelectedModelIndexes(new Set())}>{t("settings.shared.clearSelection")}</Button>
                <span className="mx-1 h-4 w-px bg-edge" aria-hidden="true" />
                <Button type="button" size="sm" variant="ghost" disabled={busy || discovering || selectedModelIndexes.size === 0}
                  onClick={() => updateSelectedModels("vision-on")}>{t("settings.shared.enableVisionSelected")}</Button>
                <Button type="button" size="sm" variant="ghost" disabled={busy || discovering || selectedModelIndexes.size === 0}
                  onClick={() => updateSelectedModels("vision-off")}>{t("settings.shared.disableVisionSelected")}</Button>
                <Button type="button" size="sm" variant="ghost" disabled={busy || discovering || selectedModelIndexes.size === 0}
                  onClick={() => updateSelectedModels("reasoning-on")}>{t("settings.shared.enableReasoningSelected")}</Button>
                <Button type="button" size="sm" variant="ghost" disabled={busy || discovering || selectedModelIndexes.size === 0}
                  onClick={() => updateSelectedModels("reasoning-off")}>{t("settings.shared.disableReasoningSelected")}</Button>
              </div>
              {draft.models.map((model, index) => <div key={index} className="space-y-2 rounded border border-edge p-3">
                <div className="flex gap-2">
                  <input type="checkbox" className="self-center" checked={selectedModelIndexes.has(index)} disabled={busy || discovering}
                    aria-label={t("settings.shared.selectModel", { n: index + 1 })}
                    onChange={(event) => toggleModelSelection(index, event.target.checked)} />
                  <Input required aria-label={t("settings.shared.modelId")} placeholder={t("settings.shared.modelId")} value={model.id} disabled={busy}
                    onChange={(e) => change({ models: draft.models.map((m, i) => i === index ? { ...m, id: e.target.value } : m) })} />
                  <Input aria-label={t("settings.shared.modelLabel")} placeholder={t("settings.shared.modelLabel")} value={model.label ?? ""} disabled={busy}
                    onChange={(e) => change({ models: draft.models.map((m, i) => i === index ? { ...m, label: e.target.value } : m) })} />
                  <Button variant="ghost" size="sm" type="button" title={t("settings.shared.removeModel")} disabled={busy || draft.models.length === 1}
                    onClick={() => removeModel(index)}><IconTrash size={14} /></Button>
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
              <Field label={t("settings.shared.modelsEndpoint")}>
                <Input type="url" value={draft.modelsEndpoint ?? ""} disabled={busy || discovering} placeholder={t("settings.shared.modelsEndpointPlaceholder")}
                  onChange={(e) => change({ modelsEndpoint: e.target.value || undefined })} />
              </Field>
              <p className="text-xs text-content-subtle">{t("settings.shared.modelsEndpointHint")}</p>
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
              <Button type="submit" variant="primary" size="sm" disabled={busy || discovering || !draft.protocols.length || !draft.enabledAgents.length}>
                {busy && <IconLoader2 size={12} className="animate-spin" />}{t("settings.shared.save")}
              </Button>
              {selected && <Button type="button" variant="danger" size="sm" disabled={busy || discovering} onClick={() => setPendingDelete(selected)}>{t("settings.shared.delete")}</Button>}
            </div>
          </form>
        )}
      </div>
      <ConfirmDialog open={pendingDelete !== null} title={t("settings.shared.deleteTitle")} description={t("settings.shared.deleteHint")}
        danger onOpenChange={(open) => { if (!open) setPendingDelete(null); }} onConfirm={() => { if (pendingDelete) void remove(pendingDelete); }} />
      <ConfirmDialog open={nextDraft !== null} title={t("settings.shared.unsavedTitle")} description={t("settings.shared.unsavedHint")}
        onOpenChange={(open) => { if (!open) setNextDraft(null); }} onConfirm={() => { setDraft(nextDraft); setNextDraft(null); setDirty(false); setError(null); setSelectedModelIndexes(new Set()); }} />
      <Dialog.Root open={discovered !== null} onOpenChange={(open) => { if (!open) setDiscovered(null); }}>
        <Dialog.Portal>
          <Dialog.Backdrop />
          <Dialog.Popup className="flex max-h-[80vh] w-[560px] max-w-[90vw] flex-col p-0">
            <Dialog.Title className="px-4 pt-4">{t("settings.shared.discoveryTitle")}</Dialog.Title>
            <Dialog.Description className="px-4 pt-1">
              {t("settings.shared.discoveryDescription", { n: discovered?.models.length ?? 0 })}
            </Dialog.Description>
            {discovered?.partial && <p role="status" className="mx-4 mt-2 rounded bg-warning/10 px-3 py-2 text-xs font-medium text-warning">
              {t("settings.shared.discoveryPartial")}
            </p>}
            <Dialog.Close aria-label={t("settings.shared.discoveryClose")} />
            <div className="mt-3 flex items-center gap-2 border-y border-edge px-4 py-2">
              <Button type="button" size="sm" variant="ghost" onClick={() => setDiscovered((value) => value ? {
                ...value,
                selectedIds: value.models.filter((model) => !(draft?.models.some((entry) => entry.id.trim() === model.id) ?? false)).map((model) => model.id),
              } : value)}>
                {t("settings.shared.selectAll")}
              </Button>
              <Button type="button" size="sm" variant="ghost" onClick={() => setDiscovered((value) => value ? { ...value, selectedIds: [] } : value)}>
                {t("settings.shared.clearSelection")}
              </Button>
              <span className="ml-auto text-xs text-content-subtle">{t("settings.shared.selectedCount", { n: discovered?.selectedIds.length ?? 0 })}</span>
            </div>
            <div className="min-h-0 flex-1 space-y-1 overflow-y-auto p-3">
              {discovered?.models.map((model) => {
                const checked = discovered.selectedIds.includes(model.id);
                const exists = draft?.models.some((entry) => entry.id.trim() === model.id) ?? false;
                return <label key={model.id} className={cn("flex items-center gap-3 rounded px-2 py-2", exists ? "cursor-default opacity-70" : "cursor-pointer hover:bg-surface-hover")}>
                  <input type="checkbox" checked={checked} disabled={exists} onChange={(event) => setDiscovered((value) => value ? {
                    ...value,
                    selectedIds: event.target.checked ? [...value.selectedIds, model.id] : value.selectedIds.filter((id) => id !== model.id),
                  } : value)} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-content">{model.label}</span>
                    <span className="block truncate font-mono text-xs text-content-subtle">{model.id}</span>
                  </span>
                  {exists && <span className="rounded bg-surface-muted px-2 py-0.5 text-[11px] text-content-subtle">{t("settings.shared.existingModel")}</span>}
                </label>;
              })}
            </div>
            <div className="flex justify-end gap-2 border-t border-edge p-4">
              <Button type="button" size="sm" variant="ghost" onClick={() => setDiscovered(null)}>{t("settings.shared.discoveryCancel")}</Button>
              <Button type="button" size="sm" variant="primary" disabled={!discovered?.selectedIds.length} onClick={mergeDiscoveredModels}>{t("settings.shared.discoveryMerge")}</Button>
            </div>
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>
    </section>
  );
}
