import type { IpcMain } from "electron";
import {
  IPC,
  SharedProviderDiscoverInputSchema,
  SharedProviderRemoveInputSchema,
  SharedProviderSaveInputSchema,
} from "@contracts/ipc";
import { discoverSharedProviderModels } from "@main/lib/sharedProviderDiscovery.js";
import { SharedProviderStore } from "@main/lib/sharedProviderStore.js";
import { engineFetch } from "@main/network/engineProxy.js";

export function registerSharedProviderHandlers(ipcMain: IpcMain): void {
  ipcMain.handle(IPC.SHARED_PROVIDERS_LIST, async () => ({
    providers: SharedProviderStore.listPublic(),
  }));
  ipcMain.handle(IPC.SHARED_PROVIDERS_SAVE, async (_event, raw) => {
    return { providers: SharedProviderStore.save(SharedProviderSaveInputSchema.parse(raw)) };
  });
  ipcMain.handle(IPC.SHARED_PROVIDERS_REMOVE, async (_event, raw) => {
    return { providers: SharedProviderStore.remove(SharedProviderRemoveInputSchema.parse(raw).id) };
  });
  // Route through 设置 → 网络 like the engines do. Node's global fetch in the
  // main process never uses a proxy, so behind a proxy (typical for overseas
  // gateways from mainland China) discovery just timed out after 12s.
  ipcMain.handle(IPC.SHARED_PROVIDERS_DISCOVER_MODELS, async (_event, raw) =>
    discoverSharedProviderModels(SharedProviderDiscoverInputSchema.parse(raw), {
      fetch: (input, init) => engineFetch(String(input), init ?? {}),
    }));
}
