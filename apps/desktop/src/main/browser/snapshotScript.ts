/**
 * Page-injection scripts for the agent browser tools, executed in the browser
 * view's page main world via `webContents.executeJavaScript()`.
 *
 * Like `pickerScript.ts`, these are string constants (NOT modules) because
 * executeJavaScript runs in the page's own context with no access to our
 * process's module scope. Each IIFE takes its arguments as JSON-stringified
 * slots (`%XXX_JSON%`) that `build*Script()` fills with `JSON.stringify` —
 * which produces a valid JS string literal, so quotes / backslashes /
 * newlines in selectors, texts and code can never break out of the script
 * syntax. Values are only ever consumed by `JSON.parse` / `querySelector`,
 * never interpolated into the source.
 *
 * The IIFEs return plain JSON-serializable objects, which Electron
 * auto-marshals back across the process boundary as the awaited return value.
 */

/** Body-text budget of one snapshot, in characters. The model moves it per
 *  call with `maxChars` inside [MIN, MAX] and pages through long text with
 *  `offset`, so a long article never lands in the context in one piece. */
export const SNAPSHOT_TEXT_DEFAULT = 4000;
export const SNAPSHOT_TEXT_MIN = 500;
export const SNAPSHOT_TEXT_MAX = 20000;
/** Cap the number of interactive elements collected from the page. */
export const SNAPSHOT_INTERACTIVE_CAP = 200;
/** Cap the number of interactive elements RENDERED into the tool result text
 *  (the collection cap above is larger so the index map stays useful deeper
 *  into the page; the text budget is what bounds the model's context).
 *  `interactive` mode carries no body text, so it can afford more rows. */
export const SNAPSHOT_DISPLAY_CAP = 40;
export const SNAPSHOT_DISPLAY_CAP_INTERACTIVE = 80;

/** What a snapshot reads: elements + text (default), elements only, or text
 *  only (reading an article). */
export type SnapshotMode = "both" | "interactive" | "text";

/**
 * Main-content text extraction, spliced into page scripts as source (these
 * scripts can't import — see the file header). Shared by the agent snapshot
 * and the web_fetch reader so both read a page the same way.
 *
 * `mcMainRoot(document)` picks the content root: the longest <main> /
 * [role=main] when it holds a real share of the page text, else the longest
 * <article>, else the element whose direct <p> children carry most of the
 * paragraph text, else <body>.
 *
 * `mcExtractText(root, opts)` walks the visible DOM under that root into
 * light Markdown (headings `#`, list items `- `, table cells ` | `, <pre>
 * fenced), dropping navigation, sidebars, footers, buttons, selects, dialogs,
 * media and hidden / aria-hidden subtrees — and the site <header> when the
 * root is <body> (`siteChrome`). `links: true` renders anchors as
 * [text](absolute-url). Output stops growing at `limit` characters.
 */
export const MAIN_TEXT_JS = `
  function mcMainRoot(doc) {
    var body = doc.body;
    if (!body) return null;
    function len(el) { try { return (el.innerText || '').length; } catch (e) { return 0; } }
    function longest(list) {
      var best = null;
      var bestLen = 0;
      for (var i = 0; i < list.length; i++) {
        var l = len(list[i]);
        if (l > bestLen) { best = list[i]; bestLen = l; }
      }
      return { el: best, len: bestLen };
    }
    var bodyLen = len(body);
    var m = longest(doc.querySelectorAll('main, [role="main"]'));
    if (m.el && m.len >= 200 && m.len >= bodyLen * 0.3) return { el: m.el, kind: 'main' };
    var a = longest(doc.querySelectorAll('article'));
    if (a.el && a.len >= 200 && a.len >= bodyLen * 0.25) return { el: a.el, kind: 'article' };
    var ps = body.querySelectorAll('p');
    if (ps.length >= 3) {
      var scores = new Map();
      var total = 0;
      for (var k = 0; k < ps.length && k < 3000; k++) {
        var parent = ps[k].parentElement;
        var n = (ps[k].textContent || '').trim().length;
        if (!parent || n < 20) continue;
        total += n;
        scores.set(parent, (scores.get(parent) || 0) + n);
      }
      var top = null;
      var topScore = 0;
      scores.forEach(function (v, el) { if (v > topScore) { topScore = v; top = el; } });
      if (top && topScore >= 500 && topScore >= total * 0.5) return { el: top, kind: 'block' };
    }
    return { el: body, kind: 'body' };
  }

  function mcExtractText(root, opts) {
    opts = opts || {};
    var links = !!opts.links;
    var siteChrome = !!opts.siteChrome;
    var limit = opts.limit > 0 ? opts.limit : 200000;
    var FENCE = String.fromCharCode(96, 96, 96);
    var SKIP = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEMPLATE: 1, SVG: 1, CANVAS: 1, IFRAME: 1, OBJECT: 1, EMBED: 1,
      NAV: 1, ASIDE: 1, FOOTER: 1, BUTTON: 1, SELECT: 1, DIALOG: 1, MENU: 1, IMG: 1, PICTURE: 1, VIDEO: 1, AUDIO: 1 };
    var SKIP_ROLES = { navigation: 1, banner: 1, contentinfo: 1, complementary: 1, search: 1, menu: 1, menubar: 1,
      dialog: 1, alertdialog: 1, tooltip: 1 };
    var BLOCK = { ADDRESS: 1, ARTICLE: 1, BLOCKQUOTE: 1, CAPTION: 1, DD: 1, DETAILS: 1, DIV: 1, DL: 1, DT: 1,
      FIELDSET: 1, FIGCAPTION: 1, FIGURE: 1, FORM: 1, H1: 1, H2: 1, H3: 1, H4: 1, H5: 1, H6: 1, HEADER: 1, LI: 1,
      MAIN: 1, OL: 1, P: 1, PRE: 1, SECTION: 1, SUMMARY: 1, TABLE: 1, TR: 1, UL: 1 };
    var PARA = { P: 1, H1: 1, H2: 1, H3: 1, H4: 1, H5: 1, H6: 1, PRE: 1, TABLE: 1, BLOCKQUOTE: 1 };
    var out = [];
    var size = 0;
    // Newlines at the end of the output so far: block boundaries top it up
    // (brk) instead of stacking, and whitespace at a line start is dropped.
    var trail = 2;
    function push(s) {
      if (!s || size >= limit) return;
      out.push(s);
      size += s.length;
      var m = /\\n*$/.exec(s)[0].length;
      trail = m === s.length ? trail + m : m;
    }
    function brk(n) { while (trail < n && size < limit) push('\\n'); }
    function hiddenEl(el) {
      if (el.hidden || el.getAttribute('aria-hidden') === 'true') return true;
      var cs = window.getComputedStyle(el);
      if (el.getClientRects().length === 0) return cs.display !== 'contents';
      return cs.visibility === 'hidden' || cs.visibility === 'collapse';
    }
    function walk(node, pre) {
      if (size >= limit) return;
      if (node.nodeType === 3) {
        var t = node.nodeValue || '';
        if (!pre) {
          t = t.replace(/\\s+/g, ' ');
          if (t === ' ' && trail > 0) return;
        }
        push(t);
        return;
      }
      if (node.nodeType !== 1) return;
      var el = node;
      var tag = el.tagName;
      if (SKIP[tag]) return;
      var role = el.getAttribute('role');
      if (role && SKIP_ROLES[role]) return;
      if (tag === 'HEADER' && siteChrome && !el.closest('article, main, [role="main"]')) return;
      if (hiddenEl(el)) return;
      if (tag === 'BR') { push('\\n'); return; }
      if (tag === 'HR') { brk(2); push('---'); brk(2); return; }
      var block = BLOCK[tag] === 1;
      var gap = PARA[tag] === 1 ? 2 : 1;
      if (block) brk(gap);
      if (/^H[1-6]$/.test(tag)) push('######'.slice(0, +tag.charAt(1)) + ' ');
      else if (tag === 'LI') push('- ');
      else if (tag === 'PRE') push(FENCE + '\\n');
      if ((tag === 'TD' || tag === 'TH') && el.previousElementSibling) push(' | ');
      var href = '';
      if (links && tag === 'A') {
        var raw = el.getAttribute('href') || '';
        if (raw && !/^(javascript:|#|mailto:)/i.test(raw)) {
          try { href = new URL(raw, location.href).href; } catch (e) { href = ''; }
        }
      }
      var mark = out.length;
      var markSize = size;
      var childPre = pre || tag === 'PRE' || tag === 'TEXTAREA';
      for (var c = el.firstChild; c; c = c.nextSibling) walk(c, childPre);
      if (href) {
        var inner = out.splice(mark).join('').replace(/\\s+/g, ' ').trim();
        size = markSize;
        if (inner) push('[' + inner + '](' + href + ')');
      }
      if (tag === 'PRE') { brk(1); push(FENCE); }
      if (block) brk(gap);
    }
    walk(root, false);
    var lines = out.join('').split('\\n');
    var clean = [];
    var inFence = false;
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (line.trim() === FENCE) { inFence = !inFence; clean.push(FENCE); continue; }
      clean.push(inFence ? line.replace(/\\s+$/, '') : line.replace(/[ \\t\\u00a0]+/g, ' ').trim());
    }
    return clean.join('\\n').replace(/\\n{3,}/g, '\\n\\n').trim();
  }
`;

/**
 * Snapshot script, one `%ARG_JSON%` slot `{ mode, textCap, textOffset }`
 * (see buildSnapshotScript). Returns `{ url, title, readyState, bodyText,
 * textTotal, textOffset, textSource, interactive }`.
 *
 * `interactive` (skipped in `text` mode): each entry carries a 1-based
 * `index` (the handle the model passes to `browser_click` / `browser_type` /
 * `browser_select`), the form state needed to understand the page (value /
 * checked / disabled / placeholder / href — same-origin hrefs shortened to
 * their path), an `inView` flag (false = below the fold, clicking scrolls it
 * into view) and the stable `selector` as a fallback handle. Only genuinely
 * interactive roles are collected; aria-hidden elements, headings nested in a
 * link, and repeated links (same href + name) are dropped.
 *
 * `bodyText` (skipped in `interactive` mode): the [textOffset, textOffset +
 * textCap) slice of the main-content text (MAIN_TEXT_JS); `textTotal` is the
 * whole text's length and `textSource` the root it came from.
 */
const SNAPSHOT_SCRIPT = `
(function (argJson) {
  var arg = {};
  try { arg = JSON.parse(argJson) || {}; } catch (e) { arg = {}; }
  var mode = arg.mode === 'interactive' || arg.mode === 'text' ? arg.mode : 'both';
  var textCap = typeof arg.textCap === 'number' && arg.textCap > 0 ? arg.textCap : ${SNAPSHOT_TEXT_DEFAULT};
  var textOffset = typeof arg.textOffset === 'number' && arg.textOffset > 0 ? Math.floor(arg.textOffset) : 0;
  var intCap = ${SNAPSHOT_INTERACTIVE_CAP};
${MAIN_TEXT_JS}
  function clip(s, n) {
    if (!s) return '';
    s = String(s).replace(/\\s+/g, ' ').trim();
    return s.length > n ? s.slice(0, n) + '\\u2026' : s;
  }

  // Stable CSS selector for an element: prefer id, then a class chain, falling
  // back to nth-child path. Mirrors pickerScript's buildSelector so selectors
  // are consistent between the human picker and the agent snapshot/click path.
  function buildSelector(el) {
    if (el.id) return '#' + CSS.escape(el.id);
    var parts = [];
    var node = el;
    while (node && node.nodeType === 1 && node !== document.documentElement) {
      var part = node.tagName.toLowerCase();
      if (node.id) { part += '#' + CSS.escape(node.id); parts.unshift(part); break; }
      var classes = Array.from(node.classList).filter(Boolean);
      if (classes.length) part += '.' + classes.map(function (c) { return CSS.escape(c); }).join('.');
      var parent = node.parentElement;
      if (parent) {
        var sameTag = Array.from(parent.children).filter(function (c) { return c.tagName === node.tagName; });
        if (sameTag.length > 1) {
          var idx = sameTag.indexOf(node) + 1;
          part += ':nth-child(' + idx + ')';
        }
      }
      parts.unshift(part);
      node = node.parentElement;
      if (parts.length >= 5) break;
    }
    return parts.join(' > ');
  }

  // Best-effort accessible name: aria-label/aria-labelledby > associated
  // <label> > placeholder > visible inner text.
  function accName(el) {
    var labelled = el.getAttribute('aria-labelledby');
    if (labelled) {
      var targets = labelled.split(/\\s+/).map(function (id) { return document.getElementById(id); }).filter(Boolean);
      if (targets.length) return clip(targets.map(function (t) { return t.textContent; }).join(' '), 60);
    }
    var al = el.getAttribute('aria-label');
    if (al) return clip(al, 60);
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') {
      if (el.id) {
        var lbl = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
        if (lbl && lbl.textContent) return clip(lbl.textContent, 60);
      }
      var ph = el.getAttribute('placeholder');
      if (ph) return clip(ph, 60);
      // A select's text is every option glued together; its value is shown
      // in the state annotations instead.
      if (el.tagName === 'SELECT') return '';
    }
    return clip(el.textContent, 60);
  }

  // Current form state of an element, as human-readable annotations the model
  // can read directly (value / checked / disabled / placeholder / href).
  function stateAnnotations(el) {
    var parts = [];
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
      var v = '';
      if (el.type === 'checkbox' || el.type === 'radio') {
        parts.push(el.checked ? '[checked]' : '[unchecked]');
      } else {
        try { v = String(el.value || ''); } catch (e) { v = ''; }
        if (v) parts.push('value=' + JSON.stringify(clip(v, 40)));
      }
      if (el.disabled) parts.push('[disabled]');
      if (el.readOnly) parts.push('[readonly]');
    } else if (el.tagName === 'SELECT') {
      var sel = el.selectedOptions && el.selectedOptions[0];
      if (sel) parts.push('value=' + JSON.stringify(clip(sel.value, 40)));
      if (el.disabled) parts.push('[disabled]');
    }
    var ph = el.getAttribute && el.getAttribute('placeholder');
    if (ph) parts.push('placeholder=' + JSON.stringify(clip(ph, 40)));
    if (el.tagName === 'A' && el.href) {
      var hv = el.href;
      try {
        var u = new URL(el.href);
        if (u.origin === location.origin && /^https?:$/.test(u.protocol)) hv = u.pathname + u.search + u.hash;
      } catch (e) { /* keep the absolute href */ }
      parts.push('href=' + JSON.stringify(clip(hv, 80)));
    }
    return parts;
  }

  var interactive = [];
  if (mode !== 'text') {
    var selector = 'a, button, input, select, textarea, summary, [onclick], [contenteditable="true"], [contenteditable=""], ' +
      '[role="button"], [role="link"], [role="checkbox"], [role="radio"], [role="switch"], [role="tab"], ' +
      '[role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"], [role="option"], [role="combobox"], ' +
      '[role="textbox"], [role="searchbox"], [role="slider"], [role="spinbutton"], [role="treeitem"], h1, h2, h3';
    var nodes = document.querySelectorAll(selector);
    var vw = window.innerWidth || 0;
    var vh = window.innerHeight || 0;
    var seenLinks = {};
    for (var i = 0; i < nodes.length && interactive.length < intCap; i++) {
      var el = nodes[i];
      var tag = el.tagName.toLowerCase();
      if (el.closest('[aria-hidden="true"]')) continue;
      if (tag === 'input' && (el.type || '').toLowerCase() === 'hidden') continue;
      if (/^h[1-3]$/.test(tag) && el.closest('a, button, nav, aside, footer')) continue;
      // Skip elements not visible in the layout (display:none / hidden ancestors).
      var rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) {
        var cs = window.getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden') continue;
      }
      var name = accName(el);
      if (tag === 'a' && el.href) {
        var linkKey = el.href + ' ' + name;
        if (seenLinks[linkKey]) continue;
        seenLinks[linkKey] = 1;
      }
      // inView: any part of the element's rect intersects the viewport. Elements
      // below the fold are still collected — the model scrolls to reach them.
      var inView = rect.bottom > 0 && rect.top < vh && rect.right > 0 && rect.left < vw;
      interactive.push({
        index: interactive.length + 1,
        role: el.getAttribute('role') || tag,
        name: name,
        tag: tag,
        selector: buildSelector(el),
        text: tag === 'select' ? '' : clip(el.textContent, 60),
        inView: inView,
        state: stateAnnotations(el),
      });
    }
  }

  var bodyText = '';
  var textTotal = 0;
  var textSource = '';
  if (mode !== 'interactive') {
    var root = mcMainRoot(document);
    if (root) {
      var full = mcExtractText(root.el, { siteChrome: root.kind === 'body' });
      textTotal = full.length;
      textSource = root.kind;
      textOffset = Math.min(textOffset, textTotal);
      bodyText = full.slice(textOffset, textOffset + textCap);
    }
  }

  return {
    url: location.href,
    title: document.title,
    readyState: document.readyState,
    bodyText: bodyText,
    textTotal: textTotal,
    textOffset: textOffset,
    textSource: textSource,
    interactive: interactive,
  };
})(%ARG_JSON%);
`;

/**
 * Click script (fallback path): locates an element by CSS selector and clicks
 * it programmatically. This triggers the DOM `click` event and framework
 * handlers, but NOT the full input pipeline (no hover/mousedown sequence), so
 * the primary click path is a real mouse event pair dispatched from the main
 * process at the element's center (see ELEMENT_CENTER_SCRIPT). This fallback
 * still works for hidden/zero-size elements that a programmatic click can
 * reach. Returns the post-click url + title so the caller can tell whether the
 * click triggered a navigation.
 */
export const CLICK_SCRIPT = `
(function (selectorJson) {
  var sel;
  try { sel = JSON.parse(selectorJson); } catch (e) { return { error: 'invalid selector json' }; }
  if (typeof sel !== 'string' || !sel) return { error: 'empty selector' };
  var el = document.querySelector(sel);
  if (!el) return { error: 'element not found for selector: ' + sel };
  try {
    el.click();
  } catch (e) {
    return { error: 'click threw: ' + (e && e.message ? e.message : String(e)) };
  }
  return { ok: true, url: location.href, title: document.title };
})(%SELECTOR_JSON%);
`;

/**
 * Element-center resolution for the real-mouse click path: scrolls the element
 * into view, computes its viewport-center coordinates (for
 * `webContents.sendInputEvent` mouse events — same CSS-pixel space as
 * getBoundingClientRect), and checks what actually sits at that point
 * (`document.elementFromPoint`) so an overlay covering the target can be
 * reported instead of silently click-jacked. Returns `{ fallback: true }` when
 * the element has no layout box (the caller should fall back to CLICK_SCRIPT).
 */
export const ELEMENT_CENTER_SCRIPT = `
(function (selectorJson) {
  var sel;
  try { sel = JSON.parse(selectorJson); } catch (e) { return { error: 'invalid selector json' }; }
  if (typeof sel !== 'string' || !sel) return { error: 'empty selector' };
  var el = document.querySelector(sel);
  if (!el) return { error: 'element not found for selector: ' + sel };
  try { el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }); } catch (e) { /* detached */ }
  var r = el.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) return { fallback: true };
  var x = Math.round(r.left + r.width / 2);
  var y = Math.round(r.top + r.height / 2);
  var hit = null;
  try { hit = document.elementFromPoint(x, y); } catch (e) { /* noop */ }
  var obscured = null;
  if (hit && hit !== el && !el.contains(hit) && !hit.contains(el)) {
    obscured = {
      tag: hit.tagName.toLowerCase(),
      text: (hit.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 60),
    };
  }
  return { ok: true, x: x, y: y, obscured: obscured, url: location.href, title: document.title };
})(%SELECTOR_JSON%);
`;

/**
 * Type/fill script: locates an element by CSS selector and sets its value to
 * the given text. Handles <input>, <textarea> and contenteditable elements.
 *
 * Value-setting strategy: instead of assigning `el.value = text` directly
 * (which silently no-ops on React/Vue controlled inputs because the framework
 * owns the value via its own setter), we use the element prototype's native
 * value setter and then dispatch `input` + `change` events. React's onChange
 * listens to the native `input` event, so the framework's state updates and
 * the controlled value round-trips correctly.
 *
 * `clear=false` appends to the current value instead of replacing it.
 * The element is focused, so a follow-up browser_keys({keys:"Enter"}) acts on
 * it (form submission etc).
 */
export const TYPE_SCRIPT = `
(function (selectorJson, textJson, clearJson) {
  var sel, text, clear;
  try { sel = JSON.parse(selectorJson); } catch (e) { return { error: 'invalid selector json' }; }
  try { text = JSON.parse(textJson); } catch (e) { return { error: 'invalid text json' }; }
  try { clear = JSON.parse(clearJson); } catch (e) { clear = true; }
  if (typeof sel !== 'string' || !sel) return { error: 'empty selector' };
  if (typeof text !== 'string') return { error: 'text must be a string' };
  if (clear !== false) clear = true;
  var el = document.querySelector(sel);
  if (!el) return { error: 'element not found for selector: ' + sel };
  try {
    el.focus();
    if (el.isContentEditable || el.getAttribute('contenteditable') === 'true') {
      // Contenteditable: replace/append text content directly.
      el.textContent = clear ? text : (el.textContent || '') + text;
    } else if (el.tagName === 'TEXTAREA') {
      var desc = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value');
      var current = clear ? '' : String(el.value || '');
      desc.set.call(el, current + text);
    } else if (el.tagName === 'INPUT') {
      var proto = Object.getPrototypeOf(el);
      var inputDesc = Object.getOwnPropertyDescriptor(proto, 'value') ||
                 Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
      if (!inputDesc || !inputDesc.set) return { error: 'input value setter unavailable' };
      if (el.type === 'checkbox' || el.type === 'radio') return { error: 'element is a checkbox/radio — use browser_click instead' };
      var cur = clear ? '' : String(el.value || '');
      inputDesc.set.call(el, cur + text);
    } else {
      return { error: 'element is not an input, textarea or contenteditable: ' + sel };
    }
    // Dispatch change/input so framework state (React/Vue) picks the value up.
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  } catch (e) {
    return { error: 'type threw: ' + (e && e.message ? e.message : String(e)) };
  }
  return { ok: true, value: String(el.value !== undefined ? el.value : ''), url: location.href, title: document.title };
})(%SELECTOR_JSON%, %TEXT_JSON%, %CLEAR_JSON%);
`;

/**
 * Scroll script: scrolls the window (or a specific element's scrollable box)
 * by a fraction of the viewport height. Returns the resulting scroll position
 * so the model can tell where it landed and whether more content remains.
 */
export const SCROLL_SCRIPT = `
(function (argJson) {
  var arg;
  try { arg = JSON.parse(argJson); } catch (e) { return { error: 'invalid args json' }; }
  var dir = arg.dir === 'up' ? -1 : 1;
  var pages = typeof arg.pages === 'number' && isFinite(arg.pages) && arg.pages > 0 ? arg.pages : 1;
  var target = null;
  if (arg.selector) {
    target = document.querySelector(arg.selector);
    if (!target) return { error: 'element not found for selector: ' + arg.selector };
  }
  var amount = Math.round(pages * (target ? target.clientHeight : window.innerHeight));
  if (target) {
    target.scrollTop = target.scrollTop + dir * amount;
  } else {
    window.scrollBy(0, dir * amount);
  }
  return {
    ok: true,
    scrollY: Math.round(target ? target.scrollTop : window.scrollY),
    scrollHeight: target ? target.scrollHeight : (document.documentElement ? document.documentElement.scrollHeight : 0),
    viewport: target ? target.clientHeight : window.innerHeight,
    url: location.href,
    title: document.title,
  };
})(%ARG_JSON%);
`;

/**
 * One poll of the wait condition: element presence (optionally requiring a
 * non-zero layout box) and/or text presence in body innerText. The main
 * process loops this on an interval until it reports found or times out.
 */
export const WAIT_SCRIPT = `
(function (argJson) {
  var arg;
  try { arg = JSON.parse(argJson); } catch (e) { return { error: 'invalid args json' }; }
  if (arg.selector) {
    var el = document.querySelector(arg.selector);
    if (!el) return { found: false, reason: 'selector 未出现' };
    if (arg.requireVisible !== false) {
      var r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) {
        var cs = window.getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden') return { found: false, reason: 'selector 已出现但仍不可见' };
      }
    }
    return { found: true, url: location.href, title: document.title };
  }
  if (arg.text) {
    var body = document.body ? document.body.innerText : '';
    if (body.indexOf(arg.text) === -1) return { found: false, reason: '文本未出现' };
    return { found: true, url: location.href, title: document.title };
  }
  return { found: true, url: location.href, title: document.title };
})(%ARG_JSON%);
`;

/**
 * Native <select> dropdown: selects the option matching value or exact visible
 * text, and dispatches input/change so framework state updates. On no match,
 * returns the option list (value + text) so the model can retry with an exact
 * spelling instead of guessing. Custom (div-based) dropdown widgets are NOT
 * native selects — the error says to click them open instead.
 */
export const SELECT_SCRIPT = `
(function (selectorJson, valueJson) {
  var sel, value;
  try { sel = JSON.parse(selectorJson); } catch (e) { return { error: 'invalid selector json' }; }
  try { value = JSON.parse(valueJson); } catch (e) { return { error: 'invalid value json' }; }
  if (typeof sel !== 'string' || !sel) return { error: 'empty selector' };
  var el = document.querySelector(sel);
  if (!el) return { error: 'element not found for selector: ' + sel };
  if (el.tagName !== 'SELECT') {
    return { error: '元素不是原生 <select>(自定义下拉组件请用 browser_click 展开后再点击选项): ' + sel };
  }
  var opts = [];
  for (var i = 0; i < el.options.length && i < 60; i++) {
    var o = el.options[i];
    opts.push({ value: o.value, text: (o.text || '').trim(), selected: o.selected });
  }
  var v = String(value == null ? '' : value).trim();
  var target = null;
  for (var j = 0; j < el.options.length; j++) {
    var oj = el.options[j];
    if (oj.value === v || (oj.text || '').trim() === v) { target = oj; break; }
  }
  if (!target) {
    return { error: '没有匹配 "' + v + '" 的选项(注意大小写与空格)', options: opts };
  }
  try {
    el.focus();
    el.value = target.value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  } catch (e) {
    return { error: 'select threw: ' + (e && e.message ? e.message : String(e)) };
  }
  return {
    ok: true,
    selected: { value: target.value, text: (target.text || '').trim() },
    url: location.href,
    title: document.title,
  };
})(%SELECTOR_JSON%, %VALUE_JSON%);
`;

/**
 * Find/search script — the cheap alternative to dumping raw HTML:
 *  - selector mode: querySelectorAll under an optional scope, returning each
 *    element's tag/text plus a stable selector (so a found row can be clicked)
 *    and any requested attributes (href/src/class/…).
 *  - text mode: literal or regex search over the page text (optionally scoped)
 *    returning surrounding-context snippets.
 */
export const FIND_SCRIPT = `
(function (argJson) {
  var arg;
  try { arg = JSON.parse(argJson); } catch (e) { return { error: 'invalid args json' }; }
  var maxResults = typeof arg.maxResults === 'number' && arg.maxResults > 0 ? Math.min(arg.maxResults, 100) : 25;
  function clip(s, n) {
    if (!s) return '';
    s = String(s).replace(/\\s+/g, ' ').trim();
    return s.length > n ? s.slice(0, n) + '\\u2026' : s;
  }
  function buildSelector(el) {
    if (el.id) return '#' + CSS.escape(el.id);
    var parts = [];
    var node = el;
    while (node && node.nodeType === 1 && node !== document.documentElement) {
      var part = node.tagName.toLowerCase();
      if (node.id) { part += '#' + CSS.escape(node.id); parts.unshift(part); break; }
      var classes = Array.from(node.classList).filter(Boolean);
      if (classes.length) part += '.' + classes.map(function (c) { return CSS.escape(c); }).join('.');
      var parent = node.parentElement;
      if (parent) {
        var sameTag = Array.from(parent.children).filter(function (c) { return c.tagName === node.tagName; });
        if (sameTag.length > 1) part += ':nth-child(' + (sameTag.indexOf(node) + 1) + ')';
      }
      parts.unshift(part);
      node = node.parentElement;
      if (parts.length >= 4) break;
    }
    return parts.join(' > ');
  }
  var scope = document;
  if (arg.cssScope) {
    scope = document.querySelector(arg.cssScope);
    if (!scope) return { error: 'cssScope 未匹配到元素: ' + arg.cssScope };
  }
  if (arg.selector) {
    var attrs = Array.isArray(arg.attributes) ? arg.attributes.filter(function (a) { return typeof a === 'string'; }).slice(0, 8) : null;
    var out = [];
    var nodes = scope.querySelectorAll(arg.selector);
    for (var i = 0; i < nodes.length && out.length < maxResults; i++) {
      var el = nodes[i];
      var item = { tag: el.tagName.toLowerCase(), text: clip(el.textContent, 120), selector: buildSelector(el) };
      if (attrs && attrs.length) {
        var a = {};
        for (var k = 0; k < attrs.length; k++) {
          var name = attrs[k];
          var v = null;
          if (name === 'href' && el.href) v = el.href;
          else if (name === 'src' && el.src) v = el.src;
          else v = el.getAttribute(name);
          if (v) a[name] = clip(v, 300);
        }
        item.attributes = a;
      }
      out.push(item);
    }
    return { ok: true, total: nodes.length, matches: out, url: location.href, title: document.title };
  }
  if (arg.text) {
    var src = (scope === document ? (document.body ? document.body.innerText : '') : scope.innerText) || '';
    var flags = arg.caseSensitive ? 'g' : 'gi';
    var re;
    try {
      re = arg.regex ? new RegExp(arg.text, flags) : new RegExp(arg.text.replace(/[.*+?^\${}()|[\\]\\\\]/g, '\\\\$&'), flags);
    } catch (e) {
      return { error: '无效的正则表达式: ' + e.message };
    }
    var matches = [];
    var m;
    while ((m = re.exec(src)) !== null && matches.length < maxResults) {
      var start = Math.max(0, m.index - (arg.contextChars || 150));
      var end = Math.min(src.length, m.index + m[0].length + (arg.contextChars || 150));
      matches.push({ snippet: src.slice(start, m.index) + '»' + m[0] + '«' + src.slice(m.index + m[0].length, end) });
      if (m.index === re.lastIndex) re.lastIndex++;
    }
    return { ok: true, matches: matches, url: location.href, title: document.title };
  }
  return { error: '需要 selector 或 text 参数之一' };
})(%ARG_JSON%);
`;

/**
 * Evaluate script: runs arbitrary JS in the page's main world via
 * `new Function(code)()` and returns a JSON-serialized view of the result.
 * This is the "model can modify the page DOM directly" escape hatch —
 * anything reachable from the page (text nodes, styles, attributes, events)
 * can be changed. Result serialization: JSON.stringify succeeds for plain
 * data; DOM elements, functions and cyclic objects fall back to
 * String(result), and undefined reports "(undefined)".
 */
export const EVALUATE_SCRIPT = `
(function (scriptJson) {
  var code;
  try { code = JSON.parse(scriptJson); } catch (e) { return { error: 'invalid script json' }; }
  if (typeof code !== 'string' || !code) return { error: 'empty script' };
  var result;
  try {
    result = new Function(code)();
  } catch (e) {
    return { error: 'script threw: ' + (e && e.message ? e.message : String(e)) };
  }
  var text;
  if (result === undefined) {
    text = '(undefined)';
  } else {
    try {
      text = JSON.stringify(result, null, 2);
      if (text === undefined) text = String(result);
    } catch (e) {
      text = String(result);
    }
  }
  return { ok: true, result: text, url: location.href, title: document.title };
})(%SCRIPT_JSON%);
`;

/**
 * File-input pre-check for browser_upload_file: verifies the selector hits an
 * enabled `<input type="file">` BEFORE the CDP round-trip, so the model gets a
 * readable error (CDP's own DOM.setFileInputFiles failure messages are
 * cryptic about which side failed). Read-only.
 */
export const CHECK_FILE_INPUT_SCRIPT = `
(function (selectorJson) {
  var sel;
  try { sel = JSON.parse(selectorJson); } catch (e) { return { error: 'invalid selector json' }; }
  if (typeof sel !== 'string' || !sel) return { error: 'empty selector' };
  var el = document.querySelector(sel);
  if (!el) return { error: 'element not found for selector: ' + sel };
  if (el.tagName !== 'INPUT' || (el.type || '').toLowerCase() !== 'file') {
    return { error: '元素不是 <input type="file">' + (el.tagName === 'INPUT' ? '(type=' + el.type + ')' : '') + ': ' + sel };
  }
  if (el.disabled) return { error: '文件输入框已被禁用: ' + sel };
  return { ok: true, multiple: !!el.multiple };
})(%SELECTOR_JSON%);
`;

/* ── script builders ────────────────────────────────────────────────────
 * Each fills the JSON slots of its script constant. JSON.stringify output
 * is a valid JS string literal, so arbitrary model-supplied values are
 * injection-safe.
 * ────────────────────────────────────────────────────────────────────── */

export function buildSnapshotScript(arg: { mode: SnapshotMode; textCap: number; textOffset: number }): string {
  return SNAPSHOT_SCRIPT.replace("%ARG_JSON%", JSON.stringify(JSON.stringify(arg)));
}

export function buildClickScript(selector: string): string {
  return CLICK_SCRIPT.replace("%SELECTOR_JSON%", JSON.stringify(JSON.stringify(selector)));
}

export function buildCheckFileInputScript(selector: string): string {
  return CHECK_FILE_INPUT_SCRIPT.replace("%SELECTOR_JSON%", JSON.stringify(JSON.stringify(selector)));
}

export function buildEvaluateScript(code: string): string {
  return EVALUATE_SCRIPT.replace("%SCRIPT_JSON%", JSON.stringify(JSON.stringify(code)));
}

export function buildElementCenterScript(selector: string): string {
  return ELEMENT_CENTER_SCRIPT.replace("%SELECTOR_JSON%", JSON.stringify(JSON.stringify(selector)));
}

export function buildTypeScript(selector: string, text: string, clear = true): string {
  return TYPE_SCRIPT.replace("%SELECTOR_JSON%", JSON.stringify(JSON.stringify(selector)))
    .replace("%TEXT_JSON%", JSON.stringify(JSON.stringify(text)))
    .replace("%CLEAR_JSON%", JSON.stringify(JSON.stringify(clear)));
}

export function buildScrollScript(arg: { selector?: string; direction: "up" | "down"; pages: number }): string {
  return SCROLL_SCRIPT.replace(
    "%ARG_JSON%",
    JSON.stringify(JSON.stringify({ selector: arg.selector, dir: arg.direction, pages: arg.pages })),
  );
}

export function buildWaitScript(arg: { selector?: string; text?: string }): string {
  return WAIT_SCRIPT.replace(
    "%ARG_JSON%",
    JSON.stringify(JSON.stringify({ selector: arg.selector, text: arg.text })),
  );
}

export function buildSelectScript(selector: string, value: string): string {
  return SELECT_SCRIPT.replace("%SELECTOR_JSON%", JSON.stringify(JSON.stringify(selector)))
    .replace("%VALUE_JSON%", JSON.stringify(JSON.stringify(value)));
}

export function buildFindScript(arg: {
  selector?: string;
  text?: string;
  regex?: boolean;
  caseSensitive?: boolean;
  contextChars?: number;
  maxResults?: number;
  attributes?: string[];
  cssScope?: string;
}): string {
  return FIND_SCRIPT.replace("%ARG_JSON%", JSON.stringify(JSON.stringify(arg)));
}
