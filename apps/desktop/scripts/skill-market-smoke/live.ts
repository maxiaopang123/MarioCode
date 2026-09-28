// Live check (network): clone the builtin anthropics/skills market into a temp
// HOME, list it, install one skill. Run via `node run.mjs --live`.
import { existsSync } from "node:fs";
import path from "node:path";
import { installFromMarket, listMarkets, refreshMarket, globalSkillsRoot } from "@main/lib/skillMarket.js";

const t0 = Date.now();
await refreshMarket("anthropics-skills");
const cloneSec = ((Date.now() - t0) / 1000).toFixed(1);
const [m] = (await listMarkets()).filter((x) => x.id === "anthropics-skills");
if (!m || m.skills.length === 0) {
  console.log(`FAIL no skills (error=${m?.error ?? "?"})`);
  process.exit(1);
}
console.log(`clone ${cloneSec}s, ${m.skills.length} skills:`);
for (const s of m.skills) console.log(`  - ${s.name}  (${s.relPath})  ${s.description.slice(0, 60)}`);
const pick = m.skills[0];
await installFromMarket(m.id, pick.relPath, pick.name);
const ok = existsSync(path.join(globalSkillsRoot(), pick.name, "SKILL.md"));
const after = (await listMarkets()).find((x) => x.id === m.id)?.skills.find((s) => s.name === pick.name);
console.log(`install ${pick.name}: ${ok ? "OK" : "FAIL"}, installed flag=${after?.installed}`);
process.exit(ok && after?.installed ? 0 : 1);
