export interface ComposerTrigger { kind: "mention" | "slash"; start: number; query: string }
const TRIGGERS: Record<string, ComposerTrigger["kind"]> = { "@": "mention", "＠": "mention", "/": "slash", "／": "slash" };

/** While @ is open, spaces remain searchable (directory names often contain them). */
export function findComposerTrigger(text: string, caret: number, pills: ReadonlyArray<readonly [number, number]>, activeMentionStart: number | null): ComposerTrigger | null {
  const inPill = (pos: number) => pills.find(([s, e]) => pos >= s && pos < e);
  const boundary = (pos: number) => pos === 0 || /\s/.test(text[pos - 1]);
  if (activeMentionStart !== null && caret > activeMentionStart && TRIGGERS[text[activeMentionStart]] === "mention" && boundary(activeMentionStart) && !inPill(activeMentionStart)) {
    const query = text.slice(activeMentionStart + 1, caret);
    if (!/[\r\n@＠]/.test(query) && query.length <= 240) return { kind: "mention", start: activeMentionStart, query };
  }
  let i = caret;
  while (i > 0) {
    const pill = inPill(i - 1);
    if (pill) { i = pill[0]; continue; }
    const ch = text[i - 1];
    const kind = TRIGGERS[ch];
    if (kind) {
      const start = i - 1;
      const query = text.slice(i, caret);
      return boundary(start) && !/\s/.test(query) ? { kind, start, query } : null;
    }
    if (/\s/.test(ch)) break;
    i--;
  }
  return null;
}
