/**
 * The single repair pass over an IR request. Every outbound protocol is built
 * from its output, so a malformed or oddly spelled history is fixed once, the
 * same way, for both Chat Completions and Responses.
 *
 * Rules (each one mirrors a magpie normaliser):
 *  1. empty text parts disappear and adjacent text parts merge, so
 *     `"a"` + `"b"` and `"ab"` are the same history;
 *  2. messages left with no parts ("silent" assistants and the like) are
 *     dropped — Chat rejects an assistant with neither content nor calls;
 *  3. tool pairing: every call is answered exactly once, results sit first in
 *     call order, duplicates lose to the first, results with no matching call
 *     degrade to plain text, and a call nobody answered gets a CONSTANT
 *     synthetic result.
 *
 * Deliberately NOT done: magpie's "join split calls" (merging
 * assistant(A)/user(A)/assistant(B)/user(B) into one parallel turn). It would
 * rewrite earlier history the moment a later call appears, which is exactly
 * the append-only property the prefix cache needs.
 */
import { MISSING_RESULT_TEXT, ORPHAN_RESULT_TEXT, type IRMessage, type IRPart, type IRRequest } from "./ir.js";

type ResultPart = Extract<IRPart, { kind: "result" }>;
type CallPart = Extract<IRPart, { kind: "call" }>;

function cleanParts(parts: readonly IRPart[]): IRPart[] {
  const out: IRPart[] = [];
  for (const part of parts) {
    if (part.kind === "text") {
      if (part.text === "") continue;
      const last = out[out.length - 1];
      if (last?.kind === "text") { out[out.length - 1] = { kind: "text", text: last.text + part.text }; continue; }
    }
    out.push(part);
  }
  return out;
}

function syntheticResult(id: string): ResultPart {
  return { kind: "result", id, content: [{ kind: "text", text: MISSING_RESULT_TEXT }], isError: false };
}

/** Pair one assistant turn's calls with the user message that follows it. */
function pairTurn(assistant: IRMessage, next: IRMessage | undefined): { assistant: IRMessage; user: IRMessage | undefined; consumedNext: boolean } {
  const calls: CallPart[] = [];
  const seen = new Set<string>();
  const kept: IRPart[] = [];
  for (const part of assistant.parts) {
    if (part.kind === "call") {
      if (seen.has(part.id)) continue;
      seen.add(part.id);
      calls.push(part);
    }
    if (part.kind === "text" || part.kind === "call") kept.push(part);
  }
  if (calls.length === 0) return { assistant: { role: "assistant", parts: kept }, user: undefined, consumedNext: false };

  const answers = new Map<string, ResultPart>();
  const rest: IRPart[] = [];
  const nextUser = next?.role === "user" ? next : undefined;
  for (const part of nextUser?.parts ?? []) {
    if (part.kind === "result" && seen.has(part.id)) {
      if (!answers.has(part.id)) answers.set(part.id, part);
    } else if (part.kind === "result") {
      rest.push({ kind: "text", text: ORPHAN_RESULT_TEXT });
    } else if (part.kind === "text" || part.kind === "image") {
      rest.push(part);
    }
  }
  const results = calls.map((c) => answers.get(c.id) ?? syntheticResult(c.id));
  return {
    assistant: { role: "assistant", parts: kept },
    user: { role: "user", parts: cleanParts([...results, ...rest]) },
    consumedNext: nextUser !== undefined,
  };
}

export function normalizeIR(ir: IRRequest): IRRequest {
  const cleaned = ir.messages
    .map((m): IRMessage => ({ role: m.role, parts: cleanParts(m.parts) }))
    .filter((m) => m.parts.length > 0);

  const messages: IRMessage[] = [];
  for (let i = 0; i < cleaned.length; i++) {
    const msg = cleaned[i]!;
    if (msg.role === "assistant") {
      const paired = pairTurn(msg, cleaned[i + 1]);
      if (paired.assistant.parts.length > 0) messages.push(paired.assistant);
      if (paired.user) messages.push(paired.user);
      if (paired.consumedNext) i++;
      continue;
    }
    // A user message not claimed by a preceding assistant: its results have no
    // call to answer, so they are orphans.
    const parts = cleanParts(msg.parts.map((p): IRPart => (p.kind === "result" ? { kind: "text", text: ORPHAN_RESULT_TEXT } : p)));
    if (parts.length > 0) messages.push({ role: "user", parts });
  }
  return { ...ir, messages };
}
