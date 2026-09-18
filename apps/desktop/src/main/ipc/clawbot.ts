import type { IpcMain } from "electron";
import { IPC, ClawBotVerifyCodeSchema, ClawBotTestPushSchema } from "@contracts/ipc";
import { clawBotService } from "@main/clawbot/ClawBotService.js";

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
}
