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
  IconChevronDown,
  IconChevronUp,
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
 * Two states, and the second one does not exist until the SERVER agrees:
 *
 *   locked   — a password field. Nothing else is rendered: no model list, no
 *              push button. Every build ships this panel, so the gate is what
 *              keeps a normal user out of the editor.
 *   unlocked — the full editor, only after `builtinRelay.unlock` got a 200 from
 *              `GET /admin/verify`. There is intentionally no local password
 *              check; the correct value lives on the server, not in the bundle.
 *
 * Edits the model list that the built-in relay card publishes and pushes it to
 * the relay server, which overwrites the previous document (no history by
 * design). The address is displayed but never editable: it is a code constant,
 * so a compromised admin password cannot repoint anyone's key.
 *
 * What an administrator can decide per model: id, display name, context
 * window, which of the three interfaces it speaks, and the three capability
 * flags (思考 / 读图 / 生图). The ROW ORDER IS THE USER-FACING ORDER of the
 * model list, so rows can be moved instead of only appended.
 *
 * Everything the user submits is re-validated in the main process with
 * `RelayConfigSchema`; the local checks here exist only to keep obviously
 * broken drafts from making a round trip.
 */
const PROTOCOLS: SharedProviderProtocol[] = ["anthropic", "chat-completions", "responses"];
const SHORT: Record<SharedProviderProtocol, string> = { anthropic: "Messages", "chat-completions": "Chat", responses: "Responses" };
const TEXT_ONLY = ["text"] as const;

/** Stable per-row identity for selection + reordering. Model ids are not
 *  unique while a draft is being typed, and reordering must move the whole
 *  row, including its selection. */
type Row = { key: string; model: RelayConfigModel };
let rowSeq = 0;
const nextKey = () => `relay-row-${++rowSeq}`;
const toRows = (models: RelayConfigModel[]): Row[] => models.map((model) => ({ key: nextKey(), model: { ...model } }));

/** Capability flag helpers. Each returns a NEW model so React state updates
 *  stay shallow-copy clean, and deletes the key instead of writing
 *  `undefined` (`exactOptionalPropertyTypes`). */
function withReasoning(model: RelayConfigModel, on: boolean): RelayConfigModel {
  const next = { ...model };
  if (on) next.reasoning = true;
  else delete next.reasoning;
  return next;
}
function withVision(model: RelayConfigModel, on: boolean): RelayConfigModel {
  return { ...model, input: on ? ["text", "image"] : [...TEXT_ONLY] };
}
function withImageGen(model: RelayConfigModel, on: boolean): RelayConfigModel {
  const next = { ...model };
  if (on) next.imageGeneration = true;
  else delete next.imageGeneration;
  return next;
}

export function RelayAdminPanel() {
  const { t } = useI18n();
  const [status, setStatus] = useState<BuiltinRelayStatus | null>(null);
  const [name, setName] = useState("");
  const [rows, setRows] = useState<Row[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  /** The typed administrator password. Held only until the server says yes, or
   *  until the field is cleared — never persisted from here. */
  const [password, setPassword] = useState("");
  const [revealPassword, setRevealPassword] = useState(false);
  const [busy, setBusy] = useState<"load" | "refresh" | "push" | "unlock" | "lock" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingPush, setPendingPush] = useState<ReturnType<typeof diffRelayConfigs> | null>(null);

  function adopt(next: BuiltinRelayStatus) {
    setStatus(next);
    setName(next.config.name ?? BUILTIN_RELAY_FALLBACK_CONFIG.name ?? "");
    setRows(toRows(next.config.models));
    setSelected(new Set());
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
   *  duplicate ids, a model with no interface). Main validates again. Row
   *  order is preserved — that IS the published order. */
  const draftConfig: RelayConfig | null = useMemo(() => {
    const cleaned: RelayConfigModel[] = rows
      .map(({ model }) => {
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
  }, [rows, name]);

  const diff = useMemo(
    () => (status && draftConfig ? diffRelayConfigs(status.config, draftConfig) : null),
    [status, draftConfig],
  );
  const dirty = !!diff && diff.added.length + diff.changed.length + diff.removed.length > 0;
  const lock = busy !== null;

  const selectedCount = useMemo(() => rows.filter((row) => selected.has(row.key)).length, [rows, selected]);
  const allSelected = rows.length > 0 && selectedCount === rows.length;

  function patchRow(key: string, patch: Partial<RelayConfigModel>) {
    setRows((current) => current.map((row) => (row.key === key ? { ...row, model: { ...row.model, ...patch } } : row)));
  }

  /** Apply a capability flag to every selected row — the bulk switches exist
   *  because a 20-model list should not need 20 clicks per flag. */
  function bulk(update: (model: RelayConfigModel) => RelayConfigModel) {
    setRows((current) => current.map((row) => (selected.has(row.key) ? { ...row, model: update(row.model) } : row)));
  }

  function toggleRow(key: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function toggleAll() {
    setSelected((current) => (current.size === rows.length ? new Set() : new Set(rows.map((row) => row.key))));
  }

  /** Move one row by `delta`; the published order is exactly this order. */
  function moveRow(key: string, delta: -1 | 1) {
    setRows((current) => {
      const index = current.findIndex((row) => row.key === key);
      const target = index + delta;
      if (index < 0 || target < 0 || target >= current.length) return current;
      const next = [...current];
      const [moved] = next.splice(index, 1);
      next.splice(target, 0, moved!);
      return next;
    });
  }

  function removeRow(key: string) {
    setRows((current) => current.filter((row) => row.key !== key));
    setSelected((current) => {
      if (!current.has(key)) return current;
      const next = new Set(current);
      next.delete(key);
      return next;
    });
  }

  function addRow() {
    const row: Row = { key: nextKey(), model: { id: "", interfaces: [...PROTOCOLS] } };
    setRows((current) => [...current, row]);
  }

  function stripIpcError(raw: string): string {
    return raw.replace(/^Error invoking remote method '[^']*':\s*(?:Error:\s*)?/, "");
  }

  async function refreshOnline() {
    setBusy("refresh");
    setError(null);
    try {
      adopt(await api.builtinRelay.refresh());
      useToastStore.getState().push({ kind: "info", title: t("settings.about.relay.refreshed"), duration: 4_000 });
    } catch (e) {
      setError(stripIpcError(e instanceof Error ? e.message : String(e)));
    } finally {
      setBusy(null);
    }
  }

  /** Ask the server whether this password is the administrator's. The main
   *  process performs the request and only stores the password on a 200, so a
   *  wrong guess leaves the panel locked and nothing behind on disk. */
  async function unlockPanel() {
    if (!password.trim()) return;
    setBusy("unlock");
    setError(null);
    try {
      adopt(await api.builtinRelay.unlock({ token: password.trim() }));
      setPassword("");
      setRevealPassword(false);
      useToastStore.getState().push({ kind: "info", title: t("settings.about.relay.unlockOk"), duration: 4_000 });
    } catch (e) {
      setError(stripIpcError(e instanceof Error ? e.message : String(e)));
    } finally {
      setBusy(null);
    }
  }

  async function lockPanel() {
    setBusy("lock");
    setError(null);
    try {
      adopt(await api.builtinRelay.lock());
      setPassword("");
      setPendingPush(null);
    } catch (e) {
      setError(stripIpcError(e instanceof Error ? e.message : String(e)));
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
      setError(stripIpcError(e instanceof Error ? e.message : String(e)));
      setPendingPush(null);
      // A 401 means the main process just dropped the stored password; re-read
      // the status so the panel falls back to the lock screen instead of
      // showing an editor whose push can never succeed.
      try {
        setStatus(await api.builtinRelay.status());
      } catch {
        /* keep the current view; the error above already explains the failure */
      }
    } finally {
      setBusy(null);
    }
  }

  const bulkDisabled = lock || selectedCount === 0;
  const chipClass = (on: boolean) =>
    cn(
      "h-6 rounded-md border px-2 transition-colors",
      on ? "border-accent/45 bg-accent/10 text-content" : "border-edge text-content-subtle hover:text-content",
    );

  const shell = "mt-8 w-full max-w-md space-y-3";
  const header = (
    <div className="flex items-center gap-2">
      <IconShieldLock size={14} className="shrink-0 text-content-subtle" />
      <h3 className="text-[13px] font-semibold text-content">{t("settings.about.relay.title")}</h3>
      <span className="ml-auto flex items-center gap-1 text-[11.5px] text-content-subtle">
        {status?.hasAdminToken ? (
          <>
            <span className="text-content-muted">{t(`settings.shared.relay.source.${status.source}`)}</span>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="ml-1 text-content-subtle hover:text-danger"
              disabled={lock}
              onClick={() => void lockPanel()}
            >
              {busy === "lock" ? <IconLoader2 size={12} className="animate-spin" /> : <IconLock size={12} />}
              {t("settings.about.relay.lock")}
            </Button>
          </>
        ) : (
          <>
            <IconLock size={11} />
            {t("settings.about.relay.lockedBadge")}
          </>
        )}
      </span>
    </div>
  );
  const errorLine = error ? (
    <p role="alert" className="break-words rounded-lg bg-danger/10 px-3 py-2 text-[12.5px] text-danger">
      {error}
    </p>
  ) : null;

  // ── Loading ────────────────────────────────────────────────────────────────
  // `status` is null only until the first IPC round trip returns. Rendering the
  // password field before then would let a keystroke land in a form that is
  // about to be replaced.
  if (!status) {
    return (
      <div className={shell} data-relay-admin data-relay-locked>
        {header}
        <div className="flex items-center gap-2 rounded-lg border border-edge p-3 text-[12px] text-content-subtle">
          <IconLoader2 size={13} className="animate-spin" />
          {t("common.loading")}
        </div>
      </div>
    );
  }

  // ── Locked ─────────────────────────────────────────────────────────────────
  // The panel is ALWAYS mounted in 设置 → 关于 (every build ships it), but the
  // editor below is not rendered at all until the server confirms the password.
  // There is deliberately no local "is this the right password" comparison: the
  // only value this app can check against is the one it typed in.
  if (!status.hasAdminToken) {
    return (
      <div className={shell} data-relay-admin data-relay-locked>
        {header}
        <form
          className="space-y-2 rounded-lg border border-edge p-3"
          onSubmit={(event) => {
            event.preventDefault();
            void unlockPanel();
          }}
        >
          <p className="text-[11.5px] leading-relaxed text-content-subtle">{t("settings.about.relay.lockHint")}</p>
          {errorLine}
          <div className="flex items-center gap-2">
            <Input
              type={revealPassword ? "text" : "password"}
              autoComplete="current-password"
              spellCheck={false}
              aria-label={t("settings.about.relay.password")}
              placeholder={t("settings.about.relay.password")}
              className="min-w-0 flex-1 font-mono"
              value={password}
              disabled={lock}
              onChange={(event) => setPassword(event.target.value)}
            />
            <Button
              type="button"
              size="sm"
              variant="ghost"
              aria-pressed={revealPassword}
              aria-label={t("settings.about.relay.reveal")}
              disabled={lock}
              onClick={() => setRevealPassword((current) => !current)}
            >
              {t("settings.about.relay.reveal")}
            </Button>
            <Button type="submit" size="sm" variant="primary" disabled={lock || password.trim().length === 0}>
              {busy === "unlock" && <IconLoader2 size={13} className="animate-spin" />}
              {t("settings.about.relay.unlock")}
            </Button>
          </div>
        </form>
      </div>
    );
  }

  return (
    <div className={shell} data-relay-admin>
      {header}

      {errorLine}

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
            {t("settings.about.relay.models", { n: rows.length })}
          </span>
          <span className="ml-auto flex items-center gap-1">
            <Button type="button" size="sm" variant="ghost" disabled={lock} onClick={() => void refreshOnline()}>
              {busy === "refresh" ? <IconLoader2 size={13} className="animate-spin" /> : <IconRefresh size={13} />}
              {t("settings.about.relay.pullOnline")}
            </Button>
            <Button type="button" size="sm" variant="ghost" disabled={lock} onClick={addRow}>
              <IconPlus size={13} />{t("settings.shared.addModel")}
            </Button>
          </span>
        </div>

        {/* Multi-select toolbar: one switch flips a whole selection at once. */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-edge bg-surface-muted/40 px-3 py-2 text-[11.5px] text-content-subtle">
          <label className="flex cursor-pointer items-center gap-1.5 text-content-muted">
            <input
              type="checkbox"
              className="h-3.5 w-3.5 shrink-0 cursor-pointer accent-accent"
              aria-label={t("settings.about.relay.selectAll")}
              checked={allSelected}
              disabled={lock || rows.length === 0}
              onChange={toggleAll}
            />
            {t("settings.about.relay.selectedCount", { n: selectedCount, m: rows.length })}
          </label>
          {(
            [
              ["reasoning", withReasoning],
              ["vision", withVision],
              ["imageGeneration", withImageGen],
            ] as const
          ).map(([flag, apply]) => (
            <span key={flag} className="flex items-center gap-1">
              <span>{t(`settings.about.relay.bulk.${flag}`)}</span>
              {[true, false].map((on) => (
                <button
                  key={String(on)}
                  type="button"
                  aria-label={t(`settings.about.relay.bulk.${flag}${on ? "On" : "Off"}`)}
                  disabled={bulkDisabled}
                  onClick={() => bulk((model) => apply(model, on))}
                  className={cn(
                    "h-6 rounded-md border border-edge px-1.5 transition-colors hover:text-content disabled:opacity-40",
                  )}
                >
                  {t(on ? "settings.about.relay.on" : "settings.about.relay.off")}
                </button>
              ))}
            </span>
          ))}
        </div>

        <ul className="divide-y divide-edge">
          {rows.map((row, index) => {
            const model = row.model;
            const interfaces = model.interfaces ?? PROTOCOLS;
            const isSelected = selected.has(row.key);
            return (
              <li key={row.key} className={cn("space-y-2 px-3 py-2", isSelected && "bg-accent/[0.04]")}>
                <div className="flex items-center gap-1.5">
                  <input
                    type="checkbox"
                    className="h-3.5 w-3.5 shrink-0 cursor-pointer accent-accent"
                    aria-label={t("settings.about.relay.selectModel", { id: model.id || t("settings.shared.newProvider") })}
                    checked={isSelected}
                    disabled={lock}
                    onChange={() => toggleRow(row.key)}
                  />
                  <span className="flex shrink-0 flex-col">
                    <button
                      type="button"
                      aria-label={t("settings.about.relay.moveUp")}
                      disabled={lock || index === 0}
                      onClick={() => moveRow(row.key, -1)}
                      className="grid h-4 w-4 place-items-center rounded text-content-subtle transition-colors hover:text-content disabled:opacity-30"
                    >
                      <IconChevronUp size={12} />
                    </button>
                    <button
                      type="button"
                      aria-label={t("settings.about.relay.moveDown")}
                      disabled={lock || index === rows.length - 1}
                      onClick={() => moveRow(row.key, 1)}
                      className="grid h-4 w-4 place-items-center rounded text-content-subtle transition-colors hover:text-content disabled:opacity-30"
                    >
                      <IconChevronDown size={12} />
                    </button>
                  </span>
                  <Input
                    aria-label={t("settings.shared.modelId")}
                    placeholder="gpt-5.1"
                    spellCheck={false}
                    className="min-w-0 flex-1 font-mono"
                    value={model.id}
                    disabled={lock}
                    onChange={(e) => patchRow(row.key, { id: e.target.value })}
                  />
                  <button
                    type="button"
                    title={t("settings.shared.removeModel")}
                    aria-label={t("settings.shared.removeModel")}
                    disabled={lock}
                    onClick={() => removeRow(row.key)}
                    className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-content-subtle transition-colors hover:bg-danger/10 hover:text-danger disabled:opacity-40"
                  >
                    <IconTrash size={14} />
                  </button>
                </div>
                <div className="flex items-center gap-2">
                  <Input
                    aria-label={t("settings.shared.modelLabel")}
                    placeholder={t("settings.shared.modelLabelShort")}
                    className="min-w-0 flex-1"
                    value={model.label ?? ""}
                    disabled={lock}
                    onChange={(e) => patchRow(row.key, { label: e.target.value })}
                  />
                  <Input
                    type="number"
                    min={1}
                    step={1000}
                    aria-label={t("settings.shared.contextWindow")}
                    placeholder="200000"
                    className="w-[110px] shrink-0"
                    value={model.contextWindow ?? ""}
                    disabled={lock}
                    onChange={(e) => patchRow(row.key, { contextWindow: e.target.value ? Number(e.target.value) : undefined })}
                  />
                </div>
                <div className="flex flex-wrap items-center gap-1.5 pl-1 text-[11.5px] text-content-subtle">
                  {PROTOCOLS.map((protocol) => {
                    const on = interfaces.includes(protocol);
                    return (
                      <button
                        key={protocol}
                        type="button"
                        aria-pressed={on}
                        disabled={lock || (on && interfaces.length === 1)}
                        onClick={() =>
                          patchRow(row.key, {
                            interfaces: on
                              ? interfaces.filter((value) => value !== protocol)
                              : [...new Set([...interfaces, protocol])],
                          })
                        }
                        className={chipClass(on)}
                      >
                        {SHORT[protocol]}
                      </button>
                    );
                  })}
                  <span className="mx-0.5 h-4 w-px bg-edge" aria-hidden />
                  <button
                    type="button"
                    aria-pressed={model.reasoning ?? false}
                    disabled={lock}
                    onClick={() =>
                      setRows((current) =>
                        current.map((item) =>
                          item.key === row.key ? { ...item, model: withReasoning(item.model, !item.model.reasoning) } : item,
                        ),
                      )
                    }
                    className={chipClass(model.reasoning ?? false)}
                  >
                    {t("settings.shared.reasoning")}
                  </button>
                  <button
                    type="button"
                    aria-pressed={model.input?.includes("image") ?? false}
                    disabled={lock}
                    onClick={() =>
                      setRows((current) =>
                        current.map((item) =>
                          item.key === row.key
                            ? { ...item, model: withVision(item.model, !item.model.input?.includes("image")) }
                            : item,
                        ),
                      )
                    }
                    className={chipClass(model.input?.includes("image") ?? false)}
                  >
                    {t("settings.shared.vision")}
                  </button>
                  <button
                    type="button"
                    aria-pressed={model.imageGeneration ?? false}
                    disabled={lock}
                    onClick={() =>
                      setRows((current) =>
                        current.map((item) =>
                          item.key === row.key
                            ? { ...item, model: withImageGen(item.model, !item.model.imageGeneration) }
                            : item,
                        ),
                      )
                    }
                    className={chipClass(model.imageGeneration ?? false)}
                  >
                    {t("settings.shared.imageGenerationShort")}
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
        <p className="border-t border-edge px-3 py-1.5 text-[11px] text-content-subtle">
          {t("settings.about.relay.orderHint")}
        </p>
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
            disabled={lock || !draftConfig || !status?.hasAdminToken}
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
