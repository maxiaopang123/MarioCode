/** resolveImageEndpoint → the smoke's local images API (SMOKE_IMAGE_BASE). */
export function resolveImageEndpoint() {
  const base = process.env.SMOKE_IMAGE_BASE;
  if (!base) return { ok: false as const, issue: "noSource" as const };
  return { ok: true as const, baseUrl: base, apiKey: "smoke-key", model: "smoke-image-1", size: "1024x1024", label: "smoke" };
}
