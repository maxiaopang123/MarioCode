// MarioCode download page.
// - Reads latest.yml (Windows) and latest-mac.yml (macOS) — the same
//   manifests electron-updater uses — so every download button always points
//   at the newest published installer; no page edit per release.
// - Highlights the visitor's platform; zh / en copy remembered in localStorage.
(function () {
  "use strict";

  var STR = {
    zh: {
      skip: "跳到下载",
      navLabel: "主导航",
      navFeatures: "功能",
      navDownload: "下载",
      navFaq: "常见问题",
      langLabel: "Switch to English",
      eyebrow: "免费 · 开源 · MIT",
      heroTitle: "把 Claude Code、Codex 和 Pi<br>装进一个桌面 IDE",
      heroLead: "不重新发明 agent。官方引擎放进同一套界面:流式对话、工具审批、计划模式,以及文件、Git、终端和内置浏览器。",
      pill1: "三引擎切换",
      pill2: "先审批再改代码",
      pill3: "数据留在本机",
      ctaDownload: "下载 MarioCode",
      ctaWin: "下载 Windows 版",
      ctaMac: "下载 macOS 版",
      ctaFeatures: "看看能做什么",
      heroPlatforms: "支持 Windows 和 macOS(Apple 芯片 / Intel)",
      heroMacHint: "v{version} · 下一步选择 Apple 芯片或 Intel 版本",
      metaLoading: "正在获取最新版本…",
      metaReady: "v{version} · {size} · {date} 发布",
      metaError: "暂时获取不到最新版本,请稍后刷新重试。",
      metaMacSoon: "macOS 版即将上线,请稍后再来。",
      mockLabel: "MarioCode 界面示意",
      mockCaption: "界面示意:左侧项目栏与会话列,中间是对话和工具审批,右侧是文件与 Git 面板。",
      mockAlert: "1 个会话等你处理",
      mockS1: "重构登录模块",
      mockS2: "修复列表分页",
      mockS3: "补充单元测试",
      mockS4: "升级依赖版本",
      mockRun: "运行中 0:42",
      mockWait: "待审批",
      mockTime: "3 分钟前",
      mockYesterday: "昨天",
      mockAsk: "把登录逻辑拆成独立的 hook,并补上测试",
      mockAnswer: "好的,先看看现有实现,再分三步改:",
      mockDone: "完成",
      mockApprove: "允许?",
      mockComposer: "发送消息…",
      featTitle: "一个窗口,完成整段编程对话",
      f1t: "三个引擎,随时切换",
      f1d: "Claude、Codex、Pi 同一套界面。也可以接入兼容 OpenAI / Anthropic 协议的第三方模型服务。",
      f2t: "每一步都看得见",
      f2d: "回复逐字流式显示。思考、工具调用和改过的文件都是卡片,本轮可以一键撤销。",
      f3t: "先审批,再动手",
      f3d: "写文件、执行命令前先问你。计划模式先出方案,同意之后才改代码。",
      f4t: "完整的 IDE",
      f4d: "文件树、Monaco、diff、多仓库 Git、多标签终端、内置浏览器和语言服务器。",
      f5t: "关窗口也不停",
      f5d: "收到系统托盘后任务继续跑。定时任务、微信通知,手机上也能看会话和审批。",
      f6t: "自己更新",
      f6d: "Windows 在应用里下载,重启即安装。macOS 回到本页下载新的 dmg,数据保留。",
      dlTitle: "下载",
      dlSub: "选你的系统。版本号从发布清单自动读取。",
      platWin: "Windows 10 / 11 · 64 位",
      platMacArmName: "macOS · Apple 芯片",
      platMacArm: "M1 / M2 / M3 / M4",
      platMacIntelName: "macOS · Intel",
      platMacIntel: "Intel 处理器的 Mac",
      dlWin: "下载 .exe",
      dlMac: "下载 .dmg",
      stepsWinTitle: "Windows",
      installTitle: "安装时可能看到的提示",
      chipHint: "不确定 Mac 芯片:苹果菜单 → 关于本机。「芯片」写着 Apple M 选上面,写着 Intel 选下面。",
      band1: "Claude · Codex · Pi",
      band2: "工具审批",
      band3: "计划模式",
      band4: "Git 与终端",
      band5: "内置浏览器",
      band6: "手机查看",
      step1: "运行下载的安装包,按提示选择安装位置。",
      step2: "安装包暂未签名。若出现「Windows 已保护你的电脑」,点「更多信息」→「仍要运行」。",
      step3: "首次打开后,在 设置 → 模型配置 里登录官方账号,或添加你自己的模型服务。",
      stepsMacTitle: "macOS",
      mac1: "不确定是哪种芯片:点屏幕左上角苹果菜单 →「关于本机」,「芯片」一栏写着 Apple M… 就选 Apple 芯片版,写着 Intel 就选 Intel 版。",
      mac2: "打开 .dmg,把 MarioCode 拖进「应用程序」。",
      mac3: "暂未公证。第一次打开到「系统设置 → 隐私与安全性」,点下方「仍要打开」。",
      mac4: "若提示已损坏,在终端运行 <code>xattr -dr com.apple.quarantine /Applications/MarioCode.app</code> 后再打开。",
      mac5: "macOS 暂不能在应用内更新。有新版本时回到本页,覆盖安装即可,数据不会丢。",
      faqTitle: "常见问题",
      q1: "收费吗?",
      a1: "客户端免费,MIT 开源。模型调用由你使用的服务商计费。",
      q2: "需要准备什么?",
      a2: "一个模型来源:Claude 或 Codex 账号,或任意兼容 OpenAI / Anthropic 协议的 API。",
      q3: "代码和对话会上传吗?",
      a3: "会话和配置在你自己的电脑上。MarioCode 不收集使用数据,对话只发给你配置的模型服务。",
      q4: "怎么更新?",
      a4: "应用会自己检查。Windows 提示下载并在重启时安装;macOS 提示回本页下载。也可以随时覆盖安装最新包。",
      q5: "有 macOS 版吗?",
      a5: "有,分 Apple 芯片和 Intel 两个版本。安装包暂未经过苹果公证,第一次打开需要在「隐私与安全性」里允许;也暂不支持应用内自动更新,有新版本时回本页下载即可。",
      footVersion: "当前 v{version}",
      title: "MarioCode — AI 编程桌面客户端",
      langButton: "EN"
    },
    en: {
      skip: "Skip to download",
      navLabel: "Main navigation",
      navFeatures: "Features",
      navDownload: "Download",
      navFaq: "FAQ",
      langLabel: "切换到中文",
      eyebrow: "Free · Open source · MIT",
      heroTitle: "Claude Code, Codex and Pi<br>in one desktop IDE",
      heroLead: "It doesn't reinvent the agent. The official engines share one workspace: streaming chat, tool approval, plan mode, plus files, Git, a terminal and a built-in browser.",
      pill1: "Three engines",
      pill2: "Approve before edits",
      pill3: "Data stays local",
      ctaDownload: "Download MarioCode",
      ctaWin: "Download for Windows",
      ctaMac: "Download for macOS",
      ctaFeatures: "See what it does",
      heroPlatforms: "For Windows and macOS (Apple silicon / Intel)",
      heroMacHint: "v{version} · next, pick Apple silicon or Intel",
      metaLoading: "Checking the latest version…",
      metaReady: "v{version} · {size} · released {date}",
      metaError: "Couldn't load the latest version. Refresh in a moment.",
      metaMacSoon: "The macOS build is coming soon.",
      mockLabel: "MarioCode interface preview",
      mockCaption: "Interface preview.",
      mockAlert: "1 session needs you",
      mockS1: "Refactor login",
      mockS2: "Fix pagination",
      mockS3: "Add tests",
      mockS4: "Bump dependencies",
      mockRun: "Running 0:42",
      mockWait: "Approval",
      mockTime: "3 min ago",
      mockYesterday: "Yesterday",
      mockAsk: "Split login into its own hook and add tests",
      mockAnswer: "I'll read the current code first, then do it in three steps:",
      mockDone: "Done",
      mockApprove: "Allow?",
      mockComposer: "Send a message…",
      featTitle: "The whole coding conversation, one window",
      f1t: "Three engines, one interface",
      f1d: "Claude, Codex and Pi side by side. Bring any model service that speaks OpenAI or Anthropic.",
      f2t: "See every step",
      f2d: "Replies stream token by token. Thinking, tool calls and changed files are cards, and a turn can be undone in one click.",
      f3t: "Approve before it acts",
      f3d: "Writing files or running commands asks first. Plan mode waits for your OK before touching code.",
      f4t: "A full IDE",
      f4d: "File tree, Monaco, diffs, multi-repo Git, tabbed terminals, a built-in browser and language servers.",
      f5t: "Closing the window doesn't stop it",
      f5d: "It goes to the system tray and keeps running. Scheduled tasks, WeChat notifications, and a phone view.",
      f6t: "Updates itself",
      f6d: "Windows downloads in the app and installs on restart. macOS comes back here for a new dmg — your data stays.",
      dlTitle: "Download",
      dlSub: "Pick your system. The version comes from the release manifest.",
      platWin: "Windows 10 / 11 · 64-bit",
      platMacArmName: "macOS · Apple silicon",
      platMacArm: "M1 / M2 / M3 / M4",
      platMacIntelName: "macOS · Intel",
      platMacIntel: "Macs with an Intel processor",
      dlWin: "Download .exe",
      dlMac: "Download .dmg",
      stepsWinTitle: "Windows",
      installTitle: "What the installer may say",
      chipHint: "Not sure which Mac chip? Apple menu → About This Mac. Apple M… is the first Mac row; Intel is the second.",
      band1: "Claude · Codex · Pi",
      band2: "Tool approval",
      band3: "Plan mode",
      band4: "Git and terminal",
      band5: "Built-in browser",
      band6: "Phone view",
      step1: "Run the installer and choose a location.",
      step2: "The installer isn't signed yet. If Windows protected your PC appears, choose More info, then Run anyway.",
      step3: "On first launch, sign in or add your own model service under Settings → Models.",
      stepsMacTitle: "macOS",
      mac1: "Apple menu → About This Mac. Apple M… means Apple silicon; Intel means Intel.",
      mac2: "Open the dmg and drag MarioCode into Applications.",
      mac3: "Not notarized yet. On first launch open System Settings → Privacy & Security and click Open Anyway.",
      mac4: "If macOS says the app is damaged, run <code>xattr -dr com.apple.quarantine /Applications/MarioCode.app</code> in Terminal, then open it again.",
      mac5: "macOS can't update inside the app yet. Download the new dmg here and install over the old one. Your data stays.",
      faqTitle: "FAQ",
      q1: "Is it free?",
      a1: "The app is free and MIT-licensed. Model usage is billed by the service you choose.",
      q2: "What do I need?",
      a2: "A model source: a Claude or Codex account, or any API compatible with OpenAI or Anthropic.",
      q3: "Is my code uploaded?",
      a3: "Sessions stay on your computer. MarioCode collects nothing; conversations only go to the model service you set.",
      q4: "How do updates work?",
      a4: "The app checks on its own. Windows installs on restart; macOS points you back here. You can also install the latest package over the old one.",
      q5: "Is there a macOS version?",
      a5: "Yes, Apple silicon and Intel. The first launch needs Open Anyway in Privacy & Security, and updates are downloaded from this page.",
      footVersion: "Current v{version}",
      title: "MarioCode — desktop IDE for AI coding",
      langButton: "中文"
    }  };

  // Keys whose copy carries fixed markup (<br>, <code>). Their text comes only
  // from STR above, never from the network.
  var HTML_KEYS = { heroTitle: true, mac4: true };

  var STORE_KEY = "mc-site-lang";
  var lang = (function () {
    try {
      var saved = localStorage.getItem(STORE_KEY);
      if (saved === "zh" || saved === "en") return saved;
    } catch (e) { /* storage blocked */ }
    return /^zh/i.test(navigator.language || "") ? "zh" : "en";
  })();

  // Visitor platform. iPad reports "Macintosh" too, but MarioCode doesn't run
  // there; touch points tell them apart.
  var ua = navigator.userAgent || "";
  var platform = /Windows/i.test(ua)
    ? "win"
    : /Macintosh|Mac OS X/i.test(ua) && !(navigator.maxTouchPoints > 1)
      ? "mac"
      : "other";

  // { win, macArm, macIntel }: { version, path, size, date } | "error" | "missing" | undefined (loading)
  var rel = {};

  function fill(tpl, vars) {
    return tpl.replace(/\{(\w+)\}/g, function (_, k) { return vars[k] != null ? vars[k] : ""; });
  }

  function fmtSize(bytes) {
    return (bytes / 1024 / 1024).toFixed(0) + " MB";
  }

  function fmtDate(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    return lang === "zh"
      ? d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0")
      : d.toLocaleDateString("en", { year: "numeric", month: "short", day: "numeric" });
  }

  function isRelease(r) {
    return r && typeof r === "object";
  }

  function renderRelease() {
    var s = STR[lang];
    var keys = ["win", "macArm", "macIntel"];
    for (var i = 0; i < keys.length; i++) {
      var key = keys[i];
      var r = rel[key];
      var link = document.querySelector('.dl-link[data-plat="' + key + '"]');
      var meta = document.querySelector('.dl-meta[data-plat="' + key + '"]');
      if (link) {
        if (isRelease(r)) {
          link.setAttribute("href", downloadHref(r));
          link.setAttribute("download", "");
          link.removeAttribute("aria-disabled");
        } else {
          link.setAttribute("href", "#download");
          link.removeAttribute("download");
          if (r) link.setAttribute("aria-disabled", "true");
        }
        // Primary style on the visitor's own platform.
        var mine = (platform === "win" && key === "win") || (platform === "mac" && key !== "win");
        link.classList.toggle("btn-primary", mine);
        link.classList.toggle("btn-ghost", !mine);
      }
      if (meta) {
        var p = meta.parentElement;
        p.classList.toggle("error", r === "error");
        if (isRelease(r)) meta.textContent = fill(s.metaReady, { version: r.version, size: fmtSize(r.size), date: fmtDate(r.date) });
        else if (r === "error") meta.textContent = s.metaError;
        else if (r === "missing") meta.textContent = s.metaMacSoon;
        else meta.textContent = s.metaLoading;
      }
    }

    // Hero button: Windows → straight to the exe; macOS → the download card
    // (the chip can't be detected reliably from the browser); else → card.
    var hero = document.querySelector(".hero-dl");
    var heroLabel = document.querySelector(".hero-dl-label");
    var heroMeta = document.querySelector(".hero-meta");
    if (hero && heroLabel && heroMeta) {
      var w = rel.win;
      var m = isRelease(rel.macArm) ? rel.macArm : rel.macIntel;
      if (platform === "win") {
        heroLabel.textContent = s.ctaWin;
        if (isRelease(w)) {
          hero.setAttribute("href", w.path);
          hero.setAttribute("download", "");
          heroMeta.textContent = fill(s.metaReady, { version: w.version, size: fmtSize(w.size), date: fmtDate(w.date) });
        } else {
          heroMeta.textContent = w === "error" ? s.metaError : s.metaLoading;
        }
      } else if (platform === "mac") {
        heroLabel.textContent = s.ctaMac;
        hero.setAttribute("href", "#download");
        heroMeta.textContent = isRelease(m)
          ? fill(s.heroMacHint, { version: m.version })
          : rel.macArm === "missing" ? s.metaMacSoon : rel.macArm === "error" ? s.metaError : s.metaLoading;
      } else {
        heroLabel.textContent = s.ctaDownload;
        hero.setAttribute("href", "#download");
        heroMeta.textContent = s.heroPlatforms;
      }
    }

    var newest = null;
    var all = [rel.win, rel.macArm, rel.macIntel];
    for (var j = 0; j < all.length; j++) {
      if (isRelease(all[j]) && (!newest || cmpVersion(all[j].version, newest) > 0)) newest = all[j].version;
    }
    var foot = document.querySelector(".dl-version-text");
    if (foot) foot.textContent = newest ? fill(s.footVersion, { version: newest }) : "";
  }

  function cmpVersion(a, b) {
    var pa = a.split(/[.-]/), pb = b.split(/[.-]/);
    for (var i = 0; i < 3; i++) {
      var d = (Number(pa[i]) || 0) - (Number(pb[i]) || 0);
      if (d) return d;
    }
    return 0;
  }

  function applyLang() {
    var s = STR[lang];
    document.documentElement.lang = lang === "zh" ? "zh-CN" : "en";
    document.title = s.title;
    var nodes = document.querySelectorAll("[data-i18n], [data-i18n-html]");
    for (var i = 0; i < nodes.length; i++) {
      var key = nodes[i].getAttribute("data-i18n") || nodes[i].getAttribute("data-i18n-html");
      if (s[key] == null) continue;
      if (HTML_KEYS[key]) nodes[i].innerHTML = s[key];
      else nodes[i].textContent = s[key];
    }
    var attrNodes = document.querySelectorAll("[data-i18n-attr]");
    for (var k = 0; k < attrNodes.length; k++) {
      var pair = attrNodes[k].getAttribute("data-i18n-attr").split(":");
      if (s[pair[1]] != null) attrNodes[k].setAttribute(pair[0], s[pair[1]]);
    }
    var btn = document.getElementById("lang-toggle");
    if (btn) btn.textContent = s.langButton;
    renderRelease();
  }

  // The manifests are tiny electron-builder output; a line scan is enough.
  // Installer names are validated before they become an href, so a tampered
  // manifest can't turn a button into a javascript: / off-site link.
  var VERSION_RE = /^\d+\.\d+\.\d+[\w.-]*$/;
  // macOS dmgs are mirrored from this Release. Mainland browsers reach
  // release-assets.githubusercontent.com much faster than the Hong Kong VPS,
  // so the buttons link there. Windows builds are packed locally and are not
  // guaranteed to exist on GitHub, so those stay on this server.
  var GITHUB_RELEASE = "https://github.com/maxiaopang123/MarioCode/releases/download/";

  function downloadHref(r) {
    if (r && /\.dmg$/i.test(r.path)) return GITHUB_RELEASE + "v" + r.version + "/" + r.path;
    return r.path;
  }

  function unquote(v) {
    return v.replace(/^['"]|['"]$/g, "");
  }

  function pick(text, re) {
    var m = re.exec(text);
    return m ? unquote(m[1]) : null;
  }

  function parseWin(text) {
    var version = pick(text, /^version:\s*(\S+)/m);
    var path = pick(text, /^path:\s*(\S+)/m);
    var size = Number(pick(text, /^\s+size:\s*(\d+)/m));
    if (!version || !VERSION_RE.test(version)) return null;
    if (!path || !/^[A-Za-z0-9._-]+\.exe$/.test(path)) return null;
    return { version: version, path: path, size: size || 0, date: pick(text, /^releaseDate:\s*(\S+)/m) || "" };
  }

  // latest-mac.yml: files[] holds the zips (updater) and dmgs (download) of
  // both architectures; arm64 artifacts carry "-arm64" in the name.
  function parseMac(text) {
    var version = pick(text, /^version:\s*(\S+)/m);
    if (!version || !VERSION_RE.test(version)) return null;
    var date = pick(text, /^releaseDate:\s*(\S+)/m) || "";
    var files = [];
    var cur = null;
    var lines = text.replace(/\r\n/g, "\n").split("\n");
    for (var i = 0; i < lines.length; i++) {
      var raw = lines[i];
      var line = raw.trim();
      var m = /^(?:- )?(\w+):\s*(.*)$/.exec(line);
      if (!m) continue;
      if (line.indexOf("- ") === 0) { cur = {}; files.push(cur); }
      else if (raw.length === raw.replace(/^\s+/, "").length) { cur = null; continue; }
      if (cur) cur[m[1]] = unquote(m[2]);
    }
    var out = { macArm: null, macIntel: null };
    for (var j = 0; j < files.length; j++) {
      var f = files[j];
      if (!f.url || !/^[A-Za-z0-9._-]+\.dmg$/.test(f.url)) continue;
      var entry = { version: version, path: f.url, size: Number(f.size) || 0, date: date };
      if (/arm64/i.test(f.url)) out.macArm = out.macArm || entry;
      else out.macIntel = out.macIntel || entry;
    }
    return out;
  }

  function get(url) {
    return fetch(url, { cache: "no-store" }).then(function (r) {
      if (r.status === 404) return null;
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.text();
    });
  }

  function loadReleases() {
    get("latest.yml")
      .then(function (text) {
        var w = text ? parseWin(text) : null;
        rel.win = w || "error";
      })
      .catch(function () { rel.win = "error"; })
      .then(renderRelease);

    get("latest-mac.yml")
      .then(function (text) {
        if (text === null) { rel.macArm = rel.macIntel = "missing"; return; }
        var m = parseMac(text);
        rel.macArm = (m && m.macArm) || "error";
        rel.macIntel = (m && m.macIntel) || "error";
      })
      .catch(function () { rel.macArm = rel.macIntel = "error"; })
      .then(renderRelease);
  }

  function init() {
    var btn = document.getElementById("lang-toggle");
    if (btn) {
      btn.addEventListener("click", function () {
        lang = lang === "zh" ? "en" : "zh";
        try { localStorage.setItem(STORE_KEY, lang); } catch (e) { /* ignore */ }
        applyLang();
      });
    }
    // Put the visitor's own platform first in the download card.
    if (platform === "mac") {
      var list = document.querySelector(".plats");
      var win = document.querySelector('.plat[data-plat="win"]');
      if (list && win) list.appendChild(win);
    }
    applyLang();
    loadReleases();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
