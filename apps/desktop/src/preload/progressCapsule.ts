import { contextBridge, ipcRenderer } from "electron";
import { IPC, type ProgressCapsuleApi, type ProgressCapsuleState } from "@contracts/ipc";

const api: ProgressCapsuleApi = {
  getState: () => ipcRenderer.invoke(IPC.PROGRESS_CAPSULE_READ, {}),
  openSession: (sessionId) => ipcRenderer.invoke(IPC.PROGRESS_CAPSULE_OPEN, { sessionId }),
  setExpanded: (expanded) => ipcRenderer.invoke(IPC.PROGRESS_CAPSULE_VIEW, { expanded }),
  onState: (fn) => {
    const listener = (_event: Electron.IpcRendererEvent, state: ProgressCapsuleState) => fn(state);
    ipcRenderer.on(IPC.PROGRESS_CAPSULE_STATE, listener);
    return () => ipcRenderer.removeListener(IPC.PROGRESS_CAPSULE_STATE, listener);
  },
};
contextBridge.exposeInMainWorld("api", api);
