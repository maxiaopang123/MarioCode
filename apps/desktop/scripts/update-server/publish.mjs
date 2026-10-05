#!/usr/bin/env node
/**
 * Publish the current MarioCode Windows build to the self-hosted update server
 * (generic electron-updater feed, `publish.url` in electron-builder.yml).
 *
 * Usage (PowerShell, from the repo root):
 *   $env:MARIOCODE_UPDATE_SSH_PASS='...'
 *   pnpm --filter @mariocode/desktop run release:upload               # publish current version
 *   pnpm --filter @mariocode/desktop run release:upload --dry-run     # local checks only, no SSH
 *   pnpm --filter @mariocode/desktop run release:upload --setup       # (re)create the nginx container
 *
 * Flags:
 *   --dry-run      validate release/ artifacts + git state, print the plan, no network
 *   --setup        upload nginx.conf + run setup.sh on the server, then exit
 *   --allow-dirty  publish even if tracked files have uncommitted changes
 *   --force        allow publishing a version LOWER than the one currently live
 *
 * Env:
 *   MARIOCODE_UPDATE_SSH_PASS  password (falls back to MC_SSH_PASS)
 *   MARIOCODE_UPDATE_SSH_KEY   path to a private key (alternative to password)
 *   MARIOCODE_UPDATE_SSH_HOST  default: host of publish.url
 *   MARIOCODE_UPDATE_SSH_USER  default: root
 *   MARIOCODE_UPDATE_SSH_PORT  default: 22
 *
 * Upload protocol: SFTP is avoided (ssh2's sftp.fastPut breaks on new Node),
 * files are streamed through `cat >> incoming/<name>.part` over exec —
 * resuming from the bytes already on the server after a dropped connection —
 * the remote sha512 is compared with the local one, and only then is the file
 * moved into public/. The exe + blockmap go first and latest.yml goes LAST,
 * so clients never see a manifest that points at a file still uploading.
 * Old versions are kept: electron-updater's differential download fetches the
 * previous version's .blockmap from the same directory.
 */
import { createHash } from "node:crypto";
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "ssh2";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_DIR = resolve(HERE, "../..");
const RELEASE_DIR = join(APP_DIR, "release");
const REMOTE_ROOT = "/opt/mariocode-updates";
const SAFE_NAME = /^[A-Za-z0-9._-]+$/;
const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

const argv = new Set(process.argv.slice(2).filter((a) => a !== "--"));
const DRY = argv.has("--dry-run");
const SETUP = argv.has("--setup");
const ALLOW_DIRTY = argv.has("--allow-dirty");
const FORCE = argv.has("--force");

function fail(msg) {
  console.error(`\n✗ ${msg}`);
  process.exit(1);
}

function warn(msg) {
  console.warn(`! ${msg}`);
}

/** Single-quote for the remote POSIX shell. */
function q(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

/** -1 / 0 / 1. Pre-release sorts below the same x.y.z (semver-ish). */
function compareVersions(a, b) {
  const ma = SEMVER.exec(a);
  const mb = SEMVER.exec(b);
  if (!ma || !mb) return 0;
  for (let i = 1; i <= 3; i++) {
    const d = Number(ma[i]) - Number(mb[i]);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  if (ma[4] === mb[4]) return 0;
  if (!ma[4]) return 1;
  if (!mb[4]) return -1;
  return ma[4] < mb[4] ? -1 : 1;
}

/** `publish:` block of electron-builder.yml → feed URL (generic provider only). */
function readFeedUrl() {
  const yml = readFileSync(join(APP_DIR, "electron-builder.yml"), "utf8").replace(/\r\n/g, "\n");
  const block = /^publish:\n((?:[ \t]+.*(?:\n|$))+)/m.exec(yml)?.[1] ?? "";
  const provider = /^\s+provider:\s*(\S+)/m.exec(block)?.[1];
  const url = /^\s+url:\s*(\S+)/m.exec(block)?.[1]?.replace(/^["']|["']$/g, "");
  if (provider !== "generic" || !url) {
    fail("electron-builder.yml 的 publish 不是 generic provider,或缺少 url");
  }
  return new URL(url.endsWith("/") ? url : `${url}/`);
}

/** Minimal parse of electron-builder's latest.yml (flat, single-file NSIS). */
function parseLatestYml(text) {
  const t = text.replace(/\r\n/g, "\n");
  const pick = (re) => re.exec(t)?.[1]?.replace(/^["']|["']$/g, "");
  return {
    version: pick(/^version:\s*(\S+)/m),
    path: pick(/^path:\s*(\S+)/m),
    sha512: pick(/^sha512:\s*(\S+)/m),
    size: Number(pick(/^\s+size:\s*(\d+)/m) ?? NaN),
  };
}

function sha512Of(file) {
  return new Promise((res, rej) => {
    const h = createHash("sha512");
    createReadStream(file)
      .on("data", (c) => h.update(c))
      .on("error", rej)
      .on("end", () => {
        const digest = h.digest();
        res({ base64: digest.toString("base64"), hex: digest.toString("hex") });
      });
  });
}

function git(...args) {
  return execFileSync("git", args, { cwd: APP_DIR, encoding: "utf8" }).trim();
}

function fmtMB(n) {
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/* ── SSH helpers ── */

function connect(host) {
  const password = process.env.MARIOCODE_UPDATE_SSH_PASS || process.env.MC_SSH_PASS;
  const keyPath = process.env.MARIOCODE_UPDATE_SSH_KEY;
  if (!password && !keyPath) {
    fail("缺少 SSH 凭据:设置 MARIOCODE_UPDATE_SSH_PASS(或 MARIOCODE_UPDATE_SSH_KEY 指向私钥)");
  }
  return new Promise((res, rej) => {
    const conn = new Client();
    conn
      .on("ready", () => res(conn))
      .on("error", rej)
      .connect({
        host,
        port: Number(process.env.MARIOCODE_UPDATE_SSH_PORT || 22),
        username: process.env.MARIOCODE_UPDATE_SSH_USER || "root",
        password: password || undefined,
        privateKey: keyPath ? readFileSync(keyPath) : undefined,
        readyTimeout: 20_000,
        keepaliveInterval: 15_000,
      });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Lazily (re)connecting SSH session. Long transfers through a proxy get cut
 * (observed: the channel dies after ~4 min / ~170 MB with `exit null`), so
 * every remote step goes through `retry()`, which drops the dead connection
 * and reconnects before trying again.
 */
class Remote {
  constructor(host) {
    this.host = host;
    this.conn = null;
  }
  async get() {
    if (!this.conn) {
      const conn = await connect(this.host);
      conn.on("close", () => {
        if (this.conn === conn) this.conn = null;
      });
      conn.on("error", () => {});
      this.conn = conn;
    }
    return this.conn;
  }
  drop() {
    try {
      this.conn?.end();
    } catch {
      // already gone
    }
    this.conn = null;
  }
  async run(cmd, opts) {
    return run(await this.get(), cmd, opts);
  }
  /** Run `fn(this)` up to `attempts` times, reconnecting between failures. */
  async retry(what, fn, attempts = 8) {
    for (let i = 1; ; i++) {
      try {
        return await fn(this);
      } catch (err) {
        this.drop();
        const msg = (err instanceof Error ? err.message : String(err)).split("\n")[0];
        if (i >= attempts) throw new Error(`${what} 失败(已重试 ${attempts} 次):${msg}`);
        warn(`${what} 中断(${msg}),${Math.min(5 * i, 30)} 秒后重连续传(第 ${i} 次)`);
        await sleep(Math.min(5000 * i, 30_000));
      }
    }
  }
}

/**
 * Run `cmd` remotely. `input` (Buffer, local file path, or `{ path, start }`
 * to stream a file from a byte offset) is piped to the command's stdin; file
 * uploads print coarse progress.
 */
function run(conn, cmd, { input, label } = {}) {
  return new Promise((res, rej) => {
    conn.exec(cmd, (err, stream) => {
      if (err) return rej(err);
      let out = "";
      let errOut = "";
      let exitCode = null;
      let rs = null;
      stream.on("data", (d) => (out += d));
      stream.stderr.on("data", (d) => (errOut += d));
      stream.on("exit", (code) => (exitCode = code));
      stream.on("close", () => {
        rs?.destroy(); // channel gone mid-upload: stop reading the local file
        if (exitCode === 0) res(out);
        else rej(new Error(`remote exit ${exitCode}: ${cmd.split("\n")[0].slice(0, 120)}\n${errOut.trim()}`));
      });

      if (input === undefined) {
        stream.end();
      } else if (Buffer.isBuffer(input)) {
        stream.end(input);
      } else {
        const path = typeof input === "string" ? input : input.path;
        const start = typeof input === "string" ? 0 : input.start;
        const total = statSync(path).size;
        const started = Date.now();
        let sent = start;
        let lastPct = -1;
        rs = createReadStream(path, { start });
        rs.on("data", (chunk) => {
          sent += chunk.length;
          const pct = Math.floor((sent / total) * 100);
          if (label && pct !== lastPct && (pct % 5 === 0 || sent === total)) {
            lastPct = pct;
            const secs = Math.max((Date.now() - started) / 1000, 0.001);
            process.stdout.write(
              `\r  ↑ ${label} ${pct}% (${fmtMB(sent)} / ${fmtMB(total)}, ${fmtMB((sent - start) / secs)}/s)   `,
            );
          }
        });
        rs.on("end", () => label && process.stdout.write("\n"));
        rs.on("error", (e) => {
          stream.destroy();
          rej(e);
        });
        rs.pipe(stream);
      }
    });
  });
}

/**
 * Resumable upload: stream → incoming/<name>.part (appending from whatever
 * byte count already landed, across reconnects) → verify the whole file's
 * sha512 → atomic mv into public/. A sidecar `<part>.want` records which file
 * the partial bytes belong to, so a leftover .part from a different build is
 * discarded instead of being resumed into a corrupt file.
 */
async function uploadVerified(remote, localPath, name, hex) {
  if (!SAFE_NAME.test(name)) fail(`非法文件名: ${name}`);
  const part = `${REMOTE_ROOT}/incoming/${name}.part`;
  const want = `${part}.want`;
  const total = statSync(localPath).size;

  for (let pass = 1; pass <= 2; pass++) {
    await remote.retry(`上传 ${name}`, async (r) => {
      // A `cat` orphaned by a dropped channel may still be flushing into the
      // part file; stop it (fuser matches by open file, not command line, so
      // it can't hit this shell) before measuring how much landed.
      const have = Number(
        (
          await r.run(
            `command -v fuser >/dev/null && fuser -k ${q(part)} >/dev/null 2>&1 && sleep 1; ` +
              `if [ "$(cat ${q(want)} 2>/dev/null)" != ${q(hex)} ]; then rm -f ${q(part)}; printf %s ${q(hex)} > ${q(want)}; fi; ` +
              `stat -c %s ${q(part)} 2>/dev/null || echo 0`,
          )
        ).trim(),
      );
      if (have > total) {
        await r.run(`rm -f ${q(part)}`);
        throw new Error("远端分片比本地文件大,已清空重传");
      }
      if (have > 0 && have < total) console.log(`  … 从 ${fmtMB(have)} 处续传 ${name}`);
      if (have < total) await r.run(`cat >> ${q(part)}`, { input: { path: localPath, start: have }, label: name });
    });

    const remoteHex = await remote.retry(`校验 ${name}`, async (r) =>
      (await r.run(`sha512sum ${q(part)}`)).split(/\s+/)[0],
    );
    if (remoteHex === hex) break;
    await remote.retry(`清理 ${name}`, (r) => r.run(`rm -f ${q(part)} ${q(want)}`));
    if (pass === 2) {
      fail(`${name} 上传后校验不一致(本地 ${hex.slice(0, 12)}… / 远端 ${remoteHex.slice(0, 12)}…)`);
    }
    warn(`${name} 校验不一致,整文件重传一次`);
  }

  // Idempotent so a reconnect after a successful mv doesn't fail the step.
  const dest = `${REMOTE_ROOT}/public/${name}`;
  await remote.retry(`发布 ${name}`, (r) =>
    r.run(
      `if [ -f ${q(part)} ]; then chmod 644 ${q(part)} && mv -f ${q(part)} ${q(dest)}; fi; rm -f ${q(want)}; ` +
        `[ "$(sha512sum ${q(dest)} | cut -d' ' -f1)" = ${q(hex)} ]`,
    ),
  );
  console.log(`  ✓ ${name}`);
}

/* ── Modes ── */

async function setupServer(feedUrl) {
  const port = feedUrl.port || "80";
  const host = process.env.MARIOCODE_UPDATE_SSH_HOST || feedUrl.hostname;
  const conf = Buffer.from(readFileSync(join(HERE, "nginx.conf"), "utf8").replace(/\r\n/g, "\n"));
  const script = Buffer.from(readFileSync(join(HERE, "setup.sh"), "utf8").replace(/\r\n/g, "\n"));
  console.log(`→ 配置更新服务器 ${host}(端口 ${port},目录 ${REMOTE_ROOT})`);
  const conn = await connect(host);
  try {
    await run(conn, `mkdir -p ${q(`${REMOTE_ROOT}/conf`)} && cat > ${q(`${REMOTE_ROOT}/conf/default.conf`)}`, {
      input: conf,
    });
    const out = await run(conn, `PORT=${q(port)} ROOT=${q(REMOTE_ROOT)} bash -s`, { input: script });
    console.log(out.trim());
  } finally {
    conn.end();
  }
  const res = await fetch(feedUrl).catch((e) => ({ ok: false, statusText: e.message }));
  if (!res.ok) fail(`公网访问 ${feedUrl} 失败:${res.status ?? ""} ${res.statusText}`);
  console.log(`✓ 公网可访问 ${feedUrl}`);
}

async function publish(feedUrl) {
  // ── Local artifacts ──
  const pkg = JSON.parse(readFileSync(join(APP_DIR, "package.json"), "utf8"));
  const version = pkg.version;
  if (!SEMVER.test(version)) fail(`package.json 版本号不合法: ${version}`);

  const exeName = `MarioCode-${version}-x64.exe`;
  const blockmapName = `${exeName}.blockmap`;
  const exePath = join(RELEASE_DIR, exeName);
  const blockmapPath = join(RELEASE_DIR, blockmapName);
  const ymlPath = join(RELEASE_DIR, "latest.yml");
  for (const p of [exePath, blockmapPath, ymlPath]) {
    if (!existsSync(p)) fail(`缺少 ${p}\n  先打包当前版本:scripts\\package-win.bat`);
  }

  const yml = parseLatestYml(readFileSync(ymlPath, "utf8"));
  const exeSize = statSync(exePath).size;
  console.log(`→ 校验本地产物 v${version}`);
  const exeHash = await sha512Of(exePath);
  if (yml.version !== version) fail(`latest.yml 版本 ${yml.version} ≠ package.json ${version}(latest.yml 是旧的,需重新打包)`);
  if (yml.path !== exeName) fail(`latest.yml 指向 ${yml.path},应为 ${exeName}`);
  if (yml.sha512 !== exeHash.base64) fail("latest.yml 的 sha512 与安装包不一致(安装包或清单被替换过,需重新打包)");
  if (yml.size !== exeSize) fail(`latest.yml 的 size ${yml.size} ≠ 实际 ${exeSize}`);
  const blockmapHash = await sha512Of(blockmapPath);
  const ymlBuf = readFileSync(ymlPath);
  const ymlHex = createHash("sha512").update(ymlBuf).digest("hex");
  console.log(`  ✓ ${exeName}(${fmtMB(exeSize)})+ blockmap + latest.yml 一致`);

  // ── Git state: publish what is committed ──
  const dirty = git("status", "--porcelain", "--untracked-files=no");
  let headVersion = "";
  try {
    headVersion = JSON.parse(git("show", "HEAD:apps/desktop/package.json")).version;
  } catch {
    // Outside a git checkout — skip the commit checks.
  }
  if (dirty && !ALLOW_DIRTY) fail(`有未提交的改动,先提交再发布(或加 --allow-dirty):\n${dirty}`);
  if (headVersion && headVersion !== version) fail(`HEAD 提交里的版本是 ${headVersion},工作区是 ${version}`);
  if (headVersion) {
    const headTime = Number(git("log", "-1", "--format=%ct")) * 1000;
    if (statSync(exePath).mtimeMs < headTime) {
      warn(`安装包打包时间早于最新提交 ${git("log", "-1", "--format=%h %s")};若该提交改了代码,请先重新打包`);
    }
  }

  const host = process.env.MARIOCODE_UPDATE_SSH_HOST || feedUrl.hostname;
  console.log(`\n计划:上传到 ${host}:${REMOTE_ROOT}/public → ${feedUrl}`);
  console.log(`  1. ${exeName}\n  2. ${blockmapName}\n  3. latest.yml(最后上传,用户此刻才会看到新版本)`);
  if (DRY) {
    console.log("\n(--dry-run:未连接服务器)");
    return;
  }

  // ── Remote state ──
  const remote = new Remote(host);
  try {
    const probe = await remote.retry("读取线上状态", (r) =>
      r.run(
        [
          `test -d ${q(`${REMOTE_ROOT}/public`)} || { echo NO_ROOT; exit 0; }`,
          `mkdir -p ${q(`${REMOTE_ROOT}/incoming`)}`,
          `cd ${q(`${REMOTE_ROOT}/public`)}`,
          `for f in ${q(exeName)} ${q(blockmapName)} latest.yml; do [ -f "$f" ] && sha512sum "$f"; done`,
          `echo ---`,
          `cat latest.yml 2>/dev/null || true`,
        ].join("; "),
      ),
    );
    if (probe.trim() === "NO_ROOT") fail(`服务器上没有 ${REMOTE_ROOT}/public,先运行 --setup`);
    const [sums, liveYmlText = ""] = probe.split("---\n");
    const remoteHex = new Map(
      sums
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((l) => {
          const [h, ...rest] = l.trim().split(/\s+/);
          return [rest.join(" "), h];
        }),
    );
    const live = parseLatestYml(liveYmlText);
    if (live.version) {
      const cmp = compareVersions(version, live.version);
      console.log(`  线上版本:v${live.version}`);
      if (cmp < 0 && !FORCE) fail(`线上已是 v${live.version},比本地 v${version} 新;确需回退加 --force`);
      if (cmp === 0 && remoteHex.get(exeName) && remoteHex.get(exeName) !== exeHash.hex) {
        warn(`同版本 v${version} 覆盖为新的安装包:已装 v${version} 的用户不会收到这次覆盖(版本号没变)`);
      }
    } else {
      console.log("  线上暂无版本(首次发布)");
    }

    console.log("\n→ 上传");
    for (const [path, name, hex] of [
      [exePath, exeName, exeHash.hex],
      [blockmapPath, blockmapName, blockmapHash.hex],
    ]) {
      if (remoteHex.get(name) === hex) console.log(`  = ${name}(线上已是同一文件,跳过)`);
      else await uploadVerified(remote, path, name, hex);
    }
    if (remoteHex.get("latest.yml") === ymlHex) console.log("  = latest.yml(线上已是同一文件,跳过)");
    else await uploadVerified(remote, ymlPath, "latest.yml", ymlHex);
  } finally {
    remote.drop();
  }

  // ── Public HTTP check (what users' apps will actually see) ──
  console.log("\n→ 公网校验");
  const ymlRes = await fetch(new URL("latest.yml", feedUrl));
  if (!ymlRes.ok) fail(`GET latest.yml → HTTP ${ymlRes.status}`);
  const served = parseLatestYml(await ymlRes.text());
  if (served.version !== version || served.sha512 !== exeHash.base64) {
    fail(`线上 latest.yml 是 v${served.version},与刚上传的 v${version} 不一致`);
  }
  const head = await fetch(new URL(exeName, feedUrl), { method: "HEAD" });
  const len = Number(head.headers.get("content-length"));
  if (!head.ok || len !== exeSize) fail(`HEAD ${exeName} → HTTP ${head.status},长度 ${len}(应为 ${exeSize})`);
  console.log(`  ✓ ${new URL("latest.yml", feedUrl)} → v${version}`);
  console.log(`  ✓ ${new URL(exeName, feedUrl)}(${fmtMB(len)})`);
  console.log(`\n✓ 已发布 v${version}。v0.2.5 及以上的客户端会在启动 10 秒后或每 4 小时检查到它。`);
}

const feedUrl = readFeedUrl();
try {
  if (SETUP) await setupServer(feedUrl);
  else await publish(feedUrl);
} catch (err) {
  fail(err instanceof Error ? err.message : String(err));
}
