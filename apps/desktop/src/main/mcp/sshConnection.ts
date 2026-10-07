import { createHash } from "node:crypto";
import { Client } from "ssh2";
import type { SshAddress, SshExecInput, SshHostPublic } from "@contracts/ssh";
export interface SshCredential { password?:string; privateKey?:string; passphrase?:string }
export const sshFingerprint=(key:Buffer):string=>`SHA256:${createHash("sha256").update(key).digest("base64").replace(/=+$/g,"")}`;
const socketHost = (host:string):string => host.replace(/^\[([^\]]+)\]$/, "$1");
export async function probeSshFingerprint(address:SshAddress):Promise<string> {
  return new Promise((resolve,reject)=>{
    const client=new Client(); let finished=false;
    const timer=setTimeout(()=>finish(),7000);
    const finish=(fingerprint?:string):void=>{
      if(finished)return;finished=true;clearTimeout(timer);client.destroy();
      fingerprint ? resolve(fingerprint) : reject(new Error("SSH_FINGERPRINT_FAILED"));
    };
    client.on("error",()=>finish()); client.on("close",()=>finish());
    try { client.connect({...address,host:socketHost(address.host),username:"fingerprint-probe",readyTimeout:5000,
      hostVerifier:(key:Buffer)=>{finish(sshFingerprint(key));return false;}}); }
    catch { finish(); }
  });
}
export function executeSsh(host:SshHostPublic,credential:SshCredential,input:SshExecInput,signal:AbortSignal):Promise<{stdout:string;stderr:string;exitCode:number|null;truncated:boolean}> {
  return new Promise((resolve,reject)=>{
    const client=new Client(); let finished=false; let fingerprintMismatch=false;
    let size=0; let truncated=false; const stdout:Buffer[]=[];const stderr:Buffer[]=[];
    const limit=65536;
    const capture=(chunks:Buffer[],chunk:Buffer|string):void=>{
      const bytes=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);
      const remaining=Math.max(0,limit-size); if(bytes.length>remaining)truncated=true;
      if(remaining>0){const piece=bytes.subarray(0,remaining);chunks.push(piece);size+=piece.length;}
    };
    const finish=(error?:string,code:number|null=null):void=>{
      if(finished)return;finished=true;clearTimeout(timer);signal.removeEventListener("abort",abort);client.destroy();
      if(error)reject(new Error(error));else resolve({stdout:Buffer.concat(stdout).toString("utf8"),stderr:Buffer.concat(stderr).toString("utf8"),exitCode:code,truncated});
    };
    const abort=():void=>finish("SSH_CANCELLED");
    const timer=setTimeout(()=>finish("SSH_TIMEOUT"),input.timeoutSec*1000);
    signal.addEventListener("abort",abort,{once:true}); if(signal.aborted){abort();return;}
    client.on("error",()=>finish(fingerprintMismatch?"SSH_FINGERPRINT_CHANGED":"SSH_CONNECTION_FAILED"));
    client.on("close",()=>{if(!finished)finish("SSH_CONNECTION_CLOSED");});
    client.on("ready",()=>client.exec(input.command,(error,stream)=>{
      if(error){finish("SSH_EXEC_FAILED");return;}
      stream.on("data",(chunk:Buffer)=>capture(stdout,chunk));stream.stderr.on("data",(chunk:Buffer)=>capture(stderr,chunk));
      stream.on("error",()=>finish("SSH_EXEC_FAILED"));
      stream.on("close",(code:number|undefined)=>finish(undefined,typeof code==="number"?code:null));
    }));
    try {client.connect({host:socketHost(host.host),port:host.port,username:host.username,...credential,readyTimeout:Math.min(10000,input.timeoutSec*1000),
      hostVerifier:(key:Buffer)=>{fingerprintMismatch=sshFingerprint(key)!==host.fingerprint;return !fingerprintMismatch;}});}
    catch {finish("SSH_CONNECTION_FAILED");}
  });
}
