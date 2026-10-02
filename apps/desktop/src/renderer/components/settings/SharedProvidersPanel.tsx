import { useEffect, useRef, useState, type ReactNode } from "react";
import type {
  SharedProviderAgent,
  SharedProviderDiscoveredModel,
  SharedProviderProtocol,
  SharedProviderPublic,
  SharedProviderSaveInput,
} from "@contracts/sharedProvider";
import { resolveSharedModelInterfaces, resolveSharedModelProtocol, sharedProviderAddsOrigin } from "@contracts/sharedProvider";
import { api } from "@renderer/lib/api.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { useSessionStore, validateComposerSelection } from "@renderer/stores/sessionStore.js";
import { useToastStore } from "@renderer/stores/toastStore.js";
import { Button, Input, ConfirmDialog, Dialog } from "@renderer/components/ui/index.js";
import {
  IconPlus,
  IconTrash,
  IconLoader2,
  IconKey,
  IconRefresh,
  IconCheck,
  IconChevronRight,
  IconPhoto,
  IconBrain,
  IconShieldLock,
  IconSparkles,
  IconAlertTriangle,
} from "@renderer/lib/icons.js";
import { cn } from "@renderer/lib/cn.js";
import { getProviderIcon } from "@renderer/lib/providerIcon.js";
import { projectAvatarColor } from "@renderer/lib/projectAvatar.js";
import { ProjectAvatar } from "@renderer/components/layout/ProjectAvatar.js";
import { PanelHeader } from "./PanelHeader.js";

/**
 * 公用模型提供商 — one provider config shared by Claude / Codex / Pi.
 *
 * Layout (界面焕新 v3, 2026-09-28): left provider list (avatar + name + host +
 * engine badges + key state) | right form in three titled sections —
 * 连接 (name / base URL / key), 协议与引擎 (toggle chips), 模型 (compact rows
 * with icon toggles; the batch bar only appears once rows are selected) —
 * plus a collapsible 高级 section and a sticky save bar. Model interfaces are
 * explicit in drafts; routing and compatibility use the contracts helpers.
 */

const PROTOCOLS: SharedProviderProtocol[] = ["anthropic", "chat-completions", "responses"];
const AGENTS: SharedProviderAgent[] = ["claude", "codex", "pi"];
const LABELS = { anthropic: "Anthropic Messages", "chat-completions": "OpenAI Chat Completions", responses: "OpenAI Responses", claude: "Claude", codex: "Codex", pi: "Pi" };
/** Short protocol names for the compact per-model interface chips. */
const SHORT: Record<SharedProviderProtocol, string> = { anthropic: "Messages", "chat-completions": "Chat", responses: "Responses" };
function supports(agent: SharedProviderAgent, protocols: SharedProviderProtocol[], models: SharedProviderSaveInput["models"] = [{ id: "" }]): boolean {
  return models.some((model) => resolveSharedModelProtocol(agent, protocols, model.interfaces) !== undefined);
}
function fresh(): SharedProviderSaveInput {
  return { name: "", baseUrl: "", protocols: ["chat-completions"], models: [{ id: "", interfaces: ["chat-completions"] }], enabledAgents: ["claude", "pi"], apiKey: "", endpointOverrides: {} };
}
function draftOf(p: SharedProviderPublic): SharedProviderSaveInput {
  return { id: p.id, name: p.name, baseUrl: p.baseUrl, modelsEndpoint: p.modelsEndpoint, protocols: [...p.protocols], models: p.models.map((m) => ({ ...m, interfaces: resolveSharedModelInterfaces(p.protocols, m.interfaces) })), enabledAgents: [...p.enabledAgents], endpointOverrides: { ...p.endpointOverrides }, apiKey: "" };
}
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
const agentIcon = (agent: SharedProviderAgent) => getProviderIcon(`${agent}-sdk`);

/* ── presentational helpers ── */

function Field({ label, hint, children, className }: { label: string; hint?: string; children: ReactNode; className?: string }) {
  return (
    <label className={cn("block min-w-0", className)}>
      <span className="mb-1.5 block text-[12px] font-medium text-content-muted">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[11.5px] leading-relaxed text-content-subtle">{hint}</span>}
    </label>
  );
}

function Section({ title, aside, hint, children }: { title: string; aside?: ReactNode; hint?: string; children: ReactNode }) {
  return (
    <section className="space-y-3">
      <div className="flex min-h-7 items-center gap-2">
        <h3 className="text-[13px] font-semibold text-content">{title}</h3>
        {aside && <div className="ml-auto flex items-center gap-1">{aside}</div>}
      </div>
      {children}
      {hint && <p className="text-[11.5px] leading-relaxed text-content-subtle">{hint}</p>}
    </section>
  );
}

/** Toggle chip (protocols / engines): check mark replaces the icon when on. */
function Chip({ on, disabled, onClick, icon, children, title }: {
  on: boolean; disabled?: boolean; onClick: () => void; icon?: ReactNode; children: ReactNode; title?: string;
}) {
  return (
    <button
      type="button"
      aria-pressed={on}
      disabled={disabled}
      title={title}
      onClick={onClick}
      className={cn(
        "inline-flex h-8 items-center gap-1.5 rounded-lg border px-3 text-[12.5px] transition-colors",
        on
          ? "border-accent/45 bg-accent/10 font-medium text-content"
          : "border-edge bg-surface text-content-muted hover:bg-surface-hover hover:text-content",
        disabled && "cursor-not-allowed opacity-45 hover:bg-surface",
      )}
    >
      {on ? <IconCheck size={13} className="shrink-0 text-accent-strong" /> : icon}
      {children}
    </button>
  );
}

/** Small icon toggle for per-model capabilities (vision / reasoning). */
function CapToggle({ on, disabled, onClick, icon, label }: {
  on: boolean; disabled?: boolean; onClick: () => void; icon: ReactNode; label: string;
}) {
  return (
    <button
      type="button"
      aria-pressed={on}
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "grid h-8 w-8 shrink-0 place-items-center rounded-lg border transition-colors",
        on ? "border-accent/45 bg-accent/10 text-accent-strong" : "border-transparent text-content-subtle hover:bg-surface-hover hover:text-content",
        disabled && "cursor-not-allowed opacity-45",
      )}
    >
      {icon}
    </button>
  );
}

const CHECKBOX = "h-3.5 w-3.5 shrink-0 cursor-pointer accent-[rgb(var(--accent))]";

/** Per-model picks in the "加载模型" dialog. */
interface DiscoveryOption {
  interfaces: SharedProviderProtocol[];
  image: boolean;
}
/** Order of the dialog's interface chips (Chat first — the most common). */
const DISCOVERY_INTERFACES: SharedProviderProtocol[] = ["chat-completions", "anthropic", "responses"];
/** A catalog is not a capability probe. Start with only the queried protocol;
 * additional interfaces require an explicit user choice. */
const defaultDiscoveryOption = (protocol: SharedProviderProtocol): DiscoveryOption => ({ interfaces: [protocol], image: false });

/** Small toggle used in the discovery rows. */
function MiniToggle({ on, disabled, onClick, children, title }: {
  on: boolean; disabled?: boolean; onClick: () => void; children: ReactNode; title?: string;
}) {
  return (
    <button
      type="button"
      aria-pressed={on}
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "inline-flex h-6 shrink-0 items-center gap-1 rounded-md border px-2 text-[11.5px] transition-colors",
        on ? "border-accent/45 bg-accent/10 text-content" : "border-edge text-content-subtle hover:text-content",
        disabled && "cursor-not-allowed opacity-40",
      )}
    >
      {children}
    </button>
  );
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
  /** Model-discovery failure, shown inline under the 模型 section. The
   *  panel-level `error` sits above the provider list and is scrolled out of
   *  view when the user clicks 「加载模型」 further down — that looked like
   *  "the button does nothing". */
  const [discoveryError, setDiscoveryError] = useState<string | null>(null);
  const [selectedModelIndexes, setSelectedModelIndexes] = useState<Set<number>>(() => new Set());
  const [discovered, setDiscovered] = useState<{
    models: SharedProviderDiscoveredModel[];
    selectedIds: string[];
    /** Per-model picks in the dialog: interfaces + image generation. */
    options: Record<string, DiscoveryOption>;
    protocol: SharedProviderProtocol;
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
    setDraft(value); setError(null); setDiscoveryError(null); setAdvanced(false); setSelectedModelIndexes(new Set());
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
    // Saving a shared provider can remove or rename a model that the blank
    // composer remembered from an earlier catalog. Re-run the same guarded
    // validation used during startup so Claude/Codex do not send stale
    // customModelId or provider/model references into their runtimes.
    validateComposerSelection(useSessionStore.setState, useSessionStore.getState);
  }
  async function save() {
    if (!draft) return;
    draftRevisionRef.current++;
    setBusy(true); setError(null);
    try {
      const knownIds = new Set(providers.map((p) => p.id));
      const result = await api.sharedProviders.save({ ...draft,
        models: draft.models.map((model) => ({ ...model, label: model.label?.trim() || undefined })),
      });
      setProviders(result.providers);
      setSelectedModelIndexes(new Set());
      // Stay on the provider just saved (a fresh draft off the stored row, so
      // the submitted key is never kept in the form and the field shows
      // "已保存"). Closing the form here made a second edit feel like starting
      // over — including re-typing the key.
      const saved = draft.id
        ? result.providers.find((p) => p.id === draft.id)
        : result.providers.find((p) => !knownIds.has(p.id));
      setDraft(saved ? draftOf(saved) : null);
      setDirty(false);
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
    const models = draft.models.map((model) => {
      const interfaces = resolveSharedModelInterfaces(draft.protocols, model.interfaces).filter((value) => protocols.includes(value));
      return { ...model, interfaces };
    });
    change({ protocols, models, endpointOverrides });
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
    const models = draft.models.filter((_, modelIndex) => modelIndex !== index);
    change({ models });
  }
  function toggleModelInterface(index: number, protocol: SharedProviderProtocol, checked: boolean) {
    if (!draft) return;
    const current = draft.models[index];
    if (!current) return;
    const previous = current.interfaces ?? draft.protocols;
    const interfaces = checked
      ? [...new Set([...previous, protocol])]
      : previous.filter((value) => value !== protocol);
    const models = draft.models.map((model, modelIndex) => modelIndex === index ? { ...model, interfaces } : model);
    change({ models });
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
    setDiscovering(true); setError(null); setDiscoveryError(null);
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
        options: Object.fromEntries(result.models.map((model) => [model.id, defaultDiscoveryOption(protocol)])),
        protocol,
        truncated: result.truncated,
        partial: result.partial,
      });
    } catch (e) {
      if (draftRevisionRef.current !== revision) {
        useToastStore.getState().push({ kind: "warning", title: t("settings.shared.discoveryStale"), duration: 5_000 });
        return;
      }
      // IPC errors arrive as "Error invoking remote method '…': Error: <msg>";
      // keep only the part the user can act on.
      const raw = e instanceof Error ? e.message : String(e);
      const message = raw.replace(/^Error invoking remote method '[^']*':\s*(?:Error:\s*)?/, "");
      const text = t("settings.shared.discoveryFailed", { error: message });
      setDiscoveryError(text);
      useToastStore.getState().push({ kind: "error", title: text, duration: 6_000 });
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
      .map((model) => {
        const opt = discovered.options[model.id] ?? defaultDiscoveryOption(discovered.protocol);
        return {
          id: model.id,
          label: model.label,
          interfaces: DISCOVERY_INTERFACES.filter((p) => draft.protocols.includes(p) && opt.interfaces.includes(p)),
          ...(opt.image ? { imageGeneration: true } : {}),
        };
      });
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
  /** A key is on file and the user hasn't typed a replacement. */
  const keyStored = !!selected?.hasApiKey && !(draft?.apiKey ?? "");
  /** The edited URLs would send the stored key to an origin it never went to.
   *  Main refuses that (sharedProviderAddsOrigin); warn here instead of
   *  letting the user hit the error on submit. */
  const needsKeyForNewOrigin = !!draft && keyStored && !!selected
    && sharedProviderAddsOrigin(selected, draft);
  const locked = busy || discovering;
  const canSave = !!draft && !locked && !needsKeyForNewOrigin && draft.protocols.length > 0 && draft.enabledAgents.length > 0
    && !draft.models.some((model) => model.interfaces !== undefined && model.interfaces.length === 0)
    && !draft.enabledAgents.some((agent) => !supports(agent, draft.protocols, draft.models));
  const allSelected = !!draft && draft.models.length > 0 && selectedModelIndexes.size === draft.models.length;
  const updateModel = (index: number, patch: Partial<SharedProviderSaveInput["models"][number]>) => {
    if (!draft) return;
    change({ models: draft.models.map((m, i) => i === index ? { ...m, ...patch } : m) });
  };

  return (
    <section className="mx-auto w-full max-w-5xl space-y-4">
      <PanelHeader title={t("settings.shared.title")} icon={IconKey} />
      <p className="text-[13px] leading-relaxed text-content-muted">{t("settings.shared.description")}</p>
      {error && <p role="alert" className="break-words rounded-lg bg-danger/10 px-3 py-2.5 text-[13px] text-danger">{error}</p>}
      <div className="settings-provider-layout grid min-h-[480px] grid-cols-[236px_minmax(0,1fr)] overflow-hidden rounded-xl border border-edge bg-surface shadow-sm">
        {/* ── Provider list ── */}
        <aside className="settings-provider-list flex min-h-0 flex-col rounded-l-xl border-r border-edge bg-surface-muted/60">
          <div className="flex items-center justify-between px-3 pb-2 pt-3">
            <span className="text-[12px] font-semibold text-content-subtle">
              {t("settings.shared.providerCount", { n: providers.length })}
            </span>
            <button
              type="button"
              disabled={locked}
              onClick={() => select(fresh())}
              title={t("settings.shared.add")}
              className="flex h-7 items-center gap-1 rounded-lg px-2 text-[12px] font-medium text-content-muted transition-colors hover:bg-surface-hover hover:text-content disabled:opacity-50"
            >
              <IconPlus size={14} />
              {t("settings.shared.addShort")}
            </button>
          </div>
          <div className="min-h-0 flex-1 space-y-1 overflow-y-auto px-2 pb-3">
            {loading && <div className="grid place-items-center py-6"><IconLoader2 size={18} className="animate-spin text-content-subtle" /></div>}
            {!loading && providers.length === 0 && !draft && (
              <p className="px-2 py-6 text-center text-[12px] leading-relaxed text-content-subtle">{t("settings.shared.empty")}</p>
            )}
            {draft && !draft.id && (
              <div className="flex items-center gap-2.5 rounded-[10px] border border-dashed border-accent/50 bg-accent/5 px-2.5 py-2">
                <span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-accent/15 text-accent-strong"><IconPlus size={14} /></span>
                <span className="min-w-0 truncate text-[13px] font-medium text-content">{draft.name.trim() || t("settings.shared.newProvider")}</span>
              </div>
            )}
            {providers.map((p) => {
              const active = draft?.id === p.id;
              return (
                <button
                  key={p.id}
                  type="button"
                  disabled={locked}
                  onClick={() => select(draftOf(p))}
                  className={cn(
                    "flex w-full items-start gap-2.5 rounded-[10px] px-2.5 py-2 text-left transition-colors",
                    active ? "srow-active" : "hover:bg-surface-hover",
                  )}
                >
                  <ProjectAvatar name={p.name} color={projectAvatarColor(p.name)} size="lg" className="mt-0.5" />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5">
                      <span className="min-w-0 truncate text-[13px] font-medium text-content">{p.name}</span>
                      <span
                        className={cn("ml-auto h-1.5 w-1.5 shrink-0 rounded-full", p.hasApiKey ? "bg-accent" : "bg-warning")}
                        title={t(p.hasApiKey ? "settings.shared.keyStored" : "settings.shared.noKey")}
                        aria-label={t(p.hasApiKey ? "settings.shared.keyStored" : "settings.shared.noKey")}
                      />
                    </span>
                    <span className="block truncate font-mono text-[11px] text-content-subtle">{hostOf(p.baseUrl)}</span>
                    <span className="mt-1 flex items-center gap-1">
                      {p.enabledAgents.map((a) => {
                        const { Icon, color, label } = agentIcon(a);
                        return (
                          <span key={a} title={label} className="grid h-[18px] w-[18px] place-items-center rounded-[5px] bg-surface ring-1 ring-inset ring-edge">
                            <Icon size={11} className={color} />
                          </span>
                        );
                      })}
                      <span className="ml-1 text-[11px] text-content-subtle">{t("settings.shared.modelCount", { n: p.models.length })}</span>
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        </aside>

        {/* ── Detail ── */}
        {!draft ? (
          <div className="flex flex-col items-center justify-center gap-3 p-10 text-center">
            <span className="grid h-11 w-11 place-items-center rounded-xl bg-surface-muted text-content-subtle"><IconKey size={20} /></span>
            <p className="max-w-[320px] text-[13px] leading-relaxed text-content-subtle">{t("settings.shared.selectHint")}</p>
            <Button size="sm" variant="primary" disabled={locked} onClick={() => select(fresh())}>
              <IconPlus size={14} />{t("settings.shared.add")}
            </Button>
          </div>
        ) : (
          <form className="flex min-w-0 flex-col" onSubmit={(e) => { e.preventDefault(); void save(); }}>
            {/* Form header: identity + actions. Kept at the top (not a sticky
                footer) — the settings scroll area fades its bottom edge, so a
                pinned footer floated over the model list. */}
            <div className="flex items-center gap-3 border-b border-edge px-6 py-3.5">
              <ProjectAvatar name={draft.name.trim() || "?"} color={projectAvatarColor(draft.name.trim() || "?")} size="lg" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[14px] font-semibold text-content">
                  {draft.name.trim() || t("settings.shared.newProvider")}
                </span>
                {dirty ? (
                  <span className="flex items-center gap-1.5 text-[11.5px] text-warning">
                    <i className="h-1.5 w-1.5 rounded-full bg-warning" aria-hidden />
                    {t("settings.shared.unsaved")}
                  </span>
                ) : (
                  <span className="block truncate font-mono text-[11.5px] text-content-subtle">{draft.baseUrl ? hostOf(draft.baseUrl) : "—"}</span>
                )}
              </span>
              {selected && (
                <Button type="button" variant="ghost" size="sm" disabled={locked} onClick={() => setPendingDelete(selected)}
                  className="text-danger hover:bg-danger/10 hover:text-danger">
                  <IconTrash size={14} />{t("settings.shared.delete")}
                </Button>
              )}
              <Button type="submit" variant="primary" size="sm" disabled={!canSave}>
                {busy && <IconLoader2 size={13} className="animate-spin" />}{t("settings.shared.save")}
              </Button>
            </div>
            <div className="min-w-0 flex-1 space-y-7 p-6">
              {/* 连接 */}
              <Section title={t("settings.shared.sectionConnection")}>
                <div className="settings-provider-fields grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)] gap-3">
                  <Field label={t("settings.shared.name")}>
                    <Input required value={draft.name} disabled={busy} onChange={(e) => change({ name: e.target.value })} placeholder="OpenRouter" />
                  </Field>
                  <Field label={t("settings.shared.baseUrlShort")} hint={t("settings.shared.baseUrlHint")}>
                    <Input required type="url" spellCheck={false} className="font-mono" value={draft.baseUrl} disabled={busy} onChange={(e) => change({ baseUrl: e.target.value })} placeholder="https://api.example.com/v1" />
                  </Field>
                </div>
                <Field label={t("settings.shared.apiKey")}>
                  <div className="relative">
                    <IconShieldLock size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-content-subtle" />
                    <Input
                      type="password"
                      autoComplete="new-password"
                      spellCheck={false}
                      className={cn("pl-8 font-mono", keyStored && "pr-[92px]")}
                      value={draft.apiKey ?? ""}
                      disabled={busy}
                      onChange={(e) => change({ apiKey: e.target.value })}
                      placeholder={t(selected?.hasApiKey ? "settings.shared.keepKey" : "settings.shared.enterKey")}
                    />
                    {/* A stored key is never read back, so the box stays empty.
                        Say so inside it — an empty field otherwise reads as
                        "you must type this again". */}
                    {keyStored && (
                      <span className="pointer-events-none absolute right-2 top-1/2 flex -translate-y-1/2 items-center gap-1 rounded-md bg-accent/10 px-1.5 py-0.5 text-[11px] font-medium text-accent-strong">
                        <IconCheck size={11} />{t("settings.shared.keyStoredShort")}
                      </span>
                    )}
                  </div>
                  {needsKeyForNewOrigin && (
                    <span className="mt-1.5 flex items-start gap-1.5 rounded-md bg-warning/10 px-2 py-1.5 text-[11.5px] leading-relaxed text-warning">
                      <IconAlertTriangle size={13} className="mt-[1px] shrink-0" />
                      {t("settings.shared.keyNeededNewOrigin")}
                    </span>
                  )}
                </Field>
              </Section>

              {/* 协议与引擎 */}
              <Section title={t("settings.shared.sectionProtocols")} hint={t("settings.shared.compatibilityHint")}>
                <div className="space-y-2">
                  <div className="text-[12px] font-medium text-content-muted">{t("settings.shared.protocols")}</div>
                  <div className="flex flex-wrap gap-2">
                    {PROTOCOLS.map((p) => (
                      <Chip key={p} on={draft.protocols.includes(p)} disabled={busy} onClick={() => toggleProtocol(p)}>{LABELS[p]}</Chip>
                    ))}
                  </div>
                  <p className="text-[11.5px] leading-relaxed text-content-subtle">{t("settings.shared.protocolHint")}</p>
                </div>
                <div className="space-y-2">
                  <div className="text-[12px] font-medium text-content-muted">{t("settings.shared.agents")}</div>
                  <div className="flex flex-wrap gap-2">
                    {AGENTS.map((agent) => {
                      const ok = supports(agent, draft.protocols, draft.models);
                      const { Icon, color } = agentIcon(agent);
                      return (
                        <Chip
                          key={agent}
                          on={draft.enabledAgents.includes(agent)}
                          disabled={busy || (!ok && !draft.enabledAgents.includes(agent))}
                          title={ok ? undefined : t("settings.shared.agentUnsupported")}
                          icon={<Icon size={13} className={cn("shrink-0", color)} />}
                          onClick={() => change({ enabledAgents: draft.enabledAgents.includes(agent) ? draft.enabledAgents.filter((a) => a !== agent) : [...draft.enabledAgents, agent] })}
                        >
                          {LABELS[agent]}
                        </Chip>
                      );
                    })}
                  </div>
                  {draft.enabledAgents.some((agent) => !supports(agent, draft.protocols, draft.models)) && (
                    <p role="alert" className="text-[11.5px] text-danger">{t("settings.shared.agentNeedsModel")}</p>
                  )}
                </div>
              </Section>

              {/* 模型 */}
              <Section
                title={`${t("settings.shared.models")} · ${draft.models.length}`}
                aside={<>
                  <Button size="sm" variant="ghost" type="button" disabled={locked || !draft.protocols.length} onClick={() => void discoverModels()}>
                    {discovering ? <IconLoader2 size={13} className="animate-spin" /> : <IconRefresh size={13} />}
                    {t(discovering ? "settings.shared.loadingModels" : "settings.shared.loadModels")}
                  </Button>
                  <Button size="sm" variant="ghost" type="button" disabled={locked || !draft.protocols.length} onClick={() => change({ models: [...draft.models, { id: "", interfaces: [resolveSharedModelProtocol("pi", draft.protocols)!] }] })}>
                    <IconPlus size={13} />{t("settings.shared.addModel")}
                  </Button>
                </>}
              >
                {discoveryError && (
                  <p role="alert" className="mb-2 break-words rounded-lg bg-danger/10 px-3 py-2 text-[12.5px] text-danger">
                    {discoveryError}
                  </p>
                )}
                <div className="overflow-hidden rounded-lg border border-edge">
                  {/* Column header / batch bar — the batch actions only show once something is selected. */}
                  <div className="flex h-9 items-center gap-2.5 border-b border-edge bg-surface-muted/60 px-3 text-[11.5px] text-content-subtle">
                    <input
                      type="checkbox"
                      className={CHECKBOX}
                      checked={allSelected}
                      ref={(el) => { if (el) el.indeterminate = selectedModelIndexes.size > 0 && !allSelected; }}
                      disabled={locked}
                      aria-label={allSelected ? t("settings.shared.clearSelection") : t("settings.shared.selectAll")}
                      onChange={() => setSelectedModelIndexes(allSelected ? new Set() : new Set(draft.models.map((_, i) => i)))}
                    />
                    {selectedModelIndexes.size === 0 ? (
                      <>
                        <span className="flex-1">{t("settings.shared.modelId")}</span>
                        <span className="w-[168px]">{t("settings.shared.modelLabel")}</span>
                        <span className="w-[144px] text-center">{t("settings.shared.capabilities")}</span>
                      </>
                    ) : (
                      <span className="flex flex-1 flex-wrap items-center gap-1">
                        <span className="mr-1 font-medium text-content">{t("settings.shared.selectedCount", { n: selectedModelIndexes.size })}</span>
                        {([
                          ["vision-on", "settings.shared.enableVisionSelected"],
                          ["vision-off", "settings.shared.disableVisionSelected"],
                          ["reasoning-on", "settings.shared.enableReasoningSelected"],
                          ["reasoning-off", "settings.shared.disableReasoningSelected"],
                        ] as const).map(([k, label]) => (
                          <button key={k} type="button" disabled={locked} onClick={() => updateSelectedModels(k)}
                            className="h-6 rounded-md px-2 text-content-muted transition-colors hover:bg-surface-hover hover:text-content disabled:opacity-50">
                            {t(label)}
                          </button>
                        ))}
                      </span>
                    )}
                  </div>
                  <ul className="divide-y divide-edge">
                    {draft.models.map((model, index) => {
                      const vision = model.input?.includes("image") ?? false;
                      const reasoning = model.reasoning ?? false;
                      const noInterface = model.interfaces !== undefined && model.interfaces.length === 0;
                      return (
                        <li key={index} className={cn("px-3 py-2", selectedModelIndexes.has(index) && "bg-accent/[0.04]")}>
                          <div className="flex items-center gap-2.5">
                            <input type="checkbox" className={CHECKBOX} checked={selectedModelIndexes.has(index)} disabled={locked}
                              aria-label={t("settings.shared.selectModel", { n: index + 1 })}
                              onChange={(event) => toggleModelSelection(index, event.target.checked)} />
                            <Input required aria-label={t("settings.shared.modelId")} placeholder="gpt-5.1 / deepseek-v4-pro" value={model.id} disabled={busy}
                              className="min-w-0 flex-1 font-mono" spellCheck={false}
                              onChange={(e) => updateModel(index, { id: e.target.value })} />
                            <Input aria-label={t("settings.shared.modelLabel")} placeholder={t("settings.shared.modelLabelShort")} value={model.label ?? ""} disabled={busy}
                              className="w-[168px] shrink-0"
                              onChange={(e) => updateModel(index, { label: e.target.value })} />
                            <span className="flex w-[144px] shrink-0 items-center justify-center gap-1">
                              <CapToggle on={vision} disabled={busy} icon={<IconPhoto size={15} />} label={t("settings.shared.vision")}
                                onClick={() => updateModel(index, { input: vision ? ["text"] : ["text", "image"] })} />
                              <CapToggle on={reasoning} disabled={busy} icon={<IconBrain size={15} />} label={t("settings.shared.reasoning")}
                                onClick={() => updateModel(index, { reasoning: !reasoning })} />
                              <CapToggle on={model.imageGeneration ?? false} disabled={busy} icon={<IconSparkles size={15} />} label={t("settings.shared.imageGeneration")}
                                onClick={() => updateModel(index, { imageGeneration: model.imageGeneration ? undefined : true })} />
                              <button type="button" title={t("settings.shared.removeModel")} aria-label={t("settings.shared.removeModel")}
                                disabled={busy || draft.models.length === 1} onClick={() => removeModel(index)}
                                className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-content-subtle transition-colors hover:bg-danger/10 hover:text-danger disabled:pointer-events-none disabled:opacity-30">
                                <IconTrash size={14} />
                              </button>
                            </span>
                          </div>
                          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2 pl-6 text-[11.5px] text-content-subtle">
                            <span className="flex flex-wrap items-center gap-1.5">
                              <span>{t("settings.shared.modelInterfaces")}</span>
                              {draft.protocols.map((protocol) => {
                                const on = (model.interfaces ?? draft.protocols).includes(protocol);
                                return (
                                  <button key={protocol} type="button" aria-pressed={on} disabled={busy || (on && resolveSharedModelInterfaces(draft.protocols, model.interfaces).length === 1)}
                                    onClick={() => toggleModelInterface(index, protocol, !on)}
                                    className={cn("h-6 rounded-md border px-2 transition-colors",
                                      on ? "border-accent/45 bg-accent/10 text-content" : "border-edge text-content-subtle hover:text-content")}>
                                    {SHORT[protocol]}
                                  </button>
                                );
                              })}
                              {noInterface && <span className="text-danger">{t("settings.shared.modelInterfaceRequired")}</span>}
                            </span>
                            <span className="flex flex-wrap gap-2">
                              {draft.enabledAgents.map((agent) => {
                                const protocol = resolveSharedModelProtocol(agent, draft.protocols, model.interfaces);
                                return <span key={agent}>{t("settings.shared.modelRoute", { agent: LABELS[agent], protocol: protocol ? SHORT[protocol] : t("settings.shared.unavailable") })}</span>;
                              })}
                            </span>
                            {advanced && (
                              <span className="flex items-center gap-2">
                                <span>{t("settings.shared.contextShort")}</span>
                                <Input type="number" min={1} step={1} value={model.contextWindow ?? ""} disabled={busy} className="h-7 w-28"
                                  aria-label={t("settings.shared.contextWindow")} placeholder="1000000"
                                  onChange={(e) => updateModel(index, { contextWindow: e.target.value ? Number(e.target.value) : undefined })} />
                                <span>{t("settings.shared.maxTokensShort")}</span>
                                <Input type="number" min={1} step={1} value={model.maxTokens ?? ""} disabled={busy} className="h-7 w-24"
                                  aria-label={t("settings.shared.maxTokens")} placeholder="32000"
                                  onChange={(e) => updateModel(index, { maxTokens: e.target.value ? Number(e.target.value) : undefined })} />
                              </span>
                            )}
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              </Section>

              {/* 高级 */}
              <section className="rounded-lg border border-edge">
                <button type="button" onClick={() => setAdvanced(!advanced)} aria-expanded={advanced}
                  className="flex h-10 w-full items-center gap-2 px-3 text-left text-[13px] font-medium text-content-muted transition-colors hover:text-content">
                  <IconChevronRight size={14} className={cn("shrink-0 transition-transform", advanced && "rotate-90")} />
                  {t("settings.shared.advancedTitle")}
                  <span className="ml-auto text-[11.5px] font-normal text-content-subtle">{t("settings.shared.advancedSummary")}</span>
                </button>
                {advanced && (
                  <div className="space-y-3 border-t border-edge px-3 py-3">
                    <p className="text-[11.5px] leading-relaxed text-content-subtle">{t("settings.shared.overrideHint")}</p>
                    <Field label={t("settings.shared.modelsEndpoint")} hint={t("settings.shared.modelsEndpointHint")}>
                      <Input type="url" className="font-mono" value={draft.modelsEndpoint ?? ""} disabled={locked} placeholder={t("settings.shared.modelsEndpointPlaceholder")}
                        onChange={(e) => change({ modelsEndpoint: e.target.value || undefined })} />
                    </Field>
                    {draft.protocols.map((protocol) => (
                      <Field key={protocol} label={LABELS[protocol]}>
                        <Input type="url" className="font-mono" value={draft.endpointOverrides?.[protocol] ?? ""} disabled={busy} placeholder={draft.baseUrl}
                          onChange={(e) => {
                            const endpointOverrides = { ...draft.endpointOverrides };
                            if (e.target.value) endpointOverrides[protocol] = e.target.value;
                            else delete endpointOverrides[protocol];
                            change({ endpointOverrides });
                          }} />
                      </Field>
                    ))}
                  </div>
                )}
              </section>

              <p className="rounded-lg bg-accent/[0.06] px-3 py-2.5 text-[11.5px] leading-relaxed text-content-muted">{t("settings.shared.isolation")}</p>
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
          <Dialog.Popup className="flex max-h-[80vh] w-[720px] max-w-[92vw] flex-col p-0">
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
                const opt = discovered.options[model.id] ?? defaultDiscoveryOption(discovered.protocol);
                const setOpt = (next: DiscoveryOption) => setDiscovered((value) => value ? {
                  ...value,
                  options: { ...value.options, [model.id]: next },
                  // Adjusting a row's options implies the user wants it.
                  selectedIds: value.selectedIds.includes(model.id) ? value.selectedIds : [...value.selectedIds, model.id],
                } : value);
                return <div key={model.id} className={cn("flex items-center gap-3 rounded-lg px-2 py-2", exists ? "opacity-60" : "hover:bg-surface-hover")}>
                  <label className={cn("flex min-w-0 flex-1 items-center gap-3", exists ? "cursor-default" : "cursor-pointer")}>
                    <input type="checkbox" className={CHECKBOX} checked={checked} disabled={exists} onChange={(event) => setDiscovered((value) => value ? {
                      ...value,
                      selectedIds: event.target.checked ? [...value.selectedIds, model.id] : value.selectedIds.filter((id) => id !== model.id),
                    } : value)} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm text-content">{model.label}</span>
                      <span className="block truncate font-mono text-xs text-content-subtle">{model.id}</span>
                    </span>
                  </label>
                  {exists ? (
                    <span className="rounded bg-surface-muted px-2 py-0.5 text-[11px] text-content-subtle">{t("settings.shared.existingModel")}</span>
                  ) : (
                    <span className="flex shrink-0 items-center gap-1">
                      {DISCOVERY_INTERFACES.filter((p) => draft?.protocols.includes(p)).map((p) => {
                        const on = opt.interfaces.includes(p);
                        // Keep at least one interface — a model with none can't be saved.
                        const last = on && opt.interfaces.length === 1;
                        return (
                          <MiniToggle key={p} on={on} disabled={last} title={last ? t("settings.shared.modelInterfaceRequired") : LABELS[p]}
                            onClick={() => setOpt({ ...opt, interfaces: on ? opt.interfaces.filter((x) => x !== p) : [...opt.interfaces, p] })}>
                            {SHORT[p]}
                          </MiniToggle>
                        );
                      })}
                      <span className="mx-0.5 h-4 w-px bg-edge" aria-hidden />
                      <MiniToggle on={opt.image} title={t("settings.shared.imageGeneration")} onClick={() => setOpt({ ...opt, image: !opt.image })}>
                        <IconSparkles size={12} />{t("settings.shared.imageGenerationShort")}
                      </MiniToggle>
                    </span>
                  )}
                </div>;
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
