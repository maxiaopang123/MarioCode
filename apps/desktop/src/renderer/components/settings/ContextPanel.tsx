import { useEffect, useState } from "react";
import { CONTEXT_POLICY_SETTING_KEY, ContextPolicySchema, DEFAULT_CONTEXT_POLICY, DEFAULT_CONTEXT_WINDOW, parseContextPolicy, resolveContextPolicy } from "@contracts/contextPolicy";
import { api } from "@renderer/lib/api.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { Button, Input } from "@renderer/components/ui/index.js";
import { PanelHeader } from "./PanelHeader.js";
import { SettingsSection } from "./SettingsSection.js";
import { SettingRow } from "./SettingRow.js";

export function ContextPanel() {
  const { t } = useI18n();
  const [draft, setDraft] = useState(String(DEFAULT_CONTEXT_POLICY.autoCompactPercent));
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");
  const candidate = ContextPolicySchema.safeParse({ autoCompactPercent: draft.trim() ? Number(draft) : NaN });
  const tokens = candidate.success ? resolveContextPolicy(undefined, candidate.data).autoCompactTokenLimit : null;

  useEffect(() => {
    let disposed = false;
    api.setting.get({ key: CONTEXT_POLICY_SETTING_KEY }).then(({ value }) => {
      if (!disposed) { setDraft(String(parseContextPolicy(value).autoCompactPercent)); setLoaded(true); }
    }, (err: unknown) => { if (!disposed) setError(String(err)); });
    return () => { disposed = true; };
  }, []);

  const save = async () => {
    if (!candidate.success || !loaded || saving) return;
    setSaving(true); setError(""); setSaved(false);
    try {
      await api.setting.set({ key: CONTEXT_POLICY_SETTING_KEY, value: JSON.stringify(candidate.data) });
      setSaved(true);
    } catch (err) { setError(String(err)); }
    finally { setSaving(false); }
  };

  return (
    <section className="mx-auto w-full max-w-3xl space-y-4">
      <PanelHeader title={t("settings.context.title")} />
      <SettingsSection title={t("settings.context.section")} desc={t("settings.context.description")}>
        <SettingRow title={t("settings.context.capacity")} desc={t("settings.context.capacityDesc")}>
          <span className="font-mono text-sm">1M · {DEFAULT_CONTEXT_WINDOW.toLocaleString()} tokens</span>
        </SettingRow>
        <SettingRow title={t("settings.context.threshold")} desc={t("settings.context.thresholdDesc")}>
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <Input type="number" min={10} max={90} step={1} aria-label={t("settings.context.threshold")}
                className="w-24" value={draft} disabled={!loaded || saving} error={!candidate.success}
                onChange={(event) => { setDraft(event.target.value); setSaved(false); }} />
              <span className="text-xs text-content-muted">%</span>
              <Button size="sm" disabled={!loaded || saving || !candidate.success} onClick={() => void save()}>{t("common.save")}</Button>
            </div>
            <p className="text-xs text-content-muted" role="status">{saved ? t("settings.context.saved") : tokens === null ? t("settings.context.invalid") : t("settings.context.preview", { tokens: tokens.toLocaleString() })}</p>
          </div>
        </SettingRow>
      </SettingsSection>
      {error && <p className="text-xs text-danger" role="alert">{t("settings.context.error", { error })}</p>}
    </section>
  );
}
