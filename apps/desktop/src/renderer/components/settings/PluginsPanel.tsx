/**
 * Claude Code plugins settings panel.
 *
 * The Claude CLI installs and updates plugins itself; this panel lists what is
 * installed (read from ~/.mariocode/plugins) and flips the `enabledPlugins`
 * switch in settings.json. There is deliberately no installer here: the last
 * in-app plugin manager (removed in ee5c88c) fought the CLI over the same
 * directory.
 *
 * State is panel-local — nothing outside this panel consumes it, and the
 * settings shell remounts panels on section change, so every visit re-reads
 * the files and picks up changes the CLI made in the meantime.
 */
import { useCallback, useEffect, useState } from "react";
import { cn } from "@renderer/lib/cn.js";
import { api } from "@renderer/lib/api.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { Switch } from "@renderer/components/ui/index.js";
import { PanelHeader } from "./PanelHeader.js";
import { SettingsSection } from "./SettingsSection.js";
import type { PluginComponentItem, PluginState } from "@contracts/ipc";
import {
  IconAlertTriangle,
  IconChevronDown,
  IconChevronRight,
  IconLoader2,
  IconPuzzle,
} from "@renderer/lib/icons.js";

/** Strip Electron's "Error invoking remote method '…': Error:" wrapper. */
function cleanError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.replace(/^Error invoking remote method '[^']*':\s*(?:Error:\s*)?/, "");
}

export function PluginsPanel() {
  const { t } = useI18n();
  const [plugins, setPlugins] = useState<PluginState[]>([]);
  const [configPath, setConfigPath] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [pending, setPending] = useState<Set<string>>(new Set());

  const reload = useCallback(async (): Promise<void> => {
    const result = await api.plugins.list();
    setPlugins(result.plugins);
    setConfigPath(result.configPath);
  }, []);

  useEffect(() => {
    let mounted = true;
    api.plugins
      .list()
      .then((result) => {
        if (!mounted) return;
        setPlugins(result.plugins);
        setConfigPath(result.configPath);
      })
      .catch((e: unknown) => {
        if (mounted) setError(t("settings.plugins.loadFailed", { error: cleanError(e) }));
      })
      .finally(() => {
        if (mounted) setLoading(false);
      });
    return () => {
      mounted = false;
    };
    // Mount-only read; `t` changes with locale and must not re-trigger IO.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggle = async (plugin: PluginState, enabled: boolean): Promise<void> => {
    setError(null);
    setPending((prev) => new Set(prev).add(plugin.id));
    // Optimistic flip so the switch feels instant; reload() below restores
    // the on-disk truth either way.
    setPlugins((prev) => prev.map((p) => (p.id === plugin.id ? { ...p, enabled } : p)));
    try {
      const result = await api.plugins.setEnabled({ id: plugin.id, enabled });
      if (!result.ok) setError(t("settings.plugins.toggleFailed", { error: result.error ?? "unknown" }));
      await reload();
    } catch (e) {
      setError(t("settings.plugins.toggleFailed", { error: cleanError(e) }));
      await reload().catch(() => undefined);
    } finally {
      setPending((prev) => {
        const next = new Set(prev);
        next.delete(plugin.id);
        return next;
      });
    }
  };

  const toggleExpanded = (id: string): void =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <section className="mx-auto w-full max-w-3xl space-y-4">
      <PanelHeader title={t("settings.plugins.title")} icon={IconPuzzle} />

      {error && (
        <p
          role="alert"
          className="flex items-start gap-1.5 rounded-lg bg-danger/10 px-3 py-2.5 text-[13px] text-danger"
        >
          <IconAlertTriangle size={14} className="mt-0.5 shrink-0" />
          <span className="min-w-0 break-words">{error}</span>
        </p>
      )}

      <SettingsSection title={t("settings.plugins.section")} desc={t("settings.plugins.desc")}>
        {loading && (
          <div className="grid place-items-center py-6">
            <IconLoader2 size={18} className="animate-spin text-content-subtle" aria-label={t("settings.plugins.loading")} />
          </div>
        )}
        {!loading && plugins.length === 0 && (
          <p className="px-4 py-6 text-center text-[12px] leading-relaxed text-content-subtle">
            {t("settings.plugins.empty")}
          </p>
        )}
        {plugins.map((plugin) => (
          <PluginRow
            key={plugin.id}
            plugin={plugin}
            busy={pending.has(plugin.id)}
            open={expanded.has(plugin.id)}
            onToggle={(enabled) => void toggle(plugin, enabled)}
            onToggleOpen={() => toggleExpanded(plugin.id)}
          />
        ))}
      </SettingsSection>

      {configPath && (
        <p className="px-1 text-[0.7857em] break-all text-content-subtle">
          {t("settings.plugins.configPath", { path: configPath })}
        </p>
      )}
    </section>
  );
}

function PluginRow({
  plugin,
  busy,
  open,
  onToggle,
  onToggleOpen,
}: {
  plugin: PluginState;
  busy: boolean;
  open: boolean;
  onToggle: (enabled: boolean) => void;
  onToggleOpen: () => void;
}) {
  const { t } = useI18n();
  const hasComponents =
    plugin.skills.length + plugin.commands.length + plugin.agents.length + plugin.mcpServers.length > 0;
  const chips: string[] = [];
  if (plugin.skills.length) chips.push(t("settings.plugins.skills", { count: plugin.skills.length }));
  if (plugin.commands.length) chips.push(t("settings.plugins.commands", { count: plugin.commands.length }));
  if (plugin.agents.length) chips.push(t("settings.plugins.agents", { count: plugin.agents.length }));
  if (plugin.mcpServers.length) chips.push(t("settings.plugins.mcp", { count: plugin.mcpServers.length }));
  if (plugin.hasHooks) chips.push(t("settings.plugins.hooks"));
  const switchId = `setting-plugin-${plugin.id}`;

  return (
    <div className="px-4 py-3" data-plugin-id={plugin.id}>
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-baseline gap-x-2">
            <label htmlFor={switchId} className="truncate text-[0.9286em] font-medium text-content">
              {plugin.name}
            </label>
            {plugin.version && <span className="text-[0.7857em] text-content-subtle">v{plugin.version}</span>}
            <span className="text-[0.7857em] text-content-subtle">@{plugin.marketplace}</span>
          </div>
          {plugin.description && (
            <p className="mt-1 line-clamp-2 text-[0.8571em] leading-relaxed text-content-muted">
              {plugin.description}
            </p>
          )}
          {plugin.error && (
            <p className="mt-1 flex items-center gap-1 text-[0.8571em] text-warning">
              <IconAlertTriangle size={12} className="shrink-0" />
              {plugin.installed ? plugin.error : plugin.error === "enabled in settings but not installed"
                ? t("settings.plugins.notInstalled")
                : plugin.error}
            </p>
          )}
          {chips.length > 0 && (
            <p className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-[0.7857em] text-content-subtle">
              {chips.map((chip) => (
                <span key={chip}>{chip}</span>
              ))}
            </p>
          )}
          {hasComponents && (
            <button
              type="button"
              onClick={onToggleOpen}
              aria-expanded={open}
              className="mt-1.5 inline-flex items-center gap-0.5 rounded text-[0.7857em] text-content-muted hover:text-content focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
            >
              {open ? <IconChevronDown size={12} /> : <IconChevronRight size={12} />}
              {open ? t("settings.plugins.hideDetails") : t("settings.plugins.showDetails")}
            </button>
          )}
        </div>
        <Switch
          id={switchId}
          checked={plugin.enabled}
          disabled={busy}
          onCheckedChange={onToggle}
          label={t("settings.plugins.enabledLabel", { name: plugin.name })}
        />
      </div>
      {open && (
        <div className={cn("mt-2 space-y-2 border-l border-edge pl-3")}>
          <ComponentList title={t("settings.plugins.skills", { count: plugin.skills.length })} items={plugin.skills} />
          <ComponentList title={t("settings.plugins.commands", { count: plugin.commands.length })} items={plugin.commands} />
          <ComponentList title={t("settings.plugins.agents", { count: plugin.agents.length })} items={plugin.agents} />
          {plugin.mcpServers.length > 0 && (
            <div>
              <p className="text-[0.7857em] font-medium text-content-muted">
                {t("settings.plugins.mcp", { count: plugin.mcpServers.length })}
              </p>
              <p className="text-[0.7857em] text-content-subtle">{t("settings.plugins.mcpHint")}</p>
              <p className="mt-0.5 text-[0.8571em] break-words text-content">{plugin.mcpServers.join(", ")}</p>
            </div>
          )}
          {plugin.hasHooks && <p className="text-[0.7857em] text-content-subtle">{t("settings.plugins.hooksHint")}</p>}
        </div>
      )}
    </div>
  );
}

function ComponentList({ title, items }: { title: string; items: PluginComponentItem[] }) {
  if (items.length === 0) return null;
  return (
    <div>
      <p className="text-[0.7857em] font-medium text-content-muted">{title}</p>
      <ul className="mt-0.5 space-y-0.5">
        {items.map((item) => (
          <li key={item.name} className="text-[0.8571em] break-words text-content">
            {item.name}
            {item.description && <span className="text-content-subtle"> — {item.description}</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}
