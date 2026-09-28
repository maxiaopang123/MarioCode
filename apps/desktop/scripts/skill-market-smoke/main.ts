/**
 * Skill marketplace offline smoke — run via run.mjs (HOME points at a temp dir).
 */
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import {
  classifySource,
  marketIdFor,
  scanMarketTree,
  installSkillFromTree,
  globalSkillsRoot,
  marketRoot,
  listMarkets,
  addMarket,
  refreshMarket,
  removeMarket,
  installFromMarket,
} from "@main/lib/skillMarket.js";

let pass = 0;
let fail = 0;
function check(label: string, cond: boolean, extra?: unknown): void {
  if (cond) {
    pass++;
    console.log(`PASS ${label}`);
  } else {
    fail++;
    console.log(`FAIL ${label}${extra !== undefined ? ` :: ${JSON.stringify(extra)}` : ""}`);
  }
}
async function rejects(label: string, fn: () => Promise<unknown>, re?: RegExp): Promise<void> {
  try {
    await fn();
    check(label, false, "did not throw");
  } catch (err) {
    const msg = (err as Error).message;
    check(label, re ? re.test(msg) : true, msg);
  }
}
async function exists(p: string): Promise<boolean> {
  try {
    await fs.lstat(p);
    return true;
  } catch {
    return false;
  }
}
async function write(p: string, text: string): Promise<void> {
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, text, "utf-8");
}
const skillMd = (name: string, desc: string) => `---\nname: ${name}\ndescription: "${desc}"\n---\n\nbody\n`;

async function main(): Promise<void> {
  const home = process.env.SMOKE_HOME ?? "";
  check("HOME isolated to temp dir", !!home && path.resolve(homedir()) === path.resolve(home), { homedir: homedir(), home });
  if (!home || path.resolve(homedir()) !== path.resolve(home)) throw new Error("refusing to run against real home");
  check("marketRoot under temp HOME", marketRoot().startsWith(home));

  // ── Build a fake market tree ──
  const tree = path.join(home, "src", "market-a");
  const longDesc = "x".repeat(400);
  await write(path.join(tree, "alpha", "SKILL.md"), skillMd("alpha", "Alpha skill"));
  await write(path.join(tree, "alpha", "sub", "SKILL.md"), skillMd("alpha-sub", "should not be found (inside a skill)"));
  await write(path.join(tree, "deep", "nested", "beta-dir", "SKILL.md"), skillMd("beta", longDesc)); // nested 2 levels
  await write(path.join(tree, "bad name!", "SKILL.md"), skillMd("also bad", "invalid name")); // skipped
  await write(path.join(tree, "gamma", "SKILL.md"), skillMd("gamma", "Gamma with git"));
  await write(path.join(tree, "gamma", ".git", "HEAD"), "ref: refs/heads/main\n"); // nested .git
  await write(path.join(tree, "gamma", "scripts", "run.sh"), "echo hi\n");
  await write(path.join(tree, ".git", "hidden", "SKILL.md"), skillMd("hidden", "in .git")); // skipped
  await write(path.join(tree, "node_modules", "pkg", "SKILL.md"), skillMd("pkg", "in node_modules")); // skipped
  await write(path.join(tree, "a", "b", "c", "d", "e", "SKILL.md"), skillMd("too-deep", "depth 5")); // beyond depth 4
  await write(path.join(tree, "SKILL.md"), skillMd("root", "root-level skill ignored"));

  const skillsRoot = globalSkillsRoot();
  const found = await scanMarketTree(tree, "m1", skillsRoot);
  check("scan finds exactly alpha/beta/gamma", JSON.stringify(found.map((s) => s.name)) === '["alpha","beta","gamma"]', found.map((s) => s.name));
  const beta = found.find((s) => s.name === "beta");
  check("beta relPath is posix nested", beta?.relPath === "deep/nested/beta-dir", beta?.relPath);
  check("beta description truncated to 300 (+ellipsis)", beta?.description.length === 301, beta?.description.length);
  check("alpha description parsed", found.find((s) => s.name === "alpha")?.description === "Alpha skill");
  check("nothing installed yet", found.every((s) => !s.installed));
  check("marketId propagated", found.every((s) => s.marketId === "m1"));

  // ── Install ──
  await installSkillFromTree(tree, "gamma", "gamma", skillsRoot);
  const dest = path.join(skillsRoot, "gamma");
  check("install copied SKILL.md", await exists(path.join(dest, "SKILL.md")));
  check("install copied nested files", await exists(path.join(dest, "scripts", "run.sh")));
  check("install stripped nested .git", !(await exists(path.join(dest, ".git"))));
  const rescanned = await scanMarketTree(tree, "m1", skillsRoot);
  check("installed flag set after install", rescanned.find((s) => s.name === "gamma")?.installed === true);
  await rejects("second install errors", () => installSkillFromTree(tree, "gamma", "gamma", skillsRoot), /已存在同名技能/);
  await rejects("relPath ../x rejected", () => installSkillFromTree(tree, "../x", "x1", skillsRoot), /无效的技能路径/);
  await rejects("relPath ../../src traversal rejected", () => installSkillFromTree(tree, "alpha/../../market-a", "x2", skillsRoot), /无效的技能路径/);
  await rejects("relPath '.' (tree root) rejected", () => installSkillFromTree(tree, ".", "x3", skillsRoot), /无效的技能路径/);
  await rejects("absolute relPath rejected", () => installSkillFromTree(tree, path.join(tree, "alpha"), "x4", skillsRoot), /无效的技能路径/);
  await rejects("dir without SKILL.md rejected", () => installSkillFromTree(tree, "deep", "x5", skillsRoot), /SKILL\.md/);
  await rejects("invalid dest name rejected", () => installSkillFromTree(tree, "alpha", "../evil", skillsRoot), /无效的技能名/);

  // ── Source classification ──
  const g1 = classifySource("https://GitHub.com/anthropics/skills.git/");
  const g2 = classifySource("https://github.com/anthropics/skills");
  check("https url normalized (host lowercase, strip .git and slash)", g1.normalized === g2.normalized && g1.normalized === "https://github.com/anthropics/skills", g1.normalized);
  check("id = slug + hash", /^skills-[0-9a-f]{6}$/.test(marketIdFor(g1)), marketIdFor(g1));
  for (const bad of ["ssh://git@github.com/a/b.git", "git@github.com:a/b.git", "file:///tmp/x", "http://github.com/a/b", "relative/dir", "./x"]) {
    let threw = false;
    try {
      classifySource(bad);
    } catch {
      threw = true;
    }
    check(`reject source ${bad}`, threw);
  }
  check("absolute local dir accepted", classifySource(tree).kind === "local");

  // ── Full flow with a local source (no network) ──
  const before = await listMarkets();
  const builtin = before.find((m) => m.builtin);
  check("builtin market present and not fetched", !!builtin && builtin.fetchedAt === null && builtin.skills.length === 0, before);
  await addMarket(tree, "Local A");
  const after = await listMarkets();
  const local = after.find((m) => !m.builtin);
  check("local market added with 3 skills", local?.name === "Local A" && local.skills.length === 3, local);
  check("local market fetchedAt set", typeof local?.fetchedAt === "string");
  const stale = (await fs.readdir(marketRoot())).filter((n) => n.startsWith(".staging-"));
  check("no staging dirs left", stale.length === 0, stale);
  await rejects("duplicate source rejected", () => addMarket(tree + path.sep), /已添加/);
  const empty = path.join(home, "src", "empty");
  await fs.mkdir(empty, { recursive: true });
  await write(path.join(empty, "README.md"), "no skills");
  await rejects("source with no SKILL.md rejected", () => addMarket(empty), /没有找到任何 SKILL\.md/);
  const stale2 = (await fs.readdir(marketRoot())).filter((n) => n.startsWith(".staging-"));
  check("staging cleaned after failed add", stale2.length === 0, stale2);
  check("failed add not persisted", (await listMarkets()).length === 2);

  if (local) {
    // New skill appears after refresh.
    await write(path.join(tree, "delta", "SKILL.md"), skillMd("delta", "Delta"));
    await refreshMarket(local.id);
    const refreshed = (await listMarkets()).find((m) => m.id === local.id);
    check("refresh picks up new skill", refreshed?.skills.some((s) => s.name === "delta") === true);
    await installFromMarket(local.id, "delta", "delta");
    check("installFromMarket copies into ~/.mcode/skills", await exists(path.join(skillsRoot, "delta", "SKILL.md")));
    await rejects("installFromMarket unknown market", () => installFromMarket("nope-123456", "delta", "delta2"), /未知/);
    await rejects("installFromMarket traversal", () => installFromMarket(local.id, "../../../src/market-a/alpha", "alpha2"), /无效的技能路径/);
    // Refresh failure records error (source deleted).
    await fs.rm(tree, { recursive: true, force: true });
    await rejects("refresh of deleted source fails", () => refreshMarket(local.id), /不存在/);
    const errored = (await listMarkets()).find((m) => m.id === local.id);
    check("refresh error recorded, old tree kept", !!errored?.error && errored.skills.length === 4, errored);
    await removeMarket(local.id);
    check("remove deletes tree", !(await exists(path.join(marketRoot(), local.id))));
    check("remove drops record", (await listMarkets()).length === 1);
  }
  if (builtin) await rejects("builtin cannot be removed", () => removeMarket(builtin.id), /内置/);

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.log(`CRASH ${(err as Error).stack ?? String(err)}`);
  process.exitCode = 1;
});
