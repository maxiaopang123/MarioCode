/**
 * Singleton registry of bridge servers, keyed by custom-model config id.
 *
 * A bridge server is relatively heavyweight (a listening socket) but stateless
 * per-request, so we want to share ONE server across every session/turn that
 * uses the same OpenAI-format config. At the same time, the server must be
 * kept alive across the many requests a single turn generates — the Claude
 * binary fires background tier requests (Task subagents, haiku-class checks)
 * alongside the main message — so we can't tear it down per turn.
 *
 * This registry reference-counts: the first `acquire` for a config id starts a
 * server, subsequent ones just bump the count, and `release` only closes once
 * the count reaches zero. `disposeAll()` (called at app shutdown) force-closes
 * everything regardless of count.
 *
 * Pattern mirrors `TerminalManager.disposeAll()` / `fileSnapshotRegistry`.
 */
import type { ApiConfig } from "@contracts/customModel";
import { log } from "@main/lib/logger.js";
import { startBridge, type BridgeHandle } from "./bridgeServer.js";

interface Entry {
  handle: BridgeHandle;
  /** The upstream fingerprint this server was built from. */
  fingerprint: string;
  refCount: number;
}

/** A minimal fingerprint of the upstream bits that affect the running server. */
function fingerprint(cfg: ApiConfig): string {
  return JSON.stringify({
    baseUrl: cfg.baseUrl,
    protocol: cfg.protocol,
    authToken: cfg.authToken,
    authMode: cfg.authMode,
    timeoutMs: cfg.timeoutMs ?? null,
    // Headers are baked into every upstream request this server makes, so an
    // edit that doesn't rebuild would keep sending the OLD set for the rest of
    // the bridge's life (it outlives the turn that created it).
    customHeaders: cfg.customHeaders ?? null,
  });
}

class BridgeRegistryImpl {
  /**
   * Keep old and new revisions alive at the same time. A provider can be
   * edited while a turn is using its bridge; replacing the entry in place
   * would close the old listener underneath that turn.
   */
  private entries = new Map<string, Map<string, Entry>>();

  private entriesFor(customModelId: string): Map<string, Entry> {
    let entries = this.entries.get(customModelId);
    if (!entries) {
      entries = new Map<string, Entry>();
      this.entries.set(customModelId, entries);
    }
    return entries;
  }

  /** Whether a caller already holds the bridge for this exact config. */
  matches(customModelId: string, upstream: ApiConfig, localUrl: string): boolean {
    const fp = fingerprint(upstream);
    return this.entries.get(customModelId)?.get(fp)?.handle.localUrl === localUrl;
  }

  /** Acquire a bridge for the given config revision. Always bumps the ref
   *  count for the caller, who MUST pair this with {@link release}. */
  async acquire(customModelId: string, upstream: ApiConfig): Promise<BridgeHandle> {
    const fp = fingerprint(upstream);
    const entries = this.entriesFor(customModelId);
    const existing = entries.get(fp);
    if (existing) {
      existing.refCount += 1;
      return existing.handle;
    }
    // A different fingerprint is intentionally not destructive. Existing
    // turns keep their old listener; new turns receive this fresh revision.
    if (entries.size > 0) log.info(`bridge: config ${customModelId} changed, starting a new server revision`);
    const handle = await startBridge(upstream);
    entries.set(fp, { handle, fingerprint: fp, refCount: 1 });
    return handle;
  }

  /** Release a previously-acquired bridge. Decrements the ref count; closes the
   *  server only when the last holder releases. Safe to call without a prior
   *  acquire (no-op). */
  release(customModelId: string, localUrl: string): void {
    const entries = this.entries.get(customModelId);
    if (!entries) return;
    let entry: Entry | undefined;
    let entryKey: string | undefined;
    for (const [key, candidate] of entries) {
      if (candidate.handle.localUrl === localUrl) {
        entryKey = key;
        entry = candidate;
        break;
      }
    }
    if (!entry || !entryKey) return;
    entry.refCount -= 1;
    if (entry.refCount <= 0) {
      entry.handle.close();
      entries.delete(entryKey);
      if (entries.size === 0) this.entries.delete(customModelId);
    }
  }

  /** Close every bridge, regardless of ref count. Called at app shutdown. */
  disposeAll(): void {
    for (const entries of this.entries.values()) {
      for (const entry of entries.values()) entry.handle.close();
    }
    this.entries.clear();
  }
}

export const BridgeRegistry = new BridgeRegistryImpl();
