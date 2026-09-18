import { useCallback, useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import type { ClawBotBindingResult, ClawBotStatus } from "@contracts/ipc";
import { api } from "@renderer/lib/api.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import {
  IconAlertCircle,
  IconCheck,
  IconLoader2,
  IconRefresh,
  IconUnlink,
} from "@renderer/lib/icons.js";
import { Button, ConfirmDialog, Input } from "@renderer/components/ui/index.js";

const EMPTY_STATUS: ClawBotStatus = {
  state: "unbound",
  ready: false,
  accountId: null,
  userId: null,
  boundAt: null,
  lastInteractionAt: null,
  error: null,
};

export function ClawBotPanel() {
  const { t, locale } = useI18n();
  const [status, setStatus] = useState<ClawBotStatus>(EMPTY_STATUS);
  const [binding, setBinding] = useState<ClawBotBindingResult | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [verifyCode, setVerifyCode] = useState("");
  const [testText, setTestText] = useState("");
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ kind: "ok" | "error" | "warning"; text: string } | null>(null);
  const [confirmUnbind, setConfirmUnbind] = useState(false);
  const pollBusy = useRef(false);
  const bindingGeneration = useRef(0);

  const applyBinding = useCallback(async (result: ClawBotBindingResult) => {
    setBinding(result);
    setStatus(result.status);
    if (!result.qrCodeImage) {
      setQrDataUrl(null);
      return;
    }
    if (result.qrCodeImage.startsWith("data:image/")) {
      setQrDataUrl(result.qrCodeImage);
      return;
    }
    try {
      setQrDataUrl(await QRCode.toDataURL(result.qrCodeImage, {
        margin: 1,
        width: 220,
        color: { dark: "#15251f", light: "#ffffff" },
      }));
    } catch {
      setQrDataUrl(null);
    }
  }, []);

  const refreshStatus = useCallback(async () => {
    try {
      setStatus(await api.clawbot.status());
    } catch (err) {
      setFeedback({ kind: "error", text: t("settings.clawbot.actionFailed", { error: (err as Error).message }) });
    }
  }, [t]);

  useEffect(() => { void refreshStatus(); }, [refreshStatus]);

  // After QR confirmation the service still needs one inbound WeChat message
  // before proactive pushes have a usable context. Refresh that transition
  // automatically so the card becomes ready without a manual click.
  useEffect(() => {
    if (status.ready || (status.state !== "bound" && status.state !== "needs-interaction")) return;
    const timer = window.setInterval(() => void refreshStatus(), 5_000);
    return () => window.clearInterval(timer);
  }, [status.ready, status.state, refreshStatus]);

  useEffect(() => {
    const bindingStatus = binding?.bindingStatus ?? null;
    const shouldPoll = status.state === "binding" && (
      bindingStatus === null ||
      bindingStatus === "wait" ||
      bindingStatus === "scaned" ||
      bindingStatus === "scaned_but_redirect"
    );
    if (!shouldPoll) return;
    const generation = bindingGeneration.current;
    const timer = window.setInterval(async () => {
      if (pollBusy.current) return;
      pollBusy.current = true;
      try {
        const result = await api.clawbot.pollBinding();
        if (generation !== bindingGeneration.current) return;
        await applyBinding(result);
        if (result.bindingStatus === "expired") {
          setFeedback({ kind: "warning", text: t("settings.clawbot.qrExpired") });
        }
      } catch (err) {
        if (generation !== bindingGeneration.current) return;
        setFeedback({ kind: "error", text: t("settings.clawbot.actionFailed", { error: (err as Error).message }) });
      } finally {
        pollBusy.current = false;
      }
    }, 2_000);
    return () => window.clearInterval(timer);
  }, [status.state, binding?.bindingStatus, applyBinding, t]);

  const startBinding = async () => {
    const generation = ++bindingGeneration.current;
    setBusy(true);
    setFeedback(null);
    try {
      const result = await api.clawbot.startBinding();
      if (generation !== bindingGeneration.current) return;
      await applyBinding(result);
    } catch (err) {
      if (generation !== bindingGeneration.current) return;
      setFeedback({ kind: "error", text: t("settings.clawbot.actionFailed", { error: (err as Error).message }) });
    } finally {
      if (generation === bindingGeneration.current) setBusy(false);
    }
  };

  const cancelBinding = async () => {
    const generation = ++bindingGeneration.current;
    setBusy(true);
    setFeedback(null);
    try {
      const next = await api.clawbot.cancelBinding();
      if (generation !== bindingGeneration.current) return;
      setStatus(next);
      setBinding(null);
      setQrDataUrl(null);
    } catch (err) {
      if (generation !== bindingGeneration.current) return;
      setFeedback({ kind: "error", text: t("settings.clawbot.actionFailed", { error: (err as Error).message }) });
    } finally {
      if (generation === bindingGeneration.current) setBusy(false);
    }
  };

  const submitVerifyCode = async () => {
    if (!/^\d{4,8}$/.test(verifyCode)) return;
    const generation = ++bindingGeneration.current;
    setBusy(true);
    setFeedback(null);
    try {
      const result = await api.clawbot.submitVerifyCode({ code: verifyCode });
      if (generation !== bindingGeneration.current) return;
      await applyBinding(result);
    } catch (err) {
      if (generation !== bindingGeneration.current) return;
      setFeedback({ kind: "error", text: t("settings.clawbot.actionFailed", { error: (err as Error).message }) });
    } finally {
      if (generation === bindingGeneration.current) setBusy(false);
    }
  };

  const unbind = async () => {
    const generation = ++bindingGeneration.current;
    setBusy(true);
    setFeedback(null);
    try {
      const next = await api.clawbot.unbind();
      if (generation !== bindingGeneration.current) return;
      setStatus(next);
      setBinding(null);
      setQrDataUrl(null);
    } catch (err) {
      if (generation !== bindingGeneration.current) return;
      setFeedback({ kind: "error", text: t("settings.clawbot.actionFailed", { error: (err as Error).message }) });
    } finally {
      if (generation === bindingGeneration.current) {
        setBusy(false);
        setConfirmUnbind(false);
      }
    }
  };

  const testPush = async () => {
    setBusy(true);
    setFeedback(null);
    try {
      const result = await api.clawbot.testPush(testText.trim() ? { text: testText.trim() } : {});
      if (result.status === "accepted") {
        setFeedback({ kind: "ok", text: t("settings.clawbot.testAccepted") });
      } else if (result.status === "needs-interaction") {
        setFeedback({ kind: "warning", text: result.error ?? t("settings.clawbot.needsInteraction") });
      } else {
        setFeedback({ kind: "error", text: result.error ?? t("settings.clawbot.testFailed") });
      }
    } catch (err) {
      setFeedback({ kind: "error", text: t("settings.clawbot.actionFailed", { error: (err as Error).message }) });
    } finally {
      setBusy(false);
    }
  };

  const needsVerify = binding?.bindingStatus === "need_verifycode";
  const bound = status.state === "bound" || status.state === "needs-interaction";
  const stateLabel = status.ready
    ? t("settings.clawbot.state.ready")
    : t(`settings.clawbot.state.${status.state}` as never);
  const formatDate = (value: number | null) => value == null
    ? t("settings.clawbot.never")
    : new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));

  return (
    <div className="overflow-hidden rounded-lg border border-edge bg-surface-raised">
      <div className="flex items-start gap-3 border-b border-edge px-4 py-3.5">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[#07c160]/10 text-[#07994d]">
          <span className="text-sm font-bold">微</span>
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-semibold text-content">{t("settings.clawbot.title")}</h3>
            <span className={`rounded-full px-2 py-0.5 text-[10px] ${status.ready ? "bg-success/10 text-success" : status.state === "error" ? "bg-danger/10 text-danger" : "bg-surface-muted text-content-subtle"}`}>{stateLabel}</span>
          </div>
          <p className="mt-1 text-xs leading-relaxed text-content-muted">{t("settings.clawbot.description")}</p>
        </div>
        <Button size="icon" variant="ghost" title={t("settings.clawbot.refreshStatus")} disabled={busy} onClick={() => void refreshStatus()}>
          <IconRefresh size={14} />
        </Button>
      </div>

      <div className="p-4">
        {!bound && status.state !== "binding" && (
          <div className="flex items-center justify-between gap-4">
            <p className="max-w-lg text-xs leading-relaxed text-content-subtle">{t("settings.clawbot.bindHint")}</p>
            <Button variant="primary" size="md" disabled={busy} onClick={() => void startBinding()}>
              {busy && <IconLoader2 size={14} className="animate-spin" />}
              {t("settings.clawbot.startBinding")}
            </Button>
          </div>
        )}

        {status.state === "binding" && (
          <div className="flex flex-col items-center gap-3 py-2">
            {qrDataUrl ? (
              <div className="rounded-xl border border-edge bg-white p-2 shadow-sm"><img src={qrDataUrl} alt={t("settings.clawbot.qrAlt")} className="h-[220px] w-[220px]" /></div>
            ) : (
              <div className="flex h-[220px] w-[220px] items-center justify-center rounded-xl border border-edge bg-surface-muted"><IconLoader2 size={22} className="animate-spin text-content-subtle" /></div>
            )}
            <div className="text-center">
              <p className="text-sm font-medium text-content">{binding?.bindingStatus === "scaned" ? t("settings.clawbot.scanned") : needsVerify ? t("settings.clawbot.verifyRequired") : t("settings.clawbot.scanQr")}</p>
              <p className="mt-1 text-xs text-content-subtle">{t("settings.clawbot.scanHint")}</p>
            </div>
            {needsVerify && (
              <div className="flex w-full max-w-xs gap-2">
                <Input value={verifyCode} inputMode="numeric" placeholder={t("settings.clawbot.verifyPlaceholder")} onChange={(e) => setVerifyCode(e.target.value.replace(/\D/g, "").slice(0, 8))} />
                <Button variant="primary" size="md" disabled={busy || !/^\d{4,8}$/.test(verifyCode)} onClick={() => void submitVerifyCode()}>{t("settings.clawbot.verify")}</Button>
              </div>
            )}
            <div className="flex gap-2">
              <Button variant="ghost" size="md" disabled={busy} onClick={() => void startBinding()}><IconRefresh size={13} />{t("settings.clawbot.refreshQr")}</Button>
              <Button variant="ghost" size="md" disabled={busy} onClick={() => void cancelBinding()}>{t("common.cancel")}</Button>
            </div>
          </div>
        )}

        {bound && (
          <div className="space-y-4">
            <div className="grid gap-2 text-xs text-content-muted sm:grid-cols-2">
              <div>{t("settings.clawbot.boundAt")}: <span className="text-content">{formatDate(status.boundAt)}</span></div>
              <div>{t("settings.clawbot.lastInteraction")}: <span className="text-content">{formatDate(status.lastInteractionAt)}</span></div>
            </div>
            {!status.ready && (
              <div className="flex items-start gap-2 rounded border border-warning/30 bg-warning/5 px-3 py-2 text-xs leading-relaxed text-content-muted">
                <IconAlertCircle size={14} className="mt-0.5 shrink-0 text-warning" />
                {t("settings.clawbot.needsInteraction")}
              </div>
            )}
            <div className="flex flex-col gap-2 rounded-lg border border-edge bg-surface-muted/30 p-3 sm:flex-row sm:items-center">
              <Input value={testText} placeholder={t("settings.clawbot.testPlaceholder")} onChange={(e) => setTestText(e.target.value)} />
              <Button variant="secondary" size="md" disabled={busy || !status.ready} onClick={() => void testPush()}>{t("settings.clawbot.testPush")}</Button>
              <Button variant="ghost" size="md" disabled={busy} onClick={() => setConfirmUnbind(true)}><IconUnlink size={13} />{t("settings.clawbot.unbind")}</Button>
            </div>
            <p className="text-[11px] leading-relaxed text-content-subtle">{t("settings.clawbot.deliveryNotice")}</p>
          </div>
        )}

        {(status.error || feedback) && (
          <div className={`mt-3 flex items-start gap-2 rounded border px-3 py-2 text-xs ${feedback?.kind === "ok" ? "border-success/30 bg-success/5 text-success" : feedback?.kind === "warning" ? "border-warning/30 bg-warning/5 text-content-muted" : "border-danger/30 bg-danger/5 text-danger"}`}>
            {feedback?.kind === "ok" ? <IconCheck size={14} className="mt-0.5 shrink-0" /> : <IconAlertCircle size={14} className="mt-0.5 shrink-0" />}
            <span>{feedback?.text ?? status.error}</span>
          </div>
        )}
      </div>

      <ConfirmDialog
        open={confirmUnbind}
        title={t("settings.clawbot.unbindTitle")}
        description={t("settings.clawbot.unbindDescription")}
        confirmText={t("settings.clawbot.unbind")}
        danger
        onOpenChange={setConfirmUnbind}
        onConfirm={() => void unbind()}
      />
    </div>
  );
}
