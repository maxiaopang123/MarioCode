import { strFromU8 } from "fflate";

export type SlideBlock = { kind: "text"; paragraphs: string[] } | { kind: "table"; rows: string[][] } | { kind: "image"; src: string };
const descendants = (node: Element | Document, name: string) => [...node.getElementsByTagNameNS("*", name)];
function xml(parts: Record<string, Uint8Array>, path: string): Document {
  if (!parts[path]) throw Error("Missing presentation part");
  const document = new DOMParser().parseFromString(strFromU8(parts[path]), "application/xml");
  if (document.querySelector("parsererror")) throw Error("Invalid presentation XML");
  return document;
}
function relativePart(base: string, target: string): string | null {
  if (/^[a-z]+:|^\/|\\/i.test(target)) return null;
  const result = base.split("/").slice(0, -1);
  for (const segment of target.split("/")) {
    if (segment === "..") { if (!result.length) return null; result.pop(); }
    else if (segment && segment !== ".") result.push(segment);
  }
  return result.join("/");
}
function relationships(parts: Record<string, Uint8Array>, path: string): Map<string, string> {
  const dir = path.slice(0, path.lastIndexOf("/") + 1);
  const rel = `${dir}_rels/${path.slice(path.lastIndexOf("/") + 1)}.rels`;
  const result = new Map<string, string>();
  if (!parts[rel]) return result;
  for (const element of descendants(xml(parts, rel), "Relationship")) {
    if (element.getAttribute("TargetMode") === "External") continue;
    const target = relativePart(path, element.getAttribute("Target") ?? "");
    if (target) result.set(element.getAttribute("Id") ?? "", target);
  }
  return result;
}
export function presentationPages(parts: Record<string, Uint8Array>): string[] {
  const path = "ppt/presentation.xml";
  const rels = relationships(parts, path);
  const pages = descendants(xml(parts, path), "sldId").map(element =>
    rels.get(element.getAttributeNS("http://schemas.openxmlformats.org/officeDocument/2006/relationships", "id") ?? ""),
  ).filter((part): part is string => Boolean(part && parts[part]));
  if (!pages.length || pages.length > 2000) throw Error("Invalid presentation page count");
  return pages;
}
function paragraphs(element: Element): string[] {
  return descendants(element, "p").map(p => [...p.childNodes].map(child => {
    if (!(child instanceof Element)) return "";
    if (child.localName === "br") return "\n";
    return descendants(child, "t").map(t => t.textContent ?? "").join("");
  }).join("")).filter(Boolean);
}
export function presentationSlide(parts: Record<string, Uint8Array>, path: string): SlideBlock[] {
  const document = xml(parts, path);
  const rels = relationships(parts, path);
  const blocks: SlideBlock[] = [];
  const relationId = (node: Element, name: string) => node.getAttributeNS("http://schemas.openxmlformats.org/officeDocument/2006/relationships", name) ?? "";
  const visit = (element: Element) => {
    if (element.localName === "grpSp") { [...element.children].forEach(visit); return; }
    const table = descendants(element, "tbl")[0];
    if (table) {
      blocks.push({ kind: "table", rows: descendants(table, "tr").map(row =>
        [...row.children].filter(cell => cell.localName === "tc").map(cell => paragraphs(cell).join("\n")),
      ) });
      return;
    }
    if (element.localName === "pic") {
      const blip = descendants(element, "blip")[0];
      const target = blip ? rels.get(relationId(blip, "embed")) : undefined;
      const data = target ? parts[target] : undefined;
      const extension = target?.split(".").pop()?.toLowerCase() ?? "";
      const mime: Record<string, string> = { png: "png", jpg: "jpeg", jpeg: "jpeg", gif: "gif", webp: "webp", bmp: "bmp" };
      if (data && mime[extension]) {
        let binary = "";
        for (let offset = 0; offset < data.length; offset += 8192) binary += String.fromCharCode(...data.subarray(offset, offset + 8192));
        blocks.push({ kind: "image", src: `data:image/${mime[extension]};base64,${btoa(binary)}` });
      }
      return;
    }
    const text = paragraphs(element);
    if (text.length) blocks.push({ kind: "text", paragraphs: text });
    // Charts have their own XML; expose the cached labels / values for reading.
    const chart = descendants(element, "chart")[0];
    const chartPath = chart ? rels.get(relationId(chart, "id")) : undefined;
    if (chartPath && parts[chartPath]) {
      const values = descendants(xml(parts, chartPath), "v").map(node => node.textContent ?? "");
      if (values.length) blocks.push({ kind: "text", paragraphs: [values.join(" · ")] });
    }
  };
  const tree = descendants(document, "spTree")[0];
  if (tree) [...tree.children].forEach(visit);
  return blocks;
}
