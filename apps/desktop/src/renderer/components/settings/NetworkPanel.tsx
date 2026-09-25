import { useCallback, useEffect, useState } from "react";
import {
  NETWORK_PROXY_SETTING_KEY,
  normalizeProxyUrl,
  parseNetworkProxySettings,
  type NetworkProxyMode,
  type NetworkProxySettings,
  type NetworkProxyStatus,
} from "@contracts/ipc";
import { api } from "@renderer/lib/api.js";
import { useI18n, type MessageId } from "@renderer/lib/i18n/index.js";
import { Button, Input, Select } from "@renderer/components/ui/index.js";
import { PanelHeader } from "./PanelHeader.js";
import { SettingsSection } from "./SettingsSection.js";
import { SettingRow } from "./SettingRow.js";

const MODES: { value: NetworkProxyMode; labelKey: MessageId }[] = [
  { value: "system", labelKey: "settings.network.modeSystem" },
  { value: "direct", labelKey: "settings.network.modeDirect" },
  { value: "custom", labelKey: "settings.network.modeCustom" },
];

const SOURCE_KEYS: Record<NonNullable<NetworkProxyStatus["source"]>, MessageId> = {
  env: "settings.network.sourceEnv",
  system: "settings.network.sourceSystem",
  custom: "settings.network.sourceCustom",
};

/**
 * Network settings — how the three engines (Claude / Codex / Pi) reach their
 * model services: direct, the system proxy, or a custom proxy. One JSON blob
 * under `network.proxy` through the generic setting IPC; main reads it fresh
 * on every engine spawn, so a change applies from the next turn. "Custom" is
 * persisted only once a valid address is saved — until then the previous mode
 * stays in effect and the status line says so.
 */
export function NetworkPanel() {
  const { t } = useI18n();
  const [saved, setSaved] = useState<NetworkProxySettings | null>(null);
  const [mode, setMode] = useState<NetworkProxyMode>("system");
  const [draftUrl, setDraftUrl] = useState("");
  const [urlInvalid, setUrlInvalid] = useState(false);
  const [justSaved, setJustSaved] = useState(false);
  const [status, setStatus] = useState<NetworkProxyStatus | null>(null);

  const refreshStatus = useCallback(() => {
    api.network.proxyStatus().then(setStatus, () => setStatus(null));
  }, []);

  useEffect(() => {
    void (async () => {
      const { value } = await api.setting.get({ key: NETWORK_PROXY_SETTING_KEY });
      const settings = parseNetworkProxySettings(value);
      setSaved(settings);
      setMode(settings.mode);
      setDraftUrl(settings.customUrl);
      refreshStatus();
    })();
  }, [refreshStatus]);

  const persist = async (next: NetworkProxySettings) => {
    await api.setting.set({ key: NETWORK_PROXY_SETTING_KEY, value: JSON.stringify(next) });
    setSaved(next);
    setJustSaved(true);
    refreshStatus();
  };

  const changeMode = (next: NetworkProxyMode) => {
    if (!saved || next === mode) return;
    setMode(next);
    setJustSaved(false);
    setUrlInvalid(false);
    if (next !== "custom") {
      void persist({ ...saved, mode: next });
      return;
    }
    const url = normalizeProxyUrl(draftUrl);
    if (url) void persist({ mode: "custom", customUrl: url });
  };

  const saveCustom = () => {
    const url = normalizeProxyUrl(draftUrl);
    if (!url) {
      setUrlInvalid(true);
      return;
    }
    setDraftUrl(url);
    void persist({ mode: "custom", customUrl: url });
  };

  const pendingCustom = mode === "custom" && saved?.mode !== "custom";

  return (
    <section className="mx-auto w-full max-w-3xl space-y-4">
      <PanelHeader title={t("settings.network.title")} />

      <SettingsSection title={t("settings.network.section")} desc={t("settings.network.sectionDesc")}>
        <SettingRow
          title={t("settings.network.mode")}
          desc={t("settings.network.modeDesc")}
          descExtra={
            <StatusLine
              status={status}
              pendingCustom={pendingCustom}
              justSaved={justSaved}
              onRecheck={refreshStatus}
            />
          }
        >
          <Select.Root
            value={mode}
            onValueChange={(v) => changeMode(v as NetworkProxyMode)}
            disabled={!saved}
          >
            <Select.Trigger className="w-full">
              <Select.Value>
                {(val: string) => t(MODES.find((m) => m.value === val)?.labelKey ?? "settings.network.modeSystem")}
              </Select.Value>
            </Select.Trigger>
            <Select.Portal>
              <Select.Positioner>
                <Select.Popup>
                  <Select.List>
                    {MODES.map((m) => (
                      <Select.Item key={m.value} value={m.value}>
                        <Select.ItemText>{t(m.labelKey)}</Select.ItemText>
                      </Select.Item>
                    ))}
                  </Select.List>
                </Select.Popup>
              </Select.Positioner>
            </Select.Portal>
          </Select.Root>
        </SettingRow>

        {mode === "custom" && (
          <SettingRow
            layout="vertical"
            title={t("settings.network.customUrl")}
            desc={t("settings.network.customUrlDesc")}
          >
            <div className="flex gap-2">
              <Input
                value={draftUrl}
                onChange={(e) => {
                  setDraftUrl((e.target as HTMLInputElement).value);
                  setUrlInvalid(false);
                  setJustSaved(false);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") saveCustom();
                }}
                placeholder="http://127.0.0.1:7897"
                spellCheck={false}
                className="min-w-0 flex-1 font-mono"
              />
              <Button variant="primary" size="sm" onClick={saveCustom}>
                {t("common.save")}
              </Button>
            </div>
            {urlInvalid && (
              <p className="mt-1 text-[0.7857em] text-danger">{t("settings.network.customUrlInvalid")}</p>
            )}
          </SettingRow>
        )}
      </SettingsSection>
    </section>
  );
}

function StatusLine({
  status,
  pendingCustom,
  justSaved,
  onRecheck,
}: {
  status: NetworkProxyStatus | null;
  pendingCustom: boolean;
  justSaved: boolean;
  onRecheck: () => void;
}) {
  const { t } = useI18n();
  if (pendingCustom) {
    return <p className="text-[0.7857em] text-content-subtle">{t("settings.network.pendingCustom")}</p>;
  }
  if (!status) return null;
  const text = status.proxyUrl
    ? t("settings.network.statusProxy", {
        url: status.proxyUrl,
        source: t(SOURCE_KEYS[status.source ?? "custom"]),
      })
    : t(status.mode === "direct" ? "settings.network.statusDirect" : "settings.network.statusSystemNone");
  return (
    <p className="flex flex-wrap items-center gap-x-2 text-[0.7857em] text-content-subtle">
      <span className="break-all">{text}</span>
      {justSaved && <span className="text-accent">{t("settings.network.saved")}</span>}
      {status.mode === "system" && (
        <button type="button" onClick={onRecheck} className="text-accent hover:underline">
          {t("settings.network.recheck")}
        </button>
      )}
    </p>
  );
}
