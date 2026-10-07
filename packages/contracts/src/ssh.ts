import { z } from "zod";
export const SSH_MCP_SERVER_NAME = "mariocode-mcp-ssh";
export function isSshMcpTool(name: string): boolean {
  return name === `mcp__${SSH_MCP_SERVER_NAME}__ssh_hosts` || name === `mcp__${SSH_MCP_SERVER_NAME}__ssh_exec`;
}
export const SshAddressSchema = z.object({
  host:z.string().trim().min(1).max(253).regex(/^[a-zA-Z0-9.:[\]_-]+$/),
  port:z.number().int().min(1).max(65535).default(22),
}).strict();
export const SshHostSaveSchema = SshAddressSchema.extend({
  id:z.string().uuid().optional(),
  alias:z.string().trim().min(1).max(64).regex(/^[a-zA-Z0-9_-]+$/),
  username:z.string().trim().min(1).max(128),
  authentication:z.enum(["password","privateKey"]),
  fingerprint:z.string().regex(/^SHA256:[A-Za-z0-9+/]{43}$/),
  password:z.string().max(4096).optional(),
  privateKey:z.string().max(65536).optional(),
  passphrase:z.string().max(4096).optional(),
}).strict();
export type SshHostSaveInput=z.infer<typeof SshHostSaveSchema>;
export type SshAddress=z.infer<typeof SshAddressSchema>;
export interface SshHostPublic extends SshAddress {
  id:string; alias:string; username:string; authentication:"password"|"privateKey"; fingerprint:string; hasCredential:boolean;
}
export interface SshCatalogState { enabled:boolean; hosts:SshHostPublic[] }
export const SshHostIdSchema=z.object({id:z.string().uuid()}).strict();
export const SshEnabledSchema=z.object({enabled:z.boolean()}).strict();
export const SshExecSchema=z.object({host:z.string().min(1).max(64),command:z.string().min(1).max(16384),timeoutSec:z.number().int().min(1).max(120).default(30)}).strict();
export type SshExecInput=z.infer<typeof SshExecSchema>;
