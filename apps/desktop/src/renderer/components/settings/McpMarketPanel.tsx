import { useState } from "react";
import { MCP_MARKET, type McpMarketTemplate } from "@contracts/mcpMarket";
import type { McpServerEntry } from "@contracts/ipc";
import { api } from "@renderer/lib/api.js";
import { cn } from "@renderer/lib/cn.js";
import { useI18n, type MessageId } from "@renderer/lib/i18n/index.js";
import { IconExternalLink, IconFolder, IconLoader2, McpIcon } from "@renderer/lib/icons.js";
import { Button, Input } from "@renderer/components/ui/index.js";
import { ExtensionSearch } from "./ExtensionManagement.js";

const DESCRIPTIONS: Record<McpMarketTemplate["id"], MessageId> = {
  context7: "settings.mcpMarket.context7", github: "settings.mcpMarket.github", notion: "settings.mcpMarket.notion",
  playwright: "settings.mcpMarket.playwright", filesystem: "settings.mcpMarket.filesystem", memory: "settings.mcpMarket.memory",
};
export function McpMarketPanel({ servers, onAdded, onManage }: { servers: McpServerEntry[]; onAdded: (oauthName?: string) => Promise<void>; onManage: () => void }) {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<McpMarketTemplate | null>(null);
  const [name, setName] = useState("");
  const [credential, setCredential] = useState("");
  const [directory, setDirectory] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const choose = (item: McpMarketTemplate) => { setSelected(item); setName(item.id); setCredential(""); setDirectory(""); setError(null); };
  const save = async () => {
    if (!selected || saving) return;
    if (!/^[A-Za-z0-9_-]+$/.test(name.trim())) { setError(t("settings.nameCharsError")); return; }
    if (selected.auth === "token" && !credential.trim()) { setError(t("settings.mcpMarket.tokenRequired")); return; }
    if (selected.auth === "path" && !directory.trim()) { setError(t("settings.mcpMarket.pathRequired")); return; }
    setSaving(true); setError(null);
    try {
      const result = await api.mcp.marketInstall({ id: selected.id, name: name.trim(), credential, directory });
      if (!result.ok) { setError(result.error ?? t("settings.saveFailed")); return; }
      setCredential("");
      await onAdded(selected.auth === "oauth" ? name.trim() : undefined);
    } catch (err) { setError((err as Error).message); }
    finally { setSaving(false); }
  };
  return <div>
    <ExtensionSearch query={query} onQuery={setQuery} />
    <div className={cn("settings-mcp-market-layout grid items-start gap-4", selected && "lg:grid-cols-[minmax(0,1fr)_300px]")}>
      <div className="divide-y divide-edge border-t border-edge">
        {MCP_MARKET.filter((item) => `${item.name} ${item.publisher} ${t(DESCRIPTIONS[item.id])}`.toLowerCase().includes(query.trim().toLowerCase())).map((item) => {
          const exists = servers.some((s) => s.scope === "user" && (s.origin?.id === item.id || s.name === item.id));
          return <article key={item.id} className="flex flex-wrap items-center gap-3 py-4" data-market-id={item.id}>
            <McpIcon size={24} className="shrink-0 text-content-subtle" />
            <div className="min-w-0 flex-1"><h3 className="text-sm font-medium text-content">{item.name}</h3><p className="text-xs text-content-subtle">{item.publisher}</p><p className="mt-1 text-xs leading-relaxed text-content-muted">{t(DESCRIPTIONS[item.id])}</p></div>
            <Button variant="outline" size="md" onClick={() => exists ? onManage() : choose(item)} disabled={saving}>{t(exists ? "settings.extensions.manage" : "settings.mcpMarket.configure")}</Button>
          </article>;
        })}
        {!MCP_MARKET.some((item) => `${item.name} ${item.publisher} ${t(DESCRIPTIONS[item.id])}`.toLowerCase().includes(query.trim().toLowerCase())) && <p className="py-8 text-center text-xs text-content-subtle">{t("settings.skillMarket.noMatch")}</p>}
      </div>
      {selected && <aside aria-label={t("settings.mcpMarket.configure")} className="rounded-[10px] border border-edge bg-surface-muted p-4">
        <h3 className="text-sm font-medium">{selected.name}</h3><p className="mt-1 text-xs text-content-subtle">{t(DESCRIPTIONS[selected.id])}</p>
        <a href={selected.docsUrl} target="_blank" rel="noreferrer" className="mt-3 inline-flex items-center gap-1 text-xs text-content-muted underline">{t("settings.mcpMarket.docs")}<IconExternalLink size={12} /></a>
        <form onSubmit={(e) => { e.preventDefault(); void save(); }} className="mt-4 space-y-4">
          <label className="block space-y-1 text-xs"><span>{t("settings.mcp.fName")}</span><Input value={name} onChange={(e) => setName(e.target.value)} required disabled={saving} /></label>
          {(selected.auth === "token" || selected.auth === "optional-key") && <label className="block space-y-1 text-xs"><span>{t(selected.auth === "token" ? "settings.mcpMarket.token" : "settings.mcpMarket.optionalKey")}</span><Input value={credential} onChange={(e) => setCredential(e.target.value)} type="password" autoComplete="off" disabled={saving} required={selected.auth === "token"} /></label>}
          {selected.auth === "path" && <div className="space-y-1 text-xs"><label><span>{t("settings.mcpMarket.directory")}</span><Input value={directory} onChange={(e) => setDirectory(e.target.value)} required disabled={saving} /></label><Button variant="ghost" disabled={saving} onClick={() => void api.pickFolder().then((r) => { if (r.path) setDirectory(r.path); }).catch((err: unknown) => setError(String(err)))}><IconFolder size={12} />{t("settings.mcpMarket.pickDirectory")}</Button></div>}
          <p className="text-xs leading-relaxed text-content-subtle">{t(selected.auth === "oauth" ? "settings.mcpMarket.oauthHint" : selected.auth === "none" || selected.auth === "path" ? "settings.mcpMarket.localHint" : "settings.mcpMarket.remoteHint")}</p>
          <p className="text-xs text-content-subtle">{t("settings.extensions.globalHint")}</p>
          {error && <p role="alert" className="break-words text-xs text-danger">{error}</p>}
          <div className="flex gap-2"><Button variant="ghost" disabled={saving} onClick={() => setSelected(null)}>{t("common.cancel")}</Button><Button type="submit" variant="primary" size="md" disabled={saving}>{saving && <IconLoader2 size={13} className="animate-spin" />}{t(saving ? "settings.saving" : selected.auth === "oauth" ? "settings.mcpMarket.addAuthorize" : "settings.mcp.addBtn")}</Button></div>
        </form>
      </aside>}
    </div>
  </div>;
}
