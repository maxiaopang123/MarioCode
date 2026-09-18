export interface ClawBotReplyContext {
  ref: string;
  senderId: string;
  contextToken: string;
  createdAt: number;
}

export function upsertReplyContexts(
  current: readonly ClawBotReplyContext[] | undefined,
  additions: readonly ClawBotReplyContext[],
): ClawBotReplyContext[] {
  const byRef = new Map((current ?? []).map((entry) => [entry.ref, entry]));
  for (const entry of additions) byRef.set(entry.ref, entry);
  return [...byRef.values()].sort((a, b) => b.createdAt - a.createdAt);
}

export function consumeReplyContext(
  current: readonly ClawBotReplyContext[] | undefined,
  ref: string,
): ClawBotReplyContext[] {
  return (current ?? []).filter((entry) => entry.ref !== ref);
}

export function findReplyContext(
  current: readonly ClawBotReplyContext[] | undefined,
  ref: string,
): ClawBotReplyContext | null {
  return current?.find((entry) => entry.ref === ref) ?? null;
}
