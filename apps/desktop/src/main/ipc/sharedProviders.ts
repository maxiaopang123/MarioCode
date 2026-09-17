import type { IpcMain } from "electron";
import {
  IPC,
  SharedProviderDiscoverInputSchema,
  SharedProviderRemoveInputSchema,
  SharedProviderSaveInputSchema,
} from "@contracts/ipc";
import { runtimeManager } from "@main/claude/RuntimeManager.js";
import { discoverSharedProviderModels } from "@main/lib/sharedProviderDiscovery.js";
import { SharedProviderStore } from "@main/lib/sharedProviderStore.js";

function assertNoRunningTurns(): void {
  const count = runtimeManager.runningSessionIds().length;
  if (count > 0) throw new Error(`${count} session(s) still have a running turn — stop them before changing shared providers`);
}

export function registerSharedProviderHandlers(ipcMain: IpcMain): void {
  ipcMain.handle(IPC.SHARED_PROVIDERS_LIST, async () => ({
    providers: SharedProviderStore.listPublic(),
  }));
  ipcMain.handle(IPC.SHARED_PROVIDERS_SAVE, async (_event, raw) => {
    assertNoRunningTurns();
    return { providers: SharedProviderStore.save(SharedProviderSaveInputSchema.parse(raw)) };
  });
  ipcMain.handle(IPC.SHARED_PROVIDERS_REMOVE, async (_event, raw) => {
    assertNoRunningTurns();
    return { providers: SharedProviderStore.remove(SharedProviderRemoveInputSchema.parse(raw).id) };
  });
  ipcMain.handle(IPC.SHARED_PROVIDERS_DISCOVER_MODELS, async (_event, raw) =>
    discoverSharedProviderModels(SharedProviderDiscoverInputSchema.parse(raw)));
}
