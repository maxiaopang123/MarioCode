import { safeStorage } from "electron";
import { SettingRepo } from "@main/store/repositories.js";
import type { ClawBotReplyContext } from "./inbound.js";

const META_KEY = "clawbot.metadata";
const SECRETS_KEY = "clawbot.secrets";

export interface ClawBotMetadata {
  accountId: string;
  baseUrl: string;
  userId: string;
  boundAt: number;
  lastInteractionAt: number | null;
  lastError: string | null;
}

export interface ClawBotSecrets {
  botToken: string;
  cursor: string;
  contextToken: string;
  replyContexts?: ClawBotReplyContext[];
}


function parseJson<T>(raw: string | null): T | null {
  if (!raw) return null;
  try { return JSON.parse(raw) as T; } catch { return null; }
}

export class ClawBotCredentialStore {
  readMetadata(): ClawBotMetadata | null {
    return parseJson<ClawBotMetadata>(SettingRepo.get(META_KEY));
  }

  writeMetadata(value: ClawBotMetadata): void {
    SettingRepo.set(META_KEY, JSON.stringify(value));
  }

  readSecrets(): ClawBotSecrets | null {
    const cipher = SettingRepo.get(SECRETS_KEY);
    if (!cipher || !safeStorage.isEncryptionAvailable()) return null;
    try {
      return parseJson<ClawBotSecrets>(safeStorage.decryptString(Buffer.from(cipher, "base64")));
    } catch {
      return null;
    }
  }

  writeSecrets(value: ClawBotSecrets): void {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error("系统安全凭据存储不可用，拒绝保存 ClawBot 登录凭证。");
    }
    const cipher = safeStorage.encryptString(JSON.stringify(value)).toString("base64");
    SettingRepo.set(SECRETS_KEY, cipher);
  }

  clear(): void {
    SettingRepo.set(META_KEY, "");
    SettingRepo.set(SECRETS_KEY, "");
  }
}
