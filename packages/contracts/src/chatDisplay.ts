import { z } from "zod";

export const CHAT_DISPLAY_SETTING_KEY = "ui.chatDisplay";
export const ChatDisplaySchema = z.object({
  remoteImages: z.enum(["never", "trusted", "always"]).default("never"),
  trustedDomains: z.array(z.string().trim().max(253)).max(100).default([]),
  prosePaths: z.boolean().default(true),
});
export type ChatDisplay = z.infer<typeof ChatDisplaySchema>;
export const DEFAULT_CHAT_DISPLAY: ChatDisplay = ChatDisplaySchema.parse({});

export function parseChatDisplay(raw: string | null | undefined): ChatDisplay {
  try { return ChatDisplaySchema.parse(JSON.parse(raw ?? "{}")); }
  catch { return DEFAULT_CHAT_DISPLAY; }
}
