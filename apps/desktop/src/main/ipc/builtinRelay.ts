import type { IpcMain } from "electron";
import {
  IPC,
  BuiltinRelayAccountQuerySchema,
  BuiltinRelayPushInputSchema,
  BuiltinRelayUnlockInputSchema,
} from "@contracts/ipc";
import { RelayConfigStore } from "@main/lib/relayConfigStore.js";
import { RelayAccountStore } from "@main/lib/relayAccountStore.js";
import { engineFetch } from "@main/network/engineProxy.js";

/**
 * Built-in relay IPC (TODO-074).
 *
 * Two audiences on one channel family:
 *   - the user panel reads `status` / `refresh` and saves its personal key
 *     through the ordinary `sharedProviders.save` path;
 *   - 设置 → 关于 (admin) unlocks with the gateway's admin password, pulls the
 *     relay's model inventory and pushes the reviewed list.
 *
 * Network calls go through `engineFetch` for the same reason model discovery
 * does: the main process's global fetch ignores 设置 → 网络, and the relay is
 * expected to be directly reachable but may still sit behind a proxy.
 */
export function registerBuiltinRelayHandlers(ipcMain: IpcMain): void {
  ipcMain.handle(IPC.BUILTIN_RELAY_STATUS, async () => RelayConfigStore.currentStatus());
  ipcMain.handle(IPC.BUILTIN_RELAY_REFRESH, async () =>
    RelayConfigStore.refresh({ fetch: (input, init) => engineFetch(String(input), init ?? {}) }));
  ipcMain.handle(IPC.BUILTIN_RELAY_UNLOCK, async (_event, raw) =>
    RelayConfigStore.unlock(BuiltinRelayUnlockInputSchema.parse(raw).token, {
      fetch: (input, init) => engineFetch(String(input), init ?? {}),
    }));
  ipcMain.handle(IPC.BUILTIN_RELAY_LOCK, async () => RelayConfigStore.lock());
  ipcMain.handle(IPC.BUILTIN_RELAY_PUSH, async (_event, raw) =>
    RelayConfigStore.push(BuiltinRelayPushInputSchema.parse(raw).config, {
      fetch: (input, init) => engineFetch(String(input), init ?? {}),
    }));
  // "从中转站拉取": the relay's own inventory, so models no longer have to be
  // typed in by hand. Same transport as push (both talk to the config service).
  ipcMain.handle(IPC.BUILTIN_RELAY_PULL, async () =>
    RelayConfigStore.pull({ fetch: (input, init) => engineFetch(String(input), init ?? {}) }));
  // Balance/usage goes out on Node's fetch, NOT engineFetch: the gateway
  // rejects any request carrying a foreign Origin header (including
  // "null", which Chromium's stack sends), and engineFetch swaps to Chromium
  // behind a proxy. See the note at the top of relayAccountStore.
  ipcMain.handle(IPC.BUILTIN_RELAY_ACCOUNT, async (_event, raw) =>
    RelayAccountStore.fetchAccount({ noCache: BuiltinRelayAccountQuerySchema.parse(raw)?.force === true }));
}
