import type { IpcMain } from "electron";
import {
  IPC,
  ScheduledTaskCreateSchema,
  ScheduledTaskUpdateSchema,
  ScheduledTaskIdSchema,
  ScheduledTaskSetEnabledSchema,
} from "@contracts/ipc";
import { schedulerService } from "@main/scheduler/SchedulerService.js";

export function registerSchedulerHandlers(ipcMain: IpcMain): void {
  ipcMain.handle(IPC.SCHEDULER_LIST, () => ({ tasks: schedulerService.list() }));
  ipcMain.handle(IPC.SCHEDULER_CREATE, (_event, raw) => ({
    task: schedulerService.create(ScheduledTaskCreateSchema.parse(raw)),
  }));
  ipcMain.handle(IPC.SCHEDULER_UPDATE, (_event, raw) => {
    const input = ScheduledTaskUpdateSchema.parse(raw);
    return { task: schedulerService.update(input.id, input) };
  });
  ipcMain.handle(IPC.SCHEDULER_DELETE, (_event, raw) => {
    const input = ScheduledTaskIdSchema.parse(raw);
    schedulerService.delete(input.id);
  });
  ipcMain.handle(IPC.SCHEDULER_RUN_NOW, async (_event, raw) => {
    const input = ScheduledTaskIdSchema.parse(raw);
    return { task: await schedulerService.runNow(input.id) };
  });
  ipcMain.handle(IPC.SCHEDULER_SET_ENABLED, (_event, raw) => {
    const input = ScheduledTaskSetEnabledSchema.parse(raw);
    return { task: schedulerService.setEnabled(input.id, input.enabled) };
  });
}
