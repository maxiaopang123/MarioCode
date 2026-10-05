// MarioCode download page.
// - Reads latest.yml (the same manifest electron-updater uses) so the
//   download button always points at the newest published installer — no
//   page edit per release.
// - zh / en copy; the choice is remembered in localStorage.
(function () {
  "use strict";

  var STR = {
    zh: {
      skip: "跳到正文",
      navLabel: "主导航",
      navFeatures: "功能",
      navDownload: "下载",
      navFaq: "常见问题",
      langLabel: "Switch to English",
      eyebrow: "免费 · 开源 · MIT",
      heroTitle: "把 Claude Code、Codex 和 Pi<br>装进一个桌面 IDE",
      heroLead: "MarioCode 不重新发明 agent,只把官方引擎放进好用的界面:实时流式对话、可视化工具审批、计划模式,再加上文件、Git、终端和内置浏览器。",
      ctaDownload: "下载 Windows 版",
      ctaFeatures: "看看能做什么",
      metaLoading: "正在获取最新版本…",
      metaReady: "v{version} · {size} · {date} 发布",
      metaError: "暂时获取不到最新版本,请稍后刷新重试。",
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
      f2d: "回复逐字流式显示,思考过程、工具调用和结果都是结构化卡片;改了哪些文件一目了然,可以一键撤销本轮。",
      f3t: "先审批,再动手",
      f3d: "写文件、执行命令前弹出审批:允许、始终允许或拒绝。计划模式下先出方案,你同意后才开始改代码。",
      f4t: "完整的 IDE 能力",
      f4d: "文件树、Monaco 编辑器、diff 对比、多仓库 Git、多标签终端、内置浏览器和语言服务器,不用来回切窗口。",
      f5t: "后台也能干活",
      f5d: "关掉窗口会收到系统托盘,任务继续跑。支持定时任务、微信通知,也能在手机上查看会话和审批。",
      f6t: "自动更新",
      f6d: "新版本发布后应用内会提示,点一下下载,重启即完成安装。",
      dlTitle: "下载 MarioCode",
      dlSub: "Windows 10 / 11 · 64 位",
      dlButton: "下载安装包",
      platformNote: "目前只提供 Windows 版,macOS 版还在准备中。",
      stepsTitle: "安装提示",
      step1: "运行下载的安装包,按提示选择安装位置。",
      step2: "安装包暂未做代码签名,如果出现「Windows 已保护你的电脑」,点「更多信息」→「仍要运行」。",
      step3: "首次打开后,在 设置 → 模型配置 里登录官方账号,或添加你自己的模型服务。",
      faqTitle: "常见问题",
      q1: "MarioCode 收费吗?",
      a1: "免费,MIT 开源。模型调用按你使用的模型服务计费,由服务商收取。",
      q2: "需要准备什么?",
      a2: "一个可用的模型来源:Claude 或 Codex 官方账号,或者任意兼容 OpenAI / Anthropic 协议的 API 服务。",
      q3: "我的代码和对话会被上传吗?",
      a3: "会话和配置保存在你自己的电脑上,MarioCode 不收集使用数据。对话内容只会发送给你配置的模型服务。",
      q4: "怎么更新?",
      a4: "安装后应用会自动检查新版本,有更新时会提示你下载并重启安装。也可以随时回到本页下载最新安装包覆盖安装。",
      q5: "有 macOS 版吗?",
      a5: "还在准备中,目前只提供 Windows 版。",
      footVersion: "当前版本 v{version}",
      title: "MarioCode — AI 编程桌面客户端",
      langButton: "EN"
    },
    en: {
      skip: "Skip to content",
      navLabel: "Main navigation",
      navFeatures: "Features",
      navDownload: "Download",
      navFaq: "FAQ",
      langLabel: "切换到中文",
      eyebrow: "Free · Open source · MIT",
      heroTitle: "Claude Code, Codex and Pi<br>in one desktop IDE",
      heroLead: "MarioCode doesn't reinvent the agent — it puts the official engines in a proper workspace: live streaming chat, visual tool approval and plan mode, plus files, Git, a terminal and a built-in browser.",
      ctaDownload: "Download for Windows",
      ctaFeatures: "See what it does",
      metaLoading: "Checking the latest version…",
      metaReady: "v{version} · {size} · released {date}",
      metaError: "Couldn't load the latest version. Please refresh in a moment.",
      mockLabel: "MarioCode interface preview",
      mockCaption: "Interface preview: project rail and session list on the left, the conversation with tool approvals in the middle, files and Git on the right.",
      mockAlert: "1 session needs you",
      mockS1: "Refactor login module",
      mockS2: "Fix list pagination",
      mockS3: "Add unit tests",
      mockS4: "Bump dependencies",
      mockRun: "Running 0:42",
      mockWait: "Approval",
      mockTime: "3 min ago",
      mockYesterday: "Yesterday",
      mockAsk: "Split the login logic into its own hook and add tests",
      mockAnswer: "Sure — I'll read the current code first, then do it in three steps:",
      mockDone: "Done",
      mockApprove: "Allow?",
      mockComposer: "Send a message…",
      featTitle: "The whole coding conversation in one window",
      f1t: "Three engines, one interface",
      f1d: "Claude, Codex and Pi side by side. Bring any third-party model service that speaks the OpenAI or Anthropic protocol.",
      f2t: "See every step",
      f2d: "Replies stream token by token; thinking, tool calls and results are structured cards. Every changed file is listed, and a turn can be undone in one click.",
      f3t: "Approve before it acts",
      f3d: "Writing files or running commands asks first: allow, always allow or deny. Plan mode drafts a plan and waits for your OK before touching code.",
      f4t: "A full IDE",
      f4d: "File tree, Monaco editor, diffs, multi-repo Git, tabbed terminals, a built-in browser and language servers — no window juggling.",
      f5t: "Keeps working in the background",
      f5d: "Closing the window sends it to the system tray and running work continues. Scheduled tasks, WeChat notifications, and a phone view for sessions and approvals.",
      f6t: "Automatic updates",
      f6d: "When a new version ships the app tells you; one click downloads it and a restart installs it.",
      dlTitle: "Download MarioCode",
      dlSub: "Windows 10 / 11 · 64-bit",
      dlButton: "Download installer",
      platformNote: "Only Windows is available right now; macOS is on the way.",
      stepsTitle: "Installing",
      step1: "Run the installer and pick an install location.",
      step2: "The installer isn't code-signed yet. If \"Windows protected your PC\" appears, click \"More info\" → \"Run anyway\".",
      step3: "On first launch, sign in or add your own model service under Settings → Models.",
      faqTitle: "FAQ",
      q1: "Is MarioCode free?",
      a1: "Yes — free and MIT-licensed. Model usage is billed by whichever model service you use.",
      q2: "What do I need?",
      a2: "A model source: an official Claude or Codex account, or any API service compatible with the OpenAI or Anthropic protocol.",
      q3: "Is my code or conversation uploaded?",
      a3: "Sessions and settings stay on your computer and MarioCode collects no usage data. Conversations are only sent to the model service you configure.",
      q4: "How do updates work?",
      a4: "The app checks for new versions on its own and offers to download and install them on restart. You can also download the latest installer here anytime and install over the top.",
      q5: "Is there a macOS version?",
      a5: "It's on the way; only Windows is available today.",
      footVersion: "Current version v{version}",
      title: "MarioCode — AI coding desktop client",
      langButton: "中文"
    }
  };

  var STORE_KEY = "mc-site-lang";
  var lang = (function () {
    try {
      var saved = localStorage.getItem(STORE_KEY);
      if (saved === "zh" || saved === "en") return saved;
    } catch (e) { /* storage blocked */ }
    return /^zh/i.test(navigator.language || "") ? "zh" : "en";
  })();
  var release = null; // { version, path, size, date } once latest.yml loads
  var releaseFailed = false;

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

  function renderRelease() {
    var s = STR[lang];
    var metas = document.querySelectorAll(".dl-meta");
    var links = document.querySelectorAll(".dl-link");
    for (var i = 0; i < links.length; i++) {
      if (release) {
        links[i].setAttribute("href", release.path);
        links[i].setAttribute("download", "");
        links[i].removeAttribute("aria-disabled");
      } else if (releaseFailed) {
        links[i].setAttribute("href", "#download");
        links[i].setAttribute("aria-disabled", "true");
      }
    }
    for (var j = 0; j < metas.length; j++) {
      var p = metas[j].parentElement;
      if (release) {
        metas[j].textContent = fill(s.metaReady, { version: release.version, size: fmtSize(release.size), date: fmtDate(release.date) });
        p.classList.remove("error");
      } else if (releaseFailed) {
        metas[j].textContent = s.metaError;
        p.classList.add("error");
      } else {
        metas[j].textContent = s.metaLoading;
      }
    }
    var foot = document.querySelector(".dl-version-text");
    if (foot) foot.textContent = release ? fill(s.footVersion, { version: release.version }) : "";
  }

  function applyLang() {
    var s = STR[lang];
    document.documentElement.lang = lang === "zh" ? "zh-CN" : "en";
    document.title = s.title;
    var nodes = document.querySelectorAll("[data-i18n]");
    for (var i = 0; i < nodes.length; i++) {
      var key = nodes[i].getAttribute("data-i18n");
      if (s[key] == null) continue;
      // Only heroTitle carries markup (a fixed <br>); everything else is text.
      if (key === "heroTitle") nodes[i].innerHTML = s[key];
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

  // latest.yml is tiny and flat (electron-builder output); a few regexes are
  // enough. The installer name is validated before it becomes an href, so a
  // tampered manifest can't turn the button into a javascript: / off-site link.
  function parseManifest(text) {
    function pick(re) {
      var m = re.exec(text);
      return m ? m[1].replace(/^['"]|['"]$/g, "") : null;
    }
    var version = pick(/^version:\s*(\S+)/m);
    var path = pick(/^path:\s*(\S+)/m);
    var size = Number(pick(/^\s+size:\s*(\d+)/m));
    var date = pick(/^releaseDate:\s*(\S+)/m);
    if (!version || !/^\d+\.\d+\.\d+[\w.-]*$/.test(version)) return null;
    if (!path || !/^[A-Za-z0-9._-]+\.exe$/.test(path)) return null;
    return { version: version, path: path, size: size || 0, date: date || "" };
  }

  function loadRelease() {
    fetch("latest.yml", { cache: "no-store" })
      .then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.text();
      })
      .then(function (text) {
        release = parseManifest(text);
        releaseFailed = !release;
        renderRelease();
      })
      .catch(function () {
        releaseFailed = true;
        renderRelease();
      });
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
    var ua = navigator.userAgent || "";
    if (!/Windows/i.test(ua)) {
      var note = document.querySelector(".platform-note");
      if (note) note.hidden = false;
    }
    applyLang();
    loadRelease();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
