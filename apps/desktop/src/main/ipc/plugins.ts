/**
 * IPC handlers for the settings panel's "插件" section.
 *
 * Read the Claude CLI's plugin state and flip `enabledPlugins`. Installation
 * stays with the CLI (see main/plugins/pluginState.ts). Changes apply from the
 * next Claude turn: the CLI re-reads settings.json when it starts.
 */
import type { IpcMain } from "electron";
import { IPC, PluginsSetEnabledSchema } from "@contracts/ipc";
import { listPlugins, setPluginEnabled } from "@main/plugins/pluginState.js";

export function registerPluginsHandlers(ipcMain: IpcMain): void {
  ipcMain.handle(IPC.PLUGINS_LIST, async () => listPlugins());

  ipcMain.handle(IPC.PLUGINS_SET_ENABLED, async (_evt, raw) => {
    const input = PluginsSetEnabledSchema.parse(raw);
    return setPluginEnabled(input.id, input.enabled);
  });
}
