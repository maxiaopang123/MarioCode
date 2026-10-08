import { getModelEntry } from "./editorModelCache.js";

/** Dirty models own previews; clean models re-read disk for agent changes. */
export function previewDraft(filePath: string): string | undefined {
  const entry = getModelEntry(filePath);
  if (!entry || entry.model.isDisposed()) return undefined;
  const content = entry.model.getValue();
  return content !== entry.baseline ? content : undefined;
}
