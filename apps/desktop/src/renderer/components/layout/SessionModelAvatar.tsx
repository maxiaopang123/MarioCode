import type { Session } from "@contracts/session";
import { ModelAvatar } from "@renderer/components/chat/ModelAvatar.js";
import { cn } from "@renderer/lib/cn.js";
import { IconMessages } from "@renderer/lib/icons.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { modelDisplayName } from "@renderer/lib/modelAvatar.js";
import { getProviderIcon } from "@renderer/lib/providerIcon.js";

/** Identify the last actual model, never the engine or next-send selection. */
export function SessionModelAvatar({ session, className }: {
  session: Pick<Session, "lastUsedModel" | "providerId">;
  className?: string;
}) {
  const { t } = useI18n();
  const engine = getProviderIcon(session.providerId).label || session.providerId;
  const name = modelDisplayName(session.lastUsedModel);
  const title = [
    name
      ? t("layout.lastUsedModel", { model: session.lastUsedModel ?? name })
      : t("layout.sessionModelUnused"),
    t("layout.sessionEngine", { engine }),
  ].join("\n");

  if (name) {
    return <ModelAvatar model={session.lastUsedModel} title={title} className={className} />;
  }
  return (
    <span
      className={cn("inline-flex h-[18px] w-[18px] shrink-0 items-center justify-center text-content-subtle", className)}
      title={title}
      aria-label={t("layout.sessionModelUnused")}
    >
      <IconMessages size={15} />
    </span>
  );
}
