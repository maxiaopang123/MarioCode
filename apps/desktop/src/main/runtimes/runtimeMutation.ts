import type { RuntimeAgentId } from "@contracts/ipc";

let activeAgent: RuntimeAgentId | null = null;

/** True from before the first guarded check until the mutation fully settles. */
export function isRuntimeMutationActive(): boolean {
  return activeAgent !== null;
}

/** Serialize all runtime mutations globally. The assignment happens before
 * fn is invoked, without an await gap, so turn-start can reliably gate on it. */
export async function withRuntimeMutation<T>(agent: RuntimeAgentId, fn: () => Promise<T>): Promise<T> {
  if (activeAgent !== null) {
    throw new Error(`runtime ${activeAgent} is already being changed — wait for it to finish`);
  }
  activeAgent = agent;
  try {
    return await fn();
  } finally {
    activeAgent = null;
  }
}
