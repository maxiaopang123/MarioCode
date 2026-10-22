// Animated product demo for the download page.
// - Hero window: a scripted chat turn (ask → stream → read → approve → diff)
//   on a virtual clock, so pause / jump / offscreen auto-pause all freeze the
//   same timeline. Jumping replays earlier segments instantly, then plays on.
// - Feature tabs: four looping CSS vignettes, auto-rotating until clicked.
// Copy comes from app.js (window.MarioSite) so zh / en switch live.
(function () {
  "use strict";

  var site = window.MarioSite;
  if (!site) return;
  var t = site.t;
  var reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // ── Virtual clock ────────────────────────────────────────────────────────
  var vt = 0;          // ms of played time
  var last = 0;
  var timers = [];
  var userPaused = false;
  var autoPaused = false;
  var looping = false;
  var fast = false;    // replaying earlier segments: waits resolve at once
  var gen = 0;         // bumped on every (re)start; stale chains just stop

  // A ~60 Hz timer rather than requestAnimationFrame: the clock only fires
  // queued steps and moves progress bars (all motion itself is CSS), and rAF
  // is suspended in some embedded / background views that are still visible.
  // Hidden tabs and offscreen scroll positions pause it explicitly below.
  function frame() {
    var now = performance.now();
    var dt = last ? Math.min(now - last, 100) : 0;
    last = now;
    if (userPaused || autoPaused) { looping = false; last = 0; renderProgress(); return; }
    vt += dt;
    // Due timers may schedule new ones; collect first, then fire.
    var due = [];
    for (var i = timers.length - 1; i >= 0; i--) if (timers[i].at <= vt) due.push(timers.splice(i, 1)[0]);
    due.sort(function (a, b) { return a.at - b.at; });
    for (var j = 0; j < due.length; j++) due[j].fn();
    renderProgress();
    setTimeout(frame, 16);
  }

  function wake() {
    if (looping || userPaused || autoPaused) return;
    looping = true;
    setTimeout(frame, 16);
  }

  function wait(ms) {
    if (fast) return Promise.resolve();
    return new Promise(function (resolve) { timers.push({ at: vt + ms, fn: resolve }); });
  }

  // ── DOM ──────────────────────────────────────────────────────────────────
  var sec = document.getElementById("demo");
  var win = document.getElementById("demo-win");
  var chat = document.getElementById("demo-chat");
  var composer = document.getElementById("demo-composer");
  var input = document.getElementById("demo-input");
  var send = document.getElementById("demo-send");
  var pv = document.getElementById("demo-pv");
  var cursor = document.getElementById("demo-cursor");
  var eng = document.getElementById("demo-eng");
  var playBtn = document.getElementById("demo-play");
  var replayBtn = document.getElementById("demo-replay");
  var segBtns = document.querySelectorAll("#demo-segs .seg");
  if (!win || !chat) return;

  var ENGINES = ["Claude", "Codex", "Pi"];
  var engine = 0;

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function add(node) {
    chat.appendChild(node);
    // Keep the DOM small; older nodes are clipped off the top anyway.
    while (chat.children.length > 8) chat.removeChild(chat.firstChild);
    return node;
  }

  function press(node) {
    node.classList.remove("is-press");
    void node.offsetWidth;
    node.classList.add("is-press");
  }

  function setEngine(i) {
    engine = i;
    eng.style.setProperty("--eng", String(i));
    var tabs = eng.querySelectorAll(".eng");
    for (var k = 0; k < tabs.length; k++) tabs[k].classList.toggle("is-on", k === i);
  }

  function hideCursor() { cursor.classList.remove("is-on", "is-click"); }

  // Position relative to the window; the fake pointer's tip sits on target.
  function pointAt(target) {
    var wr = win.getBoundingClientRect();
    var r = target.getBoundingClientRect();
    var sx = wr.width / win.offsetWidth || 1;   // undo tilt scaling
    // The arrow's tip is ~5px into the 30px svg.
    cursor.style.setProperty("--cx", ((r.left - wr.left + r.width * 0.5) / sx - 6).toFixed(1) + "px");
    cursor.style.setProperty("--cy", ((r.top - wr.top + r.height * 0.5) / sx - 4).toFixed(1) + "px");
  }

  function reset() {
    chat.textContent = "";
    input.textContent = "";
    composer.classList.remove("has-text", "is-typing");
    pv.classList.remove("is-dark");
    win.classList.remove("is-busy");
    hideCursor();
    // Park the pointer just below the composer, so it glides in from there.
    cursor.style.setProperty("--cx", Math.round(win.offsetWidth * 0.62) + "px");
    cursor.style.setProperty("--cy", (win.offsetHeight + 20) + "px");
  }

  async function type(node, text, total) {
    if (fast) { node.textContent = text; return; }
    var chars = Array.from(text);
    var step = Math.max(18, Math.min(70, total / chars.length));
    node.textContent = "";
    for (var i = 0; i < chars.length; i++) {
      node.textContent += chars[i];
      await wait(step);
    }
  }

  // Token-ish streaming: 1–3 characters per tick.
  async function stream(node, text, total) {
    if (fast) { node.textContent = text; return; }
    var chars = Array.from(text);
    var ticks = Math.ceil(chars.length / 2);
    var step = total / ticks;
    var i = 0;
    while (i < chars.length) {
      var n = 1 + ((i * 7) % 3);
      node.textContent += chars.slice(i, i + n).join("");
      i += n;
      await wait(step);
    }
  }

  // ── Segments ─────────────────────────────────────────────────────────────
  // DUR is only for the progress bars; the real length is whatever the
  // segment awaits.
  var DUR = [2300, 3400, 1500, 2600, 3600];

  async function sAsk() {
    var q = t("demoQ");
    composer.classList.add("is-typing", "has-text");
    await wait(300);
    await type(input, q, 1300);
    await wait(380);
    press(send);
    await wait(180);
    input.textContent = "";
    composer.classList.remove("has-text", "is-typing");
    add(el("div", "dm dm-user", q));
    win.classList.add("is-busy");
    await wait(350);
  }

  async function sReply() {
    if (!fast) {
      var think = add(el("div", "dm dm-think"));
      var dots = el("span", "dots");
      dots.appendChild(el("i")); dots.appendChild(el("i")); dots.appendChild(el("i"));
      think.appendChild(dots);
      think.appendChild(el("span", null, t("demoThinking")));
      await wait(1000);
      think.remove();
    }
    var ai = add(el("div", "dm dm-ai"));
    ai.appendChild(el("span", "who", ENGINES[engine]));
    var body = ai.appendChild(el("span"));
    var tick = ai.appendChild(el("span", "tick"));
    await stream(body, t("demoA1"), 2100);
    tick.remove();
    await wait(250);
  }

  async function sRead() {
    var card = add(el("div", "dm dm-card dm-tool"));
    card.appendChild(el("span", "t-ico", "R"));
    card.appendChild(el("span", null, t("demoRead")));
    card.appendChild(el("code", null, "index.html · styles.css"));
    card.appendChild(el("span", "t-st"));
    await wait(1100);
    card.classList.add("is-done");
    await wait(350);
  }

  async function sApprove() {
    var card = add(el("div", "dm dm-card dm-approve"));
    var head = card.appendChild(el("div", "ap-head", t("demoApprove")));
    card.appendChild(el("div", "ap-file", "styles.css · +6 −1"));
    var btns = card.appendChild(el("div", "ap-btns"));
    var no = btns.appendChild(el("button", "ap-btn rp", t("demoDeny")));
    var yes = btns.appendChild(el("button", "ap-btn ap-yes rp", t("demoAllow")));
    no.type = yes.type = "button";

    function approved() {
      card.classList.add("is-ok");
      head.textContent = t("demoApproved");
    }
    if (fast) { approved(); return; }

    var g = gen;
    var clicked;
    var byUser = new Promise(function (resolve) { clicked = resolve; });
    yes.addEventListener("click", function () { clicked(true); });
    // Declining isn't part of the story; a nudge points back at Allow.
    no.addEventListener("click", function () {
      head.textContent = t("demoDenyHint");
      press(yes);
    });

    await wait(450);
    cursor.classList.add("is-on");
    await wait(60);
    pointAt(yes);
    var who = await Promise.race([wait(1500).then(function () { return false; }), byUser]);
    if (g !== gen) return;
    if (!who) {
      cursor.classList.add("is-click");
      site.ripple(yes);
    }
    press(yes);
    await wait(260);
    approved();
    await wait(200);
    hideCursor();
    await wait(200);
  }

  var DIFF = [
    [" ", ":root {"],
    ["+", "  --bg: #0f1412;"],
    ["+", "  --ink: #e8eee9;"],
    [" ", "}"],
    ["-", "body { background: #fff; }"],
    ["+", "body { background: var(--bg); }"],
    ["+", "@media (prefers-color-scheme: dark) { … }"]
  ];

  async function sApply() {
    var card = add(el("div", "dm dm-card dm-diff"));
    var head = card.appendChild(el("div", "df-head", "styles.css  "));
    head.appendChild(el("b", null, "+6"));
    head.appendChild(document.createTextNode(" "));
    head.appendChild(el("s", null, "−1"));
    var lines = [];
    for (var i = 0; i < DIFF.length; i++) {
      var d = DIFF[i];
      lines.push(card.appendChild(el("div", "df-line" + (d[0] === "+" ? " df-add" : d[0] === "-" ? " df-del" : ""), d[0] + " " + d[1])));
    }
    for (var k = 0; k < lines.length; k++) {
      await wait(140);
      lines[k].classList.add("is-in");
    }
    await wait(300);
    pv.classList.add("is-dark");
    if (!fast) {
      var flash = el("span", "pv-flash");
      pv.parentNode.appendChild(flash);
      flash.addEventListener("animationend", function () { flash.remove(); });
    }
    await wait(500);
    var ai = add(el("div", "dm dm-ai"));
    ai.appendChild(el("span", "who", ENGINES[engine]));
    var body = ai.appendChild(el("span"));
    await stream(body, t("demoA2"), 1100);
    win.classList.remove("is-busy");
  }

  var SEGS = [sAsk, sReply, sRead, sApprove, sApply];
  var cur = 0;
  var segStart = 0;

  function renderProgress() {
    for (var i = 0; i < segBtns.length; i++) {
      var p = i < cur ? 1 : i > cur ? 0 : Math.min(1, (vt - segStart) / DUR[i]);
      var bar = segBtns[i].querySelector(".seg-bar i");
      if (bar) bar.style.setProperty("--sp", p.toFixed(3));
      segBtns[i].classList.toggle("is-on", i === cur);
    }
  }

  async function play(from) {
    var g = ++gen;
    timers = [];
    reset();
    fast = true;
    for (var k = 0; k < from; k++) {
      await SEGS[k]();
      if (g !== gen) return;
    }
    fast = false;
    for (var s = from; s < SEGS.length; s++) {
      cur = s;
      segStart = vt;
      renderProgress();
      await SEGS[s]();
      if (g !== gen) return;
    }
    cur = SEGS.length;
    renderProgress();
    await wait(2800);
    if (g !== gen) return;
    // Next loop on the next engine, so all three get screen time.
    setEngine((engine + 1) % ENGINES.length);
    play(0);
  }

  function setPaused(p) {
    userPaused = p;
    sec.classList.toggle("is-paused", p);
    playBtn.setAttribute("aria-label", t(p ? "demoPlay" : "demoPause"));
    if (!p) wake();
  }

  function jump(i) {
    play(i);
    if (userPaused) setPaused(false);
    wake();
  }

  playBtn.addEventListener("click", function () { setPaused(!userPaused); });
  replayBtn.addEventListener("click", function () { jump(0); });
  for (var b = 0; b < segBtns.length; b++) {
    (function (i) { segBtns[i].addEventListener("click", function () { jump(i); }); })(b);
  }

  // Don't burn frames when nobody can see it.
  if ("IntersectionObserver" in window) {
    new IntersectionObserver(function (entries) {
      autoPaused = !entries[0].isIntersecting || document.hidden;
      wake();
    }, { threshold: 0.15 }).observe(win);
  }
  document.addEventListener("visibilitychange", function () {
    autoPaused = document.hidden;
    wake();
  });

  site.onLang(function () {
    playBtn.setAttribute("aria-label", t(userPaused ? "demoPlay" : "demoPause"));
    play(Math.min(cur, SEGS.length - 1));
    wake();
  });

  setEngine(0);
  playBtn.setAttribute("aria-label", t("demoPause"));
  if (reduce) {
    // Final frame, no autoplay; the controls still work on request.
    play(SEGS.length - 1);
    setPaused(true);
  } else {
    play(0);
    wake();
  }

  // ── Feature tabs ─────────────────────────────────────────────────────────
  var feat = document.querySelector(".feat");
  var tabs = document.querySelectorAll(".feat-tab");
  var FEAT_MS = 6500;
  var featIdx = 0;
  var featTimer = null;
  var pinned = false;

  function featGo(i, focus) {
    featIdx = (i + tabs.length) % tabs.length;
    for (var k = 0; k < tabs.length; k++) {
      var on = k === featIdx;
      var panel = document.getElementById(tabs[k].getAttribute("aria-controls"));
      tabs[k].classList.toggle("is-active", on);
      tabs[k].setAttribute("aria-selected", on ? "true" : "false");
      tabs[k].tabIndex = on ? 0 : -1;
      tabs[k].classList.remove("is-running");
      if (panel) {
        panel.hidden = !on;
        panel.classList.toggle("is-active", on);
        panel.classList.remove("is-loop");
      }
    }
    var active = tabs[featIdx];
    var activePanel = document.getElementById(active.getAttribute("aria-controls"));
    void active.offsetWidth;   // restart CSS animations
    if (!reduce && activePanel) activePanel.classList.add("is-loop");
    if (!pinned && !reduce) active.classList.add("is-running");
    if (focus) active.focus();
    clearTimeout(featTimer);
    if (!pinned && !reduce) featTimer = setTimeout(function () { featGo(featIdx + 1); }, FEAT_MS);
  }

  if (feat && tabs.length) {
    feat.style.setProperty("--dur", FEAT_MS + "ms");
    for (var f = 0; f < tabs.length; f++) {
      (function (i) {
        tabs[i].addEventListener("click", function () {
          pinned = true;
          feat.classList.add("is-pinned");
          featGo(i);
        });
      })(f);
    }
    document.getElementById("feat-tabs").addEventListener("keydown", function (e) {
      var d = e.key === "ArrowDown" || e.key === "ArrowRight" ? 1 : e.key === "ArrowUp" || e.key === "ArrowLeft" ? -1 : 0;
      if (!d) return;
      e.preventDefault();
      pinned = true;
      feat.classList.add("is-pinned");
      featGo(featIdx + d, true);
    });
    featGo(0);
  }
})();
