import { useCallback, useEffect, useState } from "react";
import {
  BROWSER_SCREENSHOT_DIR_SETTING_KEY,
  WEB_SEARCH_KEYED_BACKENDS,
  type BuiltinToolsConfig,
  type BuiltinToolsSaveInput,
  type BuiltinToolsState,
  type BuiltinToolsTestSearchResult,
  type ImageToolIssue,
  type WebSearchBackend,
  type WebSearchKeyedBackend,
  type WechatToolStatus,
} from "@contracts/ipc";
import type { SharedProviderPublic } from "@contracts/sharedProvider";
import { api } from "@renderer/lib/api.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import { useI18n, type MessageId } from "@renderer/lib/i18n/index.js";
import { Button, Input, Select, Switch } from "@renderer/components/ui/index.js";
import { PanelHeader } from "./PanelHeader.js";
import { SettingsSection } from "./SettingsSection.js";
import { SettingRow } from "./SettingRow.js";

const BACKENDS: { value: WebSearchBackend; labelKey: MessageId }[] = [
  { value: "bing", labelKey: "settings.builtinTools.backendBing" },
  { value: "baidu", labelKey: "settings.builtinTools.backendBaidu" },
  { value: "bocha", labelKey: "settings.builtinTools.backendBocha" },
  { value: "zhipu", labelKey: "settings.builtinTools.backendZhipu" },
  { value: "tavily", labelKey: "settings.builtinTools.backendTavily" },
  { value: "exa", labelKey: "settings.builtinTools.backendExa" },
  { value: "brave", labelKey: "settings.builtinTools.backendBrave" },
];

const BACKEND_NAME: Record<WebSearchBackend, MessageId> = {
  bing: "settings.builtinTools.name.bing",
  baidu: "settings.builtinTools.name.baidu",
  bocha: "settings.builtinTools.name.bocha",
  zhipu: "settings.builtinTools.name.zhipu",
  tavily: "settings.builtinTools.name.tavily",
  exa: "settings.builtinTools.name.exa",
  brave: "settings.builtinTools.name.brave",
};

const KEY_HINT: Record<WebSearchKeyedBackend, MessageId> = {
  bocha: "settings.builtinTools.keyHint.bocha",
  zhipu: "settings.builtinTools.keyHint.zhipu",
  tavily: "settings.builtinTools.keyHint.tavily",
  exa: "settings.builtinTools.keyHint.exa",
  brave: "settings.builtinTools.keyHint.brave",
};

const ISSUE: Record<ImageToolIssue, MessageId> = {
  noSource: "settings.builtinTools.issue.noSource",
  providerMissing: "settings.builtinTools.issue.providerMissing",
  noModel: "settings.builtinTools.issue.noModel",
  noKey: "settings.builtinTools.issue.noKey",
};

const WECHAT_STATUS: Record<WechatToolStatus, MessageId> = {
  unbound: "settings.builtinTools.wechatStatus.unbound",
  "needs-interaction": "settings.builtinTools.wechatStatus.needsInteraction",
  ready: "settings.builtinTools.wechatStatus.ready",
  error: "settings.builtinTools.wechatStatus.error",
};

/** One entry of the image-model picker: a shared provider's model marked
 *  生图, or the synthetic "value configured before the marker existed". */
type ImageModelOption = { id: string; label?: string; imageGeneration?: boolean };

const RESULT_COUNTS = [3, 5, 8, 10];
const FETCH_CHARS = [3000, 5000, 8000, 12000, 20000];
const IMAGE_SIZES = ["1024x1024", "1536x1024", "1024x1536", "1792x1024", "1024x1792", "auto"];

function isKeyed(backend: WebSearchBackend): backend is WebSearchKeyedBackend {
  return (WEB_SEARCH_KEYED_BACKENDS as readonly string[]).includes(backend);
}

/**
 * Settings → MarioTool: the mario_web_search / mario_web_fetch and mario_image_generate tools
 * MarioCode registers on all three engines, plus the agent browser tools
 * (browser_*; switch = the MCP row mariocode-browser) and the shared tool output
 * folder. Search defaults to keyless Bing
 * (Baidu too); optional keyed search APIs take the user's key, which goes
 * main-side only and comes back as a presence flag. Image generation reuses a
 * shared provider's endpoint + key. Config and search keys save through
 * builtinTools.save; the two switches are
 * the same flags as the MCP page's built-in rows. Everything applies from the
 * next turn.
 */
export function BuiltinToolsPanel() {
  const { t } = useI18n();
  const [state, setState] = useState<BuiltinToolsState | null>(null);
  const [providers, setProviders] = useState<SharedProviderPublic[]>([]);
  const [providersLoaded, setProvidersLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [justSaved, setJustSaved] = useState(false);
  const [searchKeyDraft, setSearchKeyDraft] = useState("");
  const [modelDraft, setModelDraft] = useState("");
  /** Escape hatch: type a model id the provider's list doesn't offer. */
  const [manualModel, setManualModel] = useState(false);
  const [testQuery, setTestQuery] = useState("MarioCode");
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<BuiltinToolsTestSearchResult | null>(null);

  const adopt = useCallback((next: BuiltinToolsState) => {
    setState(next);
    setModelDraft(next.config.image.model);
  }, []);

  useEffect(() => {
    void api.builtinTools.get().then(adopt);
    void api.sharedProviders
      .list()
      .then((r) => setProviders(r.providers), () => setProviders([]))
      .finally(() => setProvidersLoaded(true));
  }, [adopt]);

  const save = async (input: BuiltinToolsSaveInput): Promise<boolean> => {
    setError(null);
    setJustSaved(false);
    const result = await api.builtinTools.save(input);
    if (result.ok && result.state) {
      adopt(result.state);
      setJustSaved(true);
      return true;
    }
    setError(result.error ?? t("settings.builtinTools.saveFailed"));
    return false;
  };

  if (!state) return <section className="mx-auto w-full max-w-3xl space-y-4"><PanelHeader title={t("settings.builtinTools.title")} /></section>;

  const config = state.config;
  const patchConfig = (patch: (c: BuiltinToolsConfig) => BuiltinToolsConfig) => void save({ config: patch(config) });
  const backend = config.search.backend;

  const runTest = async () => {
    if (!testQuery.trim() || testing) return;
    setTesting(true);
    setTestResult(null);
    try {
      setTestResult(await api.builtinTools.testSearch({ query: testQuery.trim() }));
    } finally {
      setTesting(false);
    }
  };

  const saveModel = () => {
    if (modelDraft.trim() !== config.image.model) patchConfig((c) => ({ ...c, image: { ...c.image, model: modelDraft.trim() } }));
  };

  const sourceLabel = (value: string): string =>
    providers.find((p) => p.id === value)?.name ?? t("settings.builtinTools.imageSourceNone");

  /* ── Image model picker (TODO-024 ①) ──
   * Candidates come from the shared providers' own model lists: the ones the
   * user marked 生图 in 设置 → 模型配置 (`SharedProviderModel.imageGeneration`).
   * The marker drives THIS LIST ONLY — main still accepts any non-empty model
   * id, so a hand-typed value configured before the marker existed keeps
   * working. Hence the synthetic "current value" option and the manual escape
   * hatch: switching to a picker must never silently blank a live config. */
  const markedModelsOf = (providerId: string): ImageModelOption[] =>
    providers.find((p) => p.id === providerId)?.models.filter((m) => m.imageGeneration) ?? [];
  const markedProviders = providers.filter((p) => p.models.some((m) => m.imageGeneration));
  // Keep the configured provider selectable even if none of its models carry
  // the marker (same reason as above).
  const sourceOptions = providers.filter(
    (p) => p.models.some((m) => m.imageGeneration) || p.id === config.image.source,
  );
  const markedModels = markedModelsOf(config.image.source);
  const currentUnmarked = !!config.image.model && !markedModels.some((m) => m.id === config.image.model);
  const modelOptions: ImageModelOption[] = currentUnmarked
    ? [...markedModels, { id: config.image.model }]
    : markedModels;
  const modelLabel = (value: string): string => {
    if (!value) return t("settings.builtinTools.imageModelPick");
    const hit = modelOptions.find((m) => m.id === value);
    return hit?.label?.trim() || value;
  };
  /** Switching provider must not leave a model id from the previous one. */
  const pickSource = (next: string) => {
    const marked = markedModelsOf(next);
    const model = marked.some((m) => m.id === config.image.model)
      ? config.image.model
      : marked[0]?.id ?? "";
    patchConfig((c) => ({ ...c, image: { ...c.image, source: next, model } }));
  };

  return (
    <section className="mx-auto w-full max-w-3xl space-y-4">
      <PanelHeader title={t("settings.builtinTools.title")} />
      {(error || justSaved) && (
        <p className={error ? "text-[0.7857em] text-danger" : "text-[0.7857em] text-accent"}>
          {error ?? t("settings.builtinTools.saved")}
        </p>
      )}

      <SettingsSection title={t("settings.builtinTools.webSection")} desc={t("settings.builtinTools.webSectionDesc")}>
        <SettingRow title={t("settings.builtinTools.webEnabled")} desc={t("settings.builtinTools.webEnabledDesc")}>
          <Switch
            checked={state.webToolsEnabled}
            onCheckedChange={(v) => void save({ webToolsEnabled: v })}
            label={t("settings.builtinTools.webEnabled")}
          />
        </SettingRow>

        <SettingRow title={t("settings.builtinTools.backend")} desc={t("settings.builtinTools.backendDesc")}>
          <Select.Root
            value={backend}
            onValueChange={(v) => {
              setSearchKeyDraft("");
              setTestResult(null);
              patchConfig((c) => ({ ...c, search: { ...c.search, backend: v as WebSearchBackend } }));
            }}
          >
            <Select.Trigger className="w-full">
              <Select.Value>
                {(val: string) => t(BACKENDS.find((b) => b.value === val)?.labelKey ?? "settings.builtinTools.backendBing")}
              </Select.Value>
            </Select.Trigger>
            <Select.Portal>
              <Select.Positioner>
                <Select.Popup>
                  <Select.List>
                    {BACKENDS.map((b) => (
                      <Select.Item key={b.value} value={b.value}>
                        <Select.ItemText>{t(b.labelKey)}</Select.ItemText>
                      </Select.Item>
                    ))}
                  </Select.List>
                </Select.Popup>
              </Select.Positioner>
            </Select.Portal>
          </Select.Root>
        </SettingRow>

        {isKeyed(backend) && (
          <SettingRow
            layout="vertical"
            title={`${t(BACKEND_NAME[backend])} ${t("settings.builtinTools.apiKey")}`}
            desc={t(KEY_HINT[backend])}
            descExtra={
              <p className="text-[0.7857em] text-content-subtle">
                {t(state.keys[backend] ? "settings.builtinTools.keySaved" : "settings.builtinTools.keyMissing")}
              </p>
            }
          >
            <div className="flex gap-2">
              <Input
                type="password"
                value={searchKeyDraft}
                onChange={(e) => setSearchKeyDraft((e.target as HTMLInputElement).value)}
                placeholder={t(state.keys[backend] ? "settings.builtinTools.keyReplacePlaceholder" : "settings.builtinTools.keyPlaceholder")}
                spellCheck={false}
                aria-label={`${t(BACKEND_NAME[backend])} ${t("settings.builtinTools.apiKey")}`}
                className="min-w-0 flex-1 font-mono"
              />
              <Button
                variant="primary"
                size="sm"
                disabled={!searchKeyDraft.trim()}
                onClick={() => void save({ keys: { [backend]: searchKeyDraft } }).then((ok) => ok && setSearchKeyDraft(""))}
              >
                {t("common.save")}
              </Button>
              {state.keys[backend] && (
                <Button variant="ghost" size="sm" onClick={() => void save({ keys: { [backend]: null } })}>
                  {t("settings.builtinTools.clearKey")}
                </Button>
              )}
            </div>
          </SettingRow>
        )}

        <SettingRow title={t("settings.builtinTools.maxResults")} desc={t("settings.builtinTools.maxResultsDesc")}>
          <NumberSelect
            value={config.search.maxResults}
            options={RESULT_COUNTS}
            render={(n) => String(n)}
            onChange={(n) => patchConfig((c) => ({ ...c, search: { ...c.search, maxResults: n } }))}
          />
        </SettingRow>

        <SettingRow title={t("settings.builtinTools.fetchChars")} desc={t("settings.builtinTools.fetchCharsDesc")}>
          <NumberSelect
            value={config.fetch.maxChars}
            options={FETCH_CHARS}
            render={(n) => t("settings.builtinTools.charsOption", { n })}
            onChange={(n) => patchConfig((c) => ({ ...c, fetch: { maxChars: n } }))}
          />
        </SettingRow>

        <SettingRow
          layout="vertical"
          title={t("settings.builtinTools.test")}
          desc={t("settings.builtinTools.testDesc")}
          descExtra={<TestResultLine result={testResult} testing={testing} />}
        >
          <div className="flex gap-2">
            <Input
              value={testQuery}
              onChange={(e) => setTestQuery((e.target as HTMLInputElement).value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void runTest();
              }}
              className="min-w-0 flex-1"
            />
            <Button variant="secondary" size="sm" disabled={testing || !testQuery.trim()} onClick={() => void runTest()}>
              {t(testing ? "settings.builtinTools.testing" : "settings.builtinTools.testButton")}
            </Button>
          </div>
        </SettingRow>
      </SettingsSection>

      <SettingsSection title={t("settings.builtinTools.imageSection")} desc={t("settings.builtinTools.imageSectionDesc")}>
        <SettingRow
          title={t("settings.builtinTools.imageEnabled")}
          desc={t("settings.builtinTools.imageEnabledDesc")}
          descExtra={
            <p className={state.imageIssue ? "text-[0.7857em] text-warning" : "text-[0.7857em] text-content-subtle"}>
              {state.imageIssue
                ? t(ISSUE[state.imageIssue])
                : t(state.imageToolEnabled ? "settings.builtinTools.imageReady" : "settings.builtinTools.imageOff")}
            </p>
          }
        >
          <Switch
            checked={state.imageToolEnabled}
            onCheckedChange={(v) => void save({ imageToolEnabled: v })}
            label={t("settings.builtinTools.imageEnabled")}
          />
        </SettingRow>

        <SettingRow
          title={t("settings.builtinTools.imageSource")}
          desc={t("settings.builtinTools.imageSourceDesc")}
          descExtra={
            !providersLoaded ? undefined : providers.length === 0 ? (
              <p className="text-[0.7857em] text-warning">{t("settings.builtinTools.imageNoProviders")}</p>
            ) : markedProviders.length === 0 ? (
              // Providers exist but nothing is marked 生图 (the discovery
              // dialog leaves that chip off by default), so point at where the
              // marker lives instead of showing an empty picker.
              <p className="text-[0.7857em] text-content-subtle">
                {t("settings.builtinTools.imageNoMarkedModels")}{" "}
                <button
                  type="button"
                  onClick={() => useSessionStore.getState().setSettingsOpen(true, "custom-models")}
                  className="text-accent-strong underline-offset-2 hover:underline"
                >
                  {t("settings.builtinTools.imageGoModelConfig")}
                </button>
              </p>
            ) : undefined
          }
        >
          <Select.Root
            value={config.image.source}
            disabled={sourceOptions.length === 0}
            onValueChange={(v) => pickSource(v as string)}
          >
            <Select.Trigger className="w-full">
              <Select.Value>{(val: string) => sourceLabel(val)}</Select.Value>
            </Select.Trigger>
            <Select.Portal>
              <Select.Positioner>
                <Select.Popup>
                  <Select.List>
                    {sourceOptions.map((p) => (
                      <Select.Item key={p.id} value={p.id}>
                        <Select.ItemText>{p.name}</Select.ItemText>
                      </Select.Item>
                    ))}
                  </Select.List>
                </Select.Popup>
              </Select.Positioner>
            </Select.Portal>
          </Select.Root>
        </SettingRow>

        <SettingRow title={t("settings.builtinTools.imageModel")} desc={t("settings.builtinTools.imageModelDesc")}>
          <div className="flex w-full flex-col gap-1.5">
            {manualModel ? (
              <Input
                value={modelDraft}
                onChange={(e) => setModelDraft((e.target as HTMLInputElement).value)}
                onBlur={saveModel}
                onKeyDown={(e) => {
                  if (e.key === "Enter") saveModel();
                }}
                placeholder="gpt-image-1"
                spellCheck={false}
                className="w-full font-mono"
              />
            ) : (
              <Select.Root
                value={config.image.model}
                disabled={modelOptions.length === 0}
                onValueChange={(v) => patchConfig((c) => ({ ...c, image: { ...c.image, model: v as string } }))}
              >
                <Select.Trigger className="w-full">
                  <Select.Value>{(val: string) => modelLabel(val)}</Select.Value>
                </Select.Trigger>
                <Select.Portal>
                  <Select.Positioner>
                    <Select.Popup>
                      <Select.List>
                        {modelOptions.map((m) => (
                          <Select.Item key={m.id} value={m.id}>
                            <Select.ItemText>
                              {m.label?.trim() || m.id}
                              {!m.imageGeneration && ` · ${t("settings.builtinTools.imageModelUnmarked")}`}
                            </Select.ItemText>
                          </Select.Item>
                        ))}
                      </Select.List>
                    </Select.Popup>
                  </Select.Positioner>
                </Select.Portal>
              </Select.Root>
            )}
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[0.7143em] text-content-subtle">
              <button
                type="button"
                onClick={() => {
                  setModelDraft(config.image.model);
                  setManualModel(!manualModel);
                }}
                className="underline-offset-2 hover:text-content hover:underline"
              >
                {t(manualModel ? "settings.builtinTools.imageModelUsePicker" : "settings.builtinTools.imageModelManual")}
              </button>
              {!manualModel && modelOptions.length === 0 && config.image.source && (
                <span>{t("settings.builtinTools.imageModelNoneForSource")}</span>
              )}
              {currentUnmarked && <span>{t("settings.builtinTools.imageModelUnmarkedNote")}</span>}
            </div>
          </div>
        </SettingRow>

        <SettingRow title={t("settings.builtinTools.imageSize")} desc={t("settings.builtinTools.imageSizeDesc")}>
          <Select.Root
            value={config.image.size}
            onValueChange={(v) => patchConfig((c) => ({ ...c, image: { ...c.image, size: v as string } }))}
          >
            <Select.Trigger className="w-full">
              <Select.Value>{(val: string) => (val === "auto" ? t("settings.builtinTools.imageSizeAuto") : val)}</Select.Value>
            </Select.Trigger>
            <Select.Portal>
              <Select.Positioner>
                <Select.Popup>
                  <Select.List>
                    {IMAGE_SIZES.map((s) => (
                      <Select.Item key={s} value={s}>
                        <Select.ItemText>{s === "auto" ? t("settings.builtinTools.imageSizeAuto") : s}</Select.ItemText>
                      </Select.Item>
                    ))}
                  </Select.List>
                </Select.Popup>
              </Select.Positioner>
            </Select.Portal>
          </Select.Root>
        </SettingRow>
      </SettingsSection>

      <SettingsSection title={t("settings.builtinTools.browserSection")} desc={t("settings.builtinTools.browserSectionDesc")}>
        <SettingRow
          title={t("settings.builtinTools.browserEnabled")}
          desc={t("settings.builtinTools.browserEnabledDesc")}
          descExtra={<p className="text-[0.7857em] text-content-subtle">{t("settings.builtinTools.browserSharedHint")}</p>}
        >
          <Switch
            checked={state.browserToolsEnabled}
            onCheckedChange={(v) => void save({ browserToolsEnabled: v })}
            label={t("settings.builtinTools.browserEnabled")}
          />
        </SettingRow>
        <OutputDirRow />
      </SettingsSection>

      <SettingsSection title={t("settings.builtinTools.scheduleSection")} desc={t("settings.builtinTools.scheduleSectionDesc")}>
        <SettingRow
          title={t("settings.builtinTools.scheduleEnabled")}
          desc={t("settings.builtinTools.scheduleEnabledDesc")}
          descExtra={<p className="text-[0.7857em] text-content-subtle">{t("settings.builtinTools.scheduleManageHint")}</p>}
        >
          <Switch
            checked={state.scheduleToolsEnabled}
            onCheckedChange={(v) => void save({ scheduleToolsEnabled: v })}
            label={t("settings.builtinTools.scheduleEnabled")}
          />
        </SettingRow>
      </SettingsSection>

      <SettingsSection title={t("settings.builtinTools.wechatSection")} desc={t("settings.builtinTools.wechatSectionDesc")}>
        <SettingRow
          title={t("settings.builtinTools.wechatEnabled")}
          desc={t("settings.builtinTools.wechatEnabledDesc")}
          descExtra={
            <>
              <p className={state.wechatStatus === "ready" ? "text-[0.7857em] text-content-subtle" : "text-[0.7857em] text-warning"}>
                {t(WECHAT_STATUS[state.wechatStatus])}
              </p>
              <p className="text-[0.7857em] text-content-subtle">{t("settings.builtinTools.wechatBindHint")}</p>
            </>
          }
        >
          <Switch
            checked={state.wechatToolEnabled}
            onCheckedChange={(v) => void save({ wechatToolEnabled: v })}
            label={t("settings.builtinTools.wechatEnabled")}
          />
        </SettingRow>
      </SettingsSection>
    </section>
  );
}

/** Tool output folder (`browser.screenshotDir`, key name kept for
 *  compatibility): browser_screenshot PNGs, browser_save_pdf PDFs and
 *  mario_image_generate originals. Main reads it on every save, so it's a
 *  plain setting.get/set — no builtinTools IPC. Moved here from the Browser
 *  page because only the agent tools write to it. */
function OutputDirRow() {
  const { t } = useI18n();
  const [dir, setDir] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    void api.setting.get({ key: BROWSER_SCREENSHOT_DIR_SETTING_KEY }).then(({ value }) => {
      setDir(value ?? "");
      setLoaded(true);
    });
  }, []);

  const pickDir = async () => {
    const { path } = await api.pickFolder();
    if (path) {
      setDir(path);
      setSaved(false);
    }
  };

  const saveDir = async () => {
    setSaving(true);
    try {
      await api.setting.set({ key: BROWSER_SCREENSHOT_DIR_SETTING_KEY, value: dir.trim() });
      setSaved(true);
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingRow
      layout="vertical"
      title={t("settings.builtinTools.outputDir")}
      desc={t("settings.builtinTools.outputDirDesc")}
      descExtra={saved ? <p className="text-[0.7857em] text-accent">{t("settings.builtinTools.outputDirSaved")}</p> : undefined}
    >
      <div className="flex gap-2">
        <Input
          value={dir}
          onChange={(e) => {
            setDir((e.target as HTMLInputElement).value);
            setSaved(false);
          }}
          placeholder={t("settings.builtinTools.outputDirPlaceholder")}
          spellCheck={false}
          disabled={!loaded}
          aria-label={t("settings.builtinTools.outputDir")}
          className="min-w-0 flex-1 font-mono"
        />
        <Button variant="secondary" size="sm" onClick={() => void pickDir()} disabled={!loaded}>
          {t("settings.builtinTools.chooseDir")}
        </Button>
        <Button variant="primary" size="sm" onClick={() => void saveDir()} disabled={saving || !loaded}>
          {saving ? t("settings.saving") : t("common.save")}
        </Button>
      </div>
    </SettingRow>
  );
}

function NumberSelect({
  value,
  options,
  render,
  onChange,
}: {
  value: number;
  options: number[];
  render: (n: number) => string;
  onChange: (n: number) => void;
}) {
  const all = options.includes(value) ? options : [...options, value].sort((a, b) => a - b);
  return (
    <Select.Root value={String(value)} onValueChange={(v) => onChange(Number(v))}>
      <Select.Trigger className="w-full">
        <Select.Value>{(val: string) => render(Number(val))}</Select.Value>
      </Select.Trigger>
      <Select.Portal>
        <Select.Positioner>
          <Select.Popup>
            <Select.List>
              {all.map((n) => (
                <Select.Item key={n} value={String(n)}>
                  <Select.ItemText>{render(n)}</Select.ItemText>
                </Select.Item>
              ))}
            </Select.List>
          </Select.Popup>
        </Select.Positioner>
      </Select.Portal>
    </Select.Root>
  );
}

function TestResultLine({ result, testing }: { result: BuiltinToolsTestSearchResult | null; testing: boolean }) {
  const { t } = useI18n();
  if (testing) return <p className="text-[0.7857em] text-content-subtle">{t("settings.builtinTools.testing")}</p>;
  if (!result) return null;
  const backend = t(BACKEND_NAME[result.backend]);
  let text: string;
  if (result.fallbackFrom) {
    text = t("settings.builtinTools.testFallback", { from: t(BACKEND_NAME[result.fallbackFrom]), error: result.error ?? "", count: result.count });
  } else if (result.error) {
    text = t("settings.builtinTools.testFailed", { error: result.error });
  } else if (result.count === 0) {
    text = t("settings.builtinTools.testEmpty", { backend });
  } else {
    text = t("settings.builtinTools.testOk", {
      backend,
      count: result.count,
      sec: (result.ms / 1000).toFixed(1),
      title: result.first?.title ?? "",
    });
  }
  return <p className={`break-all text-[0.7857em] ${result.ok ? "text-accent" : "text-warning"}`}>{text}</p>;
}
