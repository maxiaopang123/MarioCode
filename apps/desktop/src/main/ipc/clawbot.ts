import type { IpcMain } from "electron";
import {
  IPC,
  ClawBotChatSettingsSchema,
  ClawBotChatSettingsInputSchema,
  ClawBotVerifyCodeSchema,
  ClawBotTestPushSchema,
} from "@contracts/ipc";
import { clawBotService } from "@main/clawbot/ClawBotService.js";
import { clawBotChatGateway } from "@main/clawbot/ClawBotChatGateway.js";

export function registerClawBotHandlers(ipcMain: IpcMain): void {
  ipcMain.handle(IPC.CLAWBOT_STATUS, () => clawBotService.getStatus());
  ipcMain.handle(IPC.CLAWBOT_START_BINDING, () => clawBotService.startBinding());
  ipcMain.handle(IPC.CLAWBOT_POLL_BINDING, () => clawBotService.pollBinding());
  ipcMain.handle(IPC.CLAWBOT_SUBMIT_VERIFY_CODE, (_event, raw) => {
    const input = ClawBotVerifyCodeSchema.parse(raw);
    return clawBotService.submitVerifyCode(input.code);
  });
  ipcMain.handle(IPC.CLAWBOT_CANCEL_BINDING, () => clawBotService.cancelBinding());
  ipcMain.handle(IPC.CLAWBOT_UNBIND, () => clawBotService.unbind());
  ipcMain.handle(IPC.CLAWBOT_TEST_PUSH, (_event, raw) => {
    const input = ClawBotTestPushSchema.parse(raw ?? {});
    return clawBotService.testPush(input.text);
  });
  ipcMain.handle(IPC.CLAWBOT_GET_CHAT_SETTINGS, () =>
    ClawBotChatSettingsSchema.parse(clawBotChatGateway.getSettings()));
  ipcMain.handle(IPC.CLAWBOT_UPDATE_CHAT_SETTINGS, async (_event, raw) => {
    const input = ClawBotChatSettingsInputSchema.parse(raw);
    return ClawBotChatSettingsSchema.parse(await clawBotChatGateway.updateSettings(input));
  });
  ipcMain.handle(IPC.CLAWBOT_RESUME_CHAT, async () =>
    ClawBotChatSettingsSchema.parse(await clawBotChatGateway.resumeLatestConversation()));
}
