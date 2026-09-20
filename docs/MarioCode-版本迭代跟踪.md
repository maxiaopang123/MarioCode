# MarioCode 功能与版本记录

> 只记录功能 TODO 进度和 Git 版本，保持简单。

最后更新：2026-09-20

## 功能 TODO

状态：⚪ 未开始　🟡 进行中　🟢 已完成　🔴 阻塞

| ID | 功能 | 进度 | 状态 | 对应 Commit | 备注 |
|---|---|---:|---|---|---|
| `TODO-001` | 定时任务 | 100% | 🟢 已完成 | `c4f35af` | 已实现一次/每天/每周、启停、立即运行、异常恢复与防重叠 |
| `TODO-002` | 微信 ClawBot 信息推送（二维码绑定 + iLink Bot API） | 100% | 🟢 已完成 | `c4f35af` | 已实现二维码绑定、安全凭证、单一用户锁定、消息激活与定时任务结果推送；已通过构建、测试和代码复审 |
| `TODO-003` | 微信 ClawBot 对话接入 MarioCode | 100% | 🟢 已完成 | `dbdab86` | 已实现绑定者私聊纯文本接入、专用微信助手项目、按会话隔离、Agent/模型选择、`新会话` 指令及安全恢复；已通过冷构建、启动检查、回归测试与独立代码审查 |
| `TODO-004` | 外部工具 Skill / MCP 同步（非复制导入） | 0% | ⚪ 未开始 | - | P1。把设备上 Claude Code / Codex / Cursor / Zcode 已有的 skills 与 MCP servers 自动同步进 MarioCode，源头变更自动跟随，替代现有一次性「导入 = 复制」 |
| `TODO-005` | 内置工具：网页搜索 + 图片生成 | 0% | ⚪ 未开始 | - | P2。三个 provider 共用的 `web_search` / `image_generate`，不依赖模型端点是否原生支持；按 `agentBrowserTools` 模式三端注册 |
| `TODO-006` | 统一系统提示词 | 0% | ⚪ 未开始 | - | P4（建议提前到 TODO-005 之前）。用户可编辑的全局 + 项目级系统提示词，Claude / Codex / Pi 三端一致注入 |
| `TODO-007` | 聊天框界面渲染优化（含前端 UI 体检） | 70% | 🟡 进行中 | `baa45a4`…`5d8ca24`（11 个） | **P0（原 P3，2026-09-20 上调）**。体检完成并排出 7 项动工顺序；第 1～3 项（焦点环、死代码清场、手机端 i18n）与第 7 项第一步已完成，第 4 项两批替换已落地、余量低频。**第 5、6 项卡在取数**——按文档自己的口径要先量后改，而量行高与分组耗时都得把应用跑起来 |
| `TODO-008` | DeepSeek Harness（dsh）接入为第四个 Provider | 0% | ⚪ 未开始 | - | P3。先做 1–2 天可行性 spike；照 Pi 的「独立 host 进程 + MessageAdapter」模板接入 |
| `TODO-009` | 禁止 agent 用内置浏览器访问搜索引擎 | 100% | 🟢 已完成 | `81fe292` | TODO-005 落地前的止血：Pi 无搜索工具时模型拿浏览器去搜索引擎翻页，每次 snapshot 10K+ token。三端共用的 `agentBrowserTools` 加守卫——navigate 到搜索站（含首页）拒绝，snapshot/find/evaluate/screenshot 发现当前页是搜索站也拒绝；只拦搜索站自身域名，产品子域不受影响；提示词同步补禁令。写死名单、暂无开关。已通过 tsc 与 28 条域名规则用例 |

## 规划详情（2026-09-20 待排期）

### TODO-007 聊天框界面渲染优化（含前端 UI 体检）· P0

- **目标**：长会话与流式输出下的流畅度与滚动稳定性，以及键盘可达性、提示层、手机端 i18n 这几处会被用户直接感知的缺口。
- **体检结论（2026-09-20，静态通读 `apps/desktop/src/renderer` 全部 84477 行 / 139 个 tsx + 79 个 ts + styles.css）**：底子比预期干净——638 处 `useSessionStore` 调用无一裸订阅（全走 selector）、0 个 `console.log`、2 个 `any`、147 个 CSS 变量而硬编码颜色仅 11 处、`!important` 仅 6 个、任意 `z-[n]` 仅 8 个。问题集中在下列七条，按「收益 ÷ 风险」排出动工顺序。

1. **键盘焦点环在默认主题下缺失（零风险，改 1 处 CSS）** —— 🟢 **已完成 2026-09-20**
   落地方式：`styles.css` 新增主题无关的「Keyboard focus ring」区块（实线 2px `--accent`/0.55，offset 2），原 `html.sketch` 那条降级为只覆盖笔触（`outline-style: dashed` + 颜色）。粗细、偏移与排除项由基础环统一提供。那 23 个写了 `outline-none` 的文件**一个都没改**。
   排除项里额外加了 `:not([class*="focus-visible:ring"])`：全库 52 处已自带 Tailwind ring，ring 走 `box-shadow`、本规则走 `outline`，两者不互相覆盖，不排除就会画出两圈同心环。
   **仍需人工验收**：跑起来 Tab 一圈，确认本就故意不要环的整行卡片 / contenteditable 没有冒框。
   <details><summary>原始问题</summary>
   全库唯一的 `:focus-visible` 规则在 `styles.css:2173`，被限定在 `html.sketch` 之下；而 `sessionStore.ts:4367` 的默认值是 `themeStyle: "classic"`。即只有切到手绘主题才有焦点环。同时 `outline-none` 写了 100 处，其中 **23 个文件**去掉 outline 且本文件内无任何 `focus-visible:` / `focus:ring` 补偿（含 `ChatPane`、`ComposerEditor`、`ModelDropdown`、`LeftBar`、`SearchDialog`、`TabBarChrome`）。
   层叠依据：`:focus-visible:not(.inputarea):not(.xterm-helper-textarea)` 特异性 0-3-0 > `.outline-none` 的 0-1-0，且 `@tailwind utilities` 在第 3 行、该段在 2000 行后，特异性与源码顺序双保险。
   </details>

2. **清场（零风险）** —— 🟢 **已完成 2026-09-20**
   `lib/virtualListAdapter.ts` 已删除（104 行，零引用）。`flushDeltas` 改为把变更收集进局部 `updated` 对象、末尾一次性合并返回，不再就地改写 `s.messagesBySession`；全部未命中时返回 `{}` 保持 map 引用不变。错注释一并改掉。
   <details><summary>原始问题</summary>
   `lib/virtualListAdapter.ts` 全库零引用，且其中 `useVirtualTimeline` 是空壳——函数体只有 `setActiveId((prev) => prev); // placeholder — real logic below`，下面并没有 real logic，滚动监听也从未挂上。另，`sessionStore.ts` 的 `flushDeltas` 在 `setState` 回调内就地改写 `s.messagesBySession[sid] = next`，配的注释称「zustand 能通过 proxy 检测到这个 mutation」——**zustand 没有 proxy**（那是 immer / valtio）。原先能跑是靠末尾那句浅拷兜底，但旧 state 对象已被污染，devtools / `subscribeWithSelector` 这类做新旧比对的会看不到变化。
   </details>

3. **手机端绕过了 i18n** —— 🟢 **已完成 2026-09-20**
   实际规模比初估大得多：不止 26 处 JSX 文本，连同 `aria-label` / `title` / `placeholder` / `label` / toast 与错误文案、以及模块级常量表里的中文，**8 个文件共 131 条**。
   落地方式：新建 `lib/i18n/{zh,en}/mobile.ts` 两份目录（131 键，前缀 `mobile.back` / `mobile.files.*` / `mobile.fileViewer.*` / `mobile.viewer.*` / `mobile.pairing.*` / `mobile.settings.*` / `mobile.connect.*` / `mobile.session.*` / `mobile.git.*`），在 `core.ts` 注册；含义完全一致的复用了既有 `common.*`（cancel / save / delete / close / copied / refresh / loading / rename）。改动文件：`MobileGitScreen`、`MobileSessionDrawer`、`RemoteConnectPanel`、`MobileSettingsSheet`、`PairingScreen`、`MobileFilesScreen`、`MobileViewerOverlay`、`FileViewer`。
   两类不能直接调 hook 的位置单独处理：模块级常量表（`STATUS_LABEL`、`STATE_LABELS`、`THEME_OPTIONS`）改为存 `MessageId`、在使用点 `t(...)`；`PairingScreen` 的 `defaultDeviceName()` 改为接收 `t` 作参数（它在 `useState` 惰性初始化和 submit 兜底里被调用，不在渲染期）。
   **待补（已确认受阻）**：挡回流的 lint 规则（禁止 `components/**/*.tsx` 的 JSX 文本节点出现 CJK，注释不管）还没加，而且**本仓库根本没装 ESLint**——两个包都没有 `lint` script，仓库里也没有任何 `eslint.config.*` / `.eslintrc*`，`turbo.json` 里那个 `lint` task 因此永远跑空（源码里残留的 `// eslint-disable-next-line` 注释是上游留下的）。要加这条规则得先从零搭 ESLint（装依赖 + 配置 + 两个包各加 script），已超出本项范围，需单独立项。

4. **提示层：569 处原生 `title=` vs 15 处 `Tooltip`** —— 🟡 **`Hint` 已落地 + 首批已替（2026-09-20）**
   `components/ui/tooltip.tsx` 已封装且从 barrel 导出，但只用了 15 次；实际承担提示的是 569 处原生 `title`。原生 title 延迟约 1 秒、样式与位置不可控（手绘主题下尤其出戏）。根因是 Tooltip 为五层 compound API（`Root / Trigger / Portal / Positioner / Popup`），替一个 `title` 要写五层。
   落地方式：新增 `components/ui/hint.tsx`（单 prop `<Hint label="…">`，从 barrel 导出）。它**把 trigger 合并到子元素上而不是包一层**——子元素的 className 改走 Trigger，由 `cn()` 的 twMerge 裁掉 primitive 自带的 `inline-flex`，DOM 节点数不变，`onClick` / `style` / `disabled` 原样保留。子元素自己没有可访问名时，`label` 顺带补成 `aria-label`（有则不覆盖，有可见文本的传 `describeOnly`）。
   首批替换只挑**窗口常驻、不随列表重复**的栏：`BrowserToolbar` 的 `ToolButton`（一处改动覆盖 8 个按钮）、`TabBarChrome` 的 `TabBarChevronButton`（两条标签栏共用）、`Titlebar` 的三个面板开关。**禁用态按钮不派发指针事件、hint 打不开**，所以 `ToolButton` 只在 `disabled` 时保留原生 `title` 兜底（前进/后退长期处于禁用态）。
   **原计划的「① 先替 `components/mobile/*`」这一条作废**：`@base-ui/react@1.6.0` 的 `TooltipTrigger.js:157` 写死 `mouseOnly: true`，tooltip 在触屏上同样不出现，换过去收益为零。手机端真正缺的是可访问名——已按这个口径扫过 8 个文件的全部 `<button>`，只有 `MobileFilesScreen` 的返回上级按钮是纯图标且无名，已补 `aria-label`；其余要么已有 `aria-label`，要么带可见文本。
   **第二批（2026-09-20）**：先把 569 处按元素分了类（脚本审计，排除 `components/mobile`）——**363 处根本不在 `<button>` 上**（绝大多数是截断行的 `title={fullPath}`，保留不动）、**93 处按钮自带可见文本**（title 是补充说明，基本不必换）、**10 处在 `.map(` 行内**（按上面的口径不换），真正「title 是唯一语义来源的纯图标按钮」只有 **77 处**。
   第二批替掉了其中高频的那些，优先走**共享包装组件**（改一处覆盖多个调用点）：`RightPanel.RailButton`、`TerminalPanel.IconBtn`、`GitRepoCard.ActionButton`、`FontSizeStepper.StepperButton`、`MicButton`、`PlanApprovalPrompt.segButton`；再加两条侧栏的常驻头尾（`LeftBar` 与 `StreamSidebar` 各自的折叠 / 视图切换 / 新建项目 / 定位会话 / 主题开关，以及共用的 `LeftBarModeSwitch`）、`ChatPane` 的停止生成与回到底部、`ActivityConsole` 的头部两个按钮、`SideChatPanel` 的新建与两处返回。全库 `<Hint>` 调用点现为 32 个。
   **被排除的共享包装**：`SidebarShared.HoverIconButton`、`SessionTabs`、`TurnFlowPanel` 的步骤行、`GitRepoCard.RowActionIcon`、`StreamSidebar.manageButton`、`UsagePanel` —— 全是按行重复渲染或挂在非按钮上的截断 title。
   **剩余**：审计脚本报 65 处，但它判断「是否按行重复」只看 `.map(` 的文本邻近度，**认不出单独定义、再被 map 调用的行组件**（`LeftBar` 1352 行之后的那些就是这样），所以真实剩余比 65 少；余下的主要散在设置页各面板与 IDE 侧的对话框里，单点低频。**不做无差别 codemod。**

5. **`estimatedItemSize={80}` 偏小**（`ChatPane.tsx:3437`，`drawDistance={400}`）—— ⛔ **卡在取数，需要跑起来**
   一行常是一整张 markdown 回复或工具卡，估值偏小会让未测量区域的滚动条长度与 `scrollToOffset` 都不准——代码里那些 `raf1 → raf2 → scrollToEnd` 双帧补丁与「先瘦一下再瞬间对齐」的写法就是症状。要先采真实行高中位数，再考虑按 `kind` 分档估值（用户消息短 / 工具卡中 / markdown 回复长）。**补丁逐个验证后再摘，不要跟着一起删**，否则出问题分不清是哪一变引起的。
   **更正**：本文档原写「用 `MessageRow` 现成的 `ResizeObserver`」——渲染层没有这个东西。`components/chat` 里唯一的 `ResizeObserver` 在 `ChatPane.tsx:4229`，量的是折叠用户消息的高度，跟行高统计无关；行的测量归 `@legendapp/list` 自己管。所以取数要么现加埋点，要么开发者工具里直接量已渲染的行。**没有真实分布之前不要改这个数**：上一轮口头说的 160～240 是猜的。

6. **流式重算（先量后改，暂不动刀）** —— ⛔ **同样卡在取数**
   每次 delta flush 后 `messages` 引用即变，`ChatPane.tsx:1314` 的 `groupMessagesForRender` 与 `3336` 的 `listItems` 两遍全历史扫描都会重跑，频率接近 60Hz。另有 `Markdown`（`Markdown.tsx:657`，已 memo）每次拿整段累积文本重解析——`MessageBlocks.tsx:1002` 已做节流铺垫、Shiki 有 fnv1a → HTML 缓存，`sessionStore.ts:4085` 的自适应节流（rAF / 50ms 定时器 / microtask 三档）也已到位。
   但消息分页（`hasMoreMessagesBySession` / `loadOlderMessages`）已经卡住了内存中的条数，**目前没有证据证明真的卡**；而分组逻辑会跨消息合并（连续纯操作类消息并成一张卡）、liveSpine 有成对哨兵，切点必须落在真正封口的回合边界上，切错会让聊天记录错乱——产品里最贵的那类 bug。正确顺序：先埋 `performance.mark` 量出分组耗时占帧预算多少，超了再做「已封口前缀缓存 + 每帧只重算活跃尾巴」。

7. **树虚拟化** —— 🟡 **第一步已完成（2026-09-20），第二步仍建议暂缓**
   聊天区已由 `@legendapp/list` 虚拟化（本文档原「长时间线虚拟化」一条可划掉），但 `FileTree.tsx` 是递归 `children.map()` 全量渲染已展开子树，`LeftBar` 的项目 / 会话树同理。
   低垂果子已摘：原先**目录行和文件行各自挂一个 `ConfirmDialog`**，展开 300 个节点就是 300 个确认框实例——各带一次 `useI18n()` 的 locale 订阅，以及每次行重渲染都要为一个关着的弹窗跑三次 `t(...)`。现改为树根单实例：新增 `DeleteRequestContext`，行右键「删除」raise 一个 `{ kind, name, confirm }` 请求，根据 `kind` 选文案；`confirm` 闭包留在行里，所以删除后的各自后续（`bumpReload`、关掉受影响的编辑器标签）行为不变。全文件 `ConfirmDialog` 从 2 处降到 1 处。
   第二步（拍平成 flat list 交给 LegendList）要重写展开折叠、键盘导航、拖拽与右键菜单的掌控，是个真项目，等真有大仓库卡顿反馈再排期。

- **顺带记录**：`@legendapp/list` 钉在 `3.0.0-beta.44`——产品最核心的聊天视窗跑在 beta 库上。`sessionStore.ts` 10341 行、`ChatPane.tsx` 4416 行（本文档原记 216KB），拆分仍是可维护性欠账，但因 selector 纪律好，当前不直接转化为性能问题。
- **工作量**：1–3 项合计约 1 天；第 4 项分批 1–2 天；5–6 项需先量化再估；第 7 项第一步半天，第二步 3–5 天。
- **1–3 项的验证（2026-09-20，依赖已装好）**：
  - `pnpm typecheck` **通过**（`@mcode/contracts` + `@mcode/desktop`，3 个 task 全绿）。
  - `pnpm build` **通过**（electron-vite 三段全部产出）；抽查构建产物确认两条焦点环规则与迁移后的英文文案都进了 bundle。
  - 另跑了一次性 Node 校验脚本，查四件事：① 每个区域文件 zh / en 键集完全一致；② 跨区域无重名键（后 spread 会静默覆盖）；③ renderer 全量 **2488 处** `t(…)` / `translate(…)` 字面量调用的键都能在合并后的 **2246** 个键里找到；④ `components/mobile` 剥掉注释后不再有中文字面量。四项全过。
  - 安装侧注意：`registry.npmjs.org` 在本机不可达，需走 `registry.npmmirror.com`（仓库 `.npmrc` 已配好 Electron 二进制镜像，registry 本身要另配）。`cpu-features`（`ssh2` 的可选依赖）因本机没有 C++ 编译器编译失败，属可选依赖，不影响安装与构建。
  - **仍未验证**：运行时表现与视觉层面（间距、对齐、配色观感、焦点环反向误伤）——需要启动应用后 Tab 一圈确认。
- **第 4、7 项的验证（2026-09-20）**：
  - `pnpm typecheck` **通过**（3 个 task 全绿）、`pnpm build` **通过**（electron-vite 三段全部产出）。
  - `Hint` 的合并行为另跑了一次性服务端渲染检查（esbuild 打包 + `renderToStaticMarkup`，四个用例）：纯图标按钮渲出**单个** `<button>`、无包装层，class 为 `outline-none flex h-7 w-7 …`（twMerge 已裁掉 primitive 的 `inline-flex`），`aria-label` 补上；子元素自带 `aria-label` 时不被覆盖；`describeOnly` 时不注入、可见文本保留；`disabled` / `title` / `style` / `type` 全部穿过合并保留。
  - 手机端可访问名的扫描是脚本跑的：遍历 `components/mobile` 全部 `<button>`，剥掉图标元素与注释后无可见文本、且无 `aria-label` 的只有 1 处。
  - **仍未验证**：需要启动应用确认的三件事——hint 的浮层位置与手绘主题下的观感；`Titlebar` 三个开关外包了 `Hint` 后 `WebkitAppRegion: no-drag` 的拖拽区域是否仍正确；文件树删除确认框提到根之后，右键删除→确认→列表刷新这条路径端到端可用。
- **未验证（体检结论本身）**：性能相关结论均由代码路径推导，非 profiler 实测。

### TODO-004 外部工具 Skill / MCP 同步

- **目标**：用户设备上已有的 skills / MCP servers（Claude Code `~/.claude`、Codex `~/.codex`、Cursor `~/.cursor`、Zcode `~/.agents` + `~/.zcode`）自动出现在 MarioCode 里，源头增删改自动跟随，不必重新添加。
- **现状**：`ipc/skills.ts` 已有外部源扫描 + 复制导入（覆盖 Claude Code / Codex / Zcode，缺 Cursor）；`lib/mcpConfig.ts` 只扫 `~/.claude.json` 做只读导入；Pi 走 `piSkillBridge` 的 `additionalSkillPaths`。
- **方案要点**：
  1. Skills：`~/.mcode/skills/<name>` 用目录 junction / symlink 指回源目录（Claude 二进制只扫 `$CLAUDE_CONFIG_DIR/skills`，必须落在该目录下），或 `fs.watch` 镜像；Pi 直接把源目录追加进 `additionalSkillPaths`。
  2. MCP：多源读取（`~/.claude.json`、`~/.codex/config.toml` 的 `[mcp_servers]`、`~/.cursor/mcp.json`）归一化后合并进 `~/.mcode/.claude.json`，条目打 `source` 标记；源文件 watch 变更增量同步；本地手改优先、同名冲突提示。
  3. 设置页：每个源一个开关 + 最近同步时间 + 冲突列表。
- **工作量**：中（3–5 天）。**风险**：Windows junction 是否被 claude 二进制 / Codex 正常跟随需实测；各家 MCP 配置字段形状不一致（Codex TOML 的 env / args）需归一化。

### TODO-005 内置工具：网页搜索 + 图片生成

- **目标**：Claude / Codex / Pi 都能调用 MarioCode 自带的 `web_search` / `image_generate`，不依赖模型端点原生能力（Claude 自定义端点下 WebSearch 不可用，Pi 完全没有，Codex 仅当 OpenAI 端点开了 webSearch / imageGeneration 才有）。
- **现状**：`browser/agentBrowserTools.ts` 已是「共享核心 + 三端注册」模板（Pi `registerTool`、Claude `createSdkMcpServer`、Codex `dynamicTools`）；Codex 的 `imageGeneration` 图片卡片与 `imageArtifacts` 落盘链路可直接复用。
- **方案要点**：
  1. 新建 `main/tools/` 共享核心，按 agentBrowserTools 模式三端注册。
  2. 搜索后端：A 接 API（Tavily / Brave / Bing / Exa，需 key，结构化结果）；B 零 key 走内置浏览器打开搜索引擎 + snapshot 抽结果（慢、易被反爬）。建议 A 为主、B 兜底。
  3. 图片生成走 OpenAI 兼容 `images/generations`（GPT-image、DeepSeek / Gemini / SD 的兼容端点），在模型供应商配置里加「图片生成」能力位。
  4. 设置 → MCP 面板加两个内置工具开关（与内置浏览器同一开关组）；结果渲染复用 image block。
- **工作量**：中大（4–6 天）。**依赖**：TODO-006 的统一提示词里补工具使用指引效果更好。

### TODO-006 统一系统提示词

- **目标**：一份用户可编辑的全局系统提示词（+ 可选项目级），三端一致注入，与现有身份提示、输出风格并存。
- **现状**：`lib/systemPrompt.ts` 已集中放 provider 中立片段（三份 IDENTITY、Plan nudge、`joinPromptSections`）；注入点各自就位——Claude `options.systemPrompt.append`、Pi `before_agent_start` 注入器、Codex `instructions`；Claude 另有 output-style（`~/.mcode/output-styles`）。
- **方案要点**：
  1. settings 表加 `agent.systemPrompt.global`；项目级存 `<project>/.mcode/prompt.md` 或挂在 projects 表。
  2. 三端 `startTurn` 统一经 `joinPromptSections(identity, userGlobal, userProject, …)` 拼接。
  3. 设置页「AI 能力」加提示词编辑器（Markdown、字数、预览最终拼接结果）。
  4. 明确与 output-style / CLAUDE.md / AGENTS.md 的叠加顺序并写进文档。
- **工作量**：小（1–2 天）。基础设施齐全，建议放到 TODO-005 之前。

### TODO-008 DeepSeek Harness（dsh）接入

- **目标**：像 Pi 一样以 `AgentProvider` 接入 DeepSeek Harness（`@deepseek-ai/dsh`，MIT，2026-08 开发者预览，Cordis 插件架构，模型无关），用户可在输入框选 dsh 引擎。
- **现状**：`AgentProvider` + `ProviderRegistry` 已 provider 中立；Pi 的「独立 Node host 进程 + 协议 + MessageAdapter」（`providers/pi-sdk/piHost.ts` / `PiHostClient.ts` / `PiMessageAdapter.ts`）是可复制模板；`docs/pi-sdk-integration.md` 有完整接入方法论。
- **方案要点**：
  1. Spike（1–2 天）：确认 dsh 是否暴露可编程的 headless 会话 API / 事件流（append-only session log 应可订阅），工具审批、模型配置、skills / MCP 各走哪个插件口。
  2. 新建 `providers/dsh/`：独立 host 进程（隔离 Cordis 运行时与依赖）+ `DshAgentProvider` + `DshMessageAdapter` 映射到 runtime 事件（text / thinking / tool_use / todo.update / turn.done）。
  3. 复用 TODO-005 的共享工具核心注册为 dsh 插件工具。
  4. 模型配置沿用公共供应商模型（`d102f73` 那套）。
- **工作量**：大（1.5–2 周，含 spike）。**风险**：开发者预览、官方明示会有破坏性变更；版本锚定 + 适配层隔离。

## Git 版本记录

| 版本 | 日期 | Commit | 主要更新 | 状态 |
|---|---|---|---|---|
| 开发版 | 2026-09-20 | `baa45a4`…`9c70d1f` | 前端 UI 体检与前四轮修复（TODO-007 第 1～4、7 项）：主题无关焦点环、死代码清场与 `flushDeltas` 改不可变、手机端 131 条文案接入 i18n、`Hint` 提示层与首批窗口常驻栏、文件树删除确认框提到树根 | 已提交、未推送 |
| 开发版 | 2026-09-20 | `81fe292` | 禁止 agent 用内置浏览器访问搜索引擎（TODO-009） | 已提交、未推送 |
| 开发版 | 2026-09-18 | `dbdab86` | 微信 ClawBot 对话接入、后台 Agent 执行、会话隔离与安全恢复 | 已提交、未推送 |
| 开发版 | 2026-09-18 | `c4f35af` | 定时任务、微信 ClawBot 绑定及任务结果推送 | 已提交、未推送 |
| 开发版 | 2026-09-17 | `cac5b9e` | 公共提供商模型加载、多选与批量能力设置、Pi 兼容处理 | 已提交、已推送 |
| 开发版 | 2026-09-16 | `d102f73` | Claude、Codex 和 Pi 共用模型提供商 | 已提交、已推送 |
| 开发版 | 2026-09-15 | `2480799` | 支持本地 Agent 和独立 Pi Node host | 已提交、已推送 |
| 开发版 | 2026-09-15 | `e69e6d7` | MarioCode 名称与应用图标 | 已提交、已推送 |
| `v0.2.2` | 2026-09-15 | `130fd90` | 原 Mcode v0.2.2 基线 | 已发布 |

## 更新方法

1. 有新功能时，在「功能 TODO」新增一行。
2. 开发时更新进度和状态。
3. Git 提交后，填入 commit，并在「Git 版本记录」新增一行。
