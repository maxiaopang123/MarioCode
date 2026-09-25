import { useCallback, useEffect, useState } from "react";
import {
  IMAGE_SOURCE_CUSTOM,
  WEB_SEARCH_KEYED_BACKENDS,
  type BuiltinToolsConfig,
  type BuiltinToolsSaveInput,
  type BuiltinToolsState,
  type BuiltinToolsTestSearchResult,
  type ImageToolIssue,
  type WebSearchBackend,
  type WebSearchKeyedBackend,
} from "@contracts/ipc";
import type { SharedProviderPublic } from "@contracts/sharedProvider";
import { api } from "@renderer/lib/api.js";
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
];

const BACKEND_NAME: Record<WebSearchBackend, MessageId> = {
  bing: "settings.builtinTools.name.bing",
  baidu: "settings.builtinTools.name.baidu",
  bocha: "settings.builtinTools.name.bocha",
  zhipu: "settings.builtinTools.name.zhipu",
  tavily: "settings.builtinTools.name.tavily",
};

const KEY_HINT: Record<WebSearchKeyedBackend, MessageId> = {
  bocha: "settings.builtinTools.keyHint.bocha",
  zhipu: "settings.builtinTools.keyHint.zhipu",
  tavily: "settings.builtinTools.keyHint.tavily",
};

const ISSUE: Record<ImageToolIssue, MessageId> = {
  noSource: "settings.builtinTools.issue.noSource",
  providerMissing: "settings.builtinTools.issue.providerMissing",
  noBaseUrl: "settings.builtinTools.issue.noBaseUrl",
  noModel: "settings.builtinTools.issue.noModel",
  noKey: "settings.builtinTools.issue.noKey",
};

const RESULT_COUNTS = [3, 5, 8, 10];
const FETCH_CHARS = [3000, 5000, 8000, 12000, 20000];
const IMAGE_SIZES = ["1024x1024", "1536x1024", "1024x1536", "1792x1024", "1024x1792", "auto"];

function isKeyed(backend: WebSearchBackend): backend is WebSearchKeyedBackend {
  return (WEB_SEARCH_KEYED_BACKENDS as readonly string[]).includes(backend);
}

/**
 * Settings → 内置工具: the web_search / web_fetch and image_generate tools
 * MarioCode registers on all three engines. Config and keys save through
 * builtinTools.save (keys go main-side only and come back as presence
 * flags); the two switches are the same flags as the MCP page's built-in
 * rows. Everything applies from the next turn.
 */
export function BuiltinToolsPanel() {
  const { t } = useI18n();
  const [state, setState] = useState<BuiltinToolsState | null>(null);
  const [providers, setProviders] = useState<SharedProviderPublic[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [justSaved, setJustSaved] = useState(false);
  const [searchKeyDraft, setSearchKeyDraft] = useState("");
  const [imageKeyDraft, setImageKeyDraft] = useState("");
  const [modelDraft, setModelDraft] = useState("");
  const [baseUrlDraft, setBaseUrlDraft] = useState("");
  const [testQuery, setTestQuery] = useState("MarioCode");
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<BuiltinToolsTestSearchResult | null>(null);

  const adopt = useCallback((next: BuiltinToolsState) => {
    setState(next);
    setModelDraft(next.config.image.model);
    setBaseUrlDraft(next.config.image.baseUrl);
  }, []);

  useEffect(() => {
    void api.builtinTools.get().then(adopt);
    void api.sharedProviders.list().then((r) => setProviders(r.providers), () => setProviders([]));
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
  const saveBaseUrl = () => {
    if (baseUrlDraft.trim() !== config.image.baseUrl) patchConfig((c) => ({ ...c, image: { ...c.image, baseUrl: baseUrlDraft.trim() } }));
  };

  const sourceLabel = (value: string): string =>
    value === IMAGE_SOURCE_CUSTOM
      ? t("settings.builtinTools.imageSourceCustom")
      : providers.find((p) => p.id === value)?.name ?? t("settings.builtinTools.imageSourceNone");

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

        <SettingRow title={t("settings.builtinTools.imageSource")} desc={t("settings.builtinTools.imageSourceDesc")}>
          <Select.Root
            value={config.image.source}
            onValueChange={(v) => patchConfig((c) => ({ ...c, image: { ...c.image, source: v as string } }))}
          >
            <Select.Trigger className="w-full">
              <Select.Value>{(val: string) => sourceLabel(val)}</Select.Value>
            </Select.Trigger>
            <Select.Portal>
              <Select.Positioner>
                <Select.Popup>
                  <Select.List>
                    {providers.map((p) => (
                      <Select.Item key={p.id} value={p.id}>
                        <Select.ItemText>{p.name}</Select.ItemText>
                      </Select.Item>
                    ))}
                    <Select.Item value={IMAGE_SOURCE_CUSTOM}>
                      <Select.ItemText>{t("settings.builtinTools.imageSourceCustom")}</Select.ItemText>
                    </Select.Item>
                  </Select.List>
                </Select.Popup>
              </Select.Positioner>
            </Select.Portal>
          </Select.Root>
        </SettingRow>

        {config.image.source === IMAGE_SOURCE_CUSTOM && (
          <>
            <SettingRow layout="vertical" title={t("settings.builtinTools.imageBaseUrl")} desc={t("settings.builtinTools.imageBaseUrlDesc")}>
              <Input
                value={baseUrlDraft}
                onChange={(e) => setBaseUrlDraft((e.target as HTMLInputElement).value)}
                onBlur={saveBaseUrl}
                onKeyDown={(e) => {
                  if (e.key === "Enter") saveBaseUrl();
                }}
                placeholder="https://api.openai.com/v1"
                spellCheck={false}
                className="w-full font-mono"
              />
            </SettingRow>
            <SettingRow
              layout="vertical"
              title={t("settings.builtinTools.apiKey")}
              descExtra={
                <p className="text-[0.7857em] text-content-subtle">
                  {t(state.keys.image ? "settings.builtinTools.keySaved" : "settings.builtinTools.keyMissing")}
                </p>
              }
            >
              <div className="flex gap-2">
                <Input
                  type="password"
                  value={imageKeyDraft}
                  onChange={(e) => setImageKeyDraft((e.target as HTMLInputElement).value)}
                  placeholder={t(state.keys.image ? "settings.builtinTools.keyReplacePlaceholder" : "settings.builtinTools.keyPlaceholder")}
                  spellCheck={false}
                  className="min-w-0 flex-1 font-mono"
                />
                <Button
                  variant="primary"
                  size="sm"
                  disabled={!imageKeyDraft.trim()}
                  onClick={() => void save({ keys: { image: imageKeyDraft } }).then((ok) => ok && setImageKeyDraft(""))}
                >
                  {t("common.save")}
                </Button>
                {state.keys.image && (
                  <Button variant="ghost" size="sm" onClick={() => void save({ keys: { image: null } })}>
                    {t("settings.builtinTools.clearKey")}
                  </Button>
                )}
              </div>
            </SettingRow>
          </>
        )}

        <SettingRow title={t("settings.builtinTools.imageModel")} desc={t("settings.builtinTools.imageModelDesc")}>
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
    </section>
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
