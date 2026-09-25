import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "@renderer/lib/api.js";
import { useI18n, type MessageId } from "@renderer/lib/i18n/index.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import { Button, Select } from "@renderer/components/ui/index.js";
import { IconDeviceFloppy, IconLoader2, IconMessageChatbot } from "@renderer/lib/icons.js";
import { SYSTEM_PROMPT_MAX_CHARS, AGENT_SYSTEM_PROMPT_GLOBAL_SETTING_KEY } from "@contracts/ipc";
import type { ProviderInfo, SystemPromptPreviewResult } from "@contracts/ipc";
import { PanelHeader } from "./PanelHeader.js";
import { SettingRow } from "./SettingRow.js";
import { SettingsSection } from "./SettingsSection.js";

const LAYER_LABELS: Record<string, MessageId> = {
  "engine.claude.base": "settings.systemPrompt.layer.engineClaude",
  "engine.claude.memory": "settings.systemPrompt.layer.engineMemory",
  "engine.pi.base": "settings.systemPrompt.layer.enginePi",
  "engine.codex.base": "settings.systemPrompt.layer.engineCodex",
  "engine.codex.projectAgents": "settings.systemPrompt.layer.engineProjectAgents",
  "engine.codex.environment": "settings.systemPrompt.layer.engineEnvironment",
  identity: "settings.systemPrompt.layer.identity",
  "user.global": "settings.systemPrompt.layer.userGlobal",
  "user.project": "settings.systemPrompt.layer.userProject",
  "claude.pathHint": "settings.systemPrompt.layer.claudePathHint",
  "claude.planNudge": "settings.systemPrompt.layer.claudePlan",
  "claude.askFallback": "settings.systemPrompt.layer.claudeAskFallback",
  "pi.askNative": "settings.systemPrompt.layer.piAsk",
  "pi.plan": "settings.systemPrompt.layer.piPlan",
  "browser.usage.on": "settings.systemPrompt.layer.browserOn",
  "browser.usage.off": "settings.systemPrompt.layer.browserOff",
  "builtin.usage.on": "settings.systemPrompt.layer.builtinOn",
  "builtin.usage.off": "settings.systemPrompt.layer.builtinOff",
  "codex.agentsHome": "settings.systemPrompt.layer.codexAgentsHome",
  "engine.unknown.base": "settings.systemPrompt.layer.engineUnknown",
};

const KIND_LABELS: Record<SystemPromptPreviewResult["sections"][number]["kind"], MessageId> = {
  engine: "settings.systemPrompt.kind.engine",
  fixed: "settings.systemPrompt.kind.fixed",
  conditional: "settings.systemPrompt.kind.conditional",
  user: "settings.systemPrompt.kind.user",
};

const textareaClass =
  "min-h-[170px] w-full resize-y rounded border border-edge bg-surface px-3 py-2 font-mono text-xs leading-relaxed text-content placeholder:text-content-subtle outline-none transition-colors focus:border-accent";

export function SystemPromptPanel() {
  const { t } = useI18n();
  const projects = useSessionStore((s) => s.projects);
  const activeProjectId = useSessionStore((s) => s.activeProjectId);
  const providers = useSessionStore((s) => s.providers);
  const activeProviderId = useSessionStore((s) => s.providerId);
  const activeProjects = useMemo(() => projects.filter((project) => !project.archived), [projects]);

  const [globalPrompt, setGlobalPrompt] = useState("");
  const [projectId, setProjectId] = useState<string | null>(activeProjectId);
  const [projectPrompt, setProjectPrompt] = useState("");
  const [projectExists, setProjectExists] = useState(false);
  const [providerId, setProviderId] = useState(activeProviderId || "claude-sdk");
  const [preview, setPreview] = useState<SystemPromptPreviewResult | null>(null);
  const [loadedProviders, setLoadedProviders] = useState<Array<Pick<ProviderInfo, "id" | "displayName">>>([]);
  const [loading, setLoading] = useState(true);
  const [projectLoading, setProjectLoading] = useState(false);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [saving, setSaving] = useState<"global" | "project" | null>(null);
  const [saved, setSaved] = useState<"global" | "project" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const selectedProject = activeProjects.find((project) => project.id === projectId) ?? null;
  const selectedProjectPath = selectedProject?.path ?? null;
  const availableProviders: Array<Pick<ProviderInfo, "id" | "displayName">> = providers.length > 0
    ? providers
    : loadedProviders.length > 0
      ? loadedProviders
      : [{ id: "claude-sdk", displayName: "Claude" }];

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Promise.all([
      api.setting.get({ key: AGENT_SYSTEM_PROMPT_GLOBAL_SETTING_KEY }),
      api.provider.list(),
    ])
      .then(([global, providerResult]) => {
        if (cancelled) return;
        setGlobalPrompt(global.value ?? "");
        setLoadedProviders(providerResult.providers.map(({ id, displayName }) => ({ id, displayName })));
        if (providerResult.providers.length > 0) {
          setProviderId((current) =>
            providerResult.providers.some((provider) => provider.id === current)
              ? current
              : providerResult.providers[0].id,
          );
        }
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!projectId) setProjectId(activeProjectId ?? activeProjects[0]?.id ?? null);
  }, [activeProjectId, activeProjects, projectId]);

  useEffect(() => {
    let cancelled = false;
    setProjectPrompt("");
    setProjectExists(false);
    if (!selectedProjectPath) return;
    setProjectLoading(true);
    api.systemPrompt
      .readProject({ projectPath: selectedProjectPath })
      .then((result) => {
        if (cancelled) return;
        setProjectPrompt(result.content);
        setProjectExists(result.exists);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setProjectLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedProjectPath]);

  const loadPreview = useCallback(() => {
    setPreviewLoading(true);
    api.systemPrompt
      .preview({ providerId, projectPath: selectedProjectPath })
      .then(setPreview)
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setPreviewLoading(false));
  }, [providerId, selectedProjectPath]);

  useEffect(() => {
    if (!loading) loadPreview();
  }, [loadPreview, loading]);

  const saveGlobal = async () => {
    setSaving("global");
    setSaved(null);
    setError(null);
    try {
      await api.setting.set({ key: AGENT_SYSTEM_PROMPT_GLOBAL_SETTING_KEY, value: globalPrompt });
      setSaved("global");
      loadPreview();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(null);
    }
  };

  const saveProject = async () => {
    if (!selectedProjectPath) return;
    setSaving("project");
    setSaved(null);
    setError(null);
    try {
      const result = await api.systemPrompt.writeProject({ projectPath: selectedProjectPath, content: projectPrompt });
      setProjectExists(result.exists);
      setSaved("project");
      loadPreview();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(null);
    }
  };

  const sectionLabel = (id: string): string => {
    const key = LAYER_LABELS[id];
    return key ? t(key) : id;
  };

  return (
    <section className="mx-auto w-full max-w-3xl space-y-4">
      <PanelHeader title={t("settings.systemPrompt.title")} icon={IconMessageChatbot} />

      <SettingsSection title={t("settings.systemPrompt.globalTitle")} desc={t("settings.systemPrompt.globalDesc")}>
        <SettingRow layout="vertical" title={t("settings.systemPrompt.globalLabel")} desc={t("settings.systemPrompt.globalHint")}>
          <textarea
            value={globalPrompt}
            maxLength={SYSTEM_PROMPT_MAX_CHARS}
            onChange={(event) => {
              setGlobalPrompt(event.target.value);
              setSaved(null);
            }}
            className={textareaClass}
            placeholder={t("settings.systemPrompt.globalPlaceholder")}
          />
          <div className="mt-2 flex items-center justify-between gap-2">
            <span className="text-[0.75em] text-content-subtle">{t("settings.systemPrompt.charCount", { n: globalPrompt.length, max: SYSTEM_PROMPT_MAX_CHARS })}</span>
            <Button variant="primary" size="sm" disabled={loading || saving !== null} onClick={() => void saveGlobal()}>
              {saving === "global" ? <IconLoader2 size={13} className="animate-spin" /> : <IconDeviceFloppy size={13} />}
              {saved === "global" ? t("settings.systemPrompt.saved") : t("settings.systemPrompt.save")}
            </Button>
          </div>
        </SettingRow>
      </SettingsSection>

      <SettingsSection title={t("settings.systemPrompt.projectTitle")} desc={t("settings.systemPrompt.projectDesc")}>
        <SettingRow title={t("settings.systemPrompt.projectSelect")} desc={t("settings.systemPrompt.projectSelectDesc")} htmlFor="setting-system-prompt-project">
          <Select.Root value={projectId ?? ""} onValueChange={(value) => setProjectId(typeof value === "string" ? value || null : null)}>
            <Select.Trigger id="setting-system-prompt-project" className="w-full" disabled={activeProjects.length === 0}>
              <Select.Value>{() => selectedProject?.name ?? t("settings.systemPrompt.noProject")}</Select.Value>
            </Select.Trigger>
            <Select.Portal>
              <Select.Positioner>
                <Select.Popup>
                  <Select.List>
                    {activeProjects.map((project) => (
                      <Select.Item key={project.id} value={project.id}>
                        <Select.ItemText>{project.name}</Select.ItemText>
                      </Select.Item>
                    ))}
                  </Select.List>
                </Select.Popup>
              </Select.Positioner>
            </Select.Portal>
          </Select.Root>
        </SettingRow>
        <SettingRow layout="vertical" title={t("settings.systemPrompt.projectLabel")} desc={selectedProjectPath ?? t("settings.systemPrompt.noProject") }>
          <textarea
            value={projectPrompt}
            maxLength={SYSTEM_PROMPT_MAX_CHARS}
            disabled={!selectedProjectPath || projectLoading}
            onChange={(event) => {
              setProjectPrompt(event.target.value);
              setSaved(null);
            }}
            className={textareaClass}
            placeholder={t("settings.systemPrompt.projectPlaceholder")}
          />
          <div className="mt-2 flex items-center justify-between gap-2">
            <span className="text-[0.75em] text-content-subtle">
              {projectLoading ? t("settings.systemPrompt.loading") : t("settings.systemPrompt.fileState", { state: projectExists ? t("settings.systemPrompt.exists") : t("settings.systemPrompt.notExists") })}
              {" · "}
              {t("settings.systemPrompt.charCount", { n: projectPrompt.length, max: SYSTEM_PROMPT_MAX_CHARS })}
            </span>
            <Button variant="primary" size="sm" disabled={!selectedProjectPath || projectLoading || saving !== null} onClick={() => void saveProject()}>
              {saving === "project" ? <IconLoader2 size={13} className="animate-spin" /> : <IconDeviceFloppy size={13} />}
              {saved === "project" ? t("settings.systemPrompt.saved") : t("settings.systemPrompt.save")}
            </Button>
          </div>
        </SettingRow>
      </SettingsSection>

      <SettingsSection title={t("settings.systemPrompt.previewTitle")} desc={t("settings.systemPrompt.previewDesc")}>
        <SettingRow title={t("settings.systemPrompt.previewProvider")} desc={t("settings.systemPrompt.previewProviderDesc")} htmlFor="setting-system-prompt-provider">
          <Select.Root value={providerId} onValueChange={(value) => setProviderId(typeof value === "string" ? value : "claude-sdk")}>
            <Select.Trigger id="setting-system-prompt-provider" className="w-full">
              <Select.Value>{() => availableProviders.find((provider) => provider.id === providerId)?.displayName ?? providerId}</Select.Value>
            </Select.Trigger>
            <Select.Portal>
              <Select.Positioner>
                <Select.Popup>
                  <Select.List>
                    {availableProviders.map((provider) => (
                      <Select.Item key={provider.id} value={provider.id}>
                        <Select.ItemText>{provider.displayName}</Select.ItemText>
                      </Select.Item>
                    ))}
                  </Select.List>
                </Select.Popup>
              </Select.Positioner>
            </Select.Portal>
          </Select.Root>
        </SettingRow>
        <SettingRow layout="vertical" title={t("settings.systemPrompt.layersTitle")}>
          <div className="space-y-1.5">
            {previewLoading && <p className="text-xs text-content-subtle">{t("settings.systemPrompt.loading")}</p>}
            {preview?.sections.map((section) => (
              <details key={section.id} open={section.kind === "user"} className="rounded border border-edge bg-surface-muted">
                <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-3 py-2 text-xs text-content">
                  <span className="min-w-0 truncate">{sectionLabel(section.id)}</span>
                  <span className="shrink-0 text-[0.85em] text-content-subtle">{t(KIND_LABELS[section.kind])}</span>
                </summary>
                <div className="border-t border-edge px-3 py-2">
                  {section.text ? <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words font-mono text-[0.75em] leading-relaxed text-content-muted">{section.text}</pre> : <p className="text-xs text-content-subtle">{t("settings.systemPrompt.engineHidden")}</p>}
                  {section.meta?.path && <p className="mt-2 truncate font-mono text-[0.7em] text-content-subtle" title={section.meta.path}>{section.meta.path}</p>}
                </div>
              </details>
            ))}
          </div>
        </SettingRow>
      </SettingsSection>

      {error && <p className="px-1 text-xs text-danger">{error}</p>}
      {saved && <p className="px-1 text-xs text-content-subtle">{t("settings.systemPrompt.nextTurn")}</p>}
    </section>
  );
}
