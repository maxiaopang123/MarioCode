/** Independent stdio MCP server; no DB, Electron or credentials. Execution
 *  stays in MarioCode's authenticated per-turn broker, including approval. */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
const server=new Server({name:"mariocode-mcp-ssh",version:"1.0.0"},{capabilities:{tools:{}}});
server.setRequestHandler(ListToolsRequestSchema,async()=>({tools:[
  {name:"ssh_hosts",description:"List configured SSH host aliases, address, user and port. Never returns credentials.",inputSchema:{type:"object",properties:{},additionalProperties:false}},
  {name:"ssh_exec",description:"Execute a command on a configured SSH host alias. Requires user approval every time; blocked during unattended runs. Output capped at 64 KiB; timeout 1–120 seconds.",inputSchema:{type:"object",properties:{host:{type:"string"},command:{type:"string"},timeoutSec:{type:"integer",minimum:1,maximum:120}},required:["host","command"],additionalProperties:false}},
]}));
server.setRequestHandler(CallToolRequestSchema,async (request, extra)=>{
  try {
    if(!["ssh_hosts","ssh_exec"].includes(request.params.name))throw new Error("SSH_TOOL_UNKNOWN");
    const url=process.env.MARIOCODE_SSH_BROKER_URL;const token=process.env.MARIOCODE_MCP_SESSION_TOKEN;
    if(!url||!/^http:\/\/127\.0\.0\.1:\d+\/ssh$/.test(url)||!token)throw new Error("SSH_MARIOCODE_REQUIRED");
    const response=await fetch(url,{method:"POST",headers:{authorization:`Bearer ${token}`,"content-type":"application/json"},body:JSON.stringify({name:request.params.name,args:request.params.arguments??{}}),signal:AbortSignal.any([extra.signal,AbortSignal.timeout(600000)])});
    if(!response.ok)throw new Error("SSH_BROKER_REJECTED");
    const result:unknown=await response.json();
    return {isError:!!(result&&typeof result==="object"&&"error" in result),content:[{type:"text",text:JSON.stringify(result)}]};
  } catch(error) {
    // Constant messages only: transport errors can include sensitive URLs.
    const message=error instanceof Error&&/^SSH_[A-Z_]+$/.test(error.message)?error.message:"SSH_REQUEST_FAILED";
    return {isError:true,content:[{type:"text",text:message}]};
  }
});
await server.connect(new StdioServerTransport());
