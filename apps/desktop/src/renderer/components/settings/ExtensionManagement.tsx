import type { ExtensionOrigin } from "@contracts/ipc";
import { Button, Input, Select } from "@renderer/components/ui/index.js";
import { cn } from "@renderer/lib/cn.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { IconSearch } from "@renderer/lib/icons.js";

export type ExtensionView = "market" | "mine";
export type OriginFilter = "all" | "market" | "import" | "manual";
export function ExtensionTabs({ view, onChange, count }: { view: ExtensionView; onChange: (view: ExtensionView) => void; count: number }) {
  const { t } = useI18n();
  return <nav aria-label={t("settings.extensions.tabs")} className="mb-4 flex gap-4 border-b border-edge">
    {(["market", "mine"] as const).map((tab) => <Button key={tab} variant="ghost" size="md" aria-pressed={view === tab} onClick={() => onChange(tab)} className={cn("rounded-none border-b-2 px-0", view === tab ? "border-content text-content" : "border-transparent text-content-subtle")}>
      {t(tab === "market" ? "settings.extensions.discover" : "settings.extensions.mine")}
      {tab === "mine" && <span className="text-content-subtle">{count}</span>}
    </Button>)}
  </nav>;
}
export function ExtensionSearch({ query, onQuery, filter, onFilter }: { query: string; onQuery: (value: string) => void; filter?: OriginFilter; onFilter?: (value: OriginFilter) => void }) {
  const { t } = useI18n();
  return <div className="mb-4 flex flex-wrap items-center gap-3">
    <label className="relative min-w-[180px] flex-1">
      <span className="sr-only">{t("settings.extensions.search")}</span>
      <IconSearch size={14} className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-content-subtle" />
      <Input value={query} onChange={(e) => onQuery(e.target.value)} placeholder={t("settings.extensions.search")} className="pl-7" type="search" />
    </label>
    {onFilter && <Select.Root value={filter ?? "all"} onValueChange={(value) => onFilter(value as OriginFilter)}>
      <Select.Trigger aria-label={t("settings.extensions.source")} className="min-w-28"><Select.Value>{(value: string) => t(`settings.extensions.filter.${value as OriginFilter}`)}</Select.Value></Select.Trigger>
      <Select.Portal><Select.Positioner><Select.Popup><Select.List>
        {(["all", "market", "import", "manual"] as const).map((value) => <Select.Item key={value} value={value}><Select.ItemText>{t(`settings.extensions.filter.${value}`)}</Select.ItemText></Select.Item>)}
      </Select.List></Select.Popup></Select.Positioner></Select.Portal>
    </Select.Root>}
  </div>;
}
export function OriginBadge({ origin }: { origin?: ExtensionOrigin }) {
  const { t } = useI18n();
  return <span className="inline-block max-w-[240px] truncate rounded bg-surface-hover px-1.5 py-0.5 align-bottom text-[11px] text-content-subtle" title={origin?.label}>
    {t(origin ? `settings.extensions.filter.${origin.kind}` : "settings.extensions.existing")}{origin?.label ? ` · ${origin.label}` : ""}
  </span>;
}
export function matchesOrigin(origin: ExtensionOrigin | undefined, filter: OriginFilter): boolean {
  return filter === "all" || (filter === "manual" ? !origin || origin.kind === "manual" : origin?.kind === filter);
}
