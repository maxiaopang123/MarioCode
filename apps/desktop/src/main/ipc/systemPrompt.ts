/**
 * IPC handlers for the settings panel's unified system prompt (TODO-006).
 * Three operations: read / write the project-scope file
 * (`<project>/.mcode/prompt.md`) and compose the layered preview for one
 * provider. The global scope needs no handler of its own — it rides the
 * generic setting.get/set channels under AGENT_SYSTEM_PROMPT_GLOBAL_SETTING_KEY
 * and is read per turn by every provider through `loadUserSystemPrompt`.
 */
import type { IpcMain } from "electron";
import {
  IPC,
  SystemPromptPreviewSchema,
  SystemPromptReadProjectSchema,
  SystemPromptWriteProjectSchema,
} from "@contracts/ipc";
import { readProjectPrompt, writeProjectPrompt } from "@main/lib/userSystemPrompt.js";
import { previewSystemPrompt } from "@main/lib/systemPromptPreview.js";

export function registerSystemPromptHandlers(ipcMain: IpcMain): void {
  ipcMain.handle(IPC.SYSTEM_PROMPT_READ_PROJECT, (_evt, raw) => {
    const input = SystemPromptReadProjectSchema.parse(raw);
    return readProjectPrompt(input.projectPath);
  });

  ipcMain.handle(IPC.SYSTEM_PROMPT_WRITE_PROJECT, (_evt, raw) => {
    const input = SystemPromptWriteProjectSchema.parse(raw);
    return writeProjectPrompt(input.projectPath, input.content);
  });

  ipcMain.handle(IPC.SYSTEM_PROMPT_PREVIEW, (_evt, raw) => {
    const input = SystemPromptPreviewSchema.parse(raw);
    return previewSystemPrompt(input.providerId, input.projectPath);
  });
}
