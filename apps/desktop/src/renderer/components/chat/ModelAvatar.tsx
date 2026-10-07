import { cn } from "@renderer/lib/cn.js";
import { modelDisplayName, modelFamily } from "@renderer/lib/modelAvatar.js";
import { OpenAIBrandIcon, SiClaude, IconCpu } from "@renderer/lib/icons.js";
import { SiGooglegemini, SiDeepseek, SiAlibabacloud, SiMoonshotai, SiMistralai } from "react-icons/si";

const MODEL_ICONS = {
  claude: SiClaude, openai: OpenAIBrandIcon, gemini: SiGooglegemini,
  deepseek: SiDeepseek, qwen: SiAlibabacloud, kimi: SiMoonshotai,
  mistral: SiMistralai, unknown: IconCpu,
};
const MODEL_COLORS = {
  claude: "#D97757", openai: "currentColor", gemini: "#4285F4",
  deepseek: "#4D6BFE", qwen: "#615CED", kimi: "currentColor",
  mistral: "#F59E0B", unknown: "currentColor",
};

/**
 * Brand avatar for the model that produced a turn.
 *
 * The stream records the model per turn (`TurnMeta.model` — the composer's
 * resolved send-model id), because the selection can change between turns. This
 * avatar resolves that id to a model family; unknown families use a neutral
 * chip. An execution engine's brand is never substituted for the model's.
 *
 * Parsing lives in lib/modelAvatar.ts (pure, smoke-tested); this file is the
 * view only.
 */

export function ModelAvatar({
  model,
  className,
  title,
}: {
  /** The turn's recorded model id; renders nothing when absent/empty. */
  model?: string | null;
  className?: string;
  /** Override the raw model tooltip when a surface has extra context. */
  title?: string;
}) {
  const name = modelDisplayName(model);
  if (!name) return null;
  const family = modelFamily(model);
  const Icon = MODEL_ICONS[family];
  return (
    <span
      className={cn(
        "inline-flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-md",
        className,
      )}
      style={{ color: MODEL_COLORS[family] }}
      title={title ?? model ?? name}
      aria-label={name}
    >
      <Icon size={15} />
    </span>
  );
}

/** Avatar + name as one left-aligned group for a turn's process header
 *  (方案A: the model that produced this turn rides with the summary row).
 *  Collapses to nothing when the turn has no recorded model — turns that
 *  predate the field must render exactly as before. */
export function ModelBadge({ model, className }: { model?: string | null; className?: string }) {
  const name = modelDisplayName(model);
  if (!name) return null;
  return (
    <span className={cn("inline-flex min-w-0 max-w-[260px] items-center gap-1.5", className)} title={model ?? name}>
      <ModelAvatar model={model} />
      <span className="chat-model-name truncate text-content-muted">{name}</span>
    </span>
  );
}
