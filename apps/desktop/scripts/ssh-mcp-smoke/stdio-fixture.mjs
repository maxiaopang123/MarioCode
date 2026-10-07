import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
const server = new Server({ name: "generic-fixture", version: "1" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: "echo", description: "Echo fixture", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } }] }));
server.setRequestHandler(CallToolRequestSchema, async req => ({ content: [{ type: "text", text: JSON.stringify({ text: req.params.arguments?.text, leakedSshToken: !!process.env.MARIOCODE_MCP_SESSION_TOKEN }) }] }));
await server.connect(new StdioServerTransport());
