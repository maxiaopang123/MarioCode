import { app, BrowserWindow, WebContentsView } from "electron";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { BrowserManager } from "@main/browser/BrowserManager.js";
import { initDb, closeDb } from "@main/store/db.js";
import { setTestWindow } from "./window.js";

const delay = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
async function waitFor(test: () => boolean | Promise<boolean>) {
  const until = Date.now() + 8000;
  while (!await test()) { assert.ok(Date.now() < until, "Native browser assertion timed out"); await delay(20); }
}
async function within<T>(result: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([result, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(Error("DOM operation waited for an unfinished resource")), 2000);
    })]);
  } finally { clearTimeout(timer); }
}

async function main() {
  const data = process.env.MARIOCODE_SMOKE_DATA!;
  app.setPath("userData", data);
  app.on("window-all-closed", () => {});
  await app.whenReady();
  await initDb();
  const server = createServer((req, res) => {
    if (req.url === "/never") { res.writeHead(200, { "Content-Type": "image/png" }); res.write(Buffer.from([137,80,78,71])); return; }
    res.end('<html><body style="background:#c9f8d4"><h1>Responsive browser fixture</h1><input id="entry"><img src="/never"></body></html>');
  });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const window = new BrowserWindow({ width: 1000, height: 750, show: true });
  setTestWindow(window);
  try {
    const created = BrowserManager.create(data);
    assert.ok(created.ok);
    const id = created.browserId;
    const view = window.contentView.children.find(v => v instanceof WebContentsView);
    assert.ok(view instanceof WebContentsView);
    const wc = view.webContents;
    const original = { x: 100, y: 90, width: 500, height: 450 };
    const updated = { x: 250, y: 160, width: 420, height: 360 };
    BrowserManager.setBounds(id, original);
    BrowserManager.show(id);
    // loadURL stays pending on /never; dom-ready is the point at which tools can act.
    let domReady = false;
    wc.once("dom-ready", () => { domReady = true; });
    const loaded = wc.loadURL(`http://127.0.0.1:${address.port}`).catch(() => {});
    await waitFor(() => domReady);
    assert.ok(wc.isLoading(), "Fixture resource remains unfinished");
    const snapshot = await within(BrowserManager.snapshot(id, { mode: "text", textCap: 5000, textOffset: 0 }));
    assert.ok(snapshot.ok);
    assert.ok(JSON.stringify(snapshot).includes("Responsive browser fixture"));
    assert.ok((await within(BrowserManager.setPickMode(id, true))).ok);
    assert.ok((await within(BrowserManager.setPickMode(id, false))).ok);
    assert.ok((await within(BrowserManager.type(id, "#entry", "still responsive", true))).ok);
    assert.equal(await wc.mainFrame.executeJavaScript('document.querySelector("#entry").value'), "still responsive");
    wc.stop();
    await loaded;

    // Hold a real native capture in flight while the UI changes its intent.
    async function captureWhile(change: () => void) {
      const realCapture = wc.capturePage.bind(wc);
      let entered = false;
      let release!: () => void;
      const gate = new Promise<void>(r => { release = r; });
      wc.capturePage = async (...args: Parameters<typeof wc.capturePage>) => {
        const image = await realCapture(...args);
        entered = true;
        await gate;
        return image;
      };
      try {
        const pending = BrowserManager.screenshot(id);
        await waitFor(() => entered);
        change();
        release();
        const result = await pending;
        assert.ok(result.ok);
        assert.ok(result.data.length > 0);
        return result;
      } finally { release(); wc.capturePage = realCapture; }
    }
    BrowserManager.hide(id);
    await captureWhile(() => {
      BrowserManager.setBounds(id, updated);
      BrowserManager.show(id);
    });
    assert.deepEqual(view.getBounds(), updated, "Capture cannot restore an old hidden state over a newer show");
    BrowserManager.hide(id);
    await captureWhile(() => BrowserManager.hide(id));
    assert.equal(view.getBounds().x, -9999, "A hide during temporary capture stays hidden");
    await captureWhile(() => BrowserManager.setBounds(id, original));
    assert.equal(view.getBounds().x, -9999, "Resizing a hidden capture must keep it hidden");
    BrowserManager.show(id);
    assert.deepEqual(view.getBounds(), original, "Hidden resize retains the latest restore bounds");
    BrowserManager.hide(id);
    await captureWhile(() => {});
    assert.equal(view.getBounds().x, -9999, "Capture without a UI change restores hidden presentation");
    assert.equal(view.getBounds().width, original.width);
    BrowserManager.show(id);
    await delay(100);
    const image = await BrowserManager.screenshot(id);
    assert.ok(image.ok && image.data.length > 0);
    writeFileSync(join(data, "browser-native.png"), Buffer.from(image.data, "base64"));
    console.log("PASS: unfinished-resource DOM operations and native capture visibility races");
  } finally {
    BrowserManager.disposeAll();
    window.destroy();
    server.closeAllConnections();
    await new Promise<void>(r => server.close(() => r()));
    closeDb();
  }
}
main().then(() => app.exit(0)).catch(error => { console.error(error); app.exit(1); });
