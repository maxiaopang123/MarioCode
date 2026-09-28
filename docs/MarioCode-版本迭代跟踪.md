# MarioCode 功能与版本记录

> 只记录功能 TODO 进度和 Git 版本，保持简单。

最后更新：2026-09-26

## 功能 TODO

状态：⚪ 未开始　🟡 进行中　🟢 已完成　🔴 阻塞　⏸ 暂定（条件不具备，等条件到位再排期）

## 当前进度（2026-09-26）

核心多 Agent 链路已经完成一轮闭环：共享提供商支持按模型分别勾选 Claude / Codex / Pi 接口；Claude、Codex、Pi 会按各自协议生成运行配置；共享提供商在已有回合运行时更新不会再阻塞或误切断旧回合；Codex 的 Responses 回合也已补上最终消息兜底，解决网关漏发流式文本时的空回问题。 TODO-004 的 MCP 同步已补上多源并发写入保护，并通过 Electron smoke 回归；当前仍待三个 Provider 的真机加载验收。

9/24–9/26 新增：UI 焕新四阶段全部提交（TODO-014）；Pi host 一启动就崩的问题已修（`ca5e0e1`）；设置新增「网络」页，统一管三个引擎的代理（TODO-015）；发现自动更新会把 MarioCode 装成上游 M Code，已先关掉（`d3e8599`，后续见 TODO-016）；关于页和 README 的仓库链接已改指 MarioCode 自己的仓库（`9ea4cc0`）。上游 M Code 从分叉点之后又发了 v0.2.3–v0.2.5，要不要同步见 TODO-017。

9/26 夜：TODO-013 snapshot 瘦身完成（`d36e806`，同页工具结果 18–21K → 3–7K 字符）；TODO-004 三个 Provider 的加载用真实引擎验过（`3b794c5`，`pnpm test:sync-load` 7/7），收成 100%；TODO-005 内置网页搜索 / 网页读取 / 图片生成完成（`c24b661`，设置 → 内置工具）。

仍需人工验收：TODO-005 在三个引擎的真实对话里调用（要模型额度）、真实图片模型出图；TODO-006 三端提示词一致性、TODO-007 / TODO-014 的运行时视觉检查、TODO-009 真实 Pi 会话、TODO-015 的真实系统代理和 Claude / Codex 端到端；Pi 真实模型调用也还没验。`apps/desktop/release/` 里的 0.1.54 安装包是旧代码打的（自动更新指向上游 + 坏的 Pi host），要 `pnpm package` 重打后才能发。`dbdab86` 之后的本地提交都还没推送（截至 `2eedfbf` 共 54 个）。

回归脚本（在 `apps/desktop` 下跑）：`pnpm test:sync-load`（TODO-004，同步产物被三个引擎加载）、`pnpm test:web-tools`（TODO-005，真实搜索 / 读网页 + 本地假图片接口）、`pnpm test:builtin-tools-electron`（TODO-005，先 `pnpm build`，真 app 设置页截图）。`pnpm test:pi-host` 要求项目和全局两套 Pi 运行时，本机只有项目的 0.83.0，可用 `node scripts/test-pi-host.mjs node_modules/@earendil-works/pi-coding-agent` 代跑。

| ID | 功能 | 进度 | 状态 | 对应 Commit | 备注 |
|---|---|---:|---|---|---|
| `TODO-001` | 定时任务 | 100% | 🟢 已完成 | `c4f35af` | 已实现一次/每天/每周、启停、立即运行、异常恢复与防重叠 |
| `TODO-002` | 微信 ClawBot 信息推送（二维码绑定 + iLink Bot API） | 100% | 🟢 已完成 | `c4f35af` | 已实现二维码绑定、安全凭证、单一用户锁定、消息激活与定时任务结果推送；已通过构建、测试和代码复审 |
| `TODO-003` | 微信 ClawBot 对话接入 MarioCode | 100% | 🟢 已完成 | `dbdab86` | 已实现绑定者私聊纯文本接入、专用微信助手项目、按会话隔离、Agent/模型选择、`新会话` 指令及安全恢复；已通过冷构建、启动检查、回归测试与独立代码审查 |
| `TODO-004` | 外部工具 Skill / MCP 同步（非复制导入） | 100% | 🟢 已完成 | `b2dfcdb` `ddad88d` `c66f635` `3b794c5` | P1。Skills 单向复制同步 + MCP 多源配置同步（Claude/Codex/Cursor/Zcode 配置文件 → ~/.mcode/.claude.json，watch 实时跟随、停用/移除自动撤回、本地手改优先）均已落地；多源并发写入保护和 Electron smoke 已通过；**三个 Provider 加载已用真实引擎验过**（`pnpm test:sync-load`：Claude CLI 列出同步的 skill 并连上两个 MCP server、Codex app-server 列出 skill 并启动两个 server、Pi loader 从镜像读到 skill，含 npx 同形的 `.cmd` 启动器，7/7）；Pi 不支持 MCP（设计如此） |
| `TODO-005` | 内置工具：网页搜索 + 图片生成 | 100% | 🟢 已完成 | `c24b661` | P2。三端共用的 `web_search` / `web_fetch` / `image_generate`（`main/tools/`），设置 → 内置工具。搜索默认必应，必应 / 百度免 Key；博查 / 智谱 / Tavily / Exa / Brave 为可选 Key 后端，失败退回必应；图片来源只能选共享提供商；读网页走隐藏窗口 + 与 snapshot 同一套正文提取、30 分钟缓存按 offset 续读；图片走 OpenAI 兼容 `/images/generations`，每次审批。已通过 typecheck、build、`pnpm test:web-tools`（14 项）、`pnpm test:builtin-tools-electron`（真 app 截图）；**未验证**：三端真实对话调用、五个 Key 后端真 Key（Exa / Brave 仅离线解析用例）、真实图片模型 |
| `TODO-006` | 统一系统提示词 | 100% | 🟢 已完成 | `8aaa72a`（功能）+ `8c7f02f`（预览对齐） | P4（原建议提前到 TODO-005 之前，已兑现）。用户可编辑的全局（settings 表）+ 项目级（`<project>/.mcode/prompt.md`）系统提示词，Claude / Codex / Pi 三端同位注入（身份之后、工具指引之前）；设置页新增「系统提示词」面板：两级编辑器、字数上限 20000、按 Agent 分层预览。三个待拍板已定：项目级存文件、Codex 走 `thread/start` / `thread/resume` 的 `developerInstructions`、模板库不做。叠加顺序已写进 `AGENTS.md`「统一系统提示词」节。已通过 `pnpm typecheck`；**真机三端一致性验证未做**（见规划详情） |
| `TODO-007` | 聊天框界面渲染优化（含前端 UI 体检） | 100% | 🟢 已完成 | `baa45a4`…`bf5672b`（11 个） | **P0（原 P3，2026-09-20 上调）**。体检 + 原七项里**静态就能做完的五项**：焦点环、死代码清场、手机端 i18n、`Hint` 提示层两批替换、文件树删除确认框提到树根。原第 5、6 项与第 7 项第二步不是没做完，是**条件不具备**，已拆成 `TODO-010` / `TODO-011` 暂定；第 3 项欠的 lint 规则拆成 `TODO-012`。**运行时验收仍待人工完成**（见规划详情末尾） |
| `TODO-008` | DeepSeek Harness（dsh）接入为第四个 Provider | 0% | ⚪ 未开始 | - | P3。先做 1–2 天可行性 spike；照 Pi 的「独立 host 进程 + MessageAdapter」模板接入 |
| `TODO-009` | 禁止 agent 用内置浏览器访问搜索引擎 | 100% | 🟢 已完成 | `81fe292` | TODO-005 落地前的止血：Pi 无搜索工具时模型拿浏览器去搜索引擎翻页，每次 snapshot 10K+ token。三端共用的 `agentBrowserTools` 加守卫——navigate 到搜索站（含首页）拒绝，snapshot/find/evaluate/screenshot 发现当前页是搜索站也拒绝；只拦搜索站自身域名，产品子域不受影响；提示词同步补禁令。写死名单、暂无开关。已通过 tsc 与 28 条域名规则用例；**真机验证未做**（需 `pnpm dev` + Pi 跑一轮，确认模型回「无法联网搜索」而非去开浏览器） |
| `TODO-013` | 内置浏览器 snapshot 瘦身（降 token） | 100% | 🟢 已完成 | `d36e806` | `browser_snapshot` 加 `mode`（both / interactive / text）、`maxChars`、`offset`；元素一行一个、去 selector 行、展示 40 个（interactive 80 个）；正文改为主内容提取（main / article / 段落最集中的块），去导航 / 页脚 / 侧栏，默认 4000 字、按 offset 续读。真实页面同页对比：菜鸟教程 18.2K→3.2K、MDN 21.6K→6.7K、新浪 21.3K→5.9K、博客园 19.1K→5.9K 字符。`browser_search` 并入 TODO-005 的免 Key 搜索后端，不单做 |
| `TODO-014` | UI 焕新（四阶段） | 100% | 🟢 已完成 | `7791101`…`abefc47`（16 个） | 原型 `prototypes/ui-refresh.html`：设计基础 → 外壳导航 → 聊天界面 → 设置弹层；浅 / 深两套主题、翡翠绿只做点缀，会话行 30px、聊天正文 15px、标题 24px/500、字号 11px 起步。已通过 tsc；**真 app 验收未做**（小徽标字变大后显挤、侧栏 / 标题栏 / 页签布局最可能出问题） |
| `TODO-015` | 网络设置：直连 / 跟随系统代理 / 自定义代理 | 100% | 🟢 已完成 | `4277991` | 设置 →「AI 能力」→「网络」。统一管 Claude（对话、连接测试、标题 / 提交信息生成）、Codex（每轮启动 app-server）、Pi（常驻 host 空闲时重启换路由）和 OpenAI 协议的本地 bridge，下一轮对话生效；跟随系统时环境变量优先，直连设 `NO_PROXY=*`，localhost 一律绕开，Pi host 加 `NODE_USE_ENV_PROXY=1`。已通过 tsc + Electron 33 对本地假代理 5 种场景实跑；**未验证**：真实系统代理读取、Claude / Codex 二进制端到端、界面真机查看；**未覆盖**：内置浏览器、插件下载、运行时下载 |
| `TODO-019` | MarioTool：定时器 + 微信通知 | 90% | 🟡 进行中（已实现待验收） | 未提交 | 三端新增 `mario_schedule_list / create / update / delete`（Claude MCP server `mcode-schedule`）和 `mario_wechat_notify`（`mcode-wechat`），设置 → MarioTool 新增「定时任务」「微信通知」两节开关，MCP 页内置组多两行。审批统一走 `builtinToolNeedsApproval`：查看免审批；创建 / 修改 / 删除与微信通知在普通对话里要审批，在无人值守运行（定时任务 / 微信对话）里不审批——定时器改动在执行时直接拒绝，微信通知直接发；微信每会话 10 分钟最多 5 条。已通过 tsc + 离线用例（审批真值表、参数合并校验）；**未验证**：三端真实对话调用、真实微信推送、无人值守运行里的拒绝链路 |
| `TODO-020` | 移除插件功能 + 技能市场 | 90% | 🟡 进行中（已实现待验收） | 未提交 | 插件功能已移除（设置页、左栏入口改为「技能」、per-turn 投递、MCP 插件组）。技能市场：Skills 设置页新增「技能市场」对话框，来源 = 内置 anthropics/skills + 用户添加的 https Git 仓库 / 本地文件夹，树缓存在 `~/.mcode/skill-market/<id>/`，安装即复制到 `~/.mcode/skills`（三引擎下一轮生效）。已通过 tsc + 离线用例（`apps/desktop/scripts/skill-market-smoke`：扫描、安装、路径守卫、本地源添加/刷新/移除）；**未验证**：真实 GitHub 拉取、界面真机查看 |
| `TODO-010` | 聊天流渲染性能：行高估值与流式重算（原 TODO-007 第 5、6 项） | 0% | ⏸ 暂定 | - | P1。**解除条件：把应用跑起来采一次数**。两项都按「先量后改」的口径走，而行高分布与分组耗时都拿不到静态答案。文档里备了一段开发者工具即贴即用的行高统计脚本；分组耗时要现加 dev-only `performance.mark`。没有真实数字之前不要改 `estimatedItemSize`，也不要动分组切点——切错会让聊天记录错乱 |
| `TODO-011` | 文件树 / 会话树拍平虚拟化（原 TODO-007 第 7 项第二步） | 0% | ⏸ 暂定 | - | P3。**解除条件：出现真实的大仓库卡顿反馈**。第一步（删除确认框提到树根）已随 TODO-007 落地；第二步要把递归树拍平交给 LegendList，连带重写展开折叠、键盘导航、拖拽与右键菜单的掌控，估 3～5 天，属于「有人抱怨再做」的那类 |
| `TODO-012` | 前端 lint 基建：从零搭 ESLint + 禁止 JSX 文本出现 CJK | 0% | ⏸ 暂定 | - | P2。**解除条件：确认要不要引入这套工具链**。本仓库根本没装 ESLint——两个包都没有 `lint` script，也没有任何 `eslint.config.*` / `.eslintrc*`，`turbo.json` 里的 `lint` task 一直在跑空（源码里残留的 `// eslint-disable-next-line` 是上游留下的）。TODO-007 第 3 项欠的那条「挡中文回流」规则要落地，得先把这套装起来 |
| `TODO-016` | 自有发布渠道（重开自动更新） | 0% | ⏸ 暂定 | `d3e8599`（先关掉） | **解除条件：MarioCode 仓库发出第一个 Release**。自动更新原先指向上游 `huangbh2020/mcode`（上游 v0.2.5 > 本仓库 0.1.54，appId 相同，会把 MarioCode 装成 M Code），已用 `AUTO_UPDATE_ENABLED = false` 关掉。重开顺序：`electron-builder.yml` 的 `publish` 和两处 `RELEASES_URL` 改到 MarioCode → 发 Release → 开关改回 `true`。相关待拍板：appId / AUMID / 数据目录（`%APPDATA%\Mcode`）要不要和 M Code 分开——分开才能共存，但老安装不会原地升级、要迁数据 |
| `TODO-017` | 同步上游 M Code 新功能（v0.2.3–v0.2.5） | 0% | ⏸ 暂定 | - | **解除条件：拍板合不合、合哪些**。分叉点 `130fd90`（v0.2.2）之后上游又有 39 个提交、动了 168 个文件：Agent / 任务编排、定时任务 v2（和本仓库 TODO-001 重叠）、终端并入右栏 + 文件树分栏、Git 面板实时 diff、右栏会话级页签、外部文件拖进输入框、后台 bash 任务列表、Agent 启动服务的端口扫描、控制中心样式的活动区，以及两个社区修复（Codex 第三方模型上下文窗口、终端 Shell 路径设置反馈）。两边都大改过界面，建议先拉下来列冲突清单再挑 |
| `TODO-018` | 用户账户 + Token 计费（内嵌官方模型服务） | 0% | ⏸ 暂定 | - | 2026-09-26 立项，具体做法之后再定。用户在 MarioCode 里登录，使用你提供的模型服务，按 token 扣费；计费在服务端网关算，客户端只负责登录、拿到用户 Key、自动配成「MarioCode 官方」共享提供商。**解除条件：拍板规划详情里的 5 个问题**（「新的 tool」指什么、用户在国内还是海外、卖哪些模型、收费方式、是否保留自带 Key）。初步规划见下方规划详情 TODO-018 |

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

5. **`estimatedItemSize={80}` 偏小** —— ⏸ **已拆为 `TODO-010`**（条件不具备：要跑起来采数）

6. **流式重算** —— ⏸ **已拆为 `TODO-010`**（同上）

7. **树虚拟化** —— 🟢 **第一步已完成 2026-09-20**；第二步 ⏸ **已拆为 `TODO-011`**
   聊天区已由 `@legendapp/list` 虚拟化（本文档原「长时间线虚拟化」一条可划掉），但 `FileTree.tsx` 是递归 `children.map()` 全量渲染已展开子树，`LeftBar` 的项目 / 会话树同理。
   低垂果子已摘：原先**目录行和文件行各自挂一个 `ConfirmDialog`**，展开 300 个节点就是 300 个确认框实例——各带一次 `useI18n()` 的 locale 订阅，以及每次行重渲染都要为一个关着的弹窗跑三次 `t(...)`。现改为树根单实例：新增 `DeleteRequestContext`，行右键「删除」raise 一个 `{ kind, name, confirm }` 请求，根据 `kind` 选文案；`confirm` 闭包留在行里，所以删除后的各自后续（`bumpReload`、关掉受影响的编辑器标签）行为不变。全文件 `ConfirmDialog` 从 2 处降到 1 处。

- **顺带记录**：`@legendapp/list` 钉在 `3.0.0-beta.44`——产品最核心的聊天视窗跑在 beta 库上。`sessionStore.ts` 10341 行、`ChatPane.tsx` 4416 行（本文档原记 216KB），拆分仍是可维护性欠账，但因 selector 纪律好，当前不直接转化为性能问题。
- **工作量**：1–3 项合计约 1 天；第 4 项分批 1–2 天；第 7 项第一步半天。拆出去的三条见 `TODO-010` / `TODO-011` / `TODO-012`。
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

### TODO-010 聊天流渲染性能：行高估值与流式重算 · ⏸ 暂定

- **从哪来**：原 TODO-007 的第 5、6 项。两项都不是「没排上」，是**这两项自己的口径就是先量后改**，而需要的数都拿不到静态答案。
- **解除条件**：把应用跑起来采一次数。下面两段各自说清要采什么。

**① 行高估值**（`ChatPane.tsx:3437` 的 `estimatedItemSize={80}`，配 `drawDistance={400}`）

一行常是一整张 markdown 回复或工具卡，估值偏小会让未测量区域的滚动条长度与 `scrollToOffset` 都不准——代码里那些 `raf1 → raf2 → scrollToEnd` 双帧补丁与「先瘦一下再瞬间对齐」的写法就是症状。**没有真实分布之前不要改这个数**：早先口头说的「160～240」是猜的。

采数最省事的办法是不改代码：开一个长会话、上下滚一遍让行都渲染过，在渲染进程的开发者工具控制台贴这段——

```js
(() => {
  const s = [...document.querySelectorAll("div")]
    .find(e => e.style.overscrollBehavior === "contain");
  if (!s || !s.firstElementChild) return "没找到聊天列表，先打开一个会话";
  const h = [...s.firstElementChild.children]
    .map(e => e.offsetHeight).filter(n => n > 0).sort((a, b) => a - b);
  const q = p => h[Math.floor((h.length - 1) * p)];
  return { n: h.length, min: h[0], p25: q(.25), median: q(.5),
           p75: q(.75), p90: q(.9), max: h.at(-1),
           mean: Math.round(h.reduce((a, b) => a + b, 0) / h.length) };
})()
```

拿到中位数再决定是给一个常数，还是按 `kind` 分档（用户消息短 / 工具卡中 / markdown 回复长）。**那些 raf 补丁逐个验证后再摘，不要跟着一起删**，否则出问题分不清是哪一变引起的。

**更正一处**：本文档原写「用 `MessageRow` 现成的 `ResizeObserver` 采行高」——渲染层没有这个东西。`components/chat` 里唯一的 `ResizeObserver` 在 `ChatPane.tsx:4229`，量的是折叠用户消息的高度，跟行高统计无关；行的测量归 `@legendapp/list` 自己管。

**② 流式重算**

每次 delta flush 后 `messages` 引用即变，`ChatPane.tsx:1314` 的 `groupMessagesForRender` 与 `3336` 的 `listItems` 两遍全历史扫描都会重跑，频率接近 60Hz。另有 `Markdown`（`Markdown.tsx:657`，已 memo）每次拿整段累积文本重解析——`MessageBlocks.tsx:1002` 已做节流铺垫、Shiki 有 fnv1a → HTML 缓存，`sessionStore.ts:4085` 的自适应节流（rAF / 50ms 定时器 / microtask 三档）也已到位。

但消息分页（`hasMoreMessagesBySession` / `loadOlderMessages`）已经卡住了内存中的条数，**目前没有证据证明真的卡**；而分组逻辑会跨消息合并（连续纯操作类消息并成一张卡）、liveSpine 有成对哨兵，切点必须落在真正封口的回合边界上，切错会让聊天记录错乱——产品里最贵的那类 bug。所以顺序是：先加一份只在 dev 构建生效的 `performance.mark`，量出分组耗时占帧预算多少；**超了才**做「已封口前缀缓存 + 每帧只重算活跃尾巴」。这一段没有免改代码的取数办法。

### TODO-011 文件树 / 会话树拍平虚拟化 · ⏸ 暂定

- **从哪来**：原 TODO-007 第 7 项的第二步。第一步（删除确认框提到树根）已随 TODO-007 落地。
- **解除条件**：出现真实的大仓库卡顿反馈。现在动手属于没有需求驱动的重写。
- **内容**：`FileTree.tsx` 目前是递归 `children.map()` 全量渲染已展开子树，`LeftBar` 的项目 / 会话树同理。要拍平成 flat list 交给 `@legendapp/list`，连带把展开折叠、键盘导航、拖拽与右键菜单的掌控全部重写一遍，估 3～5 天。

### TODO-012 前端 lint 基建 · ⏸ 暂定

- **从哪来**：TODO-007 第 3 项欠的那条「挡中文回流」规则——禁止 `components/**/*.tsx` 的 JSX 文本节点出现 CJK（注释不管）。
- **解除条件**：先确认要不要给这个仓库引入 ESLint 工具链。
- **现状**：**本仓库根本没装 ESLint**。两个包都没有 `lint` script，仓库里也没有任何 `eslint.config.*` / `.eslintrc*`，`turbo.json` 里那个 `lint` task 因此一直在跑空；源码里残留的 `// eslint-disable-next-line react-hooks/exhaustive-deps` 是上游留下的，本地没有任何东西在读它。
- **真要做**：装依赖（`eslint` + `typescript-eslint` + `eslint-plugin-react-hooks`）、加 flat config、两个包各补 `lint` script，那条 CJK 规则本身用 `no-restricted-syntax` 配一条 `JSXText` 的 esquery 选择器就够，不必写插件。顺带能把 `react-hooks` 那几条真正跑起来。

### TODO-004 外部工具 Skill / MCP 同步

- **目标**：用户设备上已有的 skills / MCP servers（Claude Code `~/.claude`、Codex `~/.codex`、Cursor `~/.cursor`、Zcode `~/.agents` + `~/.zcode`）自动出现在 MarioCode 里，源头增删改自动跟随，不必重新添加。
- **现状**：**Skills 单向复制同步已落地（2026-09-23）**；**MCP 多源配置同步已落地（2026-09-23）**。**三个 provider 的加载已验（2026-09-26，`3b794c5`）**：`pnpm test:sync-load` 在临时目录按同步引擎的产物布局（skill 镜像、合成的 Claude 插件目录、`.claude.json` 的 mcpServers、Codex config.toml）放好测试 skill 与两个 stdio MCP server（一个 `node`，一个 npx 同形的 `.cmd` 启动器），再用 provider 同样的参数问真实引擎——Claude CLI 列出 `mcode-sync-…:skill` 且两个 server 均 connected 带工具，Codex app-server 经 `skills/extraRoots/set` 列出 skill 且两个 server 启动带工具，Pi loader 从镜像读到 skill；不发模型请求。设置页「添加源 → 同步」的界面流程仍按 Electron smoke 的覆盖为准。
- **MCP 同步落地详情（2026-09-23）**：
  1. **同步引擎** `main/lib/mcpSync.ts`：用户在设置页添加外部 MCP 配置文件作为同步源（预设探测 Claude Code `~/.claude.json` / Codex `~/.codex/config.toml` / Cursor `~/.cursor/mcp.json` / Zcode `~/.zcode/mcp.json`，也支持手动选任意文件），引擎把每个源里可识别的 server 归一化为 `McpServerConfig` 后合并进 `~/.mcode/.claude.json` 的 `mcpServers`——该文件同时是 Claude 二进制的加载点与 Codex config.toml 物料来源，一处生效三端通吃。源文件只读，改动经父目录 `fs.watch`（600ms 防抖；watch 目录而非文件，因为 CLI 用替换式重写）实时跟随。
  2. **合并规则**：单向（源 → 镜像），权属表 `mcpSync.ownership`（settings 表）记录每源上轮同步进去的名字；再同步只替换/撤回自己拥有的名字，用户在面板手加/导入的同名条目经 `clearOwnershipFor` 摘除权属、永久保留（本地优先）；已存在的本地条目不同名覆盖、状态栏显示冲突名单。停用源 = 撤回其同步条目（冻结但继续加载会留下静默陈旧 server）；移除源 = 撤回 + 停止监听。
  3. **并发保护**：多个源同时变更时，共享镜像文件的读改写经全局串行锁排队，避免 Codex/Cursor 等 watcher 互相覆盖；Electron smoke 已覆盖两源共存、停用、重新启用和移除流程。
  4. **Codex TOML 归一化**：`[mcp_servers.*]` 的 `command/args/env`（stdio）与 `url/http_headers`（http）映射到 `McpServerConfig`（用 `smol-toml` 解析）；env 值里引用用户环境的 `${VAR}`/`$VAR`/`%VAR%` 被丢弃（Mcode 子进程里解析不出来，留着只会得到字面量）。
  5. **进程隔离**：与 skillSync 同一约定——模块不 import Electron，renderer 通知走注入的 `setMcpSyncChangeListener`，Electron 入口接线 `sendToRenderer(IPC.MCP_SYNC_CHANGED)`。
  6. **契约 + UI**：`mcp.syncList/syncScan/syncAdd/syncSetEnabled/syncRemove/syncRescan` 六个 IPC；MCP 设置页顶部新增「外部配置源同步」区块（开关 + server 数 + 上次同步时间/错误 + 移除 + 重新同步 + 添加对话框）。
- **Skills 同步落地详情（2026-09-23）**：
  1. **同步引擎** `main/lib/skillSync.ts`：用户添加外部技能根目录（如 `~/.codex/skills`），引擎把每个含 `SKILL.md` 的子目录复制镜像到 `~/.mcode/skills-sync/<sourceId>/`，源目录用递归 `fs.watch` + 400ms 防抖实时跟随；禁用源 = 冻结镜像保留，移除源 = 删镜像 + 删合成插件目录。
  2. **Claude 侧可见**：每次同步后合成一个本地插件目录 `~/.mcode/skills-sync-plugins/mcode-sync-<id>/.claude-plugin/plugin.json` + `skills/` 子目录拷贝，provider 启动时经 `options.plugins` 注入（`skipMcpDiscovery`），优先级最低。
  3. **Pi / Codex 侧可见**：Pi 走 host config 的 `extraSkillPaths`（主进程在 `loadHostConfiguration` 里把 `skillSyncMirrorRoots()` 追加进去）；Codex `skillRootsFor()` 直接加镜像根目录。
  4. **设置页**：SkillsPanel 顶部新增「外部源同步」区块：添加目录（原生文件夹选择器）、启停开关、skill 数 / 上次同步时间 / 错误提示、移除、手动「重新同步」。
  5. **进程隔离**：`skillSync.ts` 不许 import Electron（`build-pi-host.mjs` 会拒绝）；renderer 通知走注入的 `setSkillSyncChangeListener`，Electron 入口接线 `sendToRenderer(IPC.SKILLS_SYNC_CHANGED)`，Pi host 不接线。
  6. **契约**：`packages/contracts/src/ipc.ts` 新增 `SkillSyncSource` / `SkillSyncStatus` 类型 + `skills.syncList / syncAdd / syncSetEnabled / syncRemove / syncRescan` 五个 IPC；preload + webApi stub 已注册。
- **方案要点**：
  1. Skills：**已改拍板为纯复制镜像**（不用 junction/symlink——Windows 权限 + claude 二进制跟随性有风险）；Claude 用合成插件目录而非直接塞 `$CLAUDE_CONFIG_DIR/skills`（保持用户全局目录干净）；Pi 经 `extraSkillPaths`；Codex 加镜像根。
  2. MCP：多源读取（`~/.claude.json`、`~/.codex/config.toml` 的 `[mcp_servers]`、`~/.cursor/mcp.json`）归一化后合并进 `~/.mcode/.claude.json`，条目打 `source` 标记；源文件 watch 变更增量同步；本地手改优先、同名冲突提示。
  3. 设置页：每个源一个开关 + 最近同步时间 + 冲突列表。
- **工作量**：中（3–5 天）。**风险**：Windows junction 是否被 claude 二进制 / Codex 正常跟随需实测；各家 MCP 配置字段形状不一致（Codex TOML 的 env / args）需归一化。
- **实验方案**（补自上一会话，尚未跑）：
  1. Windows junction 跟随：`mklink /J` 建一个指向 `~/.claude/skills/<x>` 的 junction，Claude 跑一轮 `/<x>`；通过标准＝`/` 菜单列出且模型真的展开了 SKILL.md。(a) 整目录 junction 与 (b) 逐个 skill junction 两种形态分别测。
  2. `options.plugins` 指向没有 `.claude-plugin/plugin.json` 的目录能否加载（能则省掉合成清单）。
  3. Codex：`extraRoots` 传 `~/.claude/skills` + `config.toml` 追加一条从 `~/.cursor/mcp.json` 归一化来的 server，跑一轮看工具是否可见；TOML/JSON 样本覆盖 command/args/env/url 四种形状。
  4. `fs.watch(~/.claude.json)`：CLI 会频繁重写，量触发频率定 debounce 窗口。
  5. 遮蔽：两个源放同名 skill，确认只加载一份且面板提示正确。
- **待拍板**：Claude skills 走 (a) 合成插件目录还是 (b) 逐个 junction；要不要支持双向回写（建议不）。

### TODO-005 内置工具：网页搜索 + 图片生成

- **目标**：Claude / Codex / Pi 都能调用 MarioCode 自带的 `web_search` / `image_generate`，不依赖模型端点原生能力（Claude 自定义端点下 WebSearch 不可用，Pi 完全没有，Codex 仅当 OpenAI 端点开了 webSearch / imageGeneration 才有）。
- **现状**：`browser/agentBrowserTools.ts` 已是「共享核心 + 三端注册」模板（Pi `registerTool`、Claude `createSdkMcpServer`、Codex `dynamicTools`）；Codex 的 `imageGeneration` 图片卡片与 `imageArtifacts` 落盘链路可直接复用。
- **方案要点**：
  1. 新建 `main/tools/` 共享核心，按 agentBrowserTools 模式三端注册。
  2. 搜索后端：A 接 API（Tavily / Brave / Bing / Exa，需 key，结构化结果）；B 零 key 走内置浏览器打开搜索引擎 + snapshot 抽结果（慢、易被反爬）。建议 A 为主、B 兜底。
  3. 图片生成走 OpenAI 兼容 `images/generations`（GPT-image、DeepSeek / Gemini / SD 的兼容端点），在模型供应商配置里加「图片生成」能力位。
  4. 设置 → MCP 面板加两个内置工具开关（与内置浏览器同一开关组）；结果渲染复用 image block。
- **工作量**：中大（4–6 天）。**依赖**：TODO-006 的统一提示词里补工具使用指引效果更好。
- **控上下文设计（重点，避免重演 009 那种撑爆上下文）**：
  1. 搜与读分开：`web_search(query, n≤5)` 只回 标题 + URL + ≤200 字摘要（一次约 400–600 token）；要全文再调 `web_fetch(url)`，模型不会「顺手」拿到五篇全文。
  2. `web_fetch` 不回原页：Readability 去导航/广告 → HTML 转 Markdown → 硬上限 4–6K 字；可选 `focus` 参数按相关性只回 top-K 段。
  3. 溢出落盘：全文存 `userData/web-cache/<sha1>.md`，工具只返「前 4K 字 + 共 N 字 + handle」，续读用 `web_fetch(handle, offset)`。
  4. 可选二级压缩：便宜小模型按 `focus` 把页面总结成 ≤800 字（复用 `titleGen.ts` 那条副模型通道）。
  5. 同一轮去重 + 缓存；条数 / 单页字数 / 是否二级压缩三个上限在设置里可调。
- **实验方案**（补自上一会话，尚未跑）：
  1. 网络可达性先测：主进程分别探 博查 / 智谱 / Tavily / Brave 的连通与延迟，据此定默认后端（本机连 github 都不通，海外 API 大概率废）。
  2. 端到端用 Pi 测（无原生能力最干净）：「搜一下 X 并总结」看工具卡片；「画一张 Y」看 image block + 右键「在资源管理器中显示」。
  3. Claude 自定义端点：`mcp__mcode-tools__web_search` 自动放行；原生 WebSearch 在自定义端点报错时模型是否会自己切到内置。
  4. Codex 双份工具：原生 webSearch 开着时模型选哪个，定去重策略。
  5. 零 key 浏览器抓取：10 次查询的成功率 / 耗时 / 反爬，决定能否当兜底。
- **待拍板**：默认搜索后端（建议博查）；图片生成要不要进审批（花钱）；结果条数与摘要长度上限。
- **拍板结果（2026-09-26）**：默认必应（免 Key，开箱可用；本机直连实测博查 / 智谱 / Tavily / 必应 / 百度可达，Brave、DuckDuckGo 超时所以没接），博查 / 智谱 / Tavily 作为可选 Key 后端、失败自动退回必应；图片生成每次审批（Full Access / 始终允许除外）；默认 5 条、摘要 ≤200 字、正文每次 5000 字，设置页可调。图片来源没做成「模型能力位」，改为设置页选共享提供商或填自定义接口 + 模型名——图片模型不会混进对话模型列表。
- **后续调整（产品决策）**：图片来源只能选共享提供商，自定义接口及其 Key 移除（旧的 `custom` 图片源视为未配置，`builtinTools.keys` 里的 `image` 条目自动剔除）。第三方搜索 API 作为**可选**后端保留：默认仍是免 Key 的必应（百度同为免 Key），博查 / 智谱 / Tavily 恢复，新增 Exa（`api.exa.ai/search`）与 Brave（`api.search.brave.com`，有免费档）；Key 加密存在原来的 `builtinTools.keys`，用户已存的博查 / 智谱 / Tavily Key 继续可用；任何 Key 后端失败（含没填 Key）都退回必应。可达性：Brave 本机直连超时，大陆使用可能需要在 设置 → 网络 配代理；DuckDuckGo 仍不接。
- **落地（2026-09-26，`c24b661`）**：核心在 `main/tools/`（描述 `builtinToolSpecs.ts` / 配置 `builtinToolsConfig.ts` / 隐藏窗口 `webPage.ts` / 三个工具 / 调用入口 `builtinTools.ts`）；Claude = 进程内 MCP `mcode-web` + `mcode-image`，Codex = dynamicTools（image_generate 手动审批），Pi = 扩展注册 + `builtinTool` 反向调用回主进程；设置 → 内置工具（来源、Key 加密存、条数 / 字数、测试搜索、图片接口），MCP 页内置组多两行、与之共用开关；Pi / Codex 注入工具说明，预览面板同步。控上下文 1–3、5 已做（缓存：搜索 10 分钟内存、网页 30 分钟磁盘）；4（副模型二级压缩）没做。验证：`pnpm test:web-tools`（活网络 + 本地假图片接口，14 项）、`pnpm test:builtin-tools-electron`（真 app 点进设置页截图、IPC、开关联动、Pi 预览）。详见 `AGENTS.md`「内置工具」节。

### TODO-006 统一系统提示词 · 🟢 已完成（2026-09-21 功能落地，2026-09-22 收尾）

- **目标**：一份用户可编辑的全局系统提示词（+ 可选项目级），三端一致注入，与现有身份提示、输出风格并存。
- **落地方式**（`8aaa72a`，19 个文件 +971）：
  1. 存储：全局进 settings 表 `agent.systemPrompt.global`（复用通用 setting.get/set，不开专用 IPC）；项目级存 **文件** `<project>/.mcode/prompt.md`（`lib/userSystemPrompt.ts`），选文件不选 DB 是为了能像 CLAUDE.md / AGENTS.md 一样随仓库提交；清空即删文件。每级上限 20000 字符（`SYSTEM_PROMPT_MAX_CHARS`），面板拒存、加载端同界截断。每 turn 现读不缓存；工作树会话先探 cwd 再回退项目根。
  2. 注入：三端同位——身份之后、工具指引之前。Claude `appends.splice(1, 0, …)` 进 `systemPrompt.append`；Pi 主进程 join 后经 host 协议 `userSystemPrompt` 字段送给 `before_agent_start` 注入器；Codex 走 `thread/start` 与 `thread/resume` 的 **`developerInstructions`**（全局 + 项目合并为一条 developer message），`CODEX_HOME/AGENTS.md` 保持只放身份与工具指引。格式统一由 `systemPrompt.ts` 的 `formatUser*Section` 生成：`## 用户全局指令` / `## 项目指令`，两级同在时项目段带一句「冲突以项目指令为准」。
  3. 设置页新增「系统提示词」面板（`SystemPromptPanel.tsx`）：全局 / 项目两个编辑器（项目可切换）、字数、保存反馈；「提示词预览」按 Agent 列出模型实际收到的层级（`lib/systemPromptPreview.ts`），引擎自有层只标位置不伪造文本，MarioCode 自有层直接 import provider 用的同一常量。
  4. 叠加顺序（含 output-style / CLAUDE.md / AGENTS.md 的位置）已写进 `AGENTS.md`「统一系统提示词」节，改注入必须同步改预览。
- **本次收尾（2026-09-22）**：预览面板此前手拼 `user.*` 两段标题，漏掉了两级同在时的「冲突以项目指令为准」那一行——与实际注入不一致；把 `formatUserPromptSections` 拆成 `formatUserGlobalSection` / `formatUserProjectSection` 两个 helper，provider 与预览共用，消掉手拼。`pnpm typecheck` 通过（contracts + desktop 两包全绿）。
- **原实验方案的结论**：
  1. Codex per-turn 通道 ✅ 已定：对 0.153.4 `codex.exe` 串表 `rg -a` 实测，`developerInstructions`（连同 `baseInstructions`）存在于 thread start / resume / fork 三组 params 中，另有 "developerInstructions override was provided and ignored while running" 警告——线程运行中传覆盖无效，所以只在 start/resume 传，不在 `turn/start` 传。`turn/start` 侧无此字段（与协议硬事实⑬「静默丢弃未知字段」一致）。resume 是否重读项目 `AGENTS.md` **未验**。
  2. 三端一致性（同一句可观测指令分别跑 Claude / Pi / Codex）⏳ **真机未做**。
  3. 与 output-style 冲突（提示词英文 vs output style 中文谁赢）⏳ **真机未做**，胜负决定是否要在面板加提示文案。
  4. 长提示词开销（2K / 8K 对首 token 延迟与 ContextRing 读数）⏳ **真机未做**。
  - 2–4 的验收手法：`pnpm dev` → 设置 → 系统提示词，全局填「每次回复末尾加 [MC]」，项目填「回复用英文」，分别用三个 Agent 各发一句「你好」；预期三端都带 `[MC]` 且英文回复；再在预览面板核对三端 `user.*` 两段文本一致且项目段带冲突说明。
- **已定的拍板**：项目级 = 文件；Codex = `developerInstructions`；模板库 = 不做（待有需求再立项）。
- **副作用面**：`.mcode/prompt.md` 是新落盘文件，随项目提交与否由用户仓库的 `.gitignore` 决定（本仓库未忽略 `.mcode/`）；未改任何 provider 的既有身份 / 工具提示文本。

### TODO-008 DeepSeek Harness（dsh）接入

- **目标**：像 Pi 一样以 `AgentProvider` 接入 DeepSeek Harness（`@deepseek-ai/dsh`，MIT，2026-08 开发者预览，Cordis 插件架构，模型无关），用户可在输入框选 dsh 引擎。
- **现状**：`AgentProvider` + `ProviderRegistry` 已 provider 中立；Pi 的「独立 Node host 进程 + 协议 + MessageAdapter」（`providers/pi-sdk/piHost.ts` / `PiHostClient.ts` / `PiMessageAdapter.ts`）是可复制模板；`docs/pi-sdk-integration.md` 有完整接入方法论。
- **方案要点**：
  1. Spike（1–2 天）：确认 dsh 是否暴露可编程的 headless 会话 API / 事件流（append-only session log 应可订阅），工具审批、模型配置、skills / MCP 各走哪个插件口。
  2. 新建 `providers/dsh/`：独立 host 进程（隔离 Cordis 运行时与依赖）+ `DshAgentProvider` + `DshMessageAdapter` 映射到 runtime 事件（text / thinking / tool_use / todo.update / turn.done）。
  3. 复用 TODO-005 的共享工具核心注册为 dsh 插件工具。
  4. 模型配置沿用公共供应商模型（`d102f73` 那套）。
- **工作量**：大（1.5–2 周，含 spike）。**风险**：开发者预览、官方明示会有破坏性变更；版本锚定 + 适配层隔离。
- **dsh 调研结论（官方文档，补自上一会话）**：不是进程内库，所有形态都经 `dsh --profile <x>` 起子进程；有 `sdk`（`@deepseek-ai/dsh-sdk-app`，JSON-RPC server）、`acp`（ACP 协议，标 automation-only）、`headless` 三种 profile；session 有 id、持久、可 resume/fork；事件分 `session/event`（持久）与 `agent/assistant-stream`（实时 chunk）；有 approval / user-questions / permission-presets；支持 DeepSeek / Anthropic / OpenAI 兼容端点 + 代理。形态最像 Codex app-server（JSON-RPC over stdio），模板改用 `CodexAppServerClient` + `CodexMessageAdapter`。
- **实验方案（spike 1–2 天，尚未跑）**：
  1. 安装：`npm i @deepseek-ai/dsh`（走 npmmirror）在 Windows x64 跑通 `dsh --profile sdk --dump-config`，记版本与插件树。
  2. 协议摸底：手动起 `dsh --profile sdk`，脚本发 JSON-RPC 建会话 → 发 prompt → 收通知；记方法名 / 通知形状 / chunk 格式 / turn 结束信号，对照 TS SDK 的 `.d.ts`。
  3. 审批链路：执行会触发审批的 shell 命令，看有无 server→client 请求需应答；测 permission-presets 三档。
  4. 模型接入：用现有公共供应商的 DeepSeek / OpenAI 兼容端点配成 dsh provider，验证代理在国内可用。
  5. 工具注入：一个最小 stdio MCP server 挂进 dsh，确认工具出现在模型请求里且可调。
  6. resume/fork：同 session id 二次发消息能否续上；进程崩后重启能否续。
- **待拍板**：`sdk` 还是 `acp`；一进程一会话（Codex 模式）还是一进程多会话；版本锁定策略。

### TODO-013 内置浏览器 snapshot 瘦身（降 token）

- **目标**：模型操作普通网页时每次 `browser_snapshot` 仍回 8–15K token（80 个可交互元素 + 整页正文），一轮操作累积很快撑大上下文。与 009（禁搜索引擎）是两件事，独立于 TODO-005，不管做不做都值得改。上一会话两次提出但一直未立项，此处补记。
- **方案要点（改 `agentBrowserTools.ts` / `snapshotScript.ts`，三端自动受惠）**：
  1. 元素列表压成一行一个（`[n] <a> "名称…" href=…`），去掉 `selector:` 行（要 selector 走 `browser_find`），`text` 与 `name` 重复不重发、name 截 60 字，展示上限 80 → 40。
  2. 正文上限 8000 → 4000，并给 `browser_snapshot` 加 `maxChars` 参数。
  3. 加 `mode` 参数：`interactive`（只回元素）/ `text`（只回正文）/ `both`（默认，两边小上限）。
  4. 正文提主内容：优先 `<article>` / `<main>` / 最大文本块，去 `nav/footer/aside`，不再整页 `innerText`。
- **相关（可并入 TODO-005 的零 key 兜底）**：新工具 `browser_search(query, engine?)` 自己抽 10 条 标题/URL/摘要（≈1K token）；`browserToolsUsagePrompt` 补一句用法（搜索用 `browser_search`、读文章用 `browser_snapshot mode=text`）。
- **工作量**：1–4 项纯裁剪约半天；`browser_search` 新工具 + 三端注册再半天到一天。**风险**：低，裁剪逻辑需回归几个典型页面确认不误删正文。
- **落地（2026-09-26，`d36e806`）**：1–4 项全部完成，另加 `offset` 续读（原流程「scroll + snapshot 读后文」其实无效——正文与滚动位置无关）；元素采集只收真交互 role，丢 aria-hidden、链接里的标题、同 href 同名的重复链接。正文提取 `MAIN_TEXT_JS` 与 TODO-005 的 web_fetch 共用。用项目自带 Electron 在 4 个真实页面 + 1 个本地夹具页新旧对比回归（去噪、列表 / 表格 / 代码缩进、offset）。`browser_search` 不单做：TODO-005 的 web_search 必应 / 百度后端就是它。

### TODO-018 用户账户 + Token 计费（内嵌官方模型服务）· ⏸ 暂定

- **目标**：内嵌一个由你运营的大模型服务。用户在 MarioCode 里登录后直接用官方模型，按 token 计费；「自带 Key」照旧可用。
- **待拍板（解除条件）**：
  1. 「新的 tool」指什么——如果已经有网关或后端，服务端部分改成对接它。
  2. 用户主要在国内还是海外（决定登录方式、支付渠道、合规要求）。
  3. 卖哪些模型（Claude / GPT / DeepSeek / Qwen / GLM…），上游 Key 从哪来。
  4. 收费方式：预充值扣余额（建议）还是订阅 + 额度。
  5. 是否保留用户自带 Key（建议保留）。
- **初步架构（2026-09-26 规划，未动工）**：
  1. 计费只在服务端算：模型网关负责鉴权、计量、扣费；客户端只做登录 → 拿到这台设备专属的用户 Key → 自动建一个固定 id、只读的「MarioCode 官方」共享提供商。现有链路会把 Key 送到三个引擎（Claude 走 bridge、Codex 走环境变量、Pi 走 apiKeys），引擎层基本不动。
  2. 服务端建议先用现成开源网关（new-api / one-api / LiteLLM 这类，许可证要确认）。硬条件：同时支持 `/v1/chat/completions` 和 `/v1/responses`（Codex 只认 Responses），最好再有 `/v1/messages`；流式、工具调用、缓存用量字段都要实测；能按模型设输入 / 输出 / 缓存读 / 缓存写单价，按用户扣余额、余额不足拒绝；有按用户发 Key 的接口。
  3. 计费规则建议：预充值，按上游成本 × 倍率扣；以上游返回的 usage 为准，各类 token 分别计价，失败不扣；流水表记账（幂等），余额由流水算；新用户少量试用额度 + 手机验证防薅。image_generate 可走网关按张计费。
  4. 客户端改动：`main/account/`（系统浏览器登录 + 本机回调 OAuth PKCE，凭据 safeStorage 加密，刷新 / 登出吊销设备 Key，IPC `account.*`）；共享提供商 schema 加「托管」字段；设置新增「账户」页 + 标题栏余额标签 + 模型下拉显示单价 + 首次启动引导；网关的「未登录 / Key 失效」「余额不足」映射成带「重新登录」「去充值」按钮的错误卡片；每轮结束刷新余额，「用量统计」加官方计费列；标题 / 提交信息生成用官方模型也计费，界面要说明。
  5. 合规与风险：上游服务条款通常限制转售和服务地区，先确认；国内对公众提供生成式 AI 服务需备案，收费网站涉及 ICP 经营许可证，另有实名、内容审核、日志留存要求（以法规和律师意见为准）；微信 / 支付宝收款需企业商户资质；上游 Key 只放服务端，调用日志默认不存 prompt 正文。
- **分阶段粗估**：0 决策 + 网关实测 1–2 天 → 1 服务端 MVP（部署、渠道与单价、注册登录、手动充值或兑换码）1–2 周 → 2 客户端 MVP（账户模块、登录、官方提供商、余额与余额不足卡片）约 1 周 → 3 在线充值 1 周以上（看商户资质）→ 4 打磨（消费明细对到会话、单价展示、试用额度、团队账户）。
- **MVP 验收标志**：新用户登录 → 看到官方模型 → Claude / Codex / Pi 各对话一轮 → 后台三笔扣费、客户端余额同步减少 → 余额用完出现「去充值」卡片。

## Git 版本记录

| 版本 | 日期 | Commit | 主要更新 | 状态 |
|---|---|---|---|---|
| 开发版 | 2026-09-26 | `c24b661` | 内置 `web_search` / `web_fetch` / `image_generate`，三端注册 + 设置 → 内置工具 + MCP 页两个内置 server；顺带修好 contracts 包自 `4277991` 起的 typecheck（TODO-005） | 已提交、未推送 |
| 开发版 | 2026-09-26 | `3b794c5` | `pnpm test:sync-load`：用真实 Claude CLI / Codex app-server / Pi loader 验证同步的 skill 与 MCP server 能被加载（TODO-004） | 已提交、未推送 |
| 开发版 | 2026-09-26 | `d36e806` | `browser_snapshot` 瘦身：元素一行一个、主内容正文、mode / maxChars / offset（TODO-013） | 已提交、未推送 |
| 开发版 | 2026-09-26 | `9ea4cc0` | 关于页「GitHub 仓库」按钮和 README 的徽章 / Releases / issue 链接改指 MarioCode 自己的仓库 | 已提交、未推送 |
| 开发版 | 2026-09-26 | `d3e8599` | 关闭自动更新：发布源仍指向上游 M Code，开着会把 MarioCode 装成 M Code；总开关 `AUTO_UPDATE_ENABLED = false`，关于页隐藏检查更新按钮和横幅（TODO-016） | 已提交、未推送 |
| 开发版 | 2026-09-25 | `4277991` | 设置新增「网络」页：跟随系统代理 / 直连 / 自定义代理，统一管 Claude / Codex / Pi 和本地 bridge（TODO-015） | 已提交、未推送 |
| 开发版 | 2026-09-24 | `432e6ea` → `7709638` | Pi host 走系统代理，2 分钟后回滚（原因没记录；这块后来由 TODO-015 接住） | 已提交、未推送 |
| 开发版 | 2026-09-24 | `7791101`…`abefc47`（16 个） | UI 焕新四阶段：设计基础 → 外壳导航 → 聊天界面 → 设置弹层（TODO-014） | 已提交、未推送 |
| 开发版 | 2026-09-24 | `ca5e0e1` | 修复 Pi host 一启动就崩：`b2dfcdb` 让打包脚本只打包不落盘，改为在 electron 导入检查之后写盘 | 已提交、未推送 |
| 开发版 | 2026-09-24 | `c66f635` | MCP 镜像多源并发写入串行化（TODO-004） | 已提交、未推送 |
| 开发版 | 2026-09-23 | `b2dfcdb`、`ddad88d` | 外部 Skill 目录同步 + 外部 MCP 配置文件同步（TODO-004） | 已提交、未推送 |
| 开发版 | 2026-09-23 | `8c7f02f` | 统一系统提示词的注入与预览共用格式化（TODO-006 收尾） | 已提交、未推送 |
| 开发版 | 2026-09-22 | `5b12b1e` | 修复 Codex Responses 网关漏发最终文本时的空回：回合结束读取最终线程消息，兼容 `text` / `content` 响应，并对真实空响应显示警告 | 已提交、未推送 |
| 开发版 | 2026-09-22 | `5c7f96e` | 共享提供商更新支持已有回合继续运行；新旧桥接配置按版本并存，避免改配置时中断旧回合 | 已提交、未推送 |
| 开发版 | 2026-09-22 | `ddcd191` | 共享提供商支持按模型配置 Claude / Codex / Pi 接口，模型列表按接口过滤 | 已提交、未推送 |
| 开发版 | 2026-09-21 | `bdcfecf` | 共享 Claude 端点优先使用 Chat Completions 协议，修复协议路由不匹配 | 已提交、未推送 |
| 开发版 | 2026-09-21 | `8aaa72a` | 完成统一系统提示词和共享提供商刷新链路 | 已提交、未推送 |
| 开发版 | 2026-09-20 | `baa45a4`…`ee37a59` | 前端 UI 体检与前四轮修复（TODO-007 第 1～4、7 项）：主题无关焦点环、死代码清场与 `flushDeltas` 改不可变、手机端 131 条文案接入 i18n、`Hint` 提示层两批替换（共享包装组件 + 窗口常驻栏，32 个调用点）、文件树删除确认框提到树根 | 已提交、未推送 |
| 开发版 | 2026-09-20 | `81fe292` | 禁止 agent 用内置浏览器访问搜索引擎（TODO-009） | 已提交、未推送 |
| 开发版 | 2026-09-18 | `dbdab86` | 微信 ClawBot 对话接入、后台 Agent 执行、会话隔离与安全恢复 | 已提交、已推送 |
| 开发版 | 2026-09-18 | `c4f35af` | 定时任务、微信 ClawBot 绑定及任务结果推送 | 已提交、已推送 |
| 开发版 | 2026-09-17 | `cac5b9e` | 公共提供商模型加载、多选与批量能力设置、Pi 兼容处理 | 已提交、已推送 |
| 开发版 | 2026-09-16 | `d102f73` | Claude、Codex 和 Pi 共用模型提供商 | 已提交、已推送 |
| 开发版 | 2026-09-15 | `2480799` | 支持本地 Agent 和独立 Pi Node host | 已提交、已推送 |
| 开发版 | 2026-09-15 | `e69e6d7` | MarioCode 名称与应用图标 | 已提交、已推送 |
| `v0.2.2` | 2026-09-15 | `130fd90` | 原 Mcode v0.2.2 基线 | 已发布 |

## 更新方法

1. 有新功能时，在「功能 TODO」新增一行。
2. 开发时更新进度和状态。
3. Git 提交后，填入 commit，并在「Git 版本记录」新增一行。
