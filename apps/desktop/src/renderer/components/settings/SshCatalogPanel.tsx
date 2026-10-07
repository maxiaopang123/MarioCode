import { useEffect, useRef, useState } from "react";
import { api } from "@renderer/lib/api.js";
import { useI18n, type MessageId } from "@renderer/lib/i18n/index.js";
import { Button, ConfirmDialog, Dialog, Input, Switch } from "@renderer/components/ui/index.js";
import { SettingsSection } from "./SettingsSection.js";
import { SettingRow } from "./SettingRow.js";
import { SshHostSaveSchema, type SshCatalogState, type SshHostPublic } from "@contracts/ssh";

const ERRORS: Record<string, MessageId> = {
  SSH_ALIAS_DUPLICATE: "settings.ssh.aliasDuplicate",
  SSH_CONFIRM_FINGERPRINT: "settings.ssh.confirmRequired",
  SSH_FINGERPRINT_FAILED: "settings.ssh.probeFailed",
  SSH_CREDENTIAL_REQUIRED: "settings.ssh.credentialRequired",
  SSH_SECURE_STORAGE_UNAVAILABLE: "settings.ssh.storageUnavailable",
  SSH_NAME_CONFLICT: "settings.ssh.nameConflict",
};
const EMPTY: SshCatalogState = { enabled: false, hosts: [] };
export function SshCatalogPanel() {
  const { t } = useI18n();
  const [state, setState] = useState(EMPTY);
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<SshHostPublic | null | undefined>(undefined);
  const [deleting, setDeleting] = useState<SshHostPublic | null>(null);
  const showError = (e: unknown) => setError(t(ERRORS[String(e).match(/SSH_[A-Z_]+/)?.[0] ?? ""] ?? "settings.ssh.failed"));
  useEffect(() => { let active = true; void api.sshCatalog.get().then(v => { if (active) { setState(v); setReady(true); } }, e => { if (active) showError(e); }); return () => { active = false; }; }, []);
  return <SettingsSection title={t("settings.ssh.catalogTitle")} desc={t("settings.ssh.catalogDesc")}>
    <SettingRow title={t("settings.ssh.title")} desc={t("settings.ssh.desc")}>
      <Switch checked={state.enabled} disabled={busy || !ready} label={t("settings.ssh.title")} onCheckedChange={enabled => {
        setBusy(true); setError(""); void api.sshCatalog.setEnabled({ enabled }).then(setState, showError).finally(() => setBusy(false));
      }} />
    </SettingRow>
    <div className="space-y-3 px-5 pb-4">
      <p className="text-xs leading-relaxed text-content-subtle">{t("settings.ssh.policy")}</p>
      {state.hosts.map(host => <div key={host.id} className="flex min-w-0 flex-wrap items-center justify-between gap-2 rounded-lg border border-edge px-3 py-2">
        <div className="min-w-0 flex-1"><div className="text-sm font-medium text-content">{host.alias}</div><div className="break-all text-xs text-content-muted">{host.username}@{host.host}:{host.port}</div>{!host.hasCredential && <div className="text-xs text-warning">{t("settings.ssh.credentialRequired")}</div>}</div>
        <Button variant="ghost" size="sm" onClick={() => setEditing(host)}>{t("common.edit")}</Button>
        <Button variant="ghost" size="sm" onClick={() => setDeleting(host)}>{t("common.delete")}</Button>
      </div>)}
      {ready && !state.hosts.length && <p className="text-xs text-content-muted">{t("settings.ssh.empty")}</p>}
      <Button variant="outline" size="sm" disabled={!ready} onClick={() => setEditing(null)}>{t("settings.ssh.addHost")}</Button>
      {error && <p role="alert" className="text-xs text-danger">{error}</p>}
    </div>
    {editing !== undefined && <SshHostDialog host={editing} onClose={() => setEditing(undefined)} onSaved={setState} />}
    <ConfirmDialog open={!!deleting} title={t("settings.ssh.deleteTitle")} description={t("settings.ssh.deleteDesc", { name: deleting?.alias ?? "" })} danger confirmText={t("common.delete")} onOpenChange={open => { if (!open) setDeleting(null); }} onConfirm={async () => {
      if (!deleting) return; try { setState(await api.sshCatalog.removeHost({ id: deleting.id })); setDeleting(null); } catch (e) { showError(e); }
    }} />
  </SettingsSection>;
}

function SshHostDialog({ host, onClose, onSaved }: { host: SshHostPublic | null; onClose(): void; onSaved(state: SshCatalogState): void }) {
  const { t } = useI18n();
  const [alias, setAlias] = useState(host?.alias ?? "");
  const [address, setAddress] = useState(host?.host ?? "");
  const [port, setPort] = useState(String(host?.port ?? 22));
  const [username, setUsername] = useState(host?.username ?? "");
  const [authentication, setAuthentication] = useState<"password" | "privateKey">(host?.authentication ?? "password");
  const [password, setPassword] = useState("");
  const [privateKey, setPrivateKey] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [fingerprint, setFingerprint] = useState(host?.fingerprint ?? "");
  const [confirmed, setConfirmed] = useState(!!host);
  const [probing, setProbing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const revision = useRef(0);
  const sameIdentity = host?.host === address.trim() && host.port === Number(port) && host.username === username.trim() && host.authentication === authentication;
  const resetPin = () => { revision.current++; setFingerprint(""); setConfirmed(false); setProbing(false); };
  const showError = (e: unknown) => setError(t(ERRORS[String(e).match(/SSH_[A-Z_]+/)?.[0] ?? ""] ?? "settings.ssh.failed"));
  useEffect(() => () => { revision.current++; }, []);
  const probe = async () => {
    const current = ++revision.current; setProbing(true); setError(""); setConfirmed(false); setFingerprint("");
    try { const result = await api.sshCatalog.fingerprint({ host: address.trim(), port: Number(port) }); if (revision.current === current) setFingerprint(result.fingerprint); }
    catch (e) { if (revision.current === current) showError(e); }
    finally { if (revision.current === current) setProbing(false); }
  };
  const save = async () => {
    setError("");
    if (!confirmed || !fingerprint) { setError(t("settings.ssh.confirmRequired")); return; }
    const parsed = SshHostSaveSchema.safeParse({ id: host?.id, alias, host: address, port: Number(port), username, authentication, fingerprint, password: password || undefined, privateKey: privateKey || undefined, passphrase: passphrase || undefined });
    if (!parsed.success) { setError(t("settings.ssh.invalidFields")); return; }
    if (!(authentication === "password" ? password : privateKey) && !(sameIdentity && host?.hasCredential)) { setError(t("settings.ssh.credentialRequired")); return; }
    setSaving(true);
    try { onSaved(await api.sshCatalog.saveHost(parsed.data)); onClose(); }
    catch (e) { showError(e); } finally { setSaving(false); }
  };
  const field = (id: string, label: MessageId, value: string, set: (v: string) => void, type = "text") => <label className="block space-y-1 text-xs text-content-muted" htmlFor={id}>{t(label)}<Input id={id} type={type} value={value} autoComplete="off" disabled={saving} onChange={e => set(e.target.value)} className="w-full" /></label>;
  return <Dialog.Root open onOpenChange={open => { if (!open && !saving) onClose(); }}>
    <Dialog.Portal><Dialog.Backdrop /><Dialog.Popup className="flex max-h-[85vh] w-[min(540px,calc(100vw-32px))] flex-col">
      <Dialog.Title className="px-5 pt-5">{t(host ? "settings.ssh.editHost" : "settings.ssh.addHost")}</Dialog.Title>
      <Dialog.Description className="px-5 pt-1">{t("settings.ssh.hostDesc")}</Dialog.Description><Dialog.Close />
      <div className="min-h-0 space-y-4 overflow-y-auto px-5 py-4">
        {field("ssh-alias", "settings.ssh.alias", alias, setAlias)}
        <div className="grid grid-cols-[1fr_90px] gap-3">{field("ssh-address", "settings.ssh.address", address, v => { resetPin(); setAddress(v); })}{field("ssh-port", "settings.ssh.port", port, v => { resetPin(); setPort(v); }, "number")}</div>
        {field("ssh-username", "settings.ssh.username", username, setUsername)}
        <label className="block space-y-1 text-xs text-content-muted">{t("settings.ssh.authentication")}<select className="w-full rounded border border-edge-input bg-surface-input px-3 py-2 text-content" value={authentication} disabled={saving} onChange={e => { setAuthentication(e.target.value as "password" | "privateKey"); setPassword(""); setPrivateKey(""); setPassphrase(""); }}>
          <option value="password">{t("settings.ssh.password")}</option><option value="privateKey">{t("settings.ssh.privateKey")}</option>
        </select></label>
        {authentication === "password" ? field("ssh-password", "settings.ssh.password", password, setPassword, "password") : <>
          <label className="block space-y-1 text-xs text-content-muted" htmlFor="ssh-private-key">{t("settings.ssh.privateKey")}<textarea id="ssh-private-key" value={privateKey} disabled={saving} autoComplete="off" spellCheck={false} onChange={e => setPrivateKey(e.target.value)} className="h-24 w-full rounded border border-edge-input bg-surface-input p-2 font-mono text-xs text-content" /></label>
          {field("ssh-passphrase", "settings.ssh.passphrase", passphrase, setPassphrase, "password")}
        </>}
        {sameIdentity && host?.hasCredential && <p className="text-xs text-content-subtle">{t("settings.ssh.keepCredential")}</p>}
        <div className="space-y-2 rounded-lg border border-edge p-3">
          <Button variant="outline" size="sm" disabled={probing || saving || !address.trim() || !Number.isInteger(Number(port)) || Number(port) < 1 || Number(port) > 65535} onClick={() => void probe()}>{t(probing ? "settings.ssh.probing" : "settings.ssh.probe")}</Button>
          {fingerprint && <><code className="block break-all text-xs text-content">{fingerprint}</code><label className="flex items-start gap-2 text-xs text-content-muted"><input type="checkbox" checked={confirmed} disabled={saving} onChange={e => setConfirmed(e.target.checked)} />{t("settings.ssh.confirmPin")}</label></>}
        </div>
        {error && <p role="alert" className="text-xs text-danger">{error}</p>}
      </div>
      <div className="flex justify-end gap-2 border-t border-edge px-5 py-3"><Button variant="ghost" disabled={saving} onClick={onClose}>{t("common.cancel")}</Button><Button disabled={saving || probing || !confirmed} onClick={() => void save()}>{t(saving ? "settings.ssh.saving" : "common.save")}</Button></div>
    </Dialog.Popup></Dialog.Portal>
  </Dialog.Root>;
}
