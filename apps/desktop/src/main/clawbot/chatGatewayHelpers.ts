import { isAbsolute, relative, resolve } from "node:path";

export const CLAWBOT_NEW_SESSION_COMMAND = "新会话";

export function isNewSessionCommand(text: string): boolean {
  return text === CLAWBOT_NEW_SESSION_COMMAND;
}

/** Explicit IPC projection: never spread internal settings across a strict schema boundary. */
export function publicChatConfig<T extends string>(config: {
  providerId: T;
  model: string;
  permissionMode: string;
}): { providerId: T; model: string } {
  return { providerId: config.providerId, model: config.model };
}

export function resolveSafeChild(root: string, ...segments: string[]): string {
  const normalizedRoot = resolve(root);
  const child = resolve(normalizedRoot, ...segments);
  const rel = relative(normalizedRoot, child);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error("path must be a non-root child of the configured directory");
  }
  return child;
}

/** FIFO per key; failures never poison subsequent work for that key. */
export class KeyedSerialQueue {
  private readonly tails = new Map<string, Promise<void>>();

  run<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(work);
    const tail = result.then(() => undefined, () => undefined);
    this.tails.set(key, tail);
    void tail.finally(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return result;
  }
}
