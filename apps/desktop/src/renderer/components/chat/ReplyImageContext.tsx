import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import type { Block } from "@renderer/stores/sessionStore.js";
import { fileReferenceKey } from "@renderer/lib/contentTag.js";

function savedPath(value: unknown): string | null {
  if (typeof value === "string") {
    if (/^[\[{]/.test(value.trim())) {
      try { return savedPath(JSON.parse(value)); } catch { /* plain tool output */ }
    }
    const match = /(?:已保存到:|saved(?:\s+to|Path):)\s*([^\r\n]+)/i.exec(value);
    return match?.[1]?.trim() ?? null;
  }
  if (!value || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    for (const item of value) { const path = savedPath(item); if (path) return path; }
    return null;
  }
  const obj = value as Record<string, unknown>;
  if (typeof obj.savedPath === "string") return obj.savedPath;
  return savedPath(obj.text ?? obj.content);
}

const Context = createContext<{
  loaded: ReadonlySet<string>;
  toolPaths: ReadonlyMap<string, string>;
  register: (path: string) => () => void;
} | null>(null);

/** Scoped to one turn; only a successfully loaded prose image can hide a thumbnail. */
export function ReplyImageProvider({ blocks, children }: { blocks: readonly Block[]; children: ReactNode }) {
  const [counts, setCounts] = useState<ReadonlyMap<string, number>>(new Map());
  const register = useCallback((path: string) => {
    const key = fileReferenceKey(path);
    setCounts(prev => { const next = new Map(prev); next.set(key, (next.get(key) ?? 0) + 1); return next; });
    return () => setCounts(prev => { const next = new Map(prev); const n = (next.get(key) ?? 1) - 1; if (n > 0) next.set(key, n); else next.delete(key); return next; });
  }, []);
  const toolPaths = useMemo(() => {
    const paths = new Map<string, string>();
    for (const block of blocks) {
      if (block.kind !== "tool_use" || !/(?:mario_image_generate|browser_screenshot|imagegen|image_generation)$/.test(block.toolName)) continue;
      const path = savedPath(block.result);
      if (path) paths.set(block.toolCallId, fileReferenceKey(path));
    }
    return paths;
  }, [blocks]);
  const value = useMemo(() => ({ loaded: new Set(counts.keys()), toolPaths, register }), [counts, toolPaths, register]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useReplyImages() { return useContext(Context); }
