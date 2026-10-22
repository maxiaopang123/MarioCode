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
      pillRelay: "内置中转站,粘贴 Key 即用",
      tagArm: "推荐",
      tagIntel: "旧款 Mac",
      tourTitle: "三分钟上手",
      tourSub: "下载安装 → 粘贴中转站 Key → 开始对话。截图是真实界面。",
      tourImg3Alt: "中转站设置界面",
      tourImg4Alt: "IDE 文件树与编辑器",
      tourS1t: "打开就能聊",
      tourS1d: "三引擎切换,流式对话,消息逐字显示。",
      tourS2t: "粘贴 Key,即用 22 个模型",
      tourS2d: "设置 → 模型配置 → 中转站,粘贴 Key 保存即可。",
      tourS3t: "文件、代码、预览都在一个窗口",
      tourS3d: "文件树、Monaco 编辑器、Git、终端,不用切窗口。",
      metaLoading: "正在获取最新版本…",
      metaReady: "v{version} · {size} · {date} 发布",
      metaError: "暂时获取不到最新版本,请稍后刷新重试。",
      metaMacSoon: "macOS 版即将上线,请稍后再来。",
      navDemo: "演示",
      ctaDemo: "看演示",
      demoTitle: "动态演示:一次完整的编程对话",
      demoLabel: "MarioCode 界面演示",
      demoProj: "我的网站",
      demoSessions: "会话",
      demoS1: "给首页加上深色模式",
      demoS2: "修复列表分页",
      demoS3: "补充单元测试",
      demoPh: "发送消息…",
      demoQ: "帮我把首页改成深色模式",
      demoThinking: "思考中",
      demoA1: "好的。我先看一下首页的样式,然后:\n1. 在 styles.css 加一组深色变量\n2. 跟随系统的 prefers-color-scheme",
      demoRead: "读取",
      demoApprove: "要写入 styles.css,允许吗?",
      demoApproved: "已允许 · 写入 styles.css",
      demoDeny: "拒绝",
      demoAllow: "允许",
      demoDenyHint: "演示里点「允许」继续 →",
      demoA2: "改好了,右边的预览已经切到深色。",
      seg1: "提问",
      seg2: "流式回复",
      seg3: "读取文件",
      seg4: "审批改动",
      seg5: "改动生效",
      demoPlay: "播放",
      demoPause: "暂停",
      demoReplay: "重播",
      demoHint: "演示由网页代码实时绘制。可以点「允许」,也可以点下面的进度条跳到任一步。",
      statsLabel: "数字",
      stat1: "个引擎,同一套界面",
      stat2: "个模型,粘贴 Key 即用",
      stat3: "使用数据上传",
      stat4: "开源,客户端免费",
      featSub: "点左边的功能,右边演示它是怎么工作的。",
      fPlanT: "计划模式",
      fPlanD: "先列出要改什么、改哪些文件,你点头之后才开始动代码。",
      fe1: "解释一下这个函数在做什么",
      fa1: "执行命令",
      fa2: "拒绝",
      fa3: "允许",
      fa4: "构建完成 · 1.8s",
      fp0: "计划",
      fp1: "在 styles.css 加深色变量",
      fp2: "导航栏加切换按钮",
      fp3: "记住用户的选择",
      fp4: "同意并开始",
      tourLabel: "真实界面截图",
      tourImg1Alt: "MarioCode 主对话界面",
      tagMine: "你的系统",
      endTitle: "现在就试试",
      toastDl: "已开始下载 MarioCode v{version}",
      toastDlMac: "正在打开 GitHub 下载 MarioCode v{version}",
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
      chipHint: "不确定 Mac 芯片:苹果菜单 → 关于本机。「芯片」写着 Apple M 选 Apple 芯片版,写着 Intel 选 Intel 版。",
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
      a2: "最快的方式:内置中转站,粘贴 Key 即用 22 个模型。也可以用 Claude 或 Codex 账号,或任意兼容 OpenAI / Anthropic 协议的 API。",
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
      pillRelay: "Built-in relay — paste a key, start coding",
      tagArm: "Recommended",
      tagIntel: "Older Macs",
      tourTitle: "Up and running in three minutes",
      tourSub: "Install → paste a relay key → start chatting. These are real screenshots.",
      tourImg3Alt: "Relay settings panel",
      tourImg4Alt: "IDE file tree and editor",
      tourS1t: "Chat right away",
      tourS1d: "Three engines, streaming replies, token by token.",
      tourS2t: "Paste a key, use 22 models",
      tourS2d: "Settings → Model Providers → relay. Paste your key and save.",
      tourS3t: "Files, code and preview in one window",
      tourS3d: "File tree, Monaco, Git and a terminal. No window switching.",
      metaLoading: "Checking the latest version…",
      metaReady: "v{version} · {size} · released {date}",
      metaError: "Couldn't load the latest version. Refresh in a moment.",
      metaMacSoon: "The macOS build is coming soon.",
      navDemo: "Demo",
      ctaDemo: "Watch the demo",
      demoTitle: "Live demo: one full coding turn",
      demoLabel: "MarioCode interface demo",
      demoProj: "my-site",
      demoSessions: "Sessions",
      demoS1: "Add dark mode to the homepage",
      demoS2: "Fix list pagination",
      demoS3: "Add unit tests",
      demoPh: "Send a message…",
      demoQ: "Add dark mode to the homepage",
      demoThinking: "Thinking",
      demoA1: "Sure. I'll read the homepage styles first, then:\n1. add dark variables to styles.css\n2. follow prefers-color-scheme",
      demoRead: "Read",
      demoApprove: "Write to styles.css?",
      demoApproved: "Allowed · wrote styles.css",
      demoDeny: "Deny",
      demoAllow: "Allow",
      demoDenyHint: "In this demo, click Allow to continue →",
      demoA2: "Done. The preview on the right is dark now.",
      seg1: "Ask",
      seg2: "Stream",
      seg3: "Read files",
      seg4: "Approve",
      seg5: "Applied",
      demoPlay: "Play",
      demoPause: "Pause",
      demoReplay: "Replay",
      demoHint: "Drawn live by this page. Click Allow yourself, or jump to any step on the bar below.",
      statsLabel: "Numbers",
      stat1: "engines, one interface",
      stat2: "models — paste a key",
      stat3: "usage data uploaded",
      stat4: "open source, free app",
      featSub: "Pick a feature on the left to see it work on the right.",
      fPlanT: "Plan mode",
      fPlanD: "It lists what will change and which files first. Code moves only after you agree.",
      fe1: "Explain what this function does",
      fa1: "Run command",
      fa2: "Deny",
      fa3: "Allow",
      fa4: "Build finished · 1.8s",
      fp0: "Plan",
      fp1: "Add dark variables to styles.css",
      fp2: "Add a toggle to the nav",
      fp3: "Remember the choice",
      fp4: "Approve and start",
      tourLabel: "Real screenshots",
      tourImg1Alt: "MarioCode chat view",
      tagMine: "Your system",
      endTitle: "Try it now",
      toastDl: "Downloading MarioCode v{version}",
      toastDlMac: "Opening GitHub to download MarioCode v{version}",
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
      chipHint: "Not sure which Mac chip? Apple menu → About This Mac. Apple M… means Apple silicon; Intel means Intel.",
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
      a2: "Fastest way: the built-in relay — paste a key and use 22 models. You can also bring a Claude or Codex account, or any OpenAI/Anthropic-compatible API.",
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
        // Primary style + highlighted card on the visitor's own platform.
        var mine = (platform === "win" && key === "win") || (platform === "mac" && key !== "win");
        link.classList.toggle("btn-primary", mine);
        link.classList.toggle("btn-ghost", !mine);
        var card = link.closest(".plat");
        if (card) card.classList.toggle("is-mine", mine);
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
    var heroLabel = hero && hero.querySelector(".hero-dl-label");
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
    for (var h = 0; h < langHooks.length; h++) langHooks[h]();
  }

  // Shared with demo.js (loaded after this file, also deferred).
  var langHooks = [];
  window.MarioSite = {
    t: function (key) { var v = STR[lang][key]; return v == null ? key : v; },
    onLang: function (fn) { langHooks.push(fn); },
    ripple: function (node, x, y) { ripple(node, x, y); }
  };

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

  var reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var finePointer = window.matchMedia("(hover: hover) and (pointer: fine)").matches;

  // ── Click feedback: ripple from the pointer position ─────────────────────
  function ripple(node, x, y) {
    if (reduceMotion || !node) return;
    var r = node.getBoundingClientRect();
    var size = Math.max(r.width, r.height) * 2.2;
    var span = document.createElement("span");
    span.className = "ripple";
    span.style.setProperty("--rx", (x == null ? r.width / 2 : x - r.left) + "px");
    span.style.setProperty("--ry", (y == null ? r.height / 2 : y - r.top) + "px");
    span.style.setProperty("--rs", size + "px");
    node.appendChild(span);
    span.addEventListener("animationend", function () { span.remove(); });
  }

  function initRipple() {
    document.addEventListener("pointerdown", function (e) {
      var node = e.target.closest && e.target.closest(".rp");
      if (node && e.button === 0) ripple(node, e.clientX, e.clientY);
    });
  }

  // ── Toast ────────────────────────────────────────────────────────────────
  var toastTimer = null;
  function toast(text) {
    var node = document.getElementById("toast");
    if (!node) return;
    node.textContent = text;
    node.classList.add("is-on");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { node.classList.remove("is-on"); }, 3200);
  }

  function initDownloadToast() {
    document.addEventListener("click", function (e) {
      var link = e.target.closest && e.target.closest(".dl-link, .hero-dl");
      if (!link || (link.getAttribute("href") || "#").charAt(0) === "#") return;
      var key = link.getAttribute("data-plat") || "win";
      var r = rel[key];
      if (!isRelease(r)) return;
      var s = STR[lang];
      toast(fill(/\.dmg$/i.test(r.path) ? s.toastDlMac : s.toastDl, { version: r.version }));
    });
  }

  // ── Scroll reveal + count-up ─────────────────────────────────────────────
  function initReveal() {
    var groups = document.querySelectorAll("[data-reveal-group]");
    for (var g = 0; g < groups.length; g++) {
      var kids = groups[g].querySelectorAll("[data-reveal]");
      for (var k = 0; k < kids.length; k++) kids[k].style.setProperty("--i", String(k));
    }
    var nodes = document.querySelectorAll("[data-reveal]");
    if (reduceMotion || !("IntersectionObserver" in window)) {
      for (var i = 0; i < nodes.length; i++) nodes[i].classList.add("is-in");
      return;
    }
    var io = new IntersectionObserver(function (entries) {
      for (var j = 0; j < entries.length; j++) {
        if (!entries[j].isIntersecting) continue;
        entries[j].target.classList.add("is-in");
        io.unobserve(entries[j].target);
        var counters = entries[j].target.querySelectorAll(".count");
        for (var c = 0; c < counters.length; c++) countUp(counters[c]);
      }
    }, { threshold: 0.12, rootMargin: "0px 0px -6% 0px" });
    for (var n = 0; n < nodes.length; n++) io.observe(nodes[n]);
  }

  function countUp(node) {
    var to = Number(node.getAttribute("data-count")) || 0;
    var start = performance.now();
    var DUR = 1300;
    function step(now) {
      var p = Math.min(1, (now - start) / DUR);
      node.textContent = String(Math.round(to * (1 - Math.pow(1 - p, 3))));
      if (p < 1) requestAnimationFrame(step);
    }
    node.textContent = "0";
    requestAnimationFrame(step);
  }

  // ── Pointer effects: tilt, card spotlight, hero blob parallax ────────────
  function initPointer() {
    if (!finePointer || reduceMotion) return;
    var tilts = document.querySelectorAll(".tilt");
    for (var i = 0; i < tilts.length; i++) {
      (function (node) {
        var MAX = node.id === "demo-tilt" ? 3.5 : 5;
        var raf = 0;
        node.addEventListener("pointermove", function (e) {
          var r = node.getBoundingClientRect();
          var px = (e.clientX - r.left) / r.width - 0.5;
          var py = (e.clientY - r.top) / r.height - 0.5;
          cancelAnimationFrame(raf);
          raf = requestAnimationFrame(function () {
            node.classList.add("is-tilting");
            node.style.setProperty("--ty", (px * MAX * 2).toFixed(2) + "deg");
            node.style.setProperty("--tx", (-py * MAX * 2).toFixed(2) + "deg");
          });
        });
        node.addEventListener("pointerleave", function () {
          cancelAnimationFrame(raf);
          node.classList.remove("is-tilting");
          node.style.setProperty("--tx", "0deg");
          node.style.setProperty("--ty", "0deg");
        });
      })(tilts[i]);
    }
    var spots = document.querySelectorAll(".spot");
    for (var s = 0; s < spots.length; s++) {
      spots[s].addEventListener("pointermove", function (e) {
        var r = this.getBoundingClientRect();
        this.style.setProperty("--sx", (e.clientX - r.left) + "px");
        this.style.setProperty("--sy", (e.clientY - r.top) + "px");
      });
    }
    var blobs = document.getElementById("blobs");
    var hero = document.querySelector(".hero");
    if (blobs && hero) {
      hero.addEventListener("pointermove", function (e) {
        blobs.style.setProperty("--mx", (e.clientX / window.innerWidth - 0.5).toFixed(3));
        blobs.style.setProperty("--my", (e.clientY / window.innerHeight - 0.5).toFixed(3));
        // Dot grid revealed around the pointer.
        var r = hero.getBoundingClientRect();
        hero.style.setProperty("--hx", (e.clientX - r.left) + "px");
        hero.style.setProperty("--hy", (e.clientY - r.top) + "px");
        hero.classList.add("is-hover");
      });
      hero.addEventListener("pointerleave", function () { hero.classList.remove("is-hover"); });
    }
    initMagnets();
    initCursorRing();
    initBurst();
  }

  // Buttons lean toward the pointer within a small radius, then spring back.
  function initMagnets() {
    var mags = document.querySelectorAll(".magnet");
    for (var i = 0; i < mags.length; i++) {
      (function (node) {
        var PULL = 0.28;
        node.addEventListener("pointermove", function (e) {
          var r = node.getBoundingClientRect();
          node.classList.add("is-pulling");
          node.style.setProperty("--mgx", ((e.clientX - r.left - r.width / 2) * PULL).toFixed(1) + "px");
          node.style.setProperty("--mgy", ((e.clientY - r.top - r.height / 2) * PULL).toFixed(1) + "px");
        });
        node.addEventListener("pointerleave", function () {
          node.classList.remove("is-pulling");
          node.style.setProperty("--mgx", "0px");
          node.style.setProperty("--mgy", "0px");
        });
      })(mags[i]);
    }
  }

  // A soft ring trails the pointer: grows over clickable things, turns dashed
  // over the demo / screenshots, squeezes on press. The real cursor stays.
  function initCursorRing() {
    var ring = document.createElement("span");
    ring.className = "cursor-ring";
    ring.setAttribute("aria-hidden", "true");
    document.body.appendChild(ring);
    var tx = -100, ty = -100, x = tx, y = ty, raf = 0;
    function loop() {
      x += (tx - x) * 0.22;
      y += (ty - y) * 0.22;
      ring.style.setProperty("--x", x.toFixed(1) + "px");
      ring.style.setProperty("--y", y.toFixed(1) + "px");
      raf = Math.abs(tx - x) + Math.abs(ty - y) > 0.3 ? requestAnimationFrame(loop) : 0;
    }
    document.addEventListener("pointermove", function (e) {
      if (e.pointerType !== "mouse") return;
      tx = e.clientX; ty = e.clientY;
      if (!ring.classList.contains("is-on")) { x = tx; y = ty; ring.classList.add("is-on"); }
      var t = e.target.closest ? e.target : null;
      var hot = !!(t && t.closest("a, button, summary, [role=tab]"));
      var view = !hot && !!(t && t.closest(".win, .tour-stage, .feat-stage"));
      ring.classList.toggle("is-hot", hot);
      ring.classList.toggle("is-view", view);
      if (!raf) raf = requestAnimationFrame(loop);
    }, { passive: true });
    document.addEventListener("pointerdown", function () { ring.classList.add("is-down"); });
    document.addEventListener("pointerup", function () { ring.classList.remove("is-down"); });
    document.documentElement.addEventListener("pointerleave", function () { ring.classList.remove("is-on"); });
  }

  // Clicking a primary button throws a few clay specks out from the pointer.
  function initBurst() {
    document.addEventListener("pointerdown", function (e) {
      var btn = e.target.closest && e.target.closest(".btn-primary, .ap-yes, .feat-tab, .tour-step-btn");
      if (!btn || e.button !== 0) return;
      var fx = document.createElement("span");
      fx.className = "burst-fx";
      fx.style.setProperty("--x", e.clientX + "px");
      fx.style.setProperty("--y", e.clientY + "px");
      var N = 9;
      for (var i = 0; i < N; i++) {
        var a = (i / N) * Math.PI * 2 + Math.random() * 0.5;
        var d = 26 + Math.random() * 26;
        var p = document.createElement("i");
        p.style.setProperty("--dx", (Math.cos(a) * d).toFixed(1) + "px");
        p.style.setProperty("--dy", (Math.sin(a) * d).toFixed(1) + "px");
        p.style.setProperty("--s", (0.7 + Math.random() * 0.6).toFixed(2));
        fx.appendChild(p);
      }
      document.body.appendChild(fx);
      setTimeout(function () { fx.remove(); }, 800);
    });
  }

  // ── Nav: shadow, reading progress, current-section highlight ─────────────
  function initNav() {
    var nav = document.getElementById("nav");
    var bar = document.getElementById("nav-progress");
    var links = document.querySelectorAll(".nav nav a");
    var targets = [];
    for (var i = 0; i < links.length; i++) {
      var sec = document.querySelector(links[i].getAttribute("href"));
      if (sec) targets.push({ link: links[i], sec: sec });
    }
    var ticking = false;
    function update() {
      ticking = false;
      var y = window.scrollY;
      var max = document.documentElement.scrollHeight - window.innerHeight;
      if (nav) nav.classList.toggle("is-scrolled", y > 8);
      if (bar) bar.style.setProperty("--p", max > 0 ? (y / max).toFixed(4) : "0");
      var current = null;
      for (var k = 0; k < targets.length; k++) {
        if (targets[k].sec.getBoundingClientRect().top < window.innerHeight * 0.4) current = targets[k];
      }
      for (var m = 0; m < targets.length; m++) targets[m].link.classList.toggle("is-current", targets[m] === current);
    }
    window.addEventListener("scroll", function () {
      if (!ticking) { ticking = true; requestAnimationFrame(update); }
    }, { passive: true });
    update();
  }

  // ── FAQ: animate the answer height instead of a hard jump ────────────────
  function initFaq() {
    var items = document.querySelectorAll(".faq details");
    for (var i = 0; i < items.length; i++) {
      (function (d) {
        var summary = d.querySelector("summary");
        var body = d.querySelector(".faq-a");
        if (!summary || !body) return;
        summary.addEventListener("click", function (e) {
          e.preventDefault();
          if (d.open) {
            d.classList.remove("is-open");
            var done = function () { d.open = false; body.removeEventListener("transitionend", done); };
            if (reduceMotion) done(); else body.addEventListener("transitionend", done);
          } else {
            d.open = true;
            void body.offsetWidth;
            d.classList.add("is-open");
          }
        });
      })(items[i]);
    }
  }
  // ── Tour carousel (real screenshots) ─────────────────────────────────────
  // The countdown bar under the active step is a CSS animation; hovering the
  // screenshot pauses both it and the timer, keeping them in sync.
  var TOUR_MS = 4500;
  var tourTimer = null;
  var tourIdx = 0;
  var tourHover = false;
  var tourLeft = TOUR_MS;
  var tourAt = 0;

  function tourGo(idx) {
    var imgs = document.querySelectorAll(".tour-img");
    var steps = document.querySelectorAll(".tour-step");
    if (!imgs.length) return;
    tourIdx = (idx + imgs.length) % imgs.length;
    for (var i = 0; i < imgs.length; i++) {
      var on = i === tourIdx;
      imgs[i].classList.toggle("is-active", on);
      if (!steps[i]) continue;
      steps[i].classList.toggle("is-active", on);
      steps[i].classList.remove("is-running", "is-paused");
    }
    if (steps[tourIdx] && !reduceMotion) {
      void steps[tourIdx].offsetWidth;   // restart the countdown bar
      steps[tourIdx].classList.add("is-running");
      steps[tourIdx].classList.toggle("is-paused", tourHover);
    }
    clearTimeout(tourTimer);
    tourLeft = TOUR_MS;
    if (!reduceMotion && !tourHover) tourArm();
  }

  function tourArm() {
    tourAt = Date.now();
    tourTimer = setTimeout(function () { tourGo(tourIdx + 1); }, tourLeft);
  }

  function tourPause(p) {
    if (reduceMotion || tourHover === p) return;
    tourHover = p;
    var step = document.querySelectorAll(".tour-step")[tourIdx];
    if (step) step.classList.toggle("is-paused", p);
    if (p) { clearTimeout(tourTimer); tourLeft = Math.max(0, tourLeft - (Date.now() - tourAt)); }
    else tourArm();
  }

  function initTour() {
    var stage = document.getElementById("tour-stage");
    var btns = document.querySelectorAll(".tour-step-btn");
    if (!stage || !btns.length) return;
    stage.parentNode.style.setProperty("--dur", TOUR_MS + "ms");
    for (var i = 0; i < btns.length; i++) {
      (function (idx) { btns[idx].addEventListener("click", function () { tourGo(idx); }); })(i);
    }
    stage.addEventListener("mouseenter", function () { tourPause(true); });
    stage.addEventListener("mouseleave", function () { tourPause(false); });
    stage.addEventListener("keydown", function (e) {
      if (e.key === "ArrowRight") { e.preventDefault(); tourGo(tourIdx + 1); }
      else if (e.key === "ArrowLeft") { e.preventDefault(); tourGo(tourIdx - 1); }
    });
    // Swipe on touch screens.
    var sx = null;
    stage.addEventListener("touchstart", function (e) { sx = e.touches[0].clientX; }, { passive: true });
    stage.addEventListener("touchend", function (e) {
      if (sx == null) return;
      var dx = e.changedTouches[0].clientX - sx;
      sx = null;
      if (Math.abs(dx) > 40) tourGo(tourIdx + (dx < 0 ? 1 : -1));
    });
    tourGo(0);
  }

  function init() {
    document.documentElement.classList.add("js");
    var btn = document.getElementById("lang-toggle");
    if (btn) {
      btn.addEventListener("click", function () {
        lang = lang === "zh" ? "en" : "zh";
        try { localStorage.setItem(STORE_KEY, lang); } catch (e) { /* ignore */ }
        applyLang();
      });
    }
    // Put the visitor's own platform first in the download cards.
    if (platform === "mac") {
      var list = document.querySelector(".plats");
      var win = document.querySelector('.plat[data-plat="win"]');
      if (list && win) list.appendChild(win);
    }
    applyLang();
    loadReleases();
    initRipple();
    initDownloadToast();
    initReveal();
    initPointer();
    initNav();
    initFaq();
    initTour();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();

