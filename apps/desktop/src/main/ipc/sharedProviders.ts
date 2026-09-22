import type { IpcMain } from "electron";
import {
  IPC,
  SharedProviderDiscoverInputSchema,
  SharedProviderRemoveInputSchema,
  SharedProviderSaveInputSchema,
} from "@contracts/ipc";
import { discoverSharedProviderModels } from "@main/lib/sharedProviderDiscovery.js";
import { SharedProviderStore } from "@main/lib/sharedProviderStore.js";

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
  ipcMain.handle(IPC.SHARED_PROVIDERS_DISCOVER_MODELS, async (_event, raw) =>
    discoverSharedProviderModels(SharedProviderDiscoverInputSchema.parse(raw)));
}
