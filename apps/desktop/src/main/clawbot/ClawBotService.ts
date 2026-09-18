import type {
  ClawBotBindingResult,
  ClawBotSendResult,
  ClawBotStatus,
} from "@contracts/clawbot";
import { log } from "@main/lib/logger.js";
import {
  ClawBotCredentialStore,
  type ClawBotMetadata,
  type ClawBotSecrets,
} from "./ClawBotCredentialStore.js";
import {
  consumeReplyContext,
  findReplyContext,
  upsertReplyContexts,
  type ClawBotReplyContext,
} from "./inbound.js";
import {
  ILINK_DEFAULT_BASE_URL,
  buildBaseInfo,
  buildIlinkCommonHeaders,
  buildIlinkHeaders,
  buildSendTextBody,
  classifySendResponse,
  isQrStatus,
  responseCode,
  resolveStoredBindingState,
  normalizeTrustedApiBase,
  deliverInboundBatch,
  normalizeOwnerInbound,
  readUpdatesCursor,
  readUpdatesMessages,
  BindingEpoch,
  type ClawBotInboundEvent,
  type ILinkResponse,
  type QrBindingStatus,
  type QrStatusResponse,
  type UpdatesResponse,
} from "./protocol.js";

interface BindingSession {
  epoch: number;
  qrCode: string;
  qrCodeImage: string;
  baseUrl: string;
  verifyCode?: string;
  status: QrBindingStatus;
}

const REGULAR_TIMEOUT_MS = 15_000;
const LONG_POLL_TIMEOUT_MS = 40_000;

export class ClawBotService {
  private readonly store = new ClawBotCredentialStore();
  private binding: BindingSession | null = null;
  private readonly bindingEpoch = new BindingEpoch();
  private bindingAbort: AbortController | null = null;
  private state: ClawBotStatus["state"] = "unbound";
  private runtimeError: string | null = null;
  private monitorAbort: AbortController | null = null;
  private monitorPromise: Promise<void> | null = null;
  private inboundSink: ((batch: readonly ClawBotInboundEvent[]) => Promise<void>) | null = null;
  private lifecycleEpoch = 0;
  private stopping = false;

  registerInboundSink(sink: (batch: readonly ClawBotInboundEvent[]) => Promise<void>): () => void {
    if (this.inboundSink) throw new Error("ClawBot 入站处理器已注册。");
    this.inboundSink = sink;
    return () => { if (this.inboundSink === sink) this.inboundSink = null; };
  }

  getStatus(): ClawBotStatus {
    const meta = this.store.readMetadata();
    const secrets = this.store.readSecrets();
    const hasBinding = Boolean(meta && secrets?.botToken);
    let state = this.state;
    if (this.binding) state = "binding";
    else if (state === "unbound" && hasBinding) state = secrets?.contextToken ? "bound" : "needs-interaction";
    return {
      state,
      ready: hasBinding && Boolean(secrets?.contextToken && meta?.userId),
      accountId: meta?.accountId ?? null,
      userId: meta?.userId || null,
      boundAt: meta?.boundAt ?? null,
      lastInteractionAt: meta?.lastInteractionAt ?? null,
      error: this.runtimeError ?? meta?.lastError ?? null,
    };
  }

  async start(): Promise<void> {
    const epoch = ++this.lifecycleEpoch;
    this.stopping = false;
    const meta = this.store.readMetadata();
    const secrets = this.store.readSecrets();
    if (!meta || !secrets?.botToken) {
      this.state = "unbound";
      return;
    }
    this.state = secrets.contextToken ? "bound" : "needs-interaction";
    await this.notify("notifystart");
    if (this.stopping || epoch !== this.lifecycleEpoch) return;
    this.startMonitor();
  }

  async stop(): Promise<void> {
    // Invalidate pending reply continuations before any shutdown I/O.
    this.lifecycleEpoch++;
    this.stopping = true;
    this.invalidateBindingSession();
    this.monitorAbort?.abort();
    this.monitorAbort = null;
    await this.notify("notifystop");
    await this.monitorPromise?.catch(() => undefined);
    this.monitorPromise = null;
  }

  async startBinding(): Promise<ClawBotBindingResult> {
    this.invalidateBindingSession();
    const epoch = this.bindingEpoch.begin();
    const bindingAbort = new AbortController();
    this.bindingAbort = bindingAbort;
    await this.stopMonitor();
    if (!this.bindingEpoch.isCurrent(epoch)) throw new Error("绑定请求已被新会话替代。");
    const previous = this.store.readSecrets();
    let response: { qrcode?: string; qrcode_img_content?: string };
    try {
      response = await this.requestJson<{ qrcode?: string; qrcode_img_content?: string }>(
        `${ILINK_DEFAULT_BASE_URL}/ilink/bot/get_bot_qrcode?bot_type=3`,
        { method: "POST", body: JSON.stringify({ local_token_list: previous?.botToken ? [previous.botToken] : [] }) },
        undefined,
        REGULAR_TIMEOUT_MS,
        bindingAbort.signal,
      );
    } catch (err) {
      if (this.bindingEpoch.isCurrent(epoch)) {
        this.invalidateBindingSession();
        this.restoreStoredState();
      }
      throw err;
    }
    if (!this.bindingEpoch.isCurrent(epoch)) throw new Error("绑定请求已被新会话替代。");
    if (!response.qrcode || !response.qrcode_img_content) {
      this.invalidateBindingSession();
      this.restoreStoredState();
      throw new Error("微信接口未返回有效二维码。");
    }
    this.binding = {
      epoch,
      qrCode: response.qrcode,
      qrCodeImage: response.qrcode_img_content,
      baseUrl: ILINK_DEFAULT_BASE_URL,
      status: "wait",
    };
    this.state = "binding";
    this.runtimeError = null;
    return this.bindingResult();
  }

  async pollBinding(): Promise<ClawBotBindingResult> {
    const binding = this.binding;
    if (!binding) throw new Error("当前没有正在进行的 ClawBot 绑定。");
    const query = new URLSearchParams({ qrcode: binding.qrCode });
    if (binding.verifyCode) query.set("verify_code", binding.verifyCode);
    const response = await this.requestJson<QrStatusResponse>(
      `${binding.baseUrl}/ilink/bot/get_qrcode_status?${query.toString()}`,
      { method: "GET" },
      undefined,
      LONG_POLL_TIMEOUT_MS,
      this.bindingAbort?.signal,
      "common",
    );
    if (this.binding !== binding || !this.bindingEpoch.isCurrent(binding.epoch)) {
      throw new Error("绑定请求已取消或被替代。");
    }
    if (!isQrStatus(response.status)) throw new Error("微信接口返回了未知的二维码状态。");
    binding.status = response.status;

    if (response.status === "scaned" && binding.verifyCode) binding.verifyCode = undefined;
    if (response.status === "scaned_but_redirect" && response.redirect_host) {
      binding.baseUrl = this.safeRedirectBase(response.redirect_host);
    } else if (response.status === "confirmed") {
      await this.finishBinding(binding, response);
    } else if (response.status === "expired" || response.status === "verify_code_blocked") {
      this.runtimeError = response.status === "expired" ? "二维码已过期，请重新生成。" : "验证码错误次数过多，请重新生成二维码。";
      this.invalidateBindingSession();
      this.restoreStoredState();
    } else if (response.status === "binded_redirect") {
      const hasCredentials = Boolean(this.store.readSecrets()?.botToken);
      this.runtimeError = hasCredentials ? null : "ClawBot 已在其他实例绑定，本机没有可用凭据，请重新绑定。";
      this.invalidateBindingSession();
      this.restoreStoredState();
    }
    return this.bindingResult(response.status);
  }

  async submitVerifyCode(code: string): Promise<ClawBotBindingResult> {
    if (!this.binding) throw new Error("当前没有正在进行的 ClawBot 绑定。");
    this.binding.verifyCode = code;
    return this.pollBinding();
  }

  cancelBinding(): ClawBotStatus {
    this.invalidateBindingSession();
    this.runtimeError = null;
    this.restoreStoredState();
    return this.getStatus();
  }

  async unbind(): Promise<ClawBotStatus> {
    this.invalidateBindingSession();
    await this.stopMonitor();
    await this.notify("notifystop");
    this.store.clear();
    this.state = "unbound";
    this.runtimeError = null;
    return this.getStatus();
  }

  async testPush(text?: string): Promise<ClawBotSendResult> {
    return this.sendText(text?.trim() || "MarioCode 微信推送测试成功。接口已接受发送请求。");
  }

  async sendText(text: string): Promise<ClawBotSendResult> {
    const meta = this.store.readMetadata();
    const secrets = this.store.readSecrets();
    if (!meta || !secrets?.botToken) return { status: "failed", error: "ClawBot 尚未绑定。" };
    if (!meta.userId || !secrets.contextToken) {
      this.state = "needs-interaction";
      return { status: "needs-interaction", error: "请先向 ClawBot 发送一条消息以激活推送。" };
    }
    try {
      const response = await this.requestJson<ILinkResponse>(
        `${this.safeApiBase(meta.baseUrl)}/ilink/bot/sendmessage`,
        { method: "POST", body: JSON.stringify(buildSendTextBody(meta.userId, text, secrets.contextToken)) },
        secrets.botToken,
        REGULAR_TIMEOUT_MS,
      );
      const result = classifySendResponse(response);
      const code = responseCode(response);
      if (code === -14) this.invalidateCredentials(result.error);
      if (code === -2) this.invalidateContext(result.error);
      return result;
    } catch (err) {
      return { status: "failed", error: this.safeError(err) };
    }
  }

  async replyTo(replyContextRef: string, text: string, stableClientId: string): Promise<ClawBotSendResult> {
    if (this.stopping) return { status: "failed", error: "ClawBot 正在关闭。" };
    const context = findReplyContext(this.store.readSecrets()?.replyContexts, replyContextRef);
    if (!context) return { status: "failed", error: "回复上下文已失效。" };
    const meta = this.store.readMetadata();
    const secrets = this.store.readSecrets();
    if (!meta || !secrets?.botToken || context.senderId !== meta.userId) {
      return { status: "failed", error: "ClawBot 尚未绑定或回复目标无效。" };
    }
    const requestEpoch = this.lifecycleEpoch;
    try {
      const response = await this.requestJson<ILinkResponse>(
        `${this.safeApiBase(meta.baseUrl)}/ilink/bot/sendmessage`,
        { method: "POST", body: JSON.stringify(buildSendTextBody(context.senderId, text, context.contextToken, stableClientId)) },
        secrets.botToken,
        REGULAR_TIMEOUT_MS,
      );
      const result = classifySendResponse(response);
      // App shutdown may have disposed the DB while fetch was in flight.
      if (this.stopping || requestEpoch !== this.lifecycleEpoch) return result;
      const code = responseCode(response);
      if (code === -14) this.invalidateCredentials(result.error);
      if (code === -2) this.invalidateContext(result.error);
      if (code === 0) {
        // Re-read after the network await so concurrent inbound commits are
        // preserved; credential writes are synchronous within the main process.
        const latest = this.store.readSecrets();
        if (latest) {
          this.store.writeSecrets({
            ...latest,
            replyContexts: consumeReplyContext(latest.replyContexts, replyContextRef),
          });
        }
      }
      return result;
    } catch (err) {
      return { status: "failed", error: this.safeError(err) };
    }
  }

  private async finishBinding(binding: BindingSession, response: QrStatusResponse): Promise<void> {
    if (this.binding !== binding || !this.bindingEpoch.isCurrent(binding.epoch)) {
      throw new Error("绑定请求已取消或被替代。");
    }
    if (!response.bot_token || !response.ilink_bot_id) {
      throw new Error("绑定已确认，但微信接口返回的账号凭证不完整。");
    }
    const baseUrl = this.safeApiBase(response.baseurl || binding.baseUrl || ILINK_DEFAULT_BASE_URL);
    const now = Date.now();
    const metadata: ClawBotMetadata = {
      accountId: response.ilink_bot_id,
      baseUrl,
      userId: response.ilink_user_id ?? "",
      boundAt: now,
      lastInteractionAt: null,
      lastError: null,
    };
    // Commit the encrypted credential first. If the OS keychain is
    // unavailable, no misleading public "bound" metadata is left behind.
    this.store.writeSecrets({ botToken: response.bot_token, cursor: "", contextToken: "" });
    this.store.writeMetadata(metadata);
    this.invalidateBindingSession();
    this.state = "needs-interaction";
    this.runtimeError = null;
    await this.notify("notifystart");
    this.startMonitor();
  }

  private startMonitor(): void {
    if (this.stopping || this.monitorPromise || this.monitorAbort) return;
    const controller = new AbortController();
    this.monitorAbort = controller;
    this.monitorPromise = this.monitorLoop(controller.signal).finally(() => {
      if (this.monitorAbort === controller) this.monitorAbort = null;
      this.monitorPromise = null;
    });
  }

  private async stopMonitor(): Promise<void> {
    this.monitorAbort?.abort();
    await this.monitorPromise?.catch(() => undefined);
  }

  private async monitorLoop(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      const meta = this.store.readMetadata();
      const secrets = this.store.readSecrets();
      if (!meta || !secrets?.botToken) return;
      try {
        const response = await this.requestJson<UpdatesResponse>(
          `${this.safeApiBase(meta.baseUrl)}/ilink/bot/getupdates`,
          { method: "POST", body: JSON.stringify({ get_updates_buf: secrets.cursor || "", base_info: buildBaseInfo() }) },
          secrets.botToken,
          Math.max(LONG_POLL_TIMEOUT_MS, 5_000),
          signal,
        );
        if (signal.aborted || this.stopping) return;
        const code = responseCode(response);
        if (code === null) throw new Error("getupdates returned an invalid business response");
        if (code === -14) { this.invalidateCredentials("ClawBot 登录凭证已失效，请重新扫码绑定。"); return; }
        if (code === -2) {
          this.invalidateContext("微信会话上下文已失效，请重新向 ClawBot 发送消息。");
          await new Promise<void>((resolve) => setTimeout(resolve, 2_000));
          continue;
        }
        if (code !== 0) throw new Error(`getupdates rejected (${code})`);

        const storedMeta = this.store.readMetadata();
        const storedSecrets = this.store.readSecrets();
        if (!storedMeta || !storedSecrets) return;
        const ownerUserId = storedMeta.userId;
        const pendingContexts: ClawBotReplyContext[] = [];
        const normalized = readUpdatesMessages(response).flatMap((message) => {
          const inbound = normalizeOwnerInbound(message, ownerUserId, storedMeta.accountId);
          if (!inbound) return [];
          pendingContexts.push({
            ref: inbound.event.replyContextRef,
            senderId: inbound.senderId,
            contextToken: inbound.contextToken,
            createdAt: Date.now(),
          });
          return [inbound];
        });
        const cursor = readUpdatesCursor(response);
        if (pendingContexts.length > 0) {
          // Make reply refs restart-safe before the Inbox can become visible.
          // Deliberately retain the old cursor: sink failure must replay.
          const beforeSink = this.store.readSecrets();
          if (!beforeSink) return;
          this.store.writeSecrets({
            ...beforeSink,
            replyContexts: upsertReplyContexts(beforeSink.replyContexts, pendingContexts),
          });
        }
        await deliverInboundBatch(normalized.map(({ event }) => event), this.inboundSink, () => {
          if (signal.aborted || this.stopping) return;
          const latestMeta = this.store.readMetadata();
          const latestSecrets = this.store.readSecrets();
          if (!latestMeta || !latestSecrets) return;
          let acknowledgedMeta: ClawBotMetadata = latestMeta;
          let acknowledgedSecrets: ClawBotSecrets = latestSecrets;
          if (normalized.length > 0) {
            const latest = normalized.at(-1)!;
            acknowledgedMeta = { ...acknowledgedMeta, lastInteractionAt: Date.now(), lastError: null };
            acknowledgedSecrets = {
              ...acknowledgedSecrets,
              contextToken: latest.contextToken,
            };
            this.state = "bound";
            this.runtimeError = null;
          }
          if (cursor && cursor !== acknowledgedSecrets.cursor) acknowledgedSecrets = { ...acknowledgedSecrets, cursor };
          if (normalized.length > 0) this.store.writeMetadata(acknowledgedMeta);
          if (normalized.length > 0 || (cursor && cursor !== latestSecrets.cursor)) {
            this.store.writeSecrets(acknowledgedSecrets);
          }
        });
      } catch (err) {
        if (signal.aborted) return;
        if (err instanceof Error && err.name === "AbortError") continue;
        this.runtimeError = this.safeError(err);
        log.warn(`ClawBot getupdates failed: ${this.runtimeError}`);
        await new Promise<void>((resolve) => setTimeout(resolve, 2_000));
      }
    }
  }

  private async notify(kind: "notifystart" | "notifystop"): Promise<void> {
    const meta = this.store.readMetadata();
    const secrets = this.store.readSecrets();
    if (!meta || !secrets?.botToken) return;
    try {
      const response = await this.requestJson<ILinkResponse>(
        `${this.safeApiBase(meta.baseUrl)}/ilink/bot/msg/${kind}`,
        { method: "POST", body: JSON.stringify({ base_info: buildBaseInfo() }) },
        secrets.botToken,
        REGULAR_TIMEOUT_MS,
      );
      const code = responseCode(response);
      if (code === null) throw new Error(`${kind} returned an invalid business response`);
      if (code !== 0) log.warn(`ClawBot ${kind} was rejected by iLink.`);
    } catch (err) {
      log.warn(`ClawBot ${kind} failed: ${this.safeError(err)}`);
    }
  }

  private invalidateCredentials(error: string | null): void {
    this.store.clear();
    this.state = "error";
    this.runtimeError = error;
    this.monitorAbort?.abort();
  }

  private invalidateContext(error: string | null): void {
    const meta = this.store.readMetadata();
    const secrets = this.store.readSecrets();
    if (meta) this.store.writeMetadata({ ...meta, lastError: error });
    if (secrets) this.store.writeSecrets({ ...secrets, contextToken: "", replyContexts: [] });
    this.state = "needs-interaction";
    this.runtimeError = error;
  }

  private bindingResult(override?: QrBindingStatus): ClawBotBindingResult {
    return {
      status: this.getStatus(),
      qrCodeImage: this.binding?.qrCodeImage ?? null,
      bindingStatus: override ?? this.binding?.status ?? "confirmed",
    };
  }

  private safeRedirectBase(host: string): string {
    if (!/^[a-z0-9.-]+(?::\d+)?$/i.test(host)) throw new Error("微信返回了无效的重定向地址。");
    return this.safeApiBase(`https://${host}`);
  }

  private safeApiBase(value: string): string {
    return normalizeTrustedApiBase(value);
  }

  private restoreStoredState(): void {
    const secrets = this.store.readSecrets();
    this.state = resolveStoredBindingState(Boolean(secrets?.botToken), Boolean(secrets?.contextToken));
    if (secrets?.botToken) this.startMonitor();
  }

  private invalidateBindingSession(): void {
    this.bindingEpoch.cancel();
    this.bindingAbort?.abort();
    this.bindingAbort = null;
    this.binding = null;
  }

  private safeError(err: unknown): string {
    if (err instanceof Error && err.name === "AbortError") return "请求已取消。";
    if (err instanceof Error && err.message) return err.message.replace(/Bearer\s+\S+/gi, "Bearer ***");
    return "ClawBot 请求失败。";
  }

  private async requestJson<T>(
    url: string,
    init: RequestInit,
    token?: string,
    timeoutMs = REGULAR_TIMEOUT_MS,
    externalSignal?: AbortSignal,
    headerMode: "auth" | "common" = "auth",
  ): Promise<T> {
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), timeoutMs);
    const abort = () => timeout.abort();
    externalSignal?.addEventListener("abort", abort, { once: true });
    if (externalSignal?.aborted) timeout.abort();
    try {
      const response = await fetch(url, {
        ...init,
        headers: {
          ...(headerMode === "common" ? buildIlinkCommonHeaders() : buildIlinkHeaders(token)),
          ...(init.headers ?? {}),
        },
        signal: timeout.signal,
      });
      if (!response.ok) throw new Error(`微信接口 HTTP ${response.status}`);
      return await response.json() as T;
    } finally {
      clearTimeout(timer);
      externalSignal?.removeEventListener("abort", abort);
    }
  }
}

export const clawBotService = new ClawBotService();
