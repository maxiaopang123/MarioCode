/**
 * Chat markdown: HTML modules, mermaid, and LaTeX.
 *
 * What this proves, in the order the assertions run:
 *  1. KaTeX renders inline `$…$`, block `$$…$$`, and a BARE `\begin{align}`
 *     environment (no `$$` wrapper) — the case `remark-math` cannot split on
 *     its own and `normalizeMathDelimiters` has to wrap.
 *  2. A ```mermaid fence becomes an `<svg>` (lazy-loaded library, debounced on
 *     a settled source).
 *  3. `<details>` renders and still toggles.
 *  4. The sanitizer actually sanitizes: no script element, no `on*` handler,
 *     no `javascript:` href, and `style` keeps layout declarations while
 *     dropping `position`/`z-index`/`top`/`left`.
 *  4b. Colours fit the theme: a `background:#fff;color:#fff` card becomes a
 *     light card with dark text in light mode and a dark inset with light text
 *     in dark mode; the mermaid SVG is re-rendered with the other palette; and
 *     a fenced code block swaps BOTH its ground (`--code-bg`) and its token
 *     colours when the theme flips.
 *  5. Both switches work: 渲染 HTML off → the markup shows literally; mermaid
 *     off → the fence shows as code.
 *
 * The last two are the point of the feature being opt-out rather than opt-in:
 * if a toggle is ignored, a user cannot get out of a broken render.
 */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { electronTest } from "./electron-test-helper.mjs";

const FENCE = "```";

// A single assistant reply exercising every branch. Note the blank lines: an
// HTML block in CommonMark ends at one, so the `<details>` line is kept
// self-contained rather than spanning paragraphs.
const REPLY = [
  "行内公式 $E=mc^2$ 与 $\\alpha+\\beta$。",
  "",
  "$$",
  "\\int_0^1 x^2\\,dx = \\tfrac{1}{3}",
  "$$",
  "",
  "\\begin{align}",
  "a &= b + c \\\\",
  "d &= e",
  "\\end{align}",
  "",
  `${FENCE}mermaid`,
  "graph TD",
  "  A[开始] --> B{判断}",
  "  B -->|是| C[结束]",
  FENCE,
  "",
  // A fenced code block: shiki bakes its palette into BOTH the token colours
  // and the block's own fill. Section 4b asserts the tokens follow the theme
  // while the fill does not (the card well carries it).
  `${FENCE}ts`,
  "const answer: number = 42;",
  FENCE,
  "",
  "<details><summary>点开看细节</summary><p>折叠里的内容</p></details>",
  "",
  '<div style="position:fixed; top:0; left:0; z-index:9; padding:8px; color:red">彩色卡片</div>',
  "",
  // Theme-fitting probe: written the way a model writes a light-mode card, and
  // deliberately self-defeating in one theme (white text on the near-white
  // fill it will be turned into). Section 4b asserts the renderer reinterprets
  // it per theme instead of trusting the literal values.
  '<div style="background:#ffffff;border:1px solid #eeeeee;color:#ffffff;padding:10px">白色卡片</div>',
  "",
  "<script>window.__mdPwned = 1</script>",
  "",
  // A real 1x1 GIF, so nothing is fetched: the point is the tag surviving
  // with its `onerror` gone. (A bare relative path would be claimed by the
  // local-image branch of the `img` override and never reach the DOM.)
  '<img src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" onerror="window.__mdPwned = 2" alt="probe">',
  "",
  '<a href="javascript:window.__mdPwned=3">bad link</a>',
].join("\n");

await electronTest(
  "markdown-render",
  async (data) => {
    const db = new DatabaseSync(join(data, "claude-gui.db"));
    db.exec("CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL)");
    for (const [key, value] of Object.entries({
      "mobile.enabled": "0",
      "network.proxy": JSON.stringify({ mode: "direct", customUrl: "" }),
      "ui.titleGenEnabled": "0",
    })) {
      db.prepare("INSERT INTO settings VALUES (?,?)").run(key, value);
    }
    db.close();
    await mkdir(join(data, "work"));
  },
  async ({ data, command, evaluate, wait }) => {
    const sessionId = await evaluate(`(async()=>{
      const {project}=await window.api.project.create({name:"md-test",path:${JSON.stringify(join(data, "work").replace(/\\/g, "/"))}});
      const {session}=await window.api.claude.startSession({projectId:project.id,title:"md-check"});
      const now=Date.now();
      await window.api.session.saveMessages({sessionId:session.id,messages:[
        {id:"md-user",sessionId:session.id,role:"user",content:[{kind:"text",text:"test"}],createdAt:now-1000},
        {id:"md-assistant",sessionId:session.id,role:"assistant",content:{blocks:[
          {kind:"text",text:${JSON.stringify(REPLY)}}
        ],turnMeta:{startedAt:now-900,endedAt:now-100,model:"test"}},createdAt:now-900}
      ]});
      await window.api.setting.set({key:"ui.lastProjectId",value:project.id});
      await window.api.setting.set({key:"ui.lastSessionId",value:session.id});
      return session.id;
    })()`);
    assert.ok(sessionId, "session seeded");

    // Re-open the session after a reload (the app restores the last session,
    // but the renderer only re-reads settings at boot).
    const reopen = async () => {
      await command("Page.reload");
      await wait("Boolean(window.api && document.querySelector('button .tabler-icon-settings'))");
      await evaluate(
        `(()=>{const n=[...document.querySelectorAll('[role=button]')].find(n=>n.textContent.includes('md-check'));n?.click()})()`,
      );
      await wait("Boolean(document.querySelector('.chat-md'))");
    };

    // Every `.chat-md` on screen, joined: the user message is also one, and it
    // is the FIRST match — asserting against `querySelector('.chat-md')` would
    // quietly check the wrong node.
    const allText = () => evaluate("[...document.querySelectorAll('.chat-md')].map(el=>el.textContent).join(' | ')");

    await reopen();
    // Streaming renders progressively even for a settled message; wait for the
    // slowest piece (mermaid) so the tree is complete before asserting.
    await wait("Boolean(document.querySelector('[data-mermaid] .mermaid-svg > svg'))");

    /* ── 1. LaTeX ──────────────────────────────────────────────────────── */
    assert.ok(
      (await evaluate("document.querySelectorAll('.chat-md .katex').length")) >= 3,
      "inline, block and bare-environment math all render",
    );
    assert.ok(
      (await evaluate("document.querySelectorAll('.chat-md .katex-display').length")) >= 2,
      "block math and the bare \\begin{align} environment are display blocks",
    );
    // Proof that the environment was actually TYPESET rather than left as
    // text: KaTeX builds an alignment table for `align`, which plain text can
    // never produce. (Note we cannot assert the absence of the source string:
    // KaTeX keeps the TeX in the MathML `<annotation>` for screen readers, so
    // `\begin{align}` is always in textContent for a correctly rendered block.)
    assert.equal(
      await evaluate("document.querySelectorAll('.chat-md .katex-display .mtable').length >= 1"),
      true,
      "the bare \\begin{align} environment typesets as an alignment table",
    );

    /* ── 2. Mermaid ───────────────────────────────────────────────────── */
    // Scoped to the body: the block's own header carries tabler icon <svg>s,
    // so `[data-mermaid] svg` would also count the copy/chevron glyphs.
    assert.equal(
      await evaluate("document.querySelectorAll('[data-mermaid] .mermaid-svg > svg').length"),
      1,
      "mermaid fence renders exactly one diagram (plus the block's icon glyphs)",
    );
    assert.equal(
      await evaluate("document.querySelector('[data-mermaid] .mermaid-svg > svg').getAttribute('class')"),
      "flowchart",
      "the diagram is the flowchart mermaid drew",
    );
    assert.ok(
      (await evaluate(
        "document.querySelector('[data-mermaid] .mermaid-svg > svg').querySelectorAll('path, rect, text').length",
      )) > 0,
      "diagram has drawn nodes",
    );
    assert.ok(
      await evaluate("Boolean(document.querySelector('[data-mermaid] .mermaid-svg > svg').getAttribute('viewBox'))"),
      "diagram scales to the column (viewBox present)",
    );
    assert.equal(
      (await allText()).includes("graph TD"),
      false,
      "diagram source is not also shown",
    );

    /* ── 3. details ───────────────────────────────────────────────────── */
    assert.equal(
      await evaluate("document.querySelectorAll('.chat-md details').length"),
      1,
      "details element is rendered, not escaped",
    );
    assert.equal(
      await evaluate("document.querySelector('.chat-md details > summary').textContent"),
      "点开看细节",
      "summary keeps its text",
    );
    assert.equal(await evaluate("document.querySelector('.chat-md details').open"), false, "starts collapsed");
    await evaluate("document.querySelector('.chat-md details > summary').click()");
    assert.equal(await evaluate("document.querySelector('.chat-md details').open"), true, "still toggles open");

    /* ── 4. Sanitizer ─────────────────────────────────────────────────── */
    assert.equal(
      await evaluate("document.querySelectorAll('.chat-md script').length"),
      0,
      "script elements are stripped",
    );
    assert.equal(await evaluate("typeof window.__mdPwned"), "undefined", "no injected script ran");
    assert.equal(
      await evaluate("document.querySelectorAll('.chat-md [onerror], .chat-md [onclick]').length"),
      0,
      "inline event handlers are stripped",
    );
    assert.equal(
      await evaluate(
        "[...document.querySelectorAll('.chat-md a')].some(a => /^javascript:/i.test(a.getAttribute('href')||''))",
      ),
      false,
      "javascript: href is stripped",
    );
    const style = await evaluate(
      "([...document.querySelectorAll('.chat-md div')].find(el=>el.textContent==='彩色卡片')||{}).getAttribute?.('style') || ''",
    );
    assert.ok(style.includes("padding"), `layout declarations survive (got ${JSON.stringify(style)})`);
    assert.ok(style.includes("color"), `colour survives (got ${JSON.stringify(style)})`);
    for (const banned of ["position", "z-index", "top", "left"]) {
      assert.equal(style.includes(banned), false, `${banned} is filtered out of style`);
    }
    assert.equal(
      await evaluate("document.querySelectorAll('.chat-md img[alt=\"probe\"]').length"),
      1,
      "an allowlisted img still renders",
    );

    /* ── 4b. Theme fitting ────────────────────────────────────────────── */
    // Both rendered artefacts bake colours at RENDER time: the inline styles
    // are rewritten by `fitColorDeclaration`, and mermaid bakes a palette into
    // the SVG it emits. So flipping the theme has to change BOTH without a
    // reload — that is exactly what a re-render, not a CSS variable, buys us.
    const channelSum = (value) =>
      (String(value).match(/[\d.]+/g) ?? []).slice(0, 3).reduce((total, n) => total + Number(n), 0);
    const card = () =>
      evaluate(`(()=>{
        const el=[...document.querySelectorAll('.chat-md div')].find(e=>e.textContent==='白色卡片');
        if(!el) return null;
        const cs=getComputedStyle(el);
        return {style: el.getAttribute('style')||'', bg: cs.backgroundColor, color: cs.color};
      })()`);
    const nodeFill = () =>
      evaluate(
        "(()=>{const r=document.querySelector('[data-mermaid] .mermaid-svg > svg rect');return r?getComputedStyle(r).fill:''})()",
      );
    // Code blocks carry TWO colours: the ground (shiki bakes a palette fill
    // inline, which CSS overrides with `--code-bg`) and the token colours
    // (shiki's own). Both must follow the theme — the tokens especially, since
    // a stale `useMemo` (the bug this guards) left the previous palette's
    // block, white fill and all, sitting in a dark window.
    // `preBg` proves shiki's inline fill was overridden; `bg` walks up to the
    // card that actually paints `--code-bg`.
    const codeBlock = () =>
      evaluate(`(()=>{
        const pre=document.querySelector('.chat-md pre.shiki');
        if(!pre) return null;
        const token=pre.querySelector('span');
        let el=pre, bg='';
        while(el && el!==document.body){
          const v=getComputedStyle(el).backgroundColor;
          if(v && v!=='rgba(0, 0, 0, 0)'){bg=v;break}
          el=el.parentElement;
        }
        return {bg, preBg:getComputedStyle(pre).backgroundColor, color:token?getComputedStyle(token).color:''};
      })()`);
    const setTheme = (dark) =>
      evaluate(
        dark
          ? "document.documentElement.classList.add('dark')"
          : "document.documentElement.classList.remove('dark')",
      );

    // Light: the white fill is snapped onto the app's card ground (still
    // light) and the white TEXT is dropped outright — kept, it would be
    // invisible on that ground. Contrast then comes from the app's own colour.
    await setTheme(false);
    await wait(
      "(()=>{const el=[...document.querySelectorAll('.chat-md div')].find(e=>e.textContent==='白色卡片');return !!el && !(el.getAttribute('style')||'').includes('color')})()",
    );
    const lightCard = await card();
    assert.ok(lightCard, "the probe card is on screen");
    assert.ok(channelSum(lightCard.bg) > 600, `light: fill stays light (${lightCard.bg})`);
    assert.equal(
      lightCard.style.includes("color"),
      false,
      `light: the illegible white text colour is dropped (${lightCard.style})`,
    );
    assert.ok(channelSum(lightCard.color) < 400, `light: text falls back to the dark app colour (${lightCard.color})`);
    assert.ok(lightCard.style.includes("border"), "light: the border declaration survives the refit");

    // Dark: the very same markup must now be a dark inset with light text —
    // the fill's HUE is what survives, its lightness is not.
    await setTheme(true);
    await wait(
      "(()=>{const el=[...document.querySelectorAll('.chat-md div')].find(e=>e.textContent==='白色卡片');return !!el && (el.getAttribute('style')||'').includes('color')})()",
    );
    const darkCard = await card();
    assert.ok(channelSum(darkCard.bg) < 200, `dark: the white fill becomes a dark inset (${darkCard.bg})`);
    assert.ok(channelSum(darkCard.color) > 600, `dark: white text is legible here, so it is kept (${darkCard.color})`);

    // Mermaid: its palette lives inside the SVG, so a stale cache entry (or a
    // stale `initialize`) would keep the previous theme's diagram on screen.
    // The re-render is debounced and asynchronous, so every assertion waits for
    // the fill to actually land rather than reading it straight after the class
    // flip — the card above settles in a microtask, the diagram takes a parse.
    // The card assertions above left the app in dark mode; go back to light.
    await setTheme(false);
    // Plain string, not a template literal: a `\d` that survives Node's own
    // escape processing as `/\\d/` would match nothing at all.
    await evaluate(
      "window.__fillSum=()=>{const r=document.querySelector('[data-mermaid] .mermaid-svg > svg rect');if(!r)return -1;return getComputedStyle(r).fill.slice(4,-1).split(',').map(Number).reduce((a,n)=>a+n,0)};true",
    );
    await wait("window.__fillSum() > 600");
    const lightFill = await nodeFill();
    assert.ok(channelSum(lightFill) > 600, `light: diagram nodes are drawn on the light surface (${lightFill})`);
    assert.equal(
      await evaluate(
        "getComputedStyle(document.querySelector('[data-mermaid] .mermaid-svg > svg')).backgroundColor",
      ),
      "rgba(0, 0, 0, 0)",
      "the SVG itself stays transparent so the block's own surface shows through",
    );

    // Code block, light pass: the highlighter is lazy (first fenced block), so
    // wait for its output rather than reading straight after the reload.
    await wait("Boolean(document.querySelector('.chat-md pre.shiki span'))");
    const lightCode = await codeBlock();
    assert.ok(lightCode, "the fenced block is highlighted");
    // The card paints the code ground from `--code-bg`, and shiki's own fill
    // must not survive on the <pre>. Both halves matter: a real fill keeps the
    // block reading as its own surface, and a light-palette value (a soft step
    // below white) is what stops it looking pasted onto the warm-paper ground.
    assert.equal(
      lightCode.preBg,
      "rgba(0, 0, 0, 0)",
      `light: shiki's inline fill is overridden (${lightCode.preBg})`,
    );
    assert.notEqual(
      lightCode.bg,
      "rgba(0, 0, 0, 0)",
      "light: the card paints a ground of its own",
    );
    assert.ok(
      channelSum(lightCode.bg) > 600 && channelSum(lightCode.bg) < 750,
      `light: that ground is a soft step below white, not #fff (${lightCode.bg})`,
    );

    await setTheme(true);
    await wait("window.__fillSum() > 0 && window.__fillSum() < 300");
    assert.ok(
      channelSum(await nodeFill()) < 300,
      "dark: the same diagram is re-rendered with the dark palette",
    );

    // Code block, dark pass: the ground flips with the palette and the tokens
    // are re-highlighted — this is the screenshot's bug
    // ("代码块输出背景色没有跟随 MarioCode 深浅改变") in assertion form.
    await evaluate(`window.__lightTokenColor=${JSON.stringify(lightCode.color)};true`);
    await wait(
      "(()=>{const t=document.querySelector('.chat-md pre.shiki span');return !!t && getComputedStyle(t).color !== window.__lightTokenColor})()",
    );
    const darkCode = await codeBlock();
    assert.notEqual(
      darkCode.color,
      lightCode.color,
      `dark: the block is re-highlighted, not the stale light palette (${darkCode.color})`,
    );
    assert.notEqual(
      darkCode.bg,
      lightCode.bg,
      `dark: the block's ground follows the palette (still ${darkCode.bg})`,
    );
    assert.ok(
      channelSum(darkCode.bg) < 200,
      `dark: that ground is the dark well, not github-light's white (${darkCode.bg})`,
    );

    /* ── 5a. 渲染 HTML off ────────────────────────────────────────────── */
    await evaluate(
      `window.api.setting.set({key:"ui.chatDisplay",value:JSON.stringify({html:false,mermaid:true,prosePaths:true,remoteImages:"never",trustedDomains:[]})})`,
    );
    await reopen();
    // The renderer paints once with the DEFAULTS (HTML on) and only then
    // receives the persisted `ui.chatDisplay`, so the message re-renders
    // shortly after opening. Wait for the settled state — a fixed sleep races
    // the store load and makes these assertions flaky in both directions.
    await wait("[...document.querySelectorAll('.chat-md')].some(el=>el.textContent.includes('<details>'))");
    assert.equal(
      await evaluate("document.querySelectorAll('.chat-md details, .chat-md img[alt=\"probe\"]').length"),
      0,
      "HTML switch off: nothing from raw markup is rendered",
    );
    // With no rehype-raw the raw nodes reach the React tree as text, i.e. the
    // markup is shown literally — the behaviour the app had before this
    // feature existed, and the reason the switch is a true opt-out.
    assert.equal(
      (await allText()).includes("折叠里的内容"),
      true,
      "HTML switch off: the markup is shown as text",
    );
    // Math and mermaid are independent of the HTML switch.
    assert.ok(
      (await evaluate("document.querySelectorAll('.chat-md .katex').length")) >= 3,
      "HTML switch off leaves math rendering intact",
    );
    await wait("Boolean(document.querySelector('[data-mermaid] .mermaid-svg > svg'))");

    /* ── 5b. mermaid off ──────────────────────────────────────────────── */
    await evaluate(
      `window.api.setting.set({key:"ui.chatDisplay",value:JSON.stringify({html:true,mermaid:false,prosePaths:true,remoteImages:"never",trustedDomains:[]})})`,
    );
    await reopen();
    // Same race as above, opposite direction: the diagram renders under the
    // default and only then disappears when the setting lands. Wait until it
    // is gone AND the source is back as text.
    await wait(
      "document.querySelectorAll('[data-mermaid]').length === 0 && [...document.querySelectorAll('.chat-md')].some(el=>el.textContent.includes('graph TD'))",
    );
    assert.equal(
      await evaluate("document.querySelectorAll('[data-mermaid]').length"),
      0,
      "mermaid switch off: no diagram container",
    );
    assert.equal(
      (await allText()).includes("graph TD"),
      true,
      "mermaid switch off: the fence falls back to a code block",
    );
    assert.equal(
      await evaluate("document.querySelectorAll('.chat-md details').length"),
      1,
      "html switch back on in the same pass",
    );
  },
);
