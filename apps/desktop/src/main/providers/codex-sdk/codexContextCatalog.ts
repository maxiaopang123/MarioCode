import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import models from "./catalog/models-0.153.4.json";
import fallbackInstructions from "./catalog/fallback-instructions-0.153.4.json";

/** Match the native manager's longest-prefix / namespaced-suffix lookup. */
export function buildCodexContextCatalog(model: string, contextWindow: number, autoCompactTokenLimit: number) {
  const longestMatch = (id: string) => models.models.filter((entry) => id.startsWith(entry.slug))
    .sort((a, b) => b.slug.length - a.slug.length)[0];
  const template = longestMatch(model) ?? (model.includes("/") ? longestMatch(model.slice(model.indexOf("/") + 1)) : undefined);
  // This mirrors the runtime's unknown-model descriptor and native prompt,
  // rather than replacing Codex's instructions with an application prompt.
  const metadata = template ?? {
    slug: model, display_name: model, description: null,
    default_reasoning_level: null, supported_reasoning_levels: [],
    shell_type: "unified_exec", visibility: "none", supported_in_api: true,
    priority: 99, support_verbosity: false, default_verbosity: null,
    apply_patch_tool_type: null, availability_nux: null, upgrade: null,
    truncation_policy: { mode: "bytes", limit: 10000 }, experimental_supported_tools: [],
    include_skills_usage_instructions: false, include_plugin_usage_instructions: false,
    include_apps_usage_instructions: false, default_reasoning_summary: "auto",
    base_instructions: fallbackInstructions,
  };
  return { models: [{ ...metadata, slug: model, context_window: contextWindow,
    // The native manager clamps model_context_window to max_context_window.
    // Both must carry the application's explicit capacity, including 1M.
    max_context_window: contextWindow, auto_compact_token_limit: autoCompactTokenLimit,
    effective_context_window_percent: 100 }] };
}

/** A unique catalog per turn avoids races across sessions and model switches. */
export async function createCodexContextCatalog(model: string, contextWindow: number, autoCompactTokenLimit: number) {
  const directory = await mkdtemp(join(tmpdir(), "mariocode-codex-context-"));
  const path = join(directory, "models.json");
  try {
    await writeFile(path, JSON.stringify(buildCodexContextCatalog(model, contextWindow, autoCompactTokenLimit)), "utf8");
  } catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
  return { path, dispose: () => rm(directory, { recursive: true, force: true }) };
}
