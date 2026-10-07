import { useEffect, useState } from "react";
import { Button, Dialog, Input } from "@renderer/components/ui/index.js";
import { api } from "@renderer/lib/api.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import type { ConversationContext, Session } from "@contracts/session";

export function ConversationActionDialog() {
  const { t } = useI18n();
  const action = useSessionStore(s => s.conversationAction);
  const close = useSessionStore(s => s.openConversationAction);
  const fork = useSessionStore(s => s.forkConversation);
  const reference = useSessionStore(s => s.referenceConversation);
  const [context, setContext] = useState<ConversationContext | null>(null);
  const [title, setTitle] = useState("");
  const [query, setQuery] = useState("");
  const [targets, setTargets] = useState<Session[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const errorText = (error: unknown) => {
    const detail = String(error);
    const messages = {
      CONVERSATION_SOURCE_MISSING: "layout.contextErrorSourceMissing",
      CONVERSATION_SOURCE_RUNNING: "layout.contextErrorRunning",
      CONVERSATION_MESSAGE_MISSING: "layout.contextErrorMessageMissing",
      CONVERSATION_PROJECT_ARCHIVED: "layout.contextErrorProjectArchived",
    } as const;
    const code = Object.keys(messages).find(code => detail.includes(code)) as keyof typeof messages | undefined;
    return code ? t(messages[code]) : detail;
  };
  useEffect(() => {
    if (!action) return;
    let cancelled = false;
    setContext(null); setError(""); setQuery(""); setBusy(false);
    void api.session.context({ sessionId: action.sessionId, messageId: action.messageId }).then(value => {
      if (!cancelled) { setContext(value); setTitle(`${value.sourceTitle} · ${t("layout.forkSuffix")}`); }
    }).catch(err => { if (!cancelled) setError(errorText(err)); });
    return () => { cancelled = true; };
  }, [action, t]);
  useEffect(() => {
    if (!action || action.mode !== "reference") return;
    let cancelled = false;
    const timer = setTimeout(() => void api.session.search({ query, limit: 40 }).then(result => {
      if (!cancelled) setTargets(result.sessions.filter(s => s.id !== action.sessionId));
    }).catch(err => { if (!cancelled) setError(errorText(err)); }), 120);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [action, query]);
  const run = async (target?: Session) => {
    if (!action || busy) return;
    setBusy(true); setError("");
    try {
      if (target) await reference(action.sessionId, target, action.messageId);
      else await fork(action.sessionId, action.messageId, title.trim());
    } catch (err) { setError(errorText(err)); } finally { setBusy(false); }
  };
  return <Dialog.Root open={!!action} onOpenChange={open => { if (!open && !busy) close(null); }}>
    <Dialog.Portal><Dialog.Backdrop /><Dialog.Popup className="w-[520px] max-w-[90vw] p-4">
      <Dialog.Title>{t(action?.mode === "reference" ? "layout.referenceConversation" : "layout.forkConversation")}</Dialog.Title>
      <Dialog.Description className="mt-2">{t(action?.mode === "reference" ? "layout.referenceDescription" : "layout.forkDescription")}</Dialog.Description>
      {context && <p className="my-3 text-xs text-content-muted">{t("layout.contextRange", { title: context.sourceTitle, n: context.messageCount })}{context.truncated ? ` · ${t("layout.contextTruncated")}` : ""}</p>}
      {action?.mode === "fork" ? <Input value={title} onChange={e => setTitle(e.target.value)} disabled={busy} /> : <>
        <Input value={query} onChange={e => setQuery(e.target.value)} placeholder={t("layout.targetConversation")} />
        <div className="my-3 max-h-52 space-y-1 overflow-auto">{targets.map(target => <button key={target.id} className="block w-full truncate rounded p-2 text-left text-sm hover:bg-surface-hover disabled:opacity-50" disabled={busy || !context} onClick={() => void run(target)}>{target.title}</button>)}{targets.length === 0 && <p className="text-xs text-content-subtle">{t("layout.noTargetConversations")}</p>}</div>
      </>}
      {context && <details className="my-3 text-xs text-content-muted"><summary className="cursor-pointer">{t("layout.previewContext")}</summary><pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap">{context.content}</pre></details>}
      {error && <p role="alert" className="my-2 text-xs text-danger">{error}</p>}
      <div className="mt-4 flex justify-end gap-2"><Button variant="ghost" size="sm" disabled={busy} onClick={() => close(null)}>{t("common.cancel")}</Button>{action?.mode === "fork" && <Button variant="primary" size="sm" disabled={busy || !context || !title.trim()} onClick={() => void run()}>{t(busy ? "layout.creatingFork" : "layout.createFork")}</Button>}</div>
    </Dialog.Popup></Dialog.Portal>
  </Dialog.Root>;
}
