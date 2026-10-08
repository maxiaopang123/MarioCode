import { useEffect, useState } from "react";
import { api } from "@renderer/lib/api.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { previewDraft } from "@renderer/lib/previewDraft.js";
import { IconLoader2 } from "@renderer/lib/icons.js";
import { Button } from "../ui/index.js";

export function HtmlPreview({ filePath }: { filePath: string }) {
  const { t } = useI18n();
  const [reload, setReload] = useState(0);
  const [url, setUrl] = useState<string | null>(null);
  const [draft, setDraft] = useState(false);
  const [error, setError] = useState<"outside" | "large" | "format" | "read" | null>(null);
  useEffect(() => {
    let cancelled = false;
    let token: string | undefined;
    setUrl(null); setError(null);
    const content = previewDraft(filePath);
    setDraft(content !== undefined);
    if (content !== undefined && content.length > 2 * 1024 * 1024) { setError("large"); return; }
    void api.file.htmlPreview({ filePath, content }).then(result => {
      if (result.ok) {
        token = result.token;
        if (cancelled) { void api.file.releasePreview({ token }).catch(() => {}); return; }
        setUrl(result.url);
      } else if (!cancelled) setError(result.code);
    }).catch(() => { if (!cancelled) setError("read"); });
    return () => { cancelled = true; if (token) void api.file.releasePreview({ token }).catch(() => {}); };
  }, [filePath, reload]);
  return <div className="flex h-full flex-col" data-html-preview>
    <div className="flex shrink-0 items-center gap-2 border-b border-edge px-3 py-1 text-xs text-content-subtle">
      <span>{draft ? t("ide.preview.unsaved") : t("ide.preview.html")}</span>
      <Button variant="ghost" className="ml-auto" onClick={() => setReload(reload + 1)}>{t("common.refresh")}</Button>
    </div>
    {error ? <div role="alert" className="flex flex-1 items-center justify-center p-6 text-sm text-content-muted">
      {error === "large" ? t("ide.preview.htmlLarge") : t(`ide.document.error.${error}`)}
    </div> : url ? <iframe key={url} src={url} title={t("ide.preview.html")} sandbox="allow-scripts allow-same-origin" referrerPolicy="no-referrer"
      allow="camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'"
      className="min-h-0 w-full flex-1 border-0 bg-white" />
      : <div className="flex flex-1 items-center justify-center gap-2 text-xs text-content-subtle"><IconLoader2 size={14} className="animate-spin" />{t("ide.editor.readingFile")}</div>}
  </div>;
}
