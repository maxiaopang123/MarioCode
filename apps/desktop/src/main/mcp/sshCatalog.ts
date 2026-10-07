import { app } from "electron";
import { join } from "node:path";
import { SSH_MCP_SERVER_NAME } from "@contracts/ssh";
import type { McpServerConfig } from "@contracts/ipc";
import { mcpServersOf, readUserClaudeJson, writeUserClaudeJson } from "@main/lib/mcpConfig.js";
import { sshCatalogState, setSshEnabled } from "./sshStore.js";
export function sshMcpConfig(): Extract<McpServerConfig, { command: string }> {
  return {command:process.execPath,args:[app.isPackaged?join(process.resourcesPath,"mcp",SSH_MCP_SERVER_NAME,"stdio.mjs"):join(__dirname,"..","mcp",SSH_MCP_SERVER_NAME,"stdio.mjs")],env:{ELECTRON_RUN_AS_NODE:"1"},env_vars:["MARIOCODE_SSH_BROKER_URL","MARIOCODE_MCP_SESSION_TOKEN"],tool_timeout_sec:600,"x-mariocode-catalog":"ssh"};
}
let tail:Promise<unknown>=Promise.resolve();
export function syncSshCatalog(enabled?:boolean):Promise<void> {
  const task=tail.then(async()=>{
    const on=enabled??sshCatalogState().enabled;
    const cfg=await readUserClaudeJson();const servers={...mcpServersOf(cfg)};
    const previous=servers[SSH_MCP_SERVER_NAME];
    const owned=previous&&typeof previous==="object"&&(previous as Record<string,unknown>)["x-mariocode-catalog"]==="ssh";
    if(previous&&!owned)throw new Error("SSH_NAME_CONFLICT");
    if(on){servers[SSH_MCP_SERVER_NAME]=sshMcpConfig();}
    else if(owned)delete servers[SSH_MCP_SERVER_NAME];
    if(JSON.stringify(cfg.mcpServers??{})!==JSON.stringify(servers))await writeUserClaudeJson({...cfg,mcpServers:servers});
    if(enabled!==undefined)setSshEnabled(enabled);
  });
  tail=task.catch(()=>{});return task;
}
