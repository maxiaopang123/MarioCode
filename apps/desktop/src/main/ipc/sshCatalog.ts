import type { IpcMain } from "electron";
import { IPC,SshHostSaveSchema,SshAddressSchema,SshHostIdSchema,SshEnabledSchema } from "@contracts/ipc";
import { sshCatalogState,saveSshHost,removeSshHost,observeSshFingerprint } from "@main/mcp/sshStore.js";
import { syncSshCatalog } from "@main/mcp/sshCatalog.js";
export function registerSshCatalogHandlers(ipc:IpcMain):void {
  ipc.handle(IPC.SSH_CATALOG_GET,()=>sshCatalogState());
  ipc.handle(IPC.SSH_CATALOG_SET_ENABLED,async(_e,raw)=>{await syncSshCatalog(SshEnabledSchema.parse(raw).enabled);return sshCatalogState();});
  ipc.handle(IPC.SSH_CATALOG_SAVE_HOST,(_e,raw)=>{saveSshHost(SshHostSaveSchema.parse(raw));return sshCatalogState();});
  ipc.handle(IPC.SSH_CATALOG_REMOVE_HOST,(_e,raw)=>{removeSshHost(SshHostIdSchema.parse(raw).id);return sshCatalogState();});
  ipc.handle(IPC.SSH_CATALOG_FINGERPRINT,(_e,raw)=>observeSshFingerprint(SshAddressSchema.parse(raw)));
}
