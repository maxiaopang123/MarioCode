# MarioCode 功能与版本记录

> 记录完成结果、验证与 Git 版本。新想法和未完成事项统一维护在 [MarioCode 想法与待办](MarioCode-TODO.md)。

最后更新：2026-10-07

## 当前进度（2026-10-07）

**10/7 更新（v0.2.15 · TODO-029）**：聊天模型图标按模型家族匹配，覆盖 Claude、OpenAI、Gemini、DeepSeek、Qwen、Kimi、Mistral；未知模型使用通用图标并保留完整名称，悬停显示原始 ID。默认选择不冒充实际模型，历史回复不受选择器改变影响。类型检查、构建及 45 项模型解析 / 历史锚点检查通过。

**10/7 更新（v0.2.14 · TODO-028）**：会话侧边栏与归档显示最近实际使用的模型；模型选择与最近使用分开保存，切换选择器不会改写历史。旧会话优先从持久化用量恢复模型，未知数据留空。类型检查、构建、53 项会话 store 检查与真实 Electron / SQLite 保存检查通过。逐想法交付已开始，剩余五项继续依次实现。

**10/7 更新（v0.2.13）**：

- **三个接口修复完成**：修复 Codex 命名空间与附加工具映射、Claude 并行工具参数与发布顺序、SSE 分帧及末帧处理、异常断流误报成功、工具结果图片回传、思考强度映射；
- **验证完成**：类型检查与构建通过，共享提供商 179 项、真实引擎协议桥 12 项、桌面三引擎 × 三接口 9 条路径及 Pi host 回归通过。真实引擎连接本地模拟服务，真实付费模型服务兼容性仍待验收；
- **本地打包完成**：提交 `0d35e72`，Windows 安装包 `apps/desktop/release/MarioCode-0.2.13-x64.exe` 已生成并核对版本与更新清单 SHA512；本轮未安装、未上传发布，打包未关闭正在运行的 MarioCode。

**10/6 更新（v0.2.12）**：
- **Codex 支持 Chat / Messages 接口**：共享提供商里只支持 Chat Completions 或 Anthropic Messages 的模型现在也可勾选 Codex；协议选择优先级为原生 Responses → Chat → Messages，后两者通过每回合临时本地 Responses 桥接转换，支持文本 / 图片、函数与 freeform 工具调用、用量统计、取消与超时；
- **Claude Responses 兼容性修复**：修复工具调用参数重复发送、网关跳过 `function_call_arguments.done` 时参数丢失、上游失败被伪装成正常结束、标准 `input_tokens_details.cached_tokens` 缓存字段漏算；
- **当时的回归验证**：`pnpm run typecheck` 通过，`pnpm run test:shared-providers` 139 项通过；Chat / Messages 桥接已覆盖请求转换、流式工具参数重建、断流失败和超时取消用例。真实 Codex 二进制连接本地模拟接口的端到端验收已在 v0.2.13 补齐。

**10/6 更新（v0.2.11）**：修复 Claude Responses 上游错误映射、工具调用去重与错误透传。

**10/6 更新（v0.2.10）**：修复 Claude Responses 历史 assistant 文本内容类型映射为 `output_text`。

**10/6 更新（v0.2.9）**：
- **Claude 支持 Responses API**：协议桥新增 `responsesRequestTranslator` 与 `responsesResponseTranslator`，全面支持 Claude Agent 驱动 OpenAI `/v1/responses` 接口（含工具调用、思考流提取、缓存换算）；
- **Chat 接口补齐思考强度映射**：在 `requestTranslator` 中将 Claude 的 `effort` / `budget_tokens` 自动转换为 OpenAI Chat 的 `reasoning_effort`（`low` / `medium` / `high`），普通模型不带该字段以确保兼容；
- **会话面板 LaTeX 公式渲染优化**：在 `Markdown.tsx` 中增加多层公式定界符自动识别归一化，支持 `\[...\]`、`\(...\)` 以及独立行嵌套公式 `[ ... \command ... ]`；配合 `styles.css` 增加了横向平滑滚动；
- **全链路测试通过**：`pnpm test:shared-providers` 扩展至 110 项全部通过，完成构建并打出 Windows 安装包 `MarioCode-0.2.9-x64.exe`（192.5 MB）。

**10/5–10/6 发布流水（v0.2.5–v0.2.8）**：
- **v0.2.5**：自建更新服务器上线（`publish` 指向 `http://39.109.58.6:3458/`），实现断点续传发布脚本 `release:upload`，应用内自动检查更新开启；
- **v0.2.6**：修复窗口控制边界情况（归档清除关注状态，窗口关闭交互完善）；
- **v0.2.7**：关闭窗口默认最小化隐藏至系统托盘；更新服务器首页上线轻量下载官网（`www/` 纯静态双语自适应）；
- **v0.2.8**：macOS 构建正式接入，通过 GitHub Actions 构建 Apple 芯片 (`arm64`) 与 Intel (`x64`) 镜像，下载页同步呈现三平台下载与芯片指引。

**10/2 Review 修复（源码仍为 v0.2.1）**：修复连续切换项目时旧会话列表请求覆盖新范围的问题——范围变化立即作废旧请求并清空旧分页，侧栏按范围变化重新加载，首页刷新时暂停分页请求。Pi 的「本会话」浮窗和输入框指标统一将会话累计用量转成每轮增量后计算 tokens、费用、缓存率、输出速度与缓存趋势；保留原始持久化记录及 Claude / Codex 的单轮口径。新增跨平台 `pnpm test:session-store`（在 `apps/desktop` 下执行），51 项覆盖原有 store 回归、乱序返回/分页切换，以及累计与单轮用量计算。当前尚未发布软件，旧数据目录迁移不列为本轮阻塞项；本次不涉及安装包发布。

核心多 Agent 链路已经完成一轮闭环：共享提供商支持按模型分别勾选 Claude / Codex / Pi 接口；Claude、Codex、Pi 会按各自协议生成运行配置；共享提供商在已有回合运行时更新不会再阻塞或误切断旧回合；Codex 的 Responses 回合也已补上最终消息兜底，解决网关漏发流式文本时的空回问题。 TODO-004 的 MCP 同步已补上多源并发写入保护，并通过 Electron smoke 回归；当前仍待三个 Provider 的真机加载验收。

9/24–9/26 新增：UI 焕新四阶段全部提交（TODO-014）；Pi host 一启动就崩的问题已修（`ca5e0e1`）；设置新增「网络」页，统一管三个引擎的代理（TODO-015）；发现自动更新会把 MarioCode 装成上游 M Code，已先关掉（`d3e8599`，后续见 TODO-016）；关于页和 README 的仓库链接已改指 MarioCode 自己的仓库（`9ea4cc0`）。上游 M Code 从分叉点之后又发了 v0.2.3–v0.2.5，要不要同步见 TODO-017。

9/26 夜：TODO-013 snapshot 瘦身完成（`d36e806`，同页工具结果 18–21K → 3–7K 字符）；TODO-004 三个 Provider 的加载用真实引擎验过（`3b794c5`，`pnpm test:sync-load` 7/7），收成 100%；TODO-005 内置网页搜索 / 网页读取 / 图片生成完成（`c24b661`，设置 → 内置工具）。

9/28：界面焕新 v3 落地到真实代码（原型 `prototypes/ui-refresh-v3.html`）——最左项目栏 + 会话列 + 右缘竖向工具条 + 底部全局状态栏，配色改成取自应用图标的石墨 + 薄荷；**项目树视图已删除**（项目管理搬到项目栏头像右键）、设置改成悬浮窗口、LSP 导航项先收起。模型配置页重做并**删掉旧版专属配置**，「加载模型」弹窗支持逐模型勾选接口 + 生图，密钥保留规则放宽到「按 origin」。剩下的尾巴见 TODO-024。以上均通过 tsc + build，浅 / 深色真机截图看过；`pnpm dev` 首屏要等约 40 秒（开发模式逐文件编译 + `sessionStore.ts` 超 500KB 走 Babel 慢路径），用户暂不处理。

9/28–9/29：v3 原型里剩下的前端全部落地（TODO-025）——「本会话」可折叠浮窗（任务 / 子代理 / 计划 / 书签 / 大纲 / 缓存与速度 / 用量）、缓存命中率与输出速度三处展示（TODO-023）、回复里的图片与文件路径标签（TODO-022）；TODO-024 ①「图片模型」改下拉已完成。`styles.css` 途中被 PowerShell 按 GBK 读写弄乱过中文注释，已按提交版本恢复。

**9/29 确认的两件事**：
- **数据全在用户本机**：模型配置、设置、会话与消息、每轮 token / 费用记录都在应用数据目录的 SQLite `claude-gui.db`（正式版 `%APPDATA%\MarioCode`），API Key 用 Electron `safeStorage`（Windows DPAPI）加密存同库；引擎配置在 `~/.mariocode/` 和 `~/.pi/agent/models.json`。代码里**没有任何遥测 / 统计上报**，自动更新也关着——开发者看不到用户量和用量。要做 TODO-018 的账户与计费，必须有自己的服务端记账。
- **改名的迁移风险（待处理）**：`1a1d948` 把正式版数据目录从 `%APPDATA%\Mcode` 改成 `%APPDATA%\MarioCode`、appId 改成 `com.mariocode.desktop`、AUMID 改成 `MarioCode`。已装旧版的用户升级后会落到空目录，旧会话 / 配置不会自动带过来；发版前要加一次性迁移（首次启动发现旧目录且新目录为空时复制过来），或者明确告知。开发模式不受影响。另：`scripts/mcp-sync-smoke/main.mjs` 疑似 esbuild 打包产物被提交，待确认去留。

**Git 状态（9/29）**：分支 `ui-refresh-v3`，v3 这批改动已提交为 `188b481`（原型与文档）+ `1a1d948`（功能 + mcode→mariocode 改名），之后又有 `03c5d5b` / `983d60d` 两个文档提交，以及 v0.2.1 的 `8350d7f`；`dbdab86` 之后共 65 个提交，都没推送（分支无远端），也还没合回 `master`。

**版本（10/07）**：当前源码 `v0.2.15`；已生成的安装包仍为 `v0.2.13`，本轮尚未安装或上传发布。每个想法都有独立本地版本提交。

人工验收与发布事项见 [MarioCode 想法与待办](MarioCode-TODO.md)。本机打包用 `scripts\package-win.bat`（`--skip-build` 跳过构建），发布用 `pnpm --filter @mariocode/desktop run release:upload`。

### 待办入口

[新想法、未完成事项与验收清单](MarioCode-TODO.md) 已拆成独立文档。后续状态在新文档更新，完成结果再记入本页版本记录。

回归脚本（在 `apps/desktop` 下跑）：`pnpm test:sync-load`（TODO-004，同步产物被三个引擎加载）、`pnpm test:web-tools`（TODO-005，真实搜索 / 读网页 + 本地假图片接口）、`pnpm test:builtin-tools-electron`（TODO-005，先 `pnpm build`，真 app 设置页截图）。`pnpm test:pi-host` 自动检查可用的项目 / 全局 Pi 运行时，也可传入额外运行时路径；包含本地服务上的 Chat / Messages / Responses 请求及跨接口续聊。

### 历史功能进度快照

以下保留拆分前的功能进度、提交和备注，便于追溯。当前未完成事项以 [MarioCode 想法与待办](MarioCode-TODO.md) 为准，历史百分比不作为当前验收结论。

状态：⚪ 未开始　🟡 进行中　🟢 已完成　🔴 阻塞　⏸ 暂定（条件不具备，等条件到位再排期）

| ID | 功能 | 进度 | 状态 | 对应 Commit | 备注 |
|---|---|---:|---|---|---|
| `TODO-026` | 内置 MCP 目录（首个：SSH 远程服务器）+ Pi 接入 MCP | 0% | ⚪ 未开始（🔥 最高优先级） | - | 2026-09-30 立项。与 MarioTool 内置工具分开定位：随包附带、默认关闭、用户在 MCP 页目录里挑选启用并填配置（主机、密码 / 私钥等）。**三个引擎都要支持**——Claude / Codex 读同一份 `~/.mariocode/.claude.json`，写进去即可；Pi 现为 `supportsMcp: false`，须先补通用 MCP 客户端。密码不落盘（本机密钥代理 + secretStore）。方案与分期见规划详情 TODO-026 |
| `TODO-001` | 定时任务 | 100% | 🟢 已完成 | `c4f35af` | 已实现一次/每天/每周、启停、立即运行、异常恢复与防重叠 |
| `TODO-002` | 微信 ClawBot 信息推送（二维码绑定 + iLink Bot API） | 100% | 🟢 已完成 | `c4f35af` | 已实现二维码绑定、安全凭证、单一用户锁定、消息激活与定时任务结果推送；已通过构建、测试和代码复审 |
| `TODO-003` | 微信 ClawBot 对话接入 MarioCode | 100% | 🟢 已完成 | `dbdab86` | 已实现绑定者私聊纯文本接入、专用微信助手项目、按会话隔离、Agent/模型选择、`新会话` 指令及安全恢复；已通过冷构建、启动检查、回归测试与独立代码审查 |
| `TODO-004` | 外部工具 Skill / MCP 同步（非复制导入） | 100% | 🟢 已完成 | `b2dfcdb` `ddad88d` `c66f635` `3b794c5` | P1。Skills 单向复制同步 + MCP 多源配置同步（Claude/Codex/Cursor/Zcode 配置文件 → ~/.mariocode/.claude.json，watch 实时跟随、停用/移除自动撤回、本地手改优先）均已落地；多源并发写入保护和 Electron smoke 已通过；**三个 Provider 加载已用真实引擎验过**（`pnpm test:sync-load`：Claude CLI 列出同步的 skill 并连上两个 MCP server、Codex app-server 列出 skill 并启动两个 server、Pi loader 从镜像读到 skill，含 npx 同形的 `.cmd` 启动器，7/7）；Pi 不支持 MCP（设计如此） |
| `TODO-005` | 内置工具：网页搜索 + 图片生成 | 100% | 🟢 已完成 | `c24b661` | P2。三端共用的 `web_search` / `web_fetch` / `image_generate`（`main/tools/`），设置 → 内置工具。搜索默认必应，必应 / 百度免 Key；博查 / 智谱 / Tavily / Exa / Brave 为可选 Key 后端，失败退回必应；图片来源只能选共享提供商；读网页走隐藏窗口 + 与 snapshot 同一套正文提取、30 分钟缓存按 offset 续读；图片走 OpenAI 兼容 `/images/generations`，每次审批。已通过 typecheck、build、`pnpm test:web-tools`（14 项）、`pnpm test:builtin-tools-electron`（真 app 截图）；**未验证**：三端真实对话调用、五个 Key 后端真 Key（Exa / Brave 仅离线解析用例）、真实图片模型 |
| `TODO-006` | 统一系统提示词 | 100% | 🟢 已完成 | `8aaa72a`（功能）+ `8c7f02f`（预览对齐） | P4（原建议提前到 TODO-005 之前，已兑现）。用户可编辑的全局（settings 表）+ 项目级（`<project>/.mariocode/prompt.md`）系统提示词，Claude / Codex / Pi 三端同位注入（身份之后、工具指引之前）；设置页新增「系统提示词」面板：两级编辑器、字数上限 20000、按 Agent 分层预览。三个待拍板已定：项目级存文件、Codex 走 `thread/start` / `thread/resume` 的 `developerInstructions`、模板库不做。叠加顺序已写进 `AGENTS.md`「统一系统提示词」节。已通过 `pnpm typecheck`；**真机三端一致性验证未做**（见规划详情） |
| `TODO-007` | 聊天框界面渲染优化（含前端 UI 体检） | 100% | 🟢 已完成 | `baa45a4`…`bf5672b`（11 个） | **P0（原 P3，2026-09-20 上调）**。体检 + 原七项里**静态就能做完的五项**：焦点环、死代码清场、手机端 i18n、`Hint` 提示层两批替换、文件树删除确认框提到树根。原第 5、6 项与第 7 项第二步不是没做完，是**条件不具备**，已拆成 `TODO-010` / `TODO-011` 暂定；第 3 项欠的 lint 规则拆成 `TODO-012`。**运行时验收仍待人工完成**（见规划详情末尾） |
| `TODO-008` | DeepSeek Harness（dsh）接入为第四个 Provider | 0% | ⚪ 未开始 | - | P3。先做 1–2 天可行性 spike；照 Pi 的「独立 host 进程 + MessageAdapter」模板接入 |
| `TODO-009` | 禁止 agent 用内置浏览器访问搜索引擎 | 100% | 🟢 已完成 | `81fe292` | TODO-005 落地前的止血：Pi 无搜索工具时模型拿浏览器去搜索引擎翻页，每次 snapshot 10K+ token。三端共用的 `agentBrowserTools` 加守卫——navigate 到搜索站（含首页）拒绝，snapshot/find/evaluate/screenshot 发现当前页是搜索站也拒绝；只拦搜索站自身域名，产品子域不受影响；提示词同步补禁令。写死名单、暂无开关。已通过 tsc 与 28 条域名规则用例；**真机验证未做**（需 `pnpm dev` + Pi 跑一轮，确认模型回「无法联网搜索」而非去开浏览器） |
| `TODO-013` | 内置浏览器 snapshot 瘦身（降 token） | 100% | 🟢 已完成 | `d36e806` | `browser_snapshot` 加 `mode`（both / interactive / text）、`maxChars`、`offset`；元素一行一个、去 selector 行、展示 40 个（interactive 80 个）；正文改为主内容提取（main / article / 段落最集中的块），去导航 / 页脚 / 侧栏，默认 4000 字、按 offset 续读。真实页面同页对比：菜鸟教程 18.2K→3.2K、MDN 21.6K→6.7K、新浪 21.3K→5.9K、博客园 19.1K→5.9K 字符。`browser_search` 并入 TODO-005 的免 Key 搜索后端，不单做 |
| `TODO-014` | UI 焕新（四阶段） | 100% | 🟢 已完成 | `7791101`…`abefc47`（16 个） | 原型 `prototypes/ui-refresh.html`：设计基础 → 外壳导航 → 聊天界面 → 设置弹层；浅 / 深两套主题、翡翠绿只做点缀，会话行 30px、聊天正文 15px、标题 24px/500、字号 11px 起步。已通过 tsc；**真 app 验收未做**（小徽标字变大后显挤、侧栏 / 标题栏 / 页签布局最可能出问题） |
| `TODO-015` | 网络设置：直连 / 跟随系统代理 / 自定义代理 | 100% | 🟢 已完成 | `4277991` | 设置 →「AI 能力」→「网络」。统一管 Claude（对话、连接测试、标题 / 提交信息生成）、Codex（每轮启动 app-server）、Pi（常驻 host 空闲时重启换路由）和 OpenAI 协议的本地 bridge，下一轮对话生效；跟随系统时环境变量优先，直连设 `NO_PROXY=*`，localhost 一律绕开，Pi host 加 `NODE_USE_ENV_PROXY=1`。已通过 tsc + Electron 33 对本地假代理 5 种场景实跑；**未验证**：真实系统代理读取、Claude / Codex 二进制端到端、界面真机查看；**未覆盖**：内置浏览器、插件下载、运行时下载 |
| `TODO-019` | MarioTool：定时器 + 微信通知 | 90% | 🟡 进行中（已实现待验收） | `ee5c88c` | 三端新增 `mario_schedule_list / create / update / delete`（Claude MCP server `mariocode-schedule`）和 `mario_wechat_notify`（`mariocode-wechat`），设置 → MarioTool 新增「定时任务」「微信通知」两节开关，MCP 页内置组多两行。审批统一走 `builtinToolNeedsApproval`：查看免审批；创建 / 修改 / 删除与微信通知在普通对话里要审批，在无人值守运行（定时任务 / 微信对话）里不审批——定时器改动在执行时直接拒绝，微信通知直接发；微信每会话 10 分钟最多 5 条。已通过 tsc + 离线用例（审批真值表、参数合并校验）；**未验证**：三端真实对话调用、真实微信推送、无人值守运行里的拒绝链路 |
| `TODO-020` | 移除插件功能 + 技能市场 | 90% | 🟡 进行中（已实现待验收） | `ee5c88c` | 插件功能已移除（设置页、左栏入口改为「技能」、per-turn 投递、MCP 插件组）。技能市场：Skills 设置页新增「技能市场」对话框，来源 = 内置 anthropics/skills + 用户添加的 https Git 仓库 / 本地文件夹，树缓存在 `~/.mariocode/skill-market/<id>/`，安装即复制到 `~/.mariocode/skills`（三引擎下一轮生效）。已通过 tsc + 离线用例（`apps/desktop/scripts/skill-market-smoke`：扫描、安装、路径守卫、本地源添加/刷新/移除）；**未验证**：真实 GitHub 拉取、界面真机查看 |
| `TODO-021` | 出错后自动发送「继续」（设置里可开关） | 0% | ⚪ 未开始 | - | 2026-09-28 立项。回合因网络断流 / 超时 / 5xx / 429 / 网关空响应截断等非人为原因中断时，自动对同一会话发「继续」；鉴权、余额、上下文超长、用户手动停止、等审批一律不自动续跑。带退避、次数上限、按回合去重、工具中断时的幂等提示，聊天里标出「自动继续」。参考 DeepSeek Harness 插件 dsh-auto-continue、Claude Code 插件 cc-resume-watchdog。设置 → Agent，默认关闭。方案与待拍板见规划详情 TODO-021 |
| `TODO-022` | 回复里渲染图片 + 文件路径可点开（为生图铺路） | 92% | 🟡 进行中（已实现待验收） | `1a1d948` | 原型 `prototypes/ui-refresh-v3.html#imgs`。**已做**：回复里的图片内联（单张大图 + 信息条四个操作，同段多张排三列方格，灯箱左右切换，读取中 / 找不到 / 网络图片三种占位）；网络图片点「加载图片」经主进程 `net:fetchImage` 拉取（CSP 不动）；行内代码和纯文本里的路径都变文件标签（单击选中、双击打开跳行、悬停卡片带缩略图）；相对路径按会话目录（工作树按 checkout）；生图联动（提示词要求 `![](保存路径)`，放行工具输出目录里的图片）；旧 `FileLink` 改双击。tsc + build + 真机截图 + 路径识别离线用例 20 条。**未做**：自动加载网络图片的设置、纯文本识别开关、正文 / 工具卡同图去重。**未验证**：真实模型回复 |
| `TODO-024` | 模型配置收尾三件（生图标记接入 / 密钥规则拍板 / 旧版数据清理） | 33% | 🟡 进行中（① 已做，②③ 待你拍板） | `1a1d948`（①） | 2026-09-28 立项，均不影响当前使用。① 🟢 **生图标记接入 MarioTool 已完成**（9/28）：「图片模型」改成下拉（候选 = 所选提供商里标了生图的模型），当前手打值保留为「未标记生图」条目 + 「手动输入模型 id」开关，主进程不因未标记而拒绝；没有任何标记时提示并可跳到模型配置；两个 smoke 测试已同步，tsc 通过；② **密钥规则拍板**：留空密钥保存时，只有「出现新的 scheme+host+port」才要求重填（只改路径 / 移除地址都保留），用户提出这条是否还有必要——保留的理由是防止把有效密钥发给新服务器，去掉的话换地址就沿用旧密钥，改动很小；③ **旧版数据清理**：旧版专属配置页已删（界面只剩公用提供商），但之前在那里存过的 Claude 端点 / Pi Provider 配置与密钥仍在本地，旧会话照常能用、输入框模型列表里也还能看到，却没有入口再改或删——要么给一个一次性「迁移到公用提供商 / 清理」入口，要么确认就这么留着。详见规划详情 TODO-024 |
| `TODO-023` | 会话里显示缓存命中率与输出速度 | 75% | 🟡 进行中（已实现待验收） | `1a1d948` | 原型 `prototypes/ui-refresh-v3.html`。**已做**：署名行「缓存 xx% · xx tok/s」、「本会话」浮窗「缓存与速度」段（本轮 / 平均 + 每轮柱状图）、输入框右侧指标组（上下文环从模型胶囊挪到这里）；速度在渲染端按增量计时（`lib/genTimer.ts`），不含工具执行和等待审批。**未做**：计时写进 `TurnUsageRecord` 持久化（现在只在内存，重开会话后旧回合没有速度）、首字延迟、OpenAI 桥 / Codex / Pi 缓存字段核对。**未验证**：真实回合的数值。口径见规划详情 |
| `TODO-025` | 界面焕新 v3 落地到真实代码 | 95% | 🟡 进行中（已提交，待收尾） | `188b481` `1a1d948`（分支 `ui-refresh-v3`） | 原型 `prototypes/ui-refresh-v3.html`。**已做**：最左项目栏 + 会话列 + 右缘工具条 + 底部状态栏、石墨 + 薄荷配色；删掉项目树视图；设置改悬浮窗口；模型配置页重做、删旧版专属配置、「加载模型」逐模型勾选接口 + 生图；「本会话」可折叠浮窗（只动 clip-path 的折叠动画，Esc / 点外面收起）取代原活动台下拉；配套 TODO-022 / 023。tsc + build + 浅 / 深色真机截图。**剩下**：合回 `master`；`ActivityCluster.tsx` 已无桌面引用，删还是留；真 app 人工走一遍 |
| `TODO-027` | 静默自动更新 + 最低版本强制更新 | 0% | ⏸ 暂定 | - | 2026-09-29 立项，**依赖 TODO-016（先有自己的发布渠道）+ 旧数据目录迁移**。两层叠加：① 静默更新——`updater.ts` 已有 electron-updater 流程，开 `AUTO_UPDATE_ENABLED`、`autoDownload=true`，下载完提示「重启完成更新」或退出时自动装；② 最低版本拦截——服务器放一个小文件（如 `{"minVersion":"0.2.1","message":"…"}`），启动时读取，当前版本低于它就弹不可关闭的窗口，只给「立即更新」「退出」，以后要求全员升级只改这个数字、不用重新发版。**限制**：不开应用 / 离线的用户管不到（只能做到下次联网打开必须先更新）；国内访问 GitHub 不稳，建议更新包和版本文件放阿里云 OSS 或自己的服务器（electron-updater 的 generic provider）；Windows 安装包没签名，首次安装会被 SmartScreen 拦。**待拍板**：更新包放哪（GitHub Releases / 阿里云 OSS / 自己服务器）；版本文件拉取失败时放行还是拦截（建议放行，避免服务器挂了所有人打不开） |
| `TODO-010` | 聊天流渲染性能：行高估值与流式重算（原 TODO-007 第 5、6 项） | 0% | ⏸ 暂定 | - | P1。**解除条件：把应用跑起来采一次数**。两项都按「先量后改」的口径走，而行高分布与分组耗时都拿不到静态答案。文档里备了一段开发者工具即贴即用的行高统计脚本；分组耗时要现加 dev-only `performance.mark`。没有真实数字之前不要改 `estimatedItemSize`，也不要动分组切点——切错会让聊天记录错乱 |
| `TODO-011` | 文件树 / 会话树拍平虚拟化（原 TODO-007 第 7 项第二步） | 0% | ⏸ 暂定 | - | P3。**解除条件：出现真实的大仓库卡顿反馈**。第一步（删除确认框提到树根）已随 TODO-007 落地；第二步要把递归树拍平交给 LegendList，连带重写展开折叠、键盘导航、拖拽与右键菜单的掌控，估 3～5 天，属于「有人抱怨再做」的那类 |
| `TODO-012` | 前端 lint 基建：从零搭 ESLint + 禁止 JSX 文本出现 CJK | 0% | ⏸ 暂定 | - | P2。**解除条件：确认要不要引入这套工具链**。本仓库根本没装 ESLint——两个包都没有 `lint` script，也没有任何 `eslint.config.*` / `.eslintrc*`，`turbo.json` 里的 `lint` task 一直在跑空（源码里残留的 `// eslint-disable-next-line` 是上游留下的）。TODO-007 第 3 项欠的那条「挡中文回流」规则要落地，得先把这套装起来 |
| `TODO-016` | 自有发布渠道（重开自动更新） | 100% | � 已完成 | `d3e8599`（先关掉）→ v0.2.5–v0.2.8 | 2026-10-05 改为**自建更新服务器**：`publish` = generic `http://39.109.58.6:3458/`（亿联云，nginx 容器 `mariocode-updates`），`AUTO_UPDATE_ENABLED = true`；发布用 `pnpm --filter @mariocode/desktop run release:upload`（校验 + 流式断点续传 + latest.yml 最后传 + 公网复核）；macOS 由 GitHub Actions 打包后通过 `--mac` 自动镜像至服务器，下载页与应用内更新已全链路打通。 |
| `TODO-017` | 同步上游 M Code 新功能（v0.2.3–v0.2.5） | 0% | ⏸ 暂定 | - | **解除条件：拍板合不合、合哪些**。分叉点 `130fd90`（v0.2.2）之后上游又有 39 个提交、动了 168 个文件：Agent / 任务编排、定时任务 v2（和本仓库 TODO-001 重叠）、终端并入右栏 + 文件树分栏、Git 面板实时 diff、右栏会话级页签、外部文件拖进输入框、后台 bash 任务列表、Agent 启动服务的端口扫描、控制中心样式的活动区，以及两个社区修复（Codex 第三方模型上下文窗口、终端 Shell 路径设置反馈）。两边都大改过界面，建议先拉下来列冲突清单再挑 |
| `TODO-018` | 用户账户 + Token 计费（内嵌官方模型服务） | 0% | ⏸ 暂定 | - | 2026-09-26 立项，具体做法之后再定。用户在 MarioCode 里登录，使用你提供的模型服务，按 token 扣费；计费在服务端网关算，客户端只负责登录、拿到用户 Key、自动配成「MarioCode 官方」共享提供商。**解除条件：拍板规划详情里的 5 个问题**（「新的 tool」指什么、用户在国内还是海外、卖哪些模型、收费方式、是否保留自带 Key）。初步规划见下方规划详情 TODO-018 |

## 规划详情（2026-09-20 待排期）

以下为原有技术方案和决策背景，保留供实施时参考。当前范围、状态和剩余验收要求在 [MarioCode 想法与待办](MarioCode-TODO.md) 维护。

### TODO-026 内置 MCP 目录（首个：SSH）+ Pi 接入 MCP · 🔥 最高优先级（2026-09-30 立项）

- **目标**：MarioCode 随包附带一组可选 MCP server，用户在 MCP 页「内置 MCP 目录」里挑选启用、只填密钥类配置即可用，三个引擎（Claude / Codex / Pi）都能调用。首个 server 是 SSH（远程执行命令，可选 SFTP）。
- **与 MarioTool 内置工具的区别**：技术上相近，定位不同。MarioTool 是核心能力、默认开、深度集成；内置 MCP 是可选目录、默认关、真正独立的 stdio MCP server，将来也能导出给 Claude Desktop / Cursor 等客户端。
- **现状（2026-09-30 核对代码）**：Claude 二进制直接加载 `~/.mariocode/.claude.json` 的 `mcpServers`；Codex 每轮把同一份转成 `config.toml` 的 `[mcp_servers]`（`codexModelsStore.ts`）；`mcpSync.ts` 已有「镜像写入 + 记录归属」机制可照搬。**Pi 为 `supportsMcp: false`**，这是三端都支持的前置缺口。
- **分期**：
  1. **Pi 接入 MCP（前置）**：在 `mariocodeExtension` 读 `.claude.json` + 项目 `.mcp.json`（尊重 `mcp.management` 启停），连 stdio / http server，把远端工具逐个 `registerTool`，审批走现有 `tool_call` 守卫。完成后用户自加的 MCP 在 Pi 上也可用，`supportsMcp` 改为 true。
  2. **内置 MCP 目录**：server 打包在 `resources/mcp/<name>/`，用 Electron 自带 Node 跑（`ELECTRON_RUN_AS_NODE=1`）；MCP 页新增目录分组（说明、开关、配置表单）；启用写入 `.claude.json`、停用删除；保留名 `mariocode-mcp-*` 进 `MCP_RESERVED_NAMES`。
  3. **SSH server**：`ssh_hosts`（只读，只回别名 / host / user / port）、`ssh_exec({host, command, timeoutSec})`（stdout / stderr / 退出码，输出截断分页），可选 `ssh_upload` / `ssh_download`（SFTP）。依赖 `ssh2` 钉精确版本，注意可选原生模块 `cpu-features` 的打包。
- **安全要点**：
  - **密码不落盘**：不写进 `.claude.json` 的 `env`（否则 Codex 的 `config.toml` 里会再多一份明文）。MarioCode 开本机回环端点 + 随机 token 写进 server env，server 按主机别名换取密钥；密钥加密存 secretStore。代价：脱离 MarioCode 使用时需改为手填 env。
  - **主机指纹校验**：首次连接在设置页确认指纹并记录，之后指纹变化拒绝连接（防中间人）。
  - **审批**：`ssh_exec` 默认每次审批（等于远程 root shell），可按主机「始终允许」；无人值守运行（定时任务 / 微信）默认拒绝。
  - 报错、日志、main.log 不得出现密码。
- **待拍板**：第一期是否带 SFTP；`ssh_exec` 是否允许按主机「始终允许」；密钥代理方案是否接受（影响导出到外部客户端的体验）。
- **过渡**：用户当前的临时方案是技能 `~/.mariocode/skills/ssh-yilianyun`（明文密码 + `scripts/run.mjs`）和 `~/.ssh/config` 的 `cloud` 别名；内置 SSH 上线后应迁移并删除该技能里的明文密码。

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
  - `pnpm typecheck` **通过**（`@mariocode/contracts` + `@mariocode/desktop`，3 个 task 全绿）。
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
- **现状**：**Skills 单向复制同步已落地（2026-09-23）**；**MCP 多源配置同步已落地（2026-09-23）**。**三个 provider 的加载已验（2026-09-26，`3b794c5`）**：`pnpm test:sync-load` 在临时目录按同步引擎的产物布局（skill 镜像、合成的 Claude 插件目录、`.claude.json` 的 mcpServers、Codex config.toml）放好测试 skill 与两个 stdio MCP server（一个 `node`，一个 npx 同形的 `.cmd` 启动器），再用 provider 同样的参数问真实引擎——Claude CLI 列出 `mariocode-sync-…:skill` 且两个 server 均 connected 带工具，Codex app-server 经 `skills/extraRoots/set` 列出 skill 且两个 server 启动带工具，Pi loader 从镜像读到 skill；不发模型请求。设置页「添加源 → 同步」的界面流程仍按 Electron smoke 的覆盖为准。
- **MCP 同步落地详情（2026-09-23）**：
  1. **同步引擎** `main/lib/mcpSync.ts`：用户在设置页添加外部 MCP 配置文件作为同步源（预设探测 Claude Code `~/.claude.json` / Codex `~/.codex/config.toml` / Cursor `~/.cursor/mcp.json` / Zcode `~/.zcode/mcp.json`，也支持手动选任意文件），引擎把每个源里可识别的 server 归一化为 `McpServerConfig` 后合并进 `~/.mariocode/.claude.json` 的 `mcpServers`——该文件同时是 Claude 二进制的加载点与 Codex config.toml 物料来源，一处生效三端通吃。源文件只读，改动经父目录 `fs.watch`（600ms 防抖；watch 目录而非文件，因为 CLI 用替换式重写）实时跟随。
  2. **合并规则**：单向（源 → 镜像），权属表 `mcpSync.ownership`（settings 表）记录每源上轮同步进去的名字；再同步只替换/撤回自己拥有的名字，用户在面板手加/导入的同名条目经 `clearOwnershipFor` 摘除权属、永久保留（本地优先）；已存在的本地条目不同名覆盖、状态栏显示冲突名单。停用源 = 撤回其同步条目（冻结但继续加载会留下静默陈旧 server）；移除源 = 撤回 + 停止监听。
  3. **并发保护**：多个源同时变更时，共享镜像文件的读改写经全局串行锁排队，避免 Codex/Cursor 等 watcher 互相覆盖；Electron smoke 已覆盖两源共存、停用、重新启用和移除流程。
  4. **Codex TOML 归一化**：`[mcp_servers.*]` 的 `command/args/env`（stdio）与 `url/http_headers`（http）映射到 `McpServerConfig`（用 `smol-toml` 解析）；env 值里引用用户环境的 `${VAR}`/`$VAR`/`%VAR%` 被丢弃（MarioCode 子进程里解析不出来，留着只会得到字面量）。
  5. **进程隔离**：与 skillSync 同一约定——模块不 import Electron，renderer 通知走注入的 `setMcpSyncChangeListener`，Electron 入口接线 `sendToRenderer(IPC.MCP_SYNC_CHANGED)`。
  6. **契约 + UI**：`mcp.syncList/syncScan/syncAdd/syncSetEnabled/syncRemove/syncRescan` 六个 IPC；MCP 设置页顶部新增「外部配置源同步」区块（开关 + server 数 + 上次同步时间/错误 + 移除 + 重新同步 + 添加对话框）。
- **Skills 同步落地详情（2026-09-23）**：
  1. **同步引擎** `main/lib/skillSync.ts`：用户添加外部技能根目录（如 `~/.codex/skills`），引擎把每个含 `SKILL.md` 的子目录复制镜像到 `~/.mariocode/skills-sync/<sourceId>/`，源目录用递归 `fs.watch` + 400ms 防抖实时跟随；禁用源 = 冻结镜像保留，移除源 = 删镜像 + 删合成插件目录。
  2. **Claude 侧可见**：每次同步后合成一个本地插件目录 `~/.mariocode/skills-sync-plugins/mariocode-sync-<id>/.claude-plugin/plugin.json` + `skills/` 子目录拷贝，provider 启动时经 `options.plugins` 注入（`skipMcpDiscovery`），优先级最低。
  3. **Pi / Codex 侧可见**：Pi 走 host config 的 `extraSkillPaths`（主进程在 `loadHostConfiguration` 里把 `skillSyncMirrorRoots()` 追加进去）；Codex `skillRootsFor()` 直接加镜像根目录。
  4. **设置页**：SkillsPanel 顶部新增「外部源同步」区块：添加目录（原生文件夹选择器）、启停开关、skill 数 / 上次同步时间 / 错误提示、移除、手动「重新同步」。
  5. **进程隔离**：`skillSync.ts` 不许 import Electron（`build-pi-host.mjs` 会拒绝）；renderer 通知走注入的 `setSkillSyncChangeListener`，Electron 入口接线 `sendToRenderer(IPC.SKILLS_SYNC_CHANGED)`，Pi host 不接线。
  6. **契约**：`packages/contracts/src/ipc.ts` 新增 `SkillSyncSource` / `SkillSyncStatus` 类型 + `skills.syncList / syncAdd / syncSetEnabled / syncRemove / syncRescan` 五个 IPC；preload + webApi stub 已注册。
- **方案要点**：
  1. Skills：**已改拍板为纯复制镜像**（不用 junction/symlink——Windows 权限 + claude 二进制跟随性有风险）；Claude 用合成插件目录而非直接塞 `$CLAUDE_CONFIG_DIR/skills`（保持用户全局目录干净）；Pi 经 `extraSkillPaths`；Codex 加镜像根。
  2. MCP：多源读取（`~/.claude.json`、`~/.codex/config.toml` 的 `[mcp_servers]`、`~/.cursor/mcp.json`）归一化后合并进 `~/.mariocode/.claude.json`，条目打 `source` 标记；源文件 watch 变更增量同步；本地手改优先、同名冲突提示。
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
  3. Claude 自定义端点：`mcp__mariocode-tools__web_search` 自动放行；原生 WebSearch 在自定义端点报错时模型是否会自己切到内置。
  4. Codex 双份工具：原生 webSearch 开着时模型选哪个，定去重策略。
  5. 零 key 浏览器抓取：10 次查询的成功率 / 耗时 / 反爬，决定能否当兜底。
- **待拍板**：默认搜索后端（建议博查）；图片生成要不要进审批（花钱）；结果条数与摘要长度上限。
- **拍板结果（2026-09-26）**：默认必应（免 Key，开箱可用；本机直连实测博查 / 智谱 / Tavily / 必应 / 百度可达，Brave、DuckDuckGo 超时所以没接），博查 / 智谱 / Tavily 作为可选 Key 后端、失败自动退回必应；图片生成每次审批（Full Access / 始终允许除外）；默认 5 条、摘要 ≤200 字、正文每次 5000 字，设置页可调。图片来源没做成「模型能力位」，改为设置页选共享提供商或填自定义接口 + 模型名——图片模型不会混进对话模型列表。
- **后续调整（产品决策）**：图片来源只能选共享提供商，自定义接口及其 Key 移除（旧的 `custom` 图片源视为未配置，`builtinTools.keys` 里的 `image` 条目自动剔除）。第三方搜索 API 作为**可选**后端保留：默认仍是免 Key 的必应（百度同为免 Key），博查 / 智谱 / Tavily 恢复，新增 Exa（`api.exa.ai/search`）与 Brave（`api.search.brave.com`，有免费档）；Key 加密存在原来的 `builtinTools.keys`，用户已存的博查 / 智谱 / Tavily Key 继续可用；任何 Key 后端失败（含没填 Key）都退回必应。可达性：Brave 本机直连超时，大陆使用可能需要在 设置 → 网络 配代理；DuckDuckGo 仍不接。
- **落地（2026-09-26，`c24b661`）**：核心在 `main/tools/`（描述 `builtinToolSpecs.ts` / 配置 `builtinToolsConfig.ts` / 隐藏窗口 `webPage.ts` / 三个工具 / 调用入口 `builtinTools.ts`）；Claude = 进程内 MCP `mariocode-web` + `mariocode-image`，Codex = dynamicTools（image_generate 手动审批），Pi = 扩展注册 + `builtinTool` 反向调用回主进程；设置 → 内置工具（来源、Key 加密存、条数 / 字数、测试搜索、图片接口），MCP 页内置组多两行、与之共用开关；Pi / Codex 注入工具说明，预览面板同步。控上下文 1–3、5 已做（缓存：搜索 10 分钟内存、网页 30 分钟磁盘）；4（副模型二级压缩）没做。验证：`pnpm test:web-tools`（活网络 + 本地假图片接口，14 项）、`pnpm test:builtin-tools-electron`（真 app 点进设置页截图、IPC、开关联动、Pi 预览）。详见 `AGENTS.md`「内置工具」节。

### TODO-006 统一系统提示词 · 🟢 已完成（2026-09-21 功能落地，2026-09-22 收尾）

- **目标**：一份用户可编辑的全局系统提示词（+ 可选项目级），三端一致注入，与现有身份提示、输出风格并存。
- **落地方式**（`8aaa72a`，19 个文件 +971）：
  1. 存储：全局进 settings 表 `agent.systemPrompt.global`（复用通用 setting.get/set，不开专用 IPC）；项目级存 **文件** `<project>/.mariocode/prompt.md`（`lib/userSystemPrompt.ts`），选文件不选 DB 是为了能像 CLAUDE.md / AGENTS.md 一样随仓库提交；清空即删文件。每级上限 20000 字符（`SYSTEM_PROMPT_MAX_CHARS`），面板拒存、加载端同界截断。每 turn 现读不缓存；工作树会话先探 cwd 再回退项目根。
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
- **副作用面**：`.mariocode/prompt.md` 是新落盘文件，随项目提交与否由用户仓库的 `.gitignore` 决定（本仓库未忽略 `.mariocode/`）；未改任何 provider 的既有身份 / 工具提示文本。

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
- **前提（2026-09-29 核对代码）**：现在所有数据（配置、会话、每轮 token 记录）都只在用户本机 SQLite，没有任何上报。所以用户量、用量统计、计费都**只能以服务端网关的记录为准**，本地的 `usage_history` 只能用来展示，不能当计费依据（用户可改）。
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

### TODO-021 出错后自动发送「继续」（可在设置里开关）· ⚪ 未开始

- **问题**：同时开很多会话时，某个回合因网络断流、网关超时、上游 5xx / 429、网关空响应截断等**非人为原因**中断后，会话就停在那里，直到用户发现并手动发一句「继续」。能不能由 MarioCode 在这类情况下主动发送「继续」，让任务接着跑？做成设置里的开关，用户自己决定开不开。
- **外部参考（2026-09-28 调研）**：
  1. [dsh-auto-continue](https://github.com/HsiangNianian/dsh-auto-continue)（DeepSeek Harness Web UI 插件）：非人为中断后模拟用户发送「继续」，消息和手动输入一样进会话记录。功能有：错误分类（网络 / 超时 / 5xx / 429 自动续跑；401/403、鉴权、余额 / 配额、未知模型、上下文超长视为永久错误，只通知不重试）、指数退避（20s → 40s → 80s…，有上限）、续跑文本模板（可带 `{code}` `{tool}` 等占位）、幂等守卫（中断在工具执行中途时提示模型先检查状态、不要重跑）、全局暂停与按会话暂停、通知按钮「立即继续 / 暂停 1 小时」、循环保护（模型重复同一段话时打断），全部在设置卡片里可配。[GitHub topic auto-continue](https://github.com/topics/auto-continue) 下还有同类的 dsh-llm-retry-settings（按 provider / 模型设重试策略、输出被 token 上限截断时自动续写）。
  2. [cc-resume-watchdog](https://github.com/nnemirovsky/cc-resume-watchdog)（Claude Code 插件）：只恢复「流在中途断掉、但请求和账户都正常」的几类错误（连接中断、响应停滞、服务端中途报错、电脑睡眠、连接失败、请求超时）；额度用完、需要重新登录、prompt 过长、模型拒答一律不恢复。按消息 uuid 去重、每小时限次，防止失败循环跑飞。作者说明 Claude Code 在流已经吐出内容后不会自动重试（怕工具被执行两次），这类回合结束时不触发任何 hook，所以只能在外部盯着补发。
  （以上为转述，Content was rephrased for compliance with licensing restrictions。）
- **我们已有的基础**：`SdkMessageAdapter` 已能识别网关空响应截断并发 `turn.incomplete`（`dangling-tools` / `empty-response` / `unfinished-text`），界面上已经提示「发送「继续」可恢复」；error 子类型的 result 也会出错误卡片。缺的只是「自动发送」这一步。
- **初步方案（未动工）**：
  1. **放在主进程、provider 中立**：在 `RuntimeManager` 回合结束处判断，命中条件就对同一会话调一次 `sendTurn`，Claude / Codex / Pi 三端共用，不在各 adapter 里各做一份。
  2. **只续跑可恢复的失败**：网络断流 / 超时 / 5xx / 429 / `Stream closed` / `turn.incomplete` 三种形态；**永不自动续跑**：用户手动停止、鉴权失败、余额或配额不足、模型不存在、上下文超长、模型拒答、等审批 / 等回答（那是在等人，不是出错）。分类规则集中在一个纯函数里，方便写用例。
  3. **防跑飞**：每次续跑前等待并指数退避（如 20s / 40s / 80s，封顶）；每会话连续自动续跑上限（如 3 次）、每小时总上限；同一次失败只续跑一次（按回合 id 去重）；续跑后又立刻失败且没有任何新输出时停止，改为提醒用户。
  4. **幂等提示**：如果中断时有工具调用没拿到结果（`dangling-tools`），续跑文本改为「上一步工具可能已经执行，先检查当前状态再继续，不要重复执行」，避免重复 `git push`、重复写文件等。
  5. **看得见**：自动发出的「继续」在聊天里标成「自动继续 · 第 n 次 · 原因」，与手动消息区分；达到上限后出琥珀色卡片「已自动继续 3 次仍失败」+ 系统通知；侧栏「等你处理」提醒只计入**自动续跑放弃后**的出错会话，正在退避等待的不算。
  6. **设置**：设置 →「Agent」下新增「出错后自动继续」：总开关（默认关闭）、最多连续次数、退避起始间隔、续跑文本（默认「继续」，可自定义）、是否对网关空响应截断也生效。先做全局设置，按会话暂停放到二期。
  7. **与无人值守的关系**：定时任务 / 微信对话这类无人值守回合最需要它，是否默认对它们开启待拍板。
- **待拍板**：默认开还是关（建议关）；上限次数与退避间隔的默认值；无人值守回合是否默认开启；是否一并做「循环保护」（模型反复输出同一段话时打断），建议拆成单独 TODO。
- **工作量粗估**：2–3 天（分类纯函数 + 用例、RuntimeManager 续跑与退避、设置项与 i18n、聊天内「自动继续」标识与上限卡片）。

### TODO-022 回复里渲染图片 + 文件路径可点开 · 🟡 92%

- **已落地（2026-09-28）**：`components/chat/MarkdownImage.tsx`（`MarkdownLocalImage` 大图 / 方格、`MarkdownRemoteImage`、`MarkdownGallery`）+ `Markdown.tsx` 的 `rehypeImageGallery`（同一段落里只有 2+ 张图时改成网格容器）；`ImageWithPreview` 新增 `thumb` / `triggerTitle`，大图和方格复用同一个灯箱。网络图片：`net:fetchImage`（`main/ipc/files.ts` 的 `fetchRemoteImage`：只收 http(s)、15 秒超时、必须 `image/*`、上限 12MB、不带 cookie 和 referrer，走 Electron `net.fetch` 即跟随系统代理）。文件标签：`components/chat/FileChip.tsx` + `lib/fileLink.ts` 的 `classifyInlinePath`（只认整段行内代码；裸文件名必须是已知扩展名，`console.log` 这类保持代码；`:行号[:列]` 剥出来用于跳行；绝对路径以分隔符结尾 = 文件夹，双击在系统文件管理器里显示）。已过 tsc + build + 真机截图（`.turbo/v3-022.mjs`，浅 / 深色、悬停卡、选中态、占位态）。
- **9/29 补上**：纯文本（不在反引号里）的路径识别——`Markdown.tsx` 的 `rehypePathChips` + `fileLink.ts` 的 `splitProsePaths`，规则按原方案「宁可漏认」：绝对路径，或含分隔符且以扩展名结尾的相对路径，可带 `:行号[:列]`；裸文件名只在反引号里认；URL（所在词含 `://`）、邮箱、`2026/09/28`、`1/2`、`TCP/IP`、词中间的 `/b/c` 都不认。离线用例 `.turbo/prose-check.mjs` 15/15。相对路径图片：聊天里按会话项目根解析（`.md` 预览仍按文件目录）。
- **9/29 第二批**：工作树会话的回复路径 / 图片 / 工具卡链接按 checkout 解析（ChatPane `renderRoot`）；中文紧跟路径不再被吞（末段无扩展名时在 ASCII→中文处截断，离线用例增至 20 条全过）；生图联动——`mario_image_generate` 描述要求模型用 `![名称](保存路径)` 引用，且 `file.readBinary` 放行工具输出目录里的图片（原图在项目外，之前读不出来）；旧 `FileLink` 裸路径形态改为单击选中 / 双击打开（链接形态不变）。
- **与原方案的差异**：网络图片自动加载设置、纯文本识别开关没做；同一张图正文与工具卡都出现时工具卡不折叠；文件夹双击是在系统文件管理器里显示，不是文件树定位；全是中文的末段（「D:\work\实验报告里」）仍无法判断边界。

- **目标**：接入生图后，模型在回复里写出生成图片的地址（`![hero](outputs/splash/hero.png)` 或绝对路径）就直接显示图片；回复里提到的文件 / 目录路径可以一键打开（参考 Codex 的会话页）。原型：`prototypes/ui-refresh-v3.html#imgs`（悬停卡常开演示：`#imgs,fpop`）。
- **现状（2026-09-28 读代码）**：
  1. 已能显示：用户附图、浏览器截图（多张成图集）、`mario_image_generate` 的结果——都是 base64 image block，走 `MessageBlocks` + 灯箱。
  2. `Markdown.tsx` 的 `img`：本地路径在聊天里（无 baseDir）只渲染成 `FileLink` 标签；`.md` 预览有 baseDir 时才用 `MarkdownLocalImage` 经 `file.readBinary` 内联。
  3. 网络图片会输出 `<img src>`，但主进程 CSP 是 `img-src 'self' data:`，打包后被拦成空白。
  4. `FileLink` 已经能把路径变成可点链接（单击解析：唯一匹配直接 `openFileInIde`，多个出候选菜单），但只在 markdown 链接 / 行内代码等位置生效，样式是虚线下划线。
- **方案（未动工）**：
  1. **本地图片内联**：聊天里给 `MarkdownBaseDirContext` 传会话 cwd（工作树会话用 checkout），相对路径据此解析、绝对路径直接读；复用 `MarkdownLocalImage`（main 侧路径守卫不变，只允许已知项目与工具输出目录 `browser.screenshotDir`）。单张最大宽 520px、底部信息条（文件名 / 尺寸 / 大小 + 在编辑器打开 / 在文件夹中显示 / 复制 / 作为附件），连续多张排三列网格，点开进现有灯箱并能左右切换；读取中骨架屏、找不到文件给占位。大图做缩略（沿用 image_generate 的 JPEG 副本思路），避免 base64 撑内存。
  2. **网络图片（已定：默认点击后加载）**：默认显示「网络图片 · 域名 · 加载图片」占位，点击后经主进程代理拉取（走 `engineFetch` 同一网络路由、限大小 / 类型、转 data URL），不放宽 CSP；设置 → 外观加「自动加载网络图片：从不 / 信任的域名 / 总是」。
  3. **文件路径标签**：扩展识别范围到纯文本里的路径，渲染成等宽小标签（文件类型图标 + 路径 + 行号）。**双击打开**（文件 → 编辑器并跳行、目录 → 文件树定位、图片 → 灯箱），单击只是选中高亮（可 Ctrl C 复制路径），键盘 Enter 等同双击；悬停 400ms 出卡片（图片带缩略图、目录显示文件数，按钮：在文件夹中显示 / 复制路径，并提示「双击打开」）。识别在渲染期只做正则，解析仍是双击时 IPC（保持 `FileLink` 现有的零渲染开销设计）。现有 `FileLink` 的单击打开要一并改成双击，两处行为保持一致。
  - **纯文本识别规则（已定，默认开启，设置里可关）**：只认「像路径」的片段，宁可漏认不误认——① 绝对路径（`C:\…`、`D:/…`、`/Users/…`、`~/…`）；② 相对路径必须含 `/` 或 `\` 且以已知扩展名结尾或以分隔符结尾（`src/app.ts`、`outputs/splash/`、`./x.md`），可带 `:行号[:列]`；③ 裸文件名（`README.md`）只在行内代码里识别。排除：URL（有 `scheme://`）、版本号 / 数字串（`0.3.238`、`1/2`）、邮箱、代码块内部（代码块保持原样，不插标签）。识别到但双击时解析不到的，沿用 `FileLink` 的「未找到匹配文件」菜单。
  4. **生图联动**：`mario_image_generate` 的提示词说明里要求模型用 `![名称](原图路径)` 引用结果，这样同一张图既有工具卡、也能在正文里按模型安排的位置出现；同一张图在同一轮重复出现时正文优先、工具卡折叠。
- **已拍板（2026-09-28）**：路径标签**双击打开**；网络图片**默认点击后加载**；纯文本路径识别**默认开启、按上面的严格规则**，设置里可关。
- **工作量粗估**：3–4 天（本地图片 1 天、路径标签 1–1.5 天、网络图片代理与设置 1 天、生图提示词联动与回归 0.5 天）。

### TODO-023 会话里显示缓存命中率与输出速度 · 🟡 75%

- **已落地（2026-09-28）**：`lib/genTimer.ts`（渲染端按 text / thinking 增量计时，模块级 Map，不触发渲染；工具调用或 2 秒无增量即断段）、`lib/sessionMetrics.ts`（命中率分母 = `totalProcessedTokens - outputTokens`，平均按 token 加权；Pi 的累计 usage 按 `turnTokens.ts` 同一规则取差值；量不出来返回 null，界面显示「—」）；store `turnGenBySession`（回合结束追加，上限 200）。界面：`MessageBlocks` 署名行 chips、`SessionFloat` 的「缓存与速度」段、`SessionMetrics`（输入框右侧，窄于 44rem 只留上下文环）。
- **与原方案的差异**：计时没写进 `TurnUsageRecord`，重开会话后历史回合没有速度；首字延迟没记；OpenAI 桥 / Codex / Pi 的缓存字段没逐个核对。

- **目标**：在会话界面看到每轮（单次）与本会话平均的缓存命中率，以及输出 token 速度（tok/s）。
- **展示位置（原型已画）**：① 每条助手回复的署名行，在「用时」后面加两枚小标签「缓存 93%」「64 tok/s」，悬停显示明细（读取 / 输入 / 写入 token、输出 token 与生成用时）；② 「本会话」浮窗新增「缓存与速度」一节：两张卡片（大字 = 本轮，小字 = 本会话平均），下方每轮缓存命中迷你柱状图（本轮高亮、明显掉档的轮用琥珀色，悬停说明原因如「换了模型，缓存失效」）；③ 本会话输入框右侧的指标组「◔ 23% | ⚡ 84% | 57 tok/s」（上下文 / 本会话平均缓存 / 本会话平均速度，悬停带本轮值，点击展开「本会话」浮窗）。**不放全局状态栏**（2026-09-28 定）：这些都是按会话算的，状态栏只放全局信息（引擎就绪、网络、运行中 / 等你处理数量、今日用量合计、定时、手机）。
- **口径（已定）**：
  1. **缓存命中率** = `cacheRead / (input + cacheRead + cacheCreation)`，只算输入侧；**平均按 token 加权**（Σ读取 / Σ全部输入），不是各轮百分比的简单平均。第一轮冷启动为 0% 是正常的，照常计入。子代理的 token 暂不计入（`TurnUsageRecord.subagentTokens` 不分输入 / 缓存）。
  2. **输出速度** = 输出 tokens / 实际生成时间。生成时间只算模型在吐字的时间：一轮里每次模型调用的「首个增量 → 最后一个增量」相加，**不含**工具执行、等待审批 / 回答、首字延迟；首字延迟单独记，放在悬停说明里。平均 = Σ输出 tokens / Σ生成时间。
  3. 端点不返回缓存字段（部分 OpenAI 协议网关）时显示「—」并在悬停里说明，不显示 0%。
- **数据来源**：缓存三项已在 `TurnUsageRecord`（`cacheReadTokens` / `cacheCreationTokens`，Claude 来自 SDK usage，OpenAI 协议桥需确认是否回译 `prompt_tokens_details.cached_tokens`；Codex / Pi 要各自核对 usage 字段）。速度需要新增：adapter 在每次模型调用的首个 / 最后一个 text·thinking 增量打时间戳，回合结束汇总成 `generationMs`、`firstTokenMs` 写进 `TurnUsageRecord`（跨进程时间戳沿用现有 turn-end 快照的对齐方式）。三端都要接。
- **待拍板**：thinking 输出算不算进 tok/s（建议算，Claude 的 output_tokens 本就含 thinking）；设置里是否提供开关隐藏署名行的指标（默认显示）。
- **工作量粗估**：2–3 天（契约与持久化 0.5 天、三端 adapter 计时 1–1.5 天、UI 三处与 i18n 0.5 天、桥 / Codex / Pi 缓存字段核对 0.5 天）。

### TODO-024 模型配置收尾三件（2026-09-28 立项，均不影响当前使用）

界面焕新 v3 落地时顺手改完了模型配置页（左列表 + 右表单三段、「加载模型」弹窗逐模型勾选接口与生图、密钥保留规则放宽、保存后不再关表单），剩下三件不着急的尾巴记在这里。

**① 生图标记接入 MarioTool 内置工具 · 🟢 已完成（2026-09-28）**

> 按下面的方案落地在 `BuiltinToolsPanel.tsx`：下拉 + 保留当前手打值（标「未标记生图」）+「手动输入模型 id」开关 + 无标记时的引导跳转；主进程 `resolveImageEndpoint()` 语义未改。以下为动工前的记录。

现状（两套数据各说各话）：
- 模型侧已经有标记：`SharedProviderModelSchema.imageGeneration?: boolean`（`packages/contracts/src/sharedProvider.ts`），「加载模型」弹窗每行有「生图」chip（默认关）、模型配置表单每行有星星开关。
- 工具侧完全不知道它存在：`BuiltinToolsConfigSchema.image = { source, model, size }`（`packages/contracts/src/ipc.ts`）里 `source` 是共享提供商 id、**`model` 是一个 `z.string().max(256)` 自由文本**；设置 → MarioTool 的「图片模型」就是一个 `Input`（占位符 `gpt-image-1`，失焦/回车才保存，见 `BuiltinToolsPanel.tsx`）。用户得自己去服务商文档里抄模型 id，抄错了只能等模型调用时报错。
- 主进程 `resolveImageEndpoint()`（`main/tools/builtinToolsConfig.ts`）只校验「source 非空且不是遗留的 `custom`」→ 提供商存在 → 协议（chat-completions 优先，其次 responses）→ `endpointUrl` → `model.trim()` 非空 → 有 Key，返回 `{baseUrl, apiKey, model, size, label}`；失败时给 `ImageToolIssue = noSource | providerMissing | noModel | noKey`，面板用 `ISSUE` 映射成文案。`mario_image_generate` 的注册条件是 `!imageToolDisabled && resolveImageEndpoint().ok`。

要做的改动：
1. **「图片模型」从输入框改成下拉**：候选 = `providers.find(p => p.id === source)?.models.filter(m => m.imageGeneration)`，显示 `label ?? id`（下面用等宽小字显示 id）。面板已经在 `useEffect` 里调了 `api.sharedProviders.list()` 拿到 `providers`，**不需要新 IPC**。
2. **「图片来源」只列有生图模型的提供商**：`providers.filter(p => p.models.some(m => m.imageGeneration))`。全局一个都没有时，把现在的 `imageNoProviders` 警告换成「去 设置 → 模型配置 给生图模型勾上「生图」」，并给一个直接跳过去的入口（`setSettingsOpen(true, "custom-models")`）。
3. **不能把老配置弄没**（关键）：现在用户的 `image.model` 是手打的，几乎不会正好等于某个标了生图的模型。所以
   - 下拉要把**当前存的值**作为一个额外条目保留（标注「当前值 · 未标记生图」），不然一进页面选择就被清空；
   - 保留一个「手动输入」小开关，切回自由文本，供标记没来得及打、或服务商模型 id 不在列表里的情况；
   - **主进程语义不变**：`resolveImageEndpoint()` 仍然只要求 `model` 非空，**不因为「没标记生图」而拒绝**。标记只驱动界面候选，避免把现在能用的配置判成坏配置。面板可以在这种情况下显示一条灰色提示（不是 warning、不拦保存）。
4. **顺带（可选）**：模型配置左侧提供商列表给「有生图模型」的提供商加一个小标记，和现有的引擎图标排在一起；「加载模型」弹窗里已勾生图的行也可以更醒目一点。

要新增的 i18n 词条（zh/en 同步）：`settings.builtinTools.imageModelPick`（下拉标签/占位）、`imageModelManual`（手动输入开关）、`imageModelUnmarked`（当前值未标记生图的灰色提示）、`imageNoMarkedModels`（全局没有标记时的引导 + 跳转按钮文案）。

边界情况：
- 提供商被删/改名 → 已有 `providerMissing` 覆盖，不用新 issue。
- 某个标了生图的模型，其提供商只开了 `anthropic` 协议 → `resolveImageEndpoint` 的 `protocol` 为 null、回落 `provider.baseUrl`，仍会去 POST `{baseUrl}/images/generations`。要不要在界面上提示「这个提供商没有 OpenAI 兼容协议，生图可能打不通」，做的时候一并想清楚。
- 「加载模型」弹窗的生图默认是关的，所以**不会自动给任何模型打标记**，老提供商升级后列表会是空的——第 2、3 点的引导文案就是为这个准备的。
- 切换「图片来源」时，如果新来源里没有当前 `model`，要顺手清空或自动选中它的第一个生图模型（别留下跨提供商的脏值）。

验证：`pnpm test:builtin-tools-electron`（先 `pnpm build`；真 app 截 MarioTool 页 + 核对 IPC 与开关联动）要跟着更新——它现在断言的是输入框形态。`pnpm test:web-tools` 里的「旧配置迁移」用例补一条：`image.model` 是未标记的手打值时，`resolveImageEndpoint()` 仍然 ok。

工作量粗估：0.5 天（面板 + i18n 0.3 天，两个测试脚本更新 0.2 天）。

**② 密钥保留规则是否保留（待拍板）**
- 现状（`sharedProviderOrigins` / `sharedProviderAddsOrigin`，contracts，主进程校验与面板提示共用）：留空密钥保存时，只有**出现新的 scheme + host + port**（换服务器、https→http 降级）才要求重填；只改路径（补 `/v1`、加尾斜杠）或移除某个地址都保留已存密钥。改之前是比对整串 URL 指纹，任何地址微调都逼用户重打长密钥。
- 用户提的问题：这条是否还有必要——「密钥错了本来就用不了」。
- 保留的理由：拦的不是打错字，是**把有效密钥发给新的收件人**。换成别人的中转站时如果沿用旧密钥，对方会收到一个能用的官方密钥，请求还会正常成功，损失发生在「发出去」那一刻。
- 去掉的成本：很小——删掉 store 里那三行判断 + 面板的 `needsKeyForNewOrigin`（含内联警告与保存禁用）即可；中间做法是不拦、保存后给一条提示。
- 回归脚本已在：`.turbo/v3-keytest.mjs`（隔离 profile 起真 app，8 步：create / 无改动 / 加模型 / 改路径 / 同源覆盖 / 换 host / http 降级 / 换 host+新密钥）。真要改，跑它确认行为。

**③ 旧版专属配置的遗留数据**
- 现状：旧版专属配置页（`CustomModelsPanel.tsx`）已删，设置 → 模型配置只剩公用提供商。但之前在那里存过的 Claude 自定义端点（`customModel` 表 + 加密 token）和 Pi Provider（`~/.pi/agent/models.json` + 加密 key）**数据都还在**：引用它们的旧会话照常能跑，输入框的模型下拉里也可能还列着它们，只是界面上没有入口再编辑或删除。
- 要做（二选一）：给一个一次性入口（列出遗留配置 → 迁移成公用提供商 / 删除），或者确认就这么留着、只在文档里说明。
- 风险点：Pi 的旧配置写在用户本机 `~/.pi/agent/models.json`（不属于隔离的公用配置），迁移要小心不要动到用户自己手写的条目。

## Git 版本记录

| 版本 | 日期 | Commit | 主要更新 | 状态 |
|---|---|---|---|---|
| `v0.2.13` | 2026-10-07 | `0d35e72` | 修复三协议桥的工具映射、并行工具流、SSE、异常断流、图片结果与思考强度 | 类型检查与构建、共享提供商 179 项、真实引擎本地协议桥 12 项、桌面 9 条接口路径及 Pi host 回归通过；Windows 本地包与更新清单校验通过，本轮未安装、未上传 |
| `v0.2.14` | 2026-10-07 | 本地标签 `v0.2.14` | TODO-028：侧边栏最近实际模型及持久化 | 类型检查、构建、53 项 store 检查、真实 Electron / SQLite 保存检查通过 |
| `v0.2.15` | 2026-10-07 | 本地标签 `v0.2.15` | TODO-029：模型品牌图标与名称 | 类型检查、构建、45 项模型与历史锚点检查通过 |
| `v0.2.12` | 2026-10-06 | `6490ed3` | Codex 增加 Chat / Messages 桥接，修复 Claude Responses 工具流与缓存字段 | 类型检查、共享提供商 139 项通过；真实引擎本地端到端已随 v0.2.13 补验 |
| `v0.2.11` | 2026-10-06 | `b7b8a99` | 修复 Responses 工具调用去重、上游错误透传与错误映射 | 已提交，后续回归见 v0.2.13 |
| `v0.2.10` | 2026-10-06 | `fdfd92d` | 修复 Responses 历史 assistant 内容类型为 `output_text` | 已提交，后续回归见 v0.2.13 |
| `v0.2.9` | 2026-10-06 | `c22c905` | Claude 支持 Responses、Chat 思考强度映射及 LaTeX 渲染优化 | 共享提供商 110 项、构建与本地 Windows 打包完成 |
| `v0.2.5` 至 `v0.2.8` | 2026-10-05 | `93f54d7` → `6346c11` | 自建更新服务器、窗口与托盘修复、下载主页及 macOS 构建接入 | 发布流水和验证记录见上方 10/5 至 10/6 记录 |
| `v0.2.4` | 2026-10-03 | `v0.2.4:` 版本提交（可按标题查询） | 新增上下文与压缩设置：默认 1M，用户可设 10%–90% 自动压缩阈值（默认 80%），模型单独容量优先；接入三端实际压缩，修 Codex 原生模型目录上限与 Pi 压缩前提前结束回合，补 Claude Messages 版本路径归一化 | 类型检查、构建、公共提供商 90 项与 Pi host 检查通过；隔离真应用中三引擎 1M / 200K 的容量与 60% 压缩、续聊、设置持久化通过，额外覆盖 Codex 已知模型；仅使用本地假模型服务，未打安装包、未发布 |
| `v0.2.3` | 2026-10-03 | `v0.2.3:` 版本提交（可按标题查询） | 修复 Pi 包内 host 路径、Messages 重复 `/v1` 与公共默认模型；统一每模型接口路由及兼容校验，发现不再虚构接口，新增协议不自动授予已有模型，界面显示实际引擎接口并保留引擎勾选 | 类型检查、构建、公共提供商 78 项、Pi 三协议/续聊/默认模型与隔离真应用请求检查通过；Codex Responses 及跨模型续聊通过；同样用 ASAR 包验证 Pi 启动及实际请求，未发布 |
| `v0.2.2` | 2026-10-02 | `v0.2.2:` 版本提交（可按标题查询） | MCP / Skills 发现市场与我的扩展、安装与导入来源管理；设置页双栏与搜索、自适应排版；修复常规 / 外观切换后整窗空白（用实际宽度测量替代 CSS size containment）；允许用户配置的 HTTP 网关加载模型；会话分页竞态及累计用量显示修复 | 类型检查及构建通过；会话 51 项、共享提供商 58 项、技能市场 45 项、设置 / 市场 13 组与设置切换 26 个画面检查通过；本地安装包按此版本生成，未发布 |
| `v0.2.1` | 2026-09-29 | `8350d7f` | ① 修「切到某个项目后会话列表显示暂无会话」：有会话在运行时 `session.changed` 回声会让切换后的首次拉取被当成过期结果丢掉，`loadStreamSessions` 改为代际变了就重拉（最多 5 次）、仍脏则 1.5 秒后重试，防复活守卫保留；② 共享提供商「加载模型」改走 `engineFetch`，跟随 设置 → 网络 的代理；③ 加载模型失败时在「模型」区内联显示错误并弹 toast（原来错误在面板顶部，滚出视野看不到）；④ 聊天区上方去掉会话标签栏，切换会话只走会话列（按选中项目过滤），标签栏只剩文件 / 计划标签、没有时整条不显示；后台会话改为按时间回收：离开（或后台回合跑完）超过 2 小时自动关闭并释放消息历史（再点开从库里重新加载首页），2 小时内最多保留最近 5 个（草稿 / 滚动秒回），每 5 分钟扫一次；当前会话和正在运行、等待回答 / 计划审批 / 工具审批的会话永不回收；⑤ 右上角「本会话」收起态宽度跟随内容（原来固定 300px，空闲时只剩右端「| 14%」、左边一长条空白），任何状态都以图标 +「本会话」标题开头，后面接运行状态 / 任务进度 / 子代理 / 上下文占用，分隔线不再悬空；⑥ 输入框底栏的设置药丸在右侧指标（上下文 / 缓存 / 速度）出现后会压到它们上面——宽度判定只看整行溢出，没看左侧可用宽度，现在药丸比左侧宽就切成紧凑态；未读、草稿等轻量状态保留，会话列徽章不受影响；另新增 `scripts/package-win.bat` + `scripts/fix-wincodesign.mjs` 本机打包脚本 | 已过 typecheck；已提交、未打包、未发布 |
| `v0.2.0` | 2026-09-29 | `983d60d` + 版本号 | 界面焕新 v3 + mcode→mariocode 改名后的首个安装包，版本号 0.1.54 → 0.2.0；本机打出 `MarioCode-0.2.0-x64.exe` | 本地打包、未发布 |
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
| `v0.2.2` | 2026-09-15 | `130fd90` | 原 MarioCode v0.2.2 基线 | 已发布 |

## 更新方法

1. 有新想法或未完成事项时，写入 [MarioCode 想法与待办](MarioCode-TODO.md)。
2. 开发时在待办文档维护状态和剩余验收要求。
3. 完成并提交后，在本页补充结果、commit 与验证，并在「Git 版本记录」新增一行。
