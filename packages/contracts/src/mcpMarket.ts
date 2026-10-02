import type { McpServerConfig } from "./ipc.js";

/** Curated configurations verified against the publishers' documentation. */
export const MCP_MARKET_IDS = ["context7", "github", "notion", "playwright", "filesystem", "memory"] as const;
export type McpMarketId = typeof MCP_MARKET_IDS[number];
export interface McpMarketTemplate {
  id: McpMarketId;
  name: string;
  publisher: string;
  docsUrl: string;
  auth: "optional-key" | "token" | "oauth" | "path" | "none";
}
export const MCP_MARKET: readonly McpMarketTemplate[] = [
  { id: "context7", name: "Context7", publisher: "Upstash", docsUrl: "https://context7.com/docs/resources/all-clients", auth: "optional-key" },
  { id: "github", name: "GitHub", publisher: "GitHub", docsUrl: "https://github.com/github/github-mcp-server", auth: "token" },
  { id: "notion", name: "Notion", publisher: "Notion", docsUrl: "https://developers.notion.com/guides/mcp/get-started-with-mcp", auth: "oauth" },
  { id: "playwright", name: "Playwright", publisher: "Microsoft", docsUrl: "https://github.com/microsoft/playwright-mcp", auth: "none" },
  { id: "filesystem", name: "Filesystem", publisher: "Model Context Protocol", docsUrl: "https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem", auth: "path" },
  { id: "memory", name: "Memory", publisher: "Model Context Protocol", docsUrl: "https://github.com/modelcontextprotocol/servers/tree/main/src/memory", auth: "none" },
];

/** No process starts when adding a template; the engines load it next turn. */
export function buildMcpMarketConfig(id: McpMarketId, credential = "", directory = ""): McpServerConfig {
  const key = credential.trim();
  switch (id) {
    case "context7": return { type: "http", url: "https://mcp.context7.com/mcp", ...(key ? { headers: { Authorization: `Bearer ${key}` } } : {}) };
    case "github":
      if (!key) throw new Error("GitHub Personal Access Token is required");
      return { type: "http", url: "https://api.githubcopilot.com/mcp/", headers: { Authorization: `Bearer ${key}` } };
    case "notion": return { type: "http", url: "https://mcp.notion.com/mcp" };
    case "playwright": return { type: "stdio", command: "npx", args: ["-y", "@playwright/mcp@latest"] };
    case "filesystem":
      if (!directory.trim()) throw new Error("An allowed directory is required");
      return { type: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", directory.trim()] };
    case "memory": return { type: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-memory"] };
  }
}
