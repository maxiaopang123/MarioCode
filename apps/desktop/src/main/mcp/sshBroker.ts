import { randomBytes,randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { z } from "zod";
import type { ProviderContext } from "@contracts/provider";
import { SshExecSchema } from "@contracts/ssh";
import { isUnattendedSession } from "@main/tools/unattended.js";
import { sshCatalogState,sshCredential } from "./sshStore.js";
import { executeSsh } from "./sshConnection.js";
import { syncSshCatalog } from "./sshCatalog.js";
interface Binding {sessionId:string;ctx:ProviderContext;controller:AbortController}
const bindings=new Map<string,Binding>();let server:Server|undefined;let starting:Promise<number>|undefined;let active=0;
const CallSchema=z.object({name:z.enum(["ssh_hosts","ssh_exec"]),args:z.unknown()}).strict();
async function brokerPort():Promise<number> {
  if(starting)return starting;
  starting=new Promise((resolve,reject)=>{
    server=createServer((req,res)=>{
      const token=req.headers.authorization?.replace(/^Bearer /,"");const binding=token?bindings.get(token):undefined;
      if(req.method!=="POST"||req.url!=="/ssh"||!binding){res.writeHead(403);res.end();return;}
      const controller=new AbortController();
      const abort=():void=>controller.abort();binding.controller.signal.addEventListener("abort",abort,{once:true});
      res.on("close",()=>{if(!res.writableEnded)controller.abort();});
      let size=0;const chunks:Buffer[]=[];
      req.on("error",()=>controller.abort());
      req.on("data",(chunk:Buffer)=>{size+=chunk.length;if(size>98304){res.writeHead(413);res.end();req.destroy();}else chunks.push(chunk);});
      req.on("end",()=>{
        void (async()=>{
          if(size>98304||controller.signal.aborted)throw new Error("SSH_CANCELLED");
          const call=CallSchema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
          const state=sshCatalogState();if(!state.enabled)throw new Error("SSH_DISABLED");
          if(call.name==="ssh_hosts")return state.hosts.map(h=>({alias:h.alias,host:h.host,port:h.port,username:h.username}));
          if(isUnattendedSession(binding.sessionId))throw new Error("SSH_UNATTENDED_DENIED");
          const input=SshExecSchema.parse(call.args);const host=state.hosts.find(h=>h.alias===input.host);
          if(!host||!host.hasCredential)throw new Error("SSH_HOST_UNAVAILABLE");
          if(!binding.ctx.requestApproval)throw new Error("SSH_APPROVAL_REQUIRED");
          const decision=await binding.ctx.requestApproval({requestId:randomUUID(),toolName:"ssh_exec",input:{...input,address:`${host.username}@${host.host}:${host.port}`,fingerprint:host.fingerprint},oneShotOnly:true});
          if(!decision.allow)throw new Error("SSH_USER_DENIED");
          if(controller.signal.aborted||!sshCatalogState().enabled||isUnattendedSession(binding.sessionId))throw new Error("SSH_CANCELLED");
          const current=sshCatalogState().hosts.find(h=>h.id===host.id);
          if(!current||JSON.stringify(current)!==JSON.stringify(host))throw new Error("SSH_HOST_CHANGED");
          const credential=sshCredential(host.id);if(!credential)throw new Error("SSH_HOST_UNAVAILABLE");
          if(active>=3)throw new Error("SSH_BUSY");active++;
          try{return await executeSsh(host,credential,input,controller.signal);}finally{active--;}
        })().then(value=>{
          if(!res.destroyed){res.writeHead(200,{"content-type":"application/json","cache-control":"no-store"});res.end(JSON.stringify(value));}
        }).catch(error=>{
          if(!res.destroyed){const code=error instanceof Error&&/^SSH_[A-Z_]+$/.test(error.message)?error.message:"SSH_REQUEST_INVALID";res.writeHead(200,{"content-type":"application/json","cache-control":"no-store"});res.end(JSON.stringify({error:code}));}
        }).finally(()=>binding.controller.signal.removeEventListener("abort",abort));
      });
    });
    server.once("error",()=>{starting=undefined;reject(new Error("SSH_BROKER_FAILED"));});
    server.listen(0,"127.0.0.1",()=>{const address=server!.address();if(!address||typeof address==="string")reject(new Error("SSH_BROKER_FAILED"));else resolve(address.port);});
  });return starting;
}
/** Per-turn capability; not written to any file. Revocation also closes TCP
 *  command execution. Credential values never leave the main process. */
export async function bindSshTurn(sessionId:string,ctx:ProviderContext):Promise<{env:Record<string,string>;dispose():void}> {
  await syncSshCatalog();
  if(!sshCatalogState().enabled)return {env:{},dispose:()=>{}};
  const port=await brokerPort();const token=randomBytes(32).toString("hex");const controller=new AbortController();bindings.set(token,{sessionId,ctx,controller});
  return {env:{MARIOCODE_SSH_BROKER_URL:`http://127.0.0.1:${port}/ssh`,MARIOCODE_MCP_SESSION_TOKEN:token},dispose:()=>{bindings.delete(token);controller.abort();}};
}
export function stopSshBroker():void {for(const b of bindings.values())b.controller.abort();bindings.clear();server?.closeAllConnections();server?.close();server=undefined;starting=undefined;}
