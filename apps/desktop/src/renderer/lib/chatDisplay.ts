import type { ChatDisplay } from "@contracts/chatDisplay";

/** Exact hostname matches only; no suffix or wildcard trust. */
export function normalizeImageDomain(value: string): string | null {
  try {
    const url = new URL(value.includes("://") ? value : `https://${value}`);
    if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) return null;
    return url.hostname.toLowerCase();
  } catch { return null; }
}

export function shouldAutoLoadImage(url: string, config: ChatDisplay): boolean {
  try {
    const parsed = new URL(url);
    if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password) return false;
    return config.remoteImages === "always" || (config.remoteImages === "trusted" &&
      config.trustedDomains.some(domain => normalizeImageDomain(domain) === parsed.hostname.toLowerCase()));
  } catch { return false; }
}
