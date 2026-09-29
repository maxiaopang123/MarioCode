/**
 * IPC for Settings → MarioTool (mario_web_search / mario_web_fetch / mario_image_generate,
 * mario_schedule_* / mario_wechat_notify switches,
 * plus the browser_* tools' on/off switch — shared with the MCP row mariocode-browser):
 * read the page state, save config / switches / search keys, and run one
 * real search with the saved settings. Search-API keys only ever travel
 * renderer → main; image generation holds no key of its own.
 */
import type { IpcMain } from "electron";
import {
  BuiltinToolsSaveSchema,
  BuiltinToolsTestSearchSchema,
  IPC,
  WEB_SEARCH_KEYED_BACKENDS,
  type BuiltinToolsSaveResult,
  type BuiltinToolsTestSearchResult,
} from "@contracts/ipc";
import { getMcpManagement, saveMcpManagement } from "@main/lib/mcpConfig.js";
import {
  builtinToolsState,
  readBuiltinToolsConfig,
  writeBuiltinToolSecret,
  writeBuiltinToolsConfig,
} from "@main/tools/builtinToolsConfig.js";
import { runWebSearch } from "@main/tools/webSearch.js";

export function registerBuiltinToolsHandlers(ipcMain: IpcMain): void {
  ipcMain.handle(IPC.BUILTIN_TOOLS_GET, () => builtinToolsState());

  ipcMain.handle(IPC.BUILTIN_TOOLS_SAVE, async (_evt, raw): Promise<BuiltinToolsSaveResult> => {
    const input = BuiltinToolsSaveSchema.parse(raw);
    try {
      for (const id of WEB_SEARCH_KEYED_BACKENDS) {
        const value = input.keys?.[id];
        if (typeof value === "string" && !value.trim()) return { ok: false, error: "API Key 不能为空" };
      }
      if (input.config) writeBuiltinToolsConfig(input.config);
      for (const id of WEB_SEARCH_KEYED_BACKENDS) {
        const value = input.keys?.[id];
        if (value !== undefined) writeBuiltinToolSecret(id, value);
      }
      if (
        input.webToolsEnabled !== undefined ||
        input.imageToolEnabled !== undefined ||
        input.browserToolsEnabled !== undefined ||
        input.scheduleToolsEnabled !== undefined ||
        input.wechatToolEnabled !== undefined
      ) {
        const state = await getMcpManagement();
        if (input.webToolsEnabled !== undefined) state.webToolsDisabled = !input.webToolsEnabled;
        if (input.imageToolEnabled !== undefined) state.imageToolDisabled = !input.imageToolEnabled;
        if (input.scheduleToolsEnabled !== undefined) state.scheduleToolsDisabled = !input.scheduleToolsEnabled;
        if (input.wechatToolEnabled !== undefined) state.wechatToolDisabled = !input.wechatToolEnabled;
        // Same flag the MCP page's mariocode-browser row flips.
        if (input.browserToolsEnabled !== undefined) state.browserDisabled = !input.browserToolsEnabled;
        saveMcpManagement(state);
      }
      return { ok: true, state: await builtinToolsState() };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle(IPC.BUILTIN_TOOLS_TEST_SEARCH, async (_evt, raw): Promise<BuiltinToolsTestSearchResult> => {
    const { query } = BuiltinToolsTestSearchSchema.parse(raw);
    const backend = readBuiltinToolsConfig().search.backend;
    const started = Date.now();
    try {
      const outcome = await runWebSearch(query, 5, backend, { noCache: true });
      const first = outcome.hits[0];
      return {
        ok: outcome.hits.length > 0 && !outcome.fallback,
        backend: outcome.backend,
        count: outcome.hits.length,
        ...(first ? { first: { title: first.title, url: first.url } } : {}),
        ...(outcome.fallback ? { fallbackFrom: outcome.fallback.from, error: outcome.fallback.error } : {}),
        ms: Date.now() - started,
      };
    } catch (err) {
      return { ok: false, backend, count: 0, error: err instanceof Error ? err.message : String(err), ms: Date.now() - started };
    }
  });
}
