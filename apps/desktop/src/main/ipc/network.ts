/**
 * IPC for Settings → 网络: reports what the engines' network route resolves
 * to right now. The setting itself goes through the generic setting.get/set.
 */
import type { IpcMain } from "electron";
import { IPC } from "@contracts/ipc";
import { engineProxyStatus } from "@main/network/engineProxy.js";

export function registerNetworkHandlers(ipcMain: IpcMain): void {
  ipcMain.handle(IPC.NETWORK_PROXY_STATUS, () => engineProxyStatus());
}
