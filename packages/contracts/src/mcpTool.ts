/** Serializable tool metadata; connection credentials remain main-side. */
export interface McpToolSpec {
  name: string;
  label: string;
  description: string;
  inputSchema: { type: "object"; properties?: Record<string, unknown>; required?: string[]; [key: string]: unknown };
}
export interface McpToolResult {
  content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>;
  isError?: boolean;
}
