// Offline smoke for mario_web_fetch's two lanes (TODO-060). A loopback fixture
// server stands in for the web: the HTTP lane must extract a static article
// without creating a window, a JS shell must fall back to Chromium and still
// read, GBK must decode, and the redirect guard must refuse before the body is
// read. Run with `pnpm test:web-reader`.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { app, BrowserWindow } from "electron";
import { NETWORK_PROXY_SETTING_KEY } from "@contracts/ipc";
import { SettingRepo } from "@main/store/repositories.js";
import { closeDb, initDb } from "@main/store/db.js";
import { readStaticPage, StaticPageRejected } from "@main/tools/httpPage.js";
import { landedProblem, loadPage } from "@main/tools/webFetch.js";

const LONG =
  "这一段是用于验证正文抽取的示例文字,它需要足够长,才能越过正文下限的判断,并让 main 区块的占比有意义。".repeat(24);

const STATIC_HTML = `<!doctype html><html><head><title>Smoke Article Title</title><meta charset="utf-8"></head>
<body>
<nav><a href="/nav">NAV CHROME</a></nav>
<aside>ASIDE CHROME</aside>
<main>
  <h1>Heading One</h1>
  <p>${LONG}</p>
  <h2>Heading Two</h2>
  <ul><li>First item</li><li>Second item</li></ul>
  <pre><code>if (a &lt; b) { console.log("code kept"); }</code></pre>
  <table><tr><th>Key</th><th>Value</th></tr><tr><td>alpha</td><td>1</td></tr></table>
  <p>See <a href="/docs/page"><span>Example</span></a> for more.</p>
  <script>if (a < b) { document.write("SCRIPT JUNK"); }</script>
</main>
<footer>FOOTER CHROME</footer>
</body></html>`;

// No <main>: the body itself is the article, and site chrome must be stripped.
const PLAIN_HTML = `<!doctype html><html><head><title>Plain Page</title></head><body>
<nav>NAV CHROME</nav>
<div><h1>Plain Heading</h1><p>${LONG}</p><p>${LONG}</p></div>
<script>var junk = "<div>SCRIPT JUNK</div>";</script>
<footer>FOOTER CHROME</footer>
</body></html>`;

// Real prose, just short: several <p> is what separates it from an app shell.
const SHORT_HTML = `<!doctype html><html><head><title>Short Note</title></head><body><main>
${[1, 2, 3, 4, 5].map((n) => `<p>第 ${n} 段:这是一条很短的说明,用来验证短正文只要段落结构清楚,就不必降级到 Chromium 渲染。</p>`).join("")}
</main></body></html>`;

// An app shell: the served HTML holds almost no text; the content exists only
// after the script runs.
const SHELL_HTML = `<!doctype html><html><head><title>App Shell</title></head><body>
<div id="app">Loading…</div>
<script>
  document.getElementById("app").innerHTML =
    "<h1>Rendered by script</h1><p>" + "脚本渲染出来的正文内容。".repeat(300) + "</p>";
</script>
</body></html>`;

/** GB2312 bytes for 中文编码测试 — Node has no GBK encoder, so the fixture
 *  carries the bytes and everything else is built around them as latin1. */
const GBK_PHRASE = Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 0xb1, 0xe0, 0xc2, 0xeb, 0xb2, 0xe2, 0xca, 0xd4]);

function gbkDocument(): Buffer {
  const phrase = GBK_PHRASE.toString("latin1");
  const doc = `<html><head><meta charset="gb2312"><title>GBK Fixture</title></head><body><main>
<h1>GBK Heading</h1>${[1, 2, 3].map(() => `<p>${phrase.repeat(80)}</p>`).join("")}
</main></body></html>`;
  // latin1 is byte-for-byte, so the GBK bytes above survive the templating.
  return Buffer.from(doc, "latin1");
}

let windowsCreated = 0;
const userData = process.env.MARIOCODE_SMOKE_DATA!;

async function main(): Promise<void> {
  app.setPath("userData", userData);
  app.on("window-all-closed", () => {});
  app.on("browser-window-created", () => {
    windowsCreated++;
  });
  await app.whenReady();
  await initDb();
  // Hermetic: the smoke must not inherit the machine's system proxy.
  SettingRepo.set(NETWORK_PROXY_SETTING_KEY, JSON.stringify({ mode: "direct", customUrl: "" }));

  const server = createServer((req, res) => {
    const url = req.url ?? "/";
    if (url === "/static") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(STATIC_HTML);
    } else if (url === "/plain") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(PLAIN_HTML);
    } else if (url === "/short") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(SHORT_HTML);
    } else if (url === "/shell") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(SHELL_HTML);
    } else if (url === "/gbk") {
      // No charset in the header: the <meta> sniff has to find it.
      res.writeHead(200, { "content-type": "text/html" }).end(gbkDocument());
    } else if (url === "/redirect") {
      res.writeHead(302, { location: "/static" }).end();
    } else if (url === "/pdf") {
      res.writeHead(200, { "content-type": "application/pdf" }).end("%PDF-1.4\n%âã\n");
    } else {
      res.writeHead(404, { "content-type": "text/html" }).end("<h1>not found</h1>");
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;

  try {
    // ---- HTTP lane: extraction quality --------------------------------
    const article = await readStaticPage(`${base}/static`, { links: true, limit: 400_000 });
    assert.ok(article.ok, "static article is read over HTTP");
    assert.equal(article.source, "main");
    assert.equal(article.title, "Smoke Article Title");
    assert.equal(article.finalUrl, `${base}/static`);
    for (const expected of [
      "# Heading One",
      "## Heading Two",
      "- First item",
      `[Example](${base}/docs/page)`,
      "Key | Value",
      "alpha | 1",
      "if (a < b)",
    ]) {
      assert.ok(article.text.includes(expected), `extraction keeps ${JSON.stringify(expected)}`);
    }
    for (const dropped of ["NAV CHROME", "ASIDE CHROME", "FOOTER CHROME", "SCRIPT JUNK"]) {
      assert.ok(!article.text.includes(dropped), `extraction drops ${JSON.stringify(dropped)}`);
    }

    // No <main>: the body is the article, chrome still goes.
    const plain = await readStaticPage(`${base}/plain`, { links: false, limit: 400_000 });
    assert.ok(plain.ok && plain.source === "body", "a page without <main> reads as body");
    assert.ok(plain.text.includes("Plain Heading"));
    assert.ok(!plain.text.includes("NAV CHROME") && !plain.text.includes("FOOTER CHROME") && !plain.text.includes("SCRIPT JUNK"));

    // links: false must not emit link syntax but keeps the link text.
    assert.ok(!plain.text.includes("]("), "links:false emits no link syntax");

    // ---- HTTP lane: boundaries ----------------------------------------
    const shortPage = await readStaticPage(`${base}/short`, { links: false, limit: 400_000 });
    assert.ok(shortPage.ok, `a short page with real paragraphs is still read (${shortPage.ok ? shortPage.text.length : shortPage.reason} chars)`);

    const gbkPage = await readStaticPage(`${base}/gbk`, { links: false, limit: 400_000 });
    assert.ok(gbkPage.ok, "GBK page is read over HTTP");
    assert.ok(gbkPage.text.includes("中文编码测试"), "GB2312 bytes decode to the right characters");
    assert.ok(gbkPage.text.includes("GBK Heading"));

    const shell = await readStaticPage(`${base}/shell`, { links: false, limit: 400_000 });
    assert.equal(shell.ok, false, "an app shell is a miss for the HTTP lane");
    assert.ok(shell.ok === false && shell.reason.includes("脚本渲染"), shell.ok ? "" : shell.reason);

    await assert.rejects(
      readStaticPage(`${base}/pdf`, { links: false, limit: 400_000 }),
      (err: unknown) => err instanceof StaticPageRejected && err.message.includes("PDF"),
      "PDF is refused in the static lane",
    );

    // ---- the redirect guard runs on the URL actually landed on ---------
    await assert.rejects(
      readStaticPage(`${base}/redirect`, {
        links: false,
        limit: 400_000,
        guard: (finalUrl) => (finalUrl.endsWith("/static") ? "redirect refused by guard" : null),
      }),
      (err: unknown) => err instanceof StaticPageRejected && err.message === "redirect refused by guard",
      "the guard sees the redirected URL, before the body is read",
    );
    assert.ok(landedProblem("http://127.0.0.1:9/"), "landedProblem refuses loopback");
    assert.ok(landedProblem("https://www.baidu.com/s?wd=x"), "landedProblem refuses a results page");
    assert.equal(landedProblem("https://example.com/article"), null);

    // ---- lane selection through webFetch's loader ----------------------
    // The real guard refuses loopback, which is exactly what the fixture is;
    // the loader is called with a permissive one so the lanes can be compared.
    const permissive = () => null;
    const before = windowsCreated;
    const httpPage = await loadPage(`${base}/static`, false, permissive);
    assert.equal(httpPage.via, "http", "a static page takes the HTTP lane");
    assert.equal(windowsCreated, before, "the HTTP lane creates no BrowserWindow");
    assert.equal(BrowserWindow.getAllWindows().length, 0, "and leaves no window behind");
    assert.ok(httpPage.text.includes("# Heading One"));

    const rendered = await loadPage(`${base}/shell`, false, permissive);
    assert.equal(rendered.via, "chromium", "an app shell falls back to Chromium");
    assert.ok(windowsCreated > before, "the fallback really opened a hidden window");
    assert.ok(rendered.text.includes("Rendered by script"), "the fallback returns the rendered text");
    assert.equal(BrowserWindow.getAllWindows().length, 0, "the hidden window is destroyed after the read");

    console.log(
      `PASS: http-first reading (${article.text.length} chars static, ${rendered.text.length} chars rendered, ${windowsCreated} hidden window(s))`,
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    closeDb();
  }
}

main()
  .then(() => app.exit(0))
  .catch((error) => {
    console.error(error);
    app.exit(1);
  });
