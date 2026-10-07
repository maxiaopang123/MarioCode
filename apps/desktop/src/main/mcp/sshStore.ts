import { randomUUID } from "node:crypto";
import { safeStorage } from "electron";
import { SshHostSaveSchema, type SshCatalogState, type SshHostPublic, type SshHostSaveInput, type SshAddress } from "@contracts/ssh";
import { SettingRepo } from "@main/store/repositories.js";
import { getDb } from "@main/store/db.js";
import { probeSshFingerprint, type SshCredential } from "./sshConnection.js";
const META_KEY="mcp.catalog.ssh";const SECRET_KEY="mcp.catalog.ssh.keys";
type Metadata=Omit<SshHostPublic,"hasCredential">;
const observed=new Map<string,{fingerprint:string;time:number}>();
const addressKey=(v:SshAddress):string=>`${v.host.toLowerCase()}:${v.port}`;
function metadata():{enabled:boolean;hosts:Metadata[]} {
  const raw:unknown=JSON.parse(SettingRepo.get(META_KEY)??'{"enabled":false,"hosts":[]}');
  if(!raw||typeof raw!=="object")throw new Error("SSH_CONFIG_INVALID");
  const cfg=raw as {enabled?:unknown;hosts?:unknown};
  if(!Array.isArray(cfg.hosts))throw new Error("SSH_CONFIG_INVALID");
  const hosts=cfg.hosts.map(value=>{
    const parsed=SshHostSaveSchema.parse(value); if(!parsed.id)throw new Error("SSH_CONFIG_INVALID");
    const {password:_p,privateKey:_k,passphrase:_s,...meta}=parsed;return {...meta,id:parsed.id};
  });
  return {enabled:cfg.enabled===true,hosts};
}
function ciphers():Record<string,string> {
  const raw:unknown=JSON.parse(SettingRepo.get(SECRET_KEY)??"{}");
  if(!raw||typeof raw!=="object"||Array.isArray(raw))throw new Error("SSH_CONFIG_INVALID");
  return Object.fromEntries(Object.entries(raw).filter((pair):pair is [string,string]=>typeof pair[1]==="string"));
}
export function sshCredential(id:string):SshCredential|null {
  const cipher=ciphers()[id];if(!cipher||!safeStorage.isEncryptionAvailable())return null;
  try {const raw:unknown=JSON.parse(safeStorage.decryptString(Buffer.from(cipher,"base64")));
    if(!raw||typeof raw!=="object")return null;
    const v=raw as SshCredential;
    return (typeof v.password==="string"||typeof v.privateKey==="string") ? {password:v.password,privateKey:v.privateKey,passphrase:v.passphrase} : null;
  } catch{return null;}
}
export function sshCatalogState():SshCatalogState {
  const cfg=metadata();return {...cfg,hosts:cfg.hosts.map(h=>({...h,hasCredential:sshCredential(h.id)!==null}))};
}
export async function observeSshFingerprint(address:SshAddress):Promise<{fingerprint:string}> {
  const fingerprint=await probeSshFingerprint(address);observed.set(addressKey(address),{fingerprint,time:Date.now()});return {fingerprint};
}
export function saveSshHost(raw:SshHostSaveInput):void {
  const value=SshHostSaveSchema.parse(raw);const cfg=metadata();const keys=ciphers();
  const id=value.id??randomUUID();const previous=cfg.hosts.find(h=>h.id===id);
  if(value.id&&!previous)throw new Error("SSH_HOST_MISSING");
  if(cfg.hosts.some(h=>h.id!==id&&h.alias===value.alias))throw new Error("SSH_ALIAS_DUPLICATE");
  const observation=observed.get(addressKey(value));
  const keepsPin=previous&&addressKey(previous)===addressKey(value)&&previous.fingerprint===value.fingerprint;
  if(!keepsPin&&(!observation||Date.now()-observation.time>10*60_000||observation.fingerprint!==value.fingerprint))throw new Error("SSH_CONFIRM_FINGERPRINT");
  const supplied=value.authentication==="password"?Boolean(value.password):Boolean(value.privateKey);
  const sameIdentity=previous&&addressKey(previous)===addressKey(value)&&previous.username===value.username&&previous.authentication===value.authentication;
  if(supplied){
    if(!safeStorage.isEncryptionAvailable())throw new Error("SSH_SECURE_STORAGE_UNAVAILABLE");
    const secret:SshCredential=value.authentication==="password"?{password:value.password}:{privateKey:value.privateKey,passphrase:value.passphrase};
    keys[id]=safeStorage.encryptString(JSON.stringify(secret)).toString("base64");
  } else if(!sameIdentity||!sshCredential(id))throw new Error("SSH_CREDENTIAL_REQUIRED");
  const {password:_p,privateKey:_k,passphrase:_s,...meta}=value;
  cfg.hosts=cfg.hosts.filter(h=>h.id!==id);cfg.hosts.push({...meta,id});
  getDb().transaction(()=>{SettingRepo.set(META_KEY,JSON.stringify(cfg));SettingRepo.set(SECRET_KEY,JSON.stringify(keys));})();
}
export function removeSshHost(id:string):void {
  const cfg=metadata();cfg.hosts=cfg.hosts.filter(h=>h.id!==id);const keys=ciphers();delete keys[id];
  getDb().transaction(()=>{SettingRepo.set(META_KEY,JSON.stringify(cfg));SettingRepo.set(SECRET_KEY,JSON.stringify(keys));})();
}
export function setSshEnabled(enabled:boolean):void {SettingRepo.set(META_KEY,JSON.stringify({...metadata(),enabled}));}
