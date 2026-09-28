/**
 * SKILL.md helpers shared by the skills IPC handlers and the skill market.
 * Electron-free (pure node:fs) so offline smokes can bundle it.
 */
import { promises as fs } from "node:fs";

/** Read up to `maxBytes` of a file as utf-8 text. Returns null on any error. */
export async function readTextHead(filePath: string, maxBytes = 8192): Promise<string | null> {
  try {
    const handle = await fs.open(filePath, "r");
    try {
      const buf = Buffer.alloc(maxBytes);
      const { bytesRead } = await handle.read(buf, 0, maxBytes, 0);
      return buf.subarray(0, bytesRead).toString("utf-8");
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}

/**
 * Parse the YAML frontmatter of a SKILL.md file. We only need `name`,
 * `description`, and (optionally) `argument-hint` / `argumentHint`, so a
 * hand-rolled line scan is enough — no yaml dependency. The frontmatter is
 * the YAML block delimited by `---` lines at the top of the file.
 *
 * Returns whatever fields were found; the caller fills in fallbacks
 * (e.g. name ← directory name).
 */
export function parseSkillFrontmatter(md: string): {
  name?: string;
  description?: string;
  argumentHint?: string;
} {
  // Frontmatter must be the very first thing in the file: "---\n".
  if (!md.startsWith("---\n") && !md.startsWith("---\r\n")) return {};
  // Find the closing "---" on its own line. Split on newlines so the leading
  // "---" line isn't matched by the closing fence regex.
  const lines = md.split(/\r?\n/);
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      end = i;
      break;
    }
  }
  if (end === -1) return {};
  const fm = lines.slice(1, end);

  const out: { name?: string; description?: string; argumentHint?: string } = {};
  for (let i = 0; i < fm.length; i++) {
    const line = fm[i].trim();
    if (!line || line.startsWith("#")) continue;
    // Top-level keys only: indented lines belong to a preceding block value.
    if (/^\s/.test(fm[i])) continue;
    const m = line.match(/^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1].toLowerCase();
    // Strip surrounding quotes (single/double) and trailing whitespace.
    let val = m[2].trim();
    // YAML block scalar (`>`, `>-`, `|`, `|-` …): the value is the following
    // indented lines. Folded (>) joins with spaces, literal (|) keeps newlines.
    if (/^[>|][+-]?\d*$/.test(val)) {
      const body: string[] = [];
      while (i + 1 < fm.length && (/^\s/.test(fm[i + 1]) || fm[i + 1].trim() === "")) {
        i++;
        body.push(fm[i].trim());
      }
      val = val.startsWith(">")
        ? body.filter(Boolean).join(" ")
        : body.join("\n").trim();
    }
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (key === "name") out.name = val;
    else if (key === "description") out.description = val;
    else if (key === "argument-hint" || key === "argumenthint") out.argumentHint = val;
  }
  return out;
}
