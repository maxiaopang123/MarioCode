# MarioCode 功能与版本记录

> 记录完成结果、验证与 Git 版本。新想法和未完成事项统一维护在 [MarioCode 想法与待办](MarioCode-TODO.md)。

最后更新：2026-10-26

## 当前进度（2026-10-26）

**10/26（v0.2.66 · 接口转换层重构为 magpie 式 IR，Codex→Anthropic 补缓存断点）**：①**起因**：v0.2.65 只修了「system 消息两种写法」这一个点，chat 与 responses 两个转换器各自维护一套规则，其余问题（空 assistant 消息、工具调用/结果不配对、finish_reason 白名单过严、工具名 `+=` 拼接、上游缺工具 id 直接失败、`cache_creation_input_tokens` 恒为 0）都还在。用户决定参照 magpie 源码整体重做，范围为请求侧与响应侧一起，工具调用仍缓冲到流结束后校验再发，DeepSeek `reasoning_content` 回放先不做。②**请求侧**（`providers/bridge/`）：`parseAnthropic → normalizeIR → buildChat / buildResponses`。`ir.ts` 放类型与固定常量，`irParse.ts` 把 `system` 角色消息在字符串与数组两种写法下都解析为 `user`、过滤 `DeferredToolPlaceholder`，`irNormalize.ts` 统一做一次修复（合并相邻文本、丢弃空消息与只含 thinking 的 assistant、调用与结果按调用顺序配对、重复结果取第一个、孤儿结果降级为 `Tool result received.`、未应答的调用补固定合成结果），`irBuild.ts` 按固定字段顺序渲染两种请求体。`requestTranslator.ts` 与 `responsesRequestTranslator.ts` 缩成薄入口，对外签名不变，`bridgeServer.ts` 无需改动。③**响应侧**：上游分块先由 `chatStreamDecoder.ts` / `responsesStreamDecoder.ts` 解码为中立的 `StreamEvent`（`streamEvents.ts`），再由 `anthropicEncoder.ts` 统一编码为 Anthropic SSE，工具缓冲、校验、停止原因映射只在编码器里写一次。行为变化：未知 `finish_reason` 视为正常结束；分片的工具名拼接，整段重发的开始片段不重复；缺 id 的工具调用补 id；`prompt_tokens_details.cache_write_tokens` 映射为 `cache_creation_input_tokens`；缓存读取兼容 `prompt_tokens_details.cached_tokens`、`prompt_cache_hit_tokens`、顶层 `cached_tokens`、`cache_read_input_tokens`。旧的 `mapStopReason`、`reset()`、`finishReason`、`toolBlockCount` 已无调用方，一并删除。④**刻意没移植的**：magpie 的 `joinSplitCalls` 会在后面出现新调用时回头改写前面的历史，破坏前缀缓存要求的只追加特性；确定性 sha256 工具 id；DeepSeek 推理回放；Search/File/Sealed 等 Part 种类；Anthropic 请求侧的 `cache_control` 构建（本项目 Anthropic 直连仍是字节透传，不经过 IR）。⑤**验证**：`test:shared-providers` 227 → 258 项（新增 `ir-regressions.ts` 31 项：system 消息块/字符串写法字节一致、多轮历史只追加、配对规则、空消息、占位符过滤、各种 usage 写法、停止原因、工具名拼接）；`tsc --noEmit` 通过。**未验证**：没有在真实 gateway 上用 openai / responses 协议各跑一轮对比缓存命中率；magpie 自带测试用例（`split_calls_test`、`chat_tool_pairing_test`、`translate_stream_test` 等）未移植；Responses 路径仍无真实流量。**遗留**：①上面两项真实流量验证；②`routeToken` 未校验（本地桥 127.0.0.1 监听无鉴权，会注入真实上游凭据），单独处理；③`ipc/git.ts` 的 `resolveModelForGitOp` 只桥接 openai / responses，不含 anthropic，与其他入口不一致；④Chat / Responses 桥接模式下 `count_tokens` 返回 404。⑤**Codex→Anthropic 缓存断点**（`18211db`）：Codex 走 `anthropic` 上游协议时，请求体此前没有任何 `cache_control`（Codex 客户端从不发，Anthropic 缓存又是显式开启的），这条路径拿不到上游缓存。现在 `markCacheBreakpoints` 在构建时标记：最后一个 system 块（没有 system 时标最后一个工具）和最后一条消息的最后一个块，最多两个断点；chat-completions 上游不受影响；冒烟新增 7 项，合计 265 项。⑥**开发版真实流量**（mariogate，10:38 重启后）：`deepseek-v4.1-flash` 经 chat 桥 87 条成功请求，总命中率 93.4%，80 条在 95% 以上，会话内 `cached_token` 紧贴上一轮 `input_token`；7 条低于 50%，其中 5 条 `cached_token` 恰为 128，全部落在同一个上游区域，对异常请求 21431 与相邻两条的请求体做字节比对，前 64KiB 完全一致，故判断不是前缀改动。Anthropic 直连 `claude-cli/2.1.304` 正常，冷启动出现在 5 分钟以上的停顿之后。**限制**：这批数据同时含 v0.2.65 修复与本次重构，分不出重构本身的增量；没覆盖工具调用、Responses 路径与 Codex→Anthropic 的真实请求；请求体日志只存 64KiB。**发布**：版本 0.2.66，tag `v0.2.66`，与 `f2549d2` 一起推送。

**10/25 续（v0.2.65 · 重放的 system 消息字节稳定，修复 DeepSeek 桥接与 Anthropic 直连的缓存命中）**：①**根因**：Claude 二进制每轮会在 `messages[]` 末尾追加一条 `system` 角色消息（环境块、延迟工具提示、每轮输出风格提醒）。该消息在新增那一轮是 block 数组（带 `cache_control`），之后从 transcript 重放时变成纯字符串。同一条消息两种写法，序列化出的字节每轮都不同，上游前缀缓存在这条消息处断开，后面的内容全部冷发。②**chat 转换器**（`requestTranslator.ts`）：`system` 分支放在字符串快速路径之前，统一以 `user` 角色输出（此前字符串写法输出 `system`、数组写法落入 user 分支，同一条消息每轮翻转角色）；`tools` 过滤 `DeferredToolPlaceholder`（它只是保持延迟工具加载开启的标记，会随 ToolSearch 变化，导致整份 prompt 重新分词）。③**Responses 转换器**（`responsesRequestTranslator.ts`）：同一个问题，同样修复。④**Anthropic 直连**：该协议此前绕过本地桥，转换器修复碰不到它。现在 `anthropic` 协议也经本地桥，以透传模式工作（`anthropicPassthrough.ts`）：只把重放历史里字符串形态的 `system` 内容改写成单个 text block，其余请求体与响应（SSE）原样转发；只有真的改动了才重新序列化，否则发出二进制自己的原字节。「测试连接」同步走桥，避免测得过但实际不通。⑤**线上数据**（mariogate `user_request_logs`）：DeepSeek 经 chat 桥第 2 轮命中 77.9% → 98.8%；`claude-sonnet-5-5` 经 MarioCode（UA 含 `sdk-ts`）此前 `cached_token` 卡在 18,919 并逐轮减 1、`cache_write` 逐轮变大，修复后第 2 轮 97.3% / 97.2%，第 3 轮起 99.2% ～ 99.3%，`cached_token` 紧贴上一轮的 `input_token`。用服务器上卡死的那几轮请求模拟：改写前相邻两轮严格 append-only 为 0/6，改写后 6/6。**验证**：`tsc --noEmit` 通过；透传纯函数断言（改写、URL、请求头）与 Responses 转换器冒烟（块/字符串两种写法序列化一致、占位符被过滤）通过。**发布**：修复提交 `622288d`，版本提交 `e36032f`，注解 tag `v0.2.65`；GitHub Release #16 成功（18 分 45 秒）；Windows 已发布到自建更新源，macOS 通过 `release:upload --mac` 由服务器从 GitHub Release 拉取 dmg，两个平台线上清单均为 0.2.65。**遗留**：①Anthropic 透传的真实数据样本很小（8 个请求，最长约 28k tokens），长会话（100k 以上）命中率待观察；②Responses 路径只有冒烟测试，尚无真实流量；③magpie 的 `joinSplitCalls` / `withoutSilentAssistants` / `pairToolMessages` 暂未移植，目前没有证据显示需要；④是否引入 magpie 的完整 IR：评估后暂缓。chat 与 responses 两个转换器真正共用的只有「system 消息统一成 user」和「过滤占位符」两件事，而透传路径不能过滤占位符（它的上游就是 Anthropic 协议，占位符用来保持延迟加载开启），也不是翻译，抽一层共用归一化收益很小；等到要加第二项归一化（例如 `joinSplitCalls`）再抽；⑤mariogate 里 MarioCode 与 Claude Desktop 的 User-Agent 区分不开（MarioCode 是 `sdk-ts`，Desktop 是 `claude-desktop-3p`，后者来自继承的环境变量），可以给 MarioCode 起的 claude 进程单独设置 `CLAUDE_CODE_ENTRYPOINT`，未做；⑥Windows 安装包仍未签名。

**10/25（v0.2.64 · Claude Anthropic 动态提示移出缓存前缀）**：①确认 `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` 放在 `preset.append` 字符串中时会原样进入 `/v1/messages`，不会形成独立断点；②稳定 system prompt 只保留固定 MarioCode 内容，计划模式提示改为隐藏 user reminder，避免每轮动态内容改变 system/tools 缓存前缀；③显式启用 `snapshot: true`，保持 resume 会话的 system prompt 快照；④不改 `query()` 生命周期，不依赖某个 runtime 版本，也不把 `systemPrompt` 改成会丢失 Claude Code preset 的数组形式。**验证**：本机 mock Anthropic 抓包确认动态提示已从 system 缓存块移到 user message；`pnpm --dir apps/desktop typecheck`、`test:shared-providers`（227 项）、`git diff --check` 全部通过。**遗留**：需要在真实 KiroRS 上继续观察 proxy credits 与 Anthropic usage，确认线上缓存率改善幅度。

**10/25（v0.2.63 · HTML/Mermaid 可视化输出增强）**：①**HTML 输出格式**：模型可根据场景选择内联 HTML（短重点、状态标签、局部强调）或 ` ```html` 围栏 HTML（指标卡、网格、A/B 对比、时间线、进度条、静态图表）；围栏 HTML 默认显示安全预览，可切换查看源码。②**HTML 视觉层次**：提示词引导使用 grid/flex、`<strong>`、`<mark>`、重点文字和 2～4 种语义色；客户端按当前浅色/深色及 MarioCode 配色自动调整背景、边框和文字对比度。脚本、事件属性、危险 CSS、外部资源和任意动画均清洗，当前只支持静态可视化。③**Mermaid 配色与风格**：流程图、饼图、柱/折线图、象限图使用主题化多色序列；`classDef` / `style` / `linkStyle` 的模型颜色按主题重新拟合。模型可在首行用受控 `%%{init: {"look":"classic"}}%%` 选择 `classic`、`neo` 或 `handDrawn`，客户端过滤 `themeVariables`、`securityLevel`、字体和外部资源。**验证**：`typecheck`、`build`、`test:rich-output-prompt-electron`、`test:markdown-render-electron`（含 handDrawn 受控主题）、`test:chat-display-electron`、`git diff --check` 全部通过。**未完成**：没有开放任意 JavaScript/CSS 动画；如需动画，后续应增加客户端白名单组件，而不是让模型注入动画代码。

**10/24（v0.2.62 · Claude Anthropic 缓存断点稳定性）**：①**SDK 对齐**：MarioCode 使用的 `@anthropic-ai/claude-agent-sdk` 从 `0.3.258` 升到 `0.3.304`，内置 Claude runtime fallback 与 contracts 注释同步更新，避免客户端 CLI / SDK 版本落后于已验证的缓存行为。②**动态提示词断点**：Claude 原生 Anthropic `/v1/messages` 请求在稳定的 MarioCode system prompt 后插入 SDK 官方 `SYSTEM_PROMPT_DYNAMIC_BOUNDARY`，把每轮会随 UI 模式变化的 plan-mode nudge 放到动态边界之后，避免动态段污染稳定前缀的缓存断点；Claude `query()` 生命周期与 `/v1/chat/completions` 未改。**验证**：`typecheck`、`test:runtime-selection`（60 项）、`test:shared-providers`（227 项）、`test:protocol-bridges-native`（12 项）全部通过；`git diff --check` 通过。**未验证**：需要在真实 KiroRS 上用新 runtime 做连续两轮 A/B，确认 proxy credits 的真实命中率改善；TODO-079 的完整出站请求体取证仍保留。

**10/23 续二（v0.2.61 · 安装包瘦身 219→128 MB + 三引擎超时不误杀长回复 + 「本会话」停靠右列）**：三件事凑成一版。①**依赖瘦身（perf）**：安装包从 219 MB 降到 128 MB（-41%），app.asar 601 MB → 110 MB。根因是 electron-builder 只打包 `dependencies` 的传递闭包，而 Vite 早已把渲染层用到的库内联进 `out/renderer` —— monaco / mermaid / shiki / katex / pdfjs / tiptap / xterm 这些库同时以 JS chunk 和 node_modules 两份形式进包。把它们移到 `devDependencies`：本地照常安装、渲染层照常解析，但 electron-builder 不再打包。规则是 `dependencies` 严格等于主进程（含 fork 出去的 `out/pi-host` 与 `out/mcp` 包）运行时真正需要的集合；原生模块（better-sqlite3、node-pty、sherpa-onnx-*）必须留在 dependencies，因为 `externalizeDepsPlugin` 只外部化 dependencies，放进 devDependencies 会被内联进主进程 chunk，而 .node 二进制无法这样工作。新增 `audit:deps` 脚本校验这条规则不漂移；`electron-builder.yml` 顶部补了一段说明，免得下一个人又把渲染库加回 dependencies。②**三引擎超时改成「只惩罚沉默，不惩罚时长」（fix）**：此前三个引擎各自用一条固定总时长预算，同一个故障——一段正在正常输出的回复，跑到一半被计时器掐死。**Codex**（中转桥）：从每个 /responses 固定 5 分钟，改成首字节 180s → 空闲 120s（每收到一块就重置）→ 12h 绝对上限；SSE 心跳注释会不断喂饱纯空闲计时器，所以绝对上限独立且永不重置，否则一个只发心跳的上游能把请求挂到天荒地老。**Claude**（中转站直连）：CLI 的字节空闲看门狗是被门控的（`X$r(provider) = _i() && Dp(provider) && Dp(currentProvider)`，`Dp` 只认官方端点/bedrock），中转站上 `Dp()` 恒为 false、看门狗根本不运行，于是 `API_TIMEOUT_MS` 是唯一守卫——不能照搬 Codex 的空闲方案，只能放大总预算，从 CLI 默认的 10 分钟恒定注入到 60 分钟（32k token @ 10 tok/s ≈ 53 分钟；用户随时可按 Stop）；显式配置的 `timeoutMs` 仍优先，0/负数/NaN 视为未配置而非禁用。**Pi**（reverse 通道）：pi-host → 主进程的反向通道原来所有方法一律 5 分钟，把「机器在跑工具」和「人还没点审批卡」当成同一个时钟，副作用是 `McpToolSession` 允许的 600s 工具超时从来不可能生效（300s 通道预算先开枪）；现在按方法分档——人类提示（审批/提问/计划确认）完全不计时，工具调用 30 分钟（> MCP 的 600s 上限，那个配置终于可达），状态查询 60s。「不计时」不会泄漏：turn 中断与 host 关闭两条路径都会 reject 掉该 turn 下所有 pending 的反向请求；顺带删掉 `PiHostClient.ts` 里从未被使用的 `REVERSE_TIMEOUT_MS`，避免以后有人以为主进程侧还有第二道闸。③**「本会话」停靠右列（feat，`8b11ab8`，另一个会话带入）**：会话概览从悬浮卡片改为贴右边缘的整高列（可拖 260–460px、Esc/‹ 收起、窗口过窄退化为覆盖层），任务清单移到输入框正上方并新增 `taskDockMode` 设置；`SessionFloat` 拆成 `SessionEntry` / `SessionPanel` / `SessionOverview` / `SessionTasks` 四个组件，删掉了死掉的 `.fsess`/`.fs-card` 浮窗样式。**验证**：`pnpm -w typecheck` 3/3 通过、`build` 通过、`test:pi-host` / `test:shared-providers`（227 项）全绿；新增两个冒烟——`test:codex-bridge-timeout`（A 持续输出不被杀 / B 沉默即断 / C 只发心跳也逃不过绝对上限）与 `test:timeout-policy`（Claude 默认值与覆盖语义、Pi 分档预算，并从 `piHostProtocol.ts` 读回方法联合类型逐个对账，防止新增方法漏配预算）；两者共用新抽的 `scripts/lib/main-bundle.mjs`（把「主进程 TS → 纯 node 可 import 的 ESM」脚手架独立出来，stub electron / better-sqlite3，补 createRequire banner）。**发布**：提交 `3b57878`（瘦身）、`b499283`（超时）、`c5a1616`（bump 0.2.61），tag `v0.2.61` 推送后 Actions Release 成功（12 个资产）；`release:upload` 传 Windows exe + blockmap、`latest.yml` 最后上传，公网复核 `http://39.109.58.6:3458/latest.yml` 为 v0.2.61、exe（134,372,132 字节，128.1 MB）可下载；`release:upload --mac` 由服务器从 GitHub Release 拉两个 dmg（148.1 / 156.1 MB，各约 90 秒）与 `latest-mac.yml` 并复核通过。**git 踩坑（本次新增）**：worktree 里做的改动先落成两个独立提交再 rebase——未提交的改动在 rebase 时会跟着漂移、冲突最难解，先提交让冲突变成干净的「两边都在这几行加了东西」；`git push mirror`（ghfast.top 代理）再次挂住（GCM 对代理域名没存凭据），改直连 `github.com` 用已存凭据秒过，这次直接加了 `github` remote 备用；上传时撞上 `REMOTE HOST IDENTIFICATION HAS CHANGED`——服务器（亿联云）只开密码登录、`publish.mjs` 走 ssh2 不校验 known_hosts，确认是自己服务器后 `ssh-keygen -R` 清掉旧记录即可。

**10/23 续（v0.2.60 · 回复富输出：LaTeX / Mermaid / HTML 卡片，颜色随主题）**：①**能力**：聊天面板里的内联 HTML 从「一律转义成文本」变成「可选渲染」——`rehype-raw` 把模型写的标记解析成 hast，`rehype-sanitize` 用白名单丢掉没被许可的标签与属性，再由 `rehypeSafeStyles` 逐条过滤 `style`；```` ```mermaid ```` 围栏交给 `MermaidBlock`（动态 import，1MB 的 mermaid 只在真的出现图时才加载，源码稳定 320ms 才解析一次，避免流式时每来一个 token 就重排）。两个总开关在 设置 → 外观（渲染 HTML / Mermaid），默认开、可单独关。②**安全边界**：`className` 故意不进白名单——应用里每个 Tailwind 工具类都合法，一句 `class="fixed inset-0 z-50"` 就能把整个回复糊在窗口上；`position` / `z-index` / `top` / `left` / `float` / `transform` / `filter` / `animation` 从 `style` 里剔掉；`<script>`、`on*`、`javascript:` 由 schema 挡掉。③**颜色按当前主题重算**（`renderer/lib/themeColor.ts`）：模型不知道读者在哪个主题，`background:#fff;color:#fff` 这种写法在深色主题下会糊成一片、只有底色没有字。做法是保留色相与饱和度意图、把明度吸附到当前主题的明暗带（底色 96.5% / 17%，边框 88% / 31%），文字色只在当前主题里读不清时才整条丢弃、回落到主题自带的对比色；解析不了的值（`var(--x)`、未知关键字）和 alpha < 0.1 的淡淡阴影原样保留。④**Mermaid 换底**：从 mermaid 自带的 `dark` / `neutral` 换成 `theme: "base"` + 现读 `--surface` / `--content` / `--edge` / `--accent` 算 `themeVariables`（`background: transparent`，让外层的 `bg-surface-muted` 透上来）；SVG 缓存键从「是否暗色」改成 `dark|warm` 主题签名——四种调色板里两种共享 `.dark`，只用布尔值会让暖 / 中性切换后继续显示旧图。⑤**系统提示词**：新增 `RICH_OUTPUT_PROMPT`（「回复排版与可视化」一节），三个引擎同一份文本、同一位置（身份之后、工具引导之前，且排在用户自己的系统提示词之后，免得被「只说纯文本」顶掉）：公式用 LaTeX、结构用 Mermaid、指标 / 对比 / 折叠用 HTML 卡片，并写明「颜色只表达意图、客户端会按主题调明暗」「mermaid 不用自己指定颜色」，一条回复里可视化元素不超过 2~3 处。⑥**顺手修掉一个坑**：`rehypeSafeStyles` 一度写成「工厂调用后把返回值塞进插件数组」，而 unified 会把 `rehypePlugins` 里的每一项都当成 attacher **不带 tree** 调用，于是 `walk(undefined)`，整块回复直接进错误边界；现在改成 `[rehypeSafeStyles, { dark }]` 的选项形式，注释里写清了区别。⑦**验证**：typecheck（只剩 `useVoiceInput` 那条历史告警）、构建通过；`test:markdown-render-electron` 覆盖 KaTeX 三种写法（行内 / `$$` / 裸 `\begin{align}`）、mermaid、`<details>`、清洗器与两个开关，并新增浅深两套断言——白色底卡在浅色主题下丢掉白色文字色、在深色主题下变成深色内嵌 + 保留白字，同一张 mermaid 图的节点填充从 `rgb(250 249 245)` 变到 `rgb(38 38 36)`、SVG 背景保持透明；`test:rich-output-prompt-electron` 证明三引擎同文本同位置；`test:chat-display-electron` 通过。**发布（同日）**：`ca6b4c9`（中转站账户卡片改走 `/apikey/stats`）与 `3598328`（v0.2.60 富输出）两个提交加标签 `v0.2.60` 推送到 GitHub，Actions Release 成功（Windows exe + arm64 / Intel 两个 dmg，共 12 个资产）；CI 的 Typecheck 先红后绿——红的是 `useVoiceInput` 里那条旧错误：TS 5.7 把类型化数组对底层 buffer 泛型化后，`Float32Array<ArrayBufferLike>` 传不进 schema 推出的 `Float32Array<ArrayBuffer>`，重新装依赖让这条早潜着的错误浮了出来，`ebaa4d6` 把累加器 ref 标注成窄类型修掉（没有为此复制 buffer）。本地 `MarioCode-0.2.60-x64.exe` 219,229,191 字节（约 209.1 MiB，比 v0.2.59 大约 28 MiB，主要来自新增的 mermaid / katex 及其依赖），复算 SHA512 与 `latest.yml` 一致；`release:upload` 先传 exe 与 blockmap、`latest.yml` 最后上传，公网复核 `http://39.109.58.6:3458/latest.yml` 为 v0.2.60、exe 可下载；`release:upload --site` 上线新下载页（动态演示 + 真实截图轮播那一版，含 `demo.js` / `demo.css`）；`release:upload --mac` 由服务器从 GitHub Release 拉两个 dmg（260.2 / 269.3 MB，各约 145 秒）并复核通过，`latest-mac.yml` 同为 v0.2.60。**推送踩坑**：`git push mirror`（ghfast.top 代理）会无限挂住——GCM 对代理域名没有存凭据，弹的是要人点的凭据窗口，命令零输出、`git-remote-https` 一直挂着；改直连 `https://github.com/maxiaopang123/MarioCode.git` 用已存凭据即可秒过。

**10/23（中转站账户卡片「Key 无效」的根因：接口挑在只认 cookie 的那一层，网关补 balance 字段）**：①**现象**：v0.2.59 的「账户与用量」卡片，用户填上自己的中转站 Key 后直接是「读取失败：中转站 API Key 无效或已失效」。②**根因不是 Key，是鉴权层**：`/api/v1/me`、`/api/v1/me/usage` 挂在网关的 `UserAuth()` 下，而 `UserAuth` 只从 cookie 里取 `auth`（Web 控制台签发的 JWT，见 `internal/server/middleware/auth.go` 的 `sessionClaims`），**完全不看 Authorization 头**——用户 Key 无论多有效都是 401；客户端把 401 一律翻成「Key 无效」，于是一个「挑错了接口」被报成了「你的 Key 有问题」。这也顺带解开了 TODO-077 里两个悬着的疑点：不是字段名猜错，是请求根本没走到解析那一步。③**只有 `/api/v1/apikey/*` 和 `/v1/*` 认 Key**（`APIKeyAuth`：`x-api-key` 或 `Authorization: Bearer`，按哈希查表，再校验 enabled / 到期 / 用户状态 / 余额）。④**网关改动**（`/opt/octopus-src` 是自家 fork）：`GET /api/v1/apikey/stats` 增加 `balance` 字段——`info.UserID > 0` 时读 `user.Balance`，管理员自用 Key（user_id=0）恒为 0；共 8 行、纯加字段、不动鉴权，所以老客户端不受影响。`go build` 后 `systemctl stop/start octopus`，中断约 2 秒，旧二进制留底 `octopus.pre-balance`；重编之前先确认过**没有任何 .go 比现有二进制更新**，不会把别的未完成改动顺带编进去。⑤**客户端改成一次调用**：`GET /api/v1/apikey/stats` → `data.balance` 出余额、`data.stats` 出用量（`billed_nano` / `input_token` / `output_token` / `cached_token` / `request_success + request_failed`）。同时删掉 `/apikey/login` 探针和 `BUILTIN_RELAY_ACCOUNT_LOGIN_URL` / `PROFILE_URL` / `USAGE_URL` 三个常量：stats 自己就认 Key，不再需要「先验证再查」两跳。⑥**两个副产品**：余额和用量现在出自同一次响应、同一时刻，不会再出现「余额比旁边的消费还旧」；代价是用量失败不再单独降级（同一个请求没有第二个来源），失败就是明确报错，而不是半个卡片。⑦**验证**：`typecheck` 通过；`test:shared-providers` 227 项，其中新增一条回归断言「绝不调用 cookie-only 的 `/api/v1/me`」；`test:models` 50 项；网关实测 `data keys: balance,info,stats`、`balance: 0`（用管理员 Key 自测，Key 未回显、未进日志）。⑧**尚未完成**：真实用户 Key 的端到端点击（要发版后在客户端上确认）；货币标签仍然待定。

**10/22 续四（线上模型清单按网关的对外目录重建：23 → 22，纯配置推送，不发版）**：①**起因**：线上 `relay-config.json` 的 23 个模型里有 5 个是死链——`claude-opus-5`、`claude-sonnet-5`、`deepseek-v4-flash`、`gemini-3.7-flash-high`、`k3` 在网关里已经没有对应的路由组（`groups` 表里 id 4/13/21/22/25/27 是空的，组被删了），用户在卡片里选中它们只会拿到上游错误。②**第一次改错了，这是本轮最值得记的一条**：我先按 `channel_models ⋈ channels WHERE enabled = 1` 建清单，推出 33 个，被用户当场指出「模型不对」。原因是**看错了层**——Octopus 的路由是三层的：`groups(name, listed)` 是客户端请求的模型名、也是唯一对外公布的目录；`group_items → channel_grants(protocols 位掩码)` 记录这个名能走哪些协议；`channel_models → channels` 才是上游渠道能跑什么。`channel_models` 只是「某条渠道能跑某个上游名」，名字甚至和对外的不一样（`qwen3.8-max-0902` vs 组名 `qwen3.8-max`）。我推的 33 个里 15 个**根本没有 group**（`claude-opus-4-6-thinking`、`claude-sonnet-4-6`、`deepseek-v4-pro`、`gemini-3-flash`、`gemini-3.1-flash-lite`、`gemini-3.5-flash-lite`、`gemini-3.1-flash-image`、`qwen3.8-flash`、`qwen3.8-max-0902`、`gpt-6-luna`、`gpt-5.6-luna`、`gpt-5.6-terra`、`gpt-oss-120b-medium`、`gpt-image-2.5`、`gpt-image-1.5`）→ 请求进来没有路由，必失败；同时漏了 4 个真在架的（`qwen3.8-max`、`oc/deepseek-v4.1-flash-free`、`oc/glm-5.3-flash-free`、`oc/mimo-v2.6-flash-free`）。③**正确的真相源**：`groups WHERE listed = 1`，**22 个**（网关自己也是按这个字段对外列表的；22 个组全部 `listed=1`，`aliases` 全空）。④**顺带修掉一个更隐蔽的错：`interfaces` 一直是编的**。`channel_grants.protocols` 是位掩码（`2 = chat-completions`、`4 = responses`、`8 = anthropic`、`16/32/64 = 生图/改图/变体`，见 `/opt/octopus-src/internal/model/channel.go`），把每个组的 grants 按位或起来才是它真正支持的协议：`claude-opus-5-5` / `claude-sonnet-5-5` **只有 anthropic**（旧清单写着三条全开）；`kimi-k3`、`glm-5.3`、`glm-5.3-flash`、`deepseek-v4.1-flash`、`qwen3.8-max`、三个 `oc/*-free` **只有 chat-completions**；`gpt-5.6-sol`、`gpt-6-astra/sol/6.1-sol`、`gemini-3.8-flash-high` 是 **chat + responses**；`grok-4.6/4.7` 三条全开；`gpt-image-2` 及两个 flare/sunburst 只有**生图 + 改图**（48），`grok-imagine-image-*` 是 **responses + anthropic + 生图 + 改图**（60）。图片模型因此不再标 `reasoning`，`gemini-3.8-flash-high` 也去掉了此前错标的 `imageGeneration`（它只有 chat+responses，没有生图位）。**过度声明协议的后果不是丑，是运行时错误**——比如 Claude 引擎选到只开 chat 的 `glm-5.3` 会直接 400。⑤**怎么推的**：服务器本机 `curl -X POST 127.0.0.1:18505/admin/relay-config`，token 用 `awk` 从 `/opt/mariocode-relay/relay.env` 现读，**密钥不出服务器**；服务端自己盖 `updatedAt`，写入走 tmp + rename。⑥**留档与回滚**：`relay-config.backup-v0.2.59.json`（改动前的 23 个）、`relay-config.bad-v33.json`（那次错的 33 个，留作反面样本），回滚就是 `cp` 回去再重推一次。⑦**验证**：公网 `GET /relay-config.json` 返回 22 个模型、`updatedAt 2026-10-22T15:59:28.177Z`、响应头 `cache-control: no-cache`（客户端下一次轮询就换，**线上清单不需要发版**）；`typecheck` 通过、`test:shared-providers` 224 项、`test:models` 50 项；`test:shared-providers-electron` 用真实密码连真实服务器跑通（解锁、管理面板行数 = 线上模型数、批量开关、行序调整）。⑧**连带改动**：`packages/contracts/src/builtinRelay.ts` 的 `BUILTIN_RELAY_FALLBACK_CONFIG` 同步成同一份 22 个（注释里写明「真相源是 `groups.listed`，不是 `channel_models`」，避免下次又按渠道表重建），这半边要等下个版本才进安装包；下载页文案 `23 个模型` → `22 个模型`（`site/app.js` 六处 + `index.html` 两处 i18n 兜底），**但线上页面还没重传**——`www/` 里压着未上线「三分钟上手」截图轮播，`--site` 会把它们一起推出去，等轮播那版验收后一并发布。⑨**未验证**：全部按网关目录与协议位判断，没有用真实 Key 逐个跑一次推理；「组存在但上游 Key 已失效」这类问题这次查不出来，见 TODO-078。

**10/22 续三（v0.2.59 · TODO-077 中转站账户与用量卡片）**：设置 → 模型配置 → 公用模型提供商 的中转站卡片，在「你的密钥」下面多了一块「账户与用量」：余额、累计消费、Token 用量（附「请求 N 次」），右上角有更新时间和刷新按钮。①**范围被收窄过一次，这是重点**：最初的诉求是「显示中转站回传的用户量、余额」，但平台总用户量属于后台数据，要读它就得在客户端里放管理员凭据——那等于把后台打进安装包（和 v0.2.58 ⑤ 同一条红线）。改成「用户填自己的 Key，只看这个 Key 的数据」之后，凭据就是用户自己的 Key 本身，越权问题自动消失。②**走哪个进程**：余额在 `:8090` 网关（Octopus）的库里，`:18505` 配置服务只有一个 JSON 文件，所以这一块打的是网关，不是配置服务。③**一个不显眼但决定实现的细节**：网关有 Origin 白名单中间件——实测 `Origin: null` 回 403 空 body，无 Origin 回 401，本站 origin 回 401。`engineFetch` 在代理环境下会切到 Chromium 的网络栈，而 Chromium 一定带 `Origin: null`，所以这条路必然 403，且响应体是空的，从现象反推原因极难。故这块读写一律用 Node 原生 `fetch`（它不发 Origin）。④**单位**：网关的金额是 nano 整数（`1e9 = 1`），字段带 `_nano`；界面只显示裸数字不印货币符号——计价单位没确认前写「元」是替服务器做假设。⑤**解析容错**：`balance` / `balance_nano` 都认，`/me/usage` 返回数组或单对象都认，用量接口失败不拖累余额（那几项显示「—」而不是整块报错）。⑥**换 Key 不能看到旧钱**：主进程有 60 秒快照缓存，如果只按时间失效，换了 Key 会先显示上一个 Key 的余额——缓存条目因此带 Key 的 SHA-256 指纹，指纹不同就不复用；保存新 Key 之后还会带 `force` 绕一次缓存。指纹放在 store 内部而不用「让 `sharedProviderStore` 通知清缓存」，是为了不引入 `relayAccountStore → sharedProviderStore` 的反向依赖。验证：`pnpm -w typecheck` 通过；`test:shared-providers` 224 项（新增 12 项覆盖信封拆解、多行求和、Bearer 头、只打网关、快照复用与 `force` 绕过、换 Key 不复用、无 Key 拒绝、401 报「Key 无效或已失效」、用量失败仍出余额、无信封响应）；`test:models` 50 项。**待办**：真实 Key 实测 `/api/v1/me` 的真实字段名（假 Key 在任何候选头下都只回同一个 `401 Authentication failed`，探测区分不了），以及货币标签。**发布（同日）**：提交 `13bbf5b`、标签 `v0.2.59` 推送到 GitHub；Actions Release 成功（Windows exe + arm64 / Intel 两个 dmg）；本地 `MarioCode-0.2.59-x64.exe`（190,938,960 字节，约 182.1 MiB）复算 SHA512 与 `latest.yml` 逐字节一致；`release:upload` 传完 Windows 包与 blockmap、`latest.yml` 最后上传，公网复核 `http://39.109.58.6:3458/latest.yml` 为 v0.2.59、exe 可下载；`release:upload --mac` 由服务器从 GitHub Release 拉取两个 dmg（226.9 / 235.9 MB）并复核通过；下载页版本号是前端现读 `latest.yml` / `latest-mac.yml`，站点文件未改动故未重传。

**10/22 续二（v0.2.58 · 中转站服务端上线 + 管理员密码门）**：①**先更正上一版的一条错记**：`8090` 上跑的是 `octopus.service`（Octopus LLM Gateway，gin + Go），不是 New API；之前把 `/` 的 HTML 当成「New API 的 SPA 壳」是误判。②**配置接口拆到独立服务**：新建 `apps/desktop/scripts/relay-server/`（约 300 行 Node，零依赖），跑在 `:18505`，只做一件事——读写一个 `relay-config.json`。推理仍在 `:8090`。不把路由塞进 Octopus 的理由是：那要改第三方 Go 源码、重编译、重启所有用户 API Key 流经的进程；而这个进程只持有一个 JSON 文件，没有 DB 句柄、没有上游凭据，最坏结果是模型列表被涂改。合约因此拆出 `BUILTIN_RELAY_CONFIG_BASE_URL`（`:18505`）与 `BUILTIN_RELAY_BASE_URL`（`:8090`）。③**端口 18505**：服务器 `ufw` 是白名单默认拒绝，**和云厂商安全组是两套规则**——只按安全组放行 1024-65535 去绑 8091，服务会正常启动、本机 curl 也通，但所有客户端超时。18505 原本就在 ufw 放行列表里且空闲，所以没动防火墙。④**管理员密码门（本轮重点）**：面板依然对所有人可见（每个安装包都挂着它），但密码被服务器确认前**只渲染一张解锁卡**——0 行模型、没有推送按钮。密码就是服务器 `relay.env` 的 `RELAY_ADMIN_TOKEN`。解锁是 `builtinRelay.unlock` → `GET /admin/verify` 的一次真实往返：200 才把密码写进 safeStorage，401 一个字节都不存。**刻意没有本地比对**——客户端能拿来比的只有用户自己敲进去的那串，正确答案必须在服务器上，否则就等于把密码打进安装包。⑤**解锁顺带解决了一个老问题**：以前是「先粘令牌，推送时才发现 401」，现在解锁失败当场分三种报：密码不正确 / 尝试过多 / 连不上服务器。IPC 更名为 `builtinRelay.unlock` / `builtinRelay.lock`，标题栏多了「退出」；推送遇 401 会清掉本地密码并重读状态，面板自动回到锁屏，而不是留一个永远推不动的编辑器。⑥**服务端安全**：`validateConfig` 独立实现不复用客户端 schema，根级只允许 `version/updatedAt/name/models`，出现 `baseUrl` 直接 400；密码比较 `timingSafeEqual` 且两边先 SHA-256 成定长（不等长会让它抛异常，本身就是时序泄漏）；同 IP 8 次失败锁 60 秒；写入 tmp + rename；鉴权失败统一同一个 401。⑦**踩坑记录**：systemd 的 `MemoryDenyWriteExecute=true` 会让 V8 的 JIT 在启动时 `SIGTRAP` 崩溃，日志只有 `code=dumped, status=5/TRAP`，完全看不出是沙箱选项——已从 unit 去掉并在注释里写明原因。⑧**线上已验证**：`GET http://39.109.58.6:18505/relay-config.json` 返回合法文档（23 个模型、4 个出图），客户端 `RelayConfigSchema` 校验通过；不带密码访问 `/admin/verify` 返回 401，带错误密码连续 9 次后返回 429。验证：`pnpm -w typecheck` 通过；`test:shared-providers` 212 项（新增锁屏禁推、错密码不落盘、服务器不可达不落盘、服务器认可后解锁四项）；`test:models` 50 项；`test:shared-providers-electron` 全绿，且确认解锁用的是**真实密码连真实服务器**，不是本地假通过。**运维备忘**：改密码 = 改 `/opt/mariocode-relay/relay.env` 的 `RELAY_ADMIN_TOKEN` + `systemctl restart mariocode-relay`，客户端**不需要发版**；部署与加固细节见 `apps/desktop/scripts/relay-server/README.md`。

**10/22 续（v0.2.57 · 中转站管理端补完：出图同步、批量开关、顺序可调）**：①**地址**按用户要求改为 `http://39.109.58.6:8090`，仍是裸 origin——`bridgeServer` 的三个 URL 构造器自己补 `/v1/chat/completions`、`/v1/messages`、`/v1/responses`，常量里带 `/v1` 只会重复一段。②**兜底模型清单**从原型占位换成用户本机已装实例里的真实 23 个模型（claude-opus-5 / claude-opus-5-5 / claude-sonnet-5 / deepseek-v4 pro·flash·4.1 / gemini-3.1-flash-image·3.7·3.8 / glm-5.3 两档 / gpt-5.6 三档 / gpt-6 三档 / gpt-image-2 两档 / kimi-k3 / qwen3.8-flash），每个都带 `interfaces`、`reasoning`、`input`，出图模型带 `imageGeneration`。③**出图标记同步**：`imageGeneration` 现在走完整链路（远程配置 → 缓存 → 管理面板开关 → 用户侧只读卡片上的魔杖图标），此前只在合约里有字段、界面上看不到也改不了。④**批量设置**：管理面板每行加复选框，工具条有全选 / 已选计数与六种批量动作（开启·关闭 思考、开启·关闭 读图、开启·关闭 生图），只作用于选中的行，未选中时按钮禁用。⑤**顺序可调**：每行加上移 / 下移，交换时保持多选状态；数组顺序即用户侧展示顺序，推送后远程配置的顺序直接决定列表排序。⑥**管理令牌可生成**：面板内「生成」按钮用 `crypto.getRandomValues` 出 48 位十六进制串并自动显示，省去管理员自己想密码——**没有也永远不会有内置默认密码**，令牌由管理员定、本地 safeStorage 加密保存，服务器端必须配成同一个 `RELAY_ADMIN_TOKEN`，否则推送 401。⑦**测试**：`test-shared-providers-electron` 的管理面板段新增断言——行数等于已发布模型数、全选后「批量开启生图」使每行出图标签都按下、「批量关闭思考」使其全部关闭、下移首两行后 id 顺序互换；顺带把该脚本两处脆弱点改成状态驱动（按目标状态点击引擎、等面板挂载而不是固定延时、展开分组再点标签），并在临时 profile 里种托管 Claude 运行时，使 wire 轮次在本机可复现。验证：`pnpm -w typecheck` 通过；`test:shared-providers` 208 项、`test:models` 50 项、`test:shared-providers-electron` 全绿。**未验证 / 待做**：服务器端接口仍未实现；`http://39.109.58.6:8090/relay-config.json` 目前返回 New API 的 HTML 壳（200 + `text/html`），客户端按设计静默回退内置清单，需要真的 JSON 与 `POST /admin/relay-config`；未在真机上点过批量开关后的下拉与推送结果。**发布（同日）**：提交 `a039f7b`、标签 `v0.2.57` 已推送到 GitHub；Actions Release 三条构建全部成功，Release 页已有 Window exe、arm64 / Intel 两个 dmg 与 zip、blockmap 和 `latest.yml` / `latest-mac.yml`。本地 Windows 安装包 `apps/desktop/release/MarioCode-0.2.57-x64.exe`（190,935,754 字节，约 182.1 MiB）已生成，本地复算 SHA512 与 `latest.yml` 一致，`app-update.yml` 指向 `http://39.109.58.6:3458/`；`release:upload --dry-run` 校验通过（计划：exe → blockmap → latest.yml 最后）。**自建更新服务器 / 下载页同日更新完成**：用 `ssh-亿联云` 技能里的 root 密码（服务器只开密码登录，`PubkeyAuthentication no`；`publish.mjs` 走 ssh2、不校验 known_hosts，所以 known_hosts 里那条过期指纹不影响上传）依次跑了三条命令：①`release:upload` 上传 Windows 包 + blockmap，`latest.yml` 最后上传，公网校验 `http://39.109.58.6:3458/latest.yml` 为 v0.2.57、安装包 182.1 MB 可下载；②`release:upload --mac` 由服务器从 GitHub Release 拉取 arm64 / Intel 两个 dmg（226.8 / 235.9 MB）与 `latest-mac.yml`，公网复核通过；③`release:upload --site` 重传下载首页（`index.html`、`site/app.js`、`site/style.css`、`site/logo.png`）。下载页的版本号与文件大小是前端从 `latest.yml` / `latest-mac.yml` 现读的（`app.js` 里没有写死版本），所以清单更新即页面更新；`index.html` 与 `site/app.js` 的线上 SHA-256 与本地逐字节一致，三个安装包直链返回 206 + `application/octet-stream`。中转站域名 `http://39.109.58.6:8090` 探活：`/` 是 New API 控制台（200 text/html），`/v1/models` 无 Key 返回 401（正常），`/relay-config.json` 仍是 404——服务器端接口尚未部署，客户端继续用内置清单兜底。

**10/22 新功能（v0.2.56 · TODO-074 内置「MarioCode 中转站」公共提供商 + 管理端推送）**：公共提供商列表最上方固定一条内置条目，地址、三条协议、三个引擎与模型清单全部预填，用户唯一要做的是填自己的 Key。①**安全边界**：`packages/contracts/src/builtinRelay.ts` 固化 `BUILTIN_RELAY_ID` 与 `BUILTIN_RELAY_BASE_URL`，远程配置 `RelayConfigSchema` 是 `.strict()` 且完全不设地址字段——配置文件里出现 `baseUrl` 直接校验失败；主进程 `sharedProviderStore` 对保留 id 再拒一次「地址 / 模型发现地址 / 端点覆盖被修改」，两层都堵死才可能重定向 Key。②**拉取**：`main/lib/relayConfigStore.ts` 启动时在 db 就绪后后台 GET，15s 超时、2MiB 上限、失败静默，成功才写缓存 `builtinRelay.config`，所以离线时用打包兜底清单（`BUILTIN_RELAY_FALLBACK_CONFIG`）；设置页有「刷新列表」。③**存储**：内置条目不入 `sharedProviders.meta`，只在 `sharedProviders.keys` 里按保留 id 存 Key，`listPublic()` 每次现拼，`hasApiKey` / `resolveApiKey` / `resolveRuntimeId` 与 Claude / Codex / Pi 三引擎目录因此自动收录，无需改引擎侧。④**界面**：`BuiltinRelaySection.tsx` 只允许编辑 Key（地址 disabled + 锁图标），协议 / 引擎 / 模型只读，「保存并测试」保存后跑一次模型发现当连通性检查；删除按钮不出现，IPC 层也拒删。⑤**管理端**：设置 → 系统 → 关于 → `RelayAdminPanel.tsx`，管理员 token 用 safeStorage 存 `builtinRelay.adminToken`（**不打进安装包**），可编辑模型表格、从线上拉取、推送前弹差异预览（新增 / 修改 / 删除条数与删除告警），确认后 `POST /admin/relay-config` 覆盖写、不保留历史。⑥**顺带修掉两处既有测试缺陷**（TODO-069 ①）：`test-shared-providers-electron` 第 145 行「协议编辑须保留引擎选择」——`fresh()` 现在默认三引擎全开（TODO-062），测试仍盲目点一下 Codex 反而把它关掉，改为按目标状态点击；同一测试后来的 wire 轮次在本机必然失败，因为打包态 Claude 只从 `<userData>/runtimes/claude/<version>` 找二进制（Codex 有 pnpm 兜底、Claude 没有），改为测试在临时 profile 里用检出里的平台包种一份托管运行时。验证：类型检查通过；`test:shared-providers` 208 项、`test:models` 50 项、`test:shared-providers-electron` 全绿（含三协议 × 三引擎 9 条真实 wire 轮次与内置条目的只读断言）。**未验证 / 待补输入**：服务器端接口未实现（需 `GET /relay-config.json` 与 `POST /admin/relay-config`）；域名暂用代码常量 `https://ai.marioya.cc.cd` 未经用户确认；首版模型清单是原型里的占位（claude-sonnet-5-5 / claude-opus-5-5 / gpt-5-codex / deepseek-v4-pro）；管理员 token 未提供；未打包、未发布。

**10/21 更新（v0.2.54 · AI 生成新图标、Agent 浏览器不再置顶、联网搜索改为 API 优先）**：①**应用图标**换为用户用生图工具做的新图（`build/icon-ai-source.webp`）；`build/gen_icon.py` 改为处理这张图（去黑底、轻微腐蚀与羽化，输出 `icon-source.png`、`icon.png`、`icon.ico`（多尺寸）、`icon.icns`、`brand-logo.png`、`favicon.png`），下载页 logo 改用 `site/logo.png`（128 像素），删除 `site/logo.svg`。②**Agent 浏览器置顶问题**（其他用户反馈 v0.2.53 读取页面时仍有窗口压在工作区上）：根因是 `BrowserManager.click()` / `clickAt()` 在视图不可见时调用 `show()`，把宿主窗口里的 Agent 视图搬进主窗口右侧 42%，且要等回合结束才还原；改为宿主视图（`hostable`）点击时不再 `show()`。同时堵住两条旁路：Agent 页面 `window.open`（搜索站点结果常用 `target=_blank`）原先会生成一个用户标签并通知渲染端上屏，现在改为在宿主窗口里再开一个 Agent 视图、不发 `tabOpened`；Agent 页面的 `window.open` / 导航到非 http(s)/file 协议（如 `mailto:`、应用协议）一律拦截，不再交给系统打开其他程序。用户自己的标签行为不变。`test:agent-browser` 新增断言：点击与坐标点击后视图仍在宿主窗口且主窗口子视图数不变；弹窗开成 Agent 视图；输入 + 回车 + 读取全程不上屏；应用协议被拦截且用户标签对照仍交给系统。每条修复都经「还原修复 → 测试失败」验证确实必要。③**联网搜索（TODO-058 的一部分）**：`mario_web_search` 默认只走搜索 API（用户在设置里填的 Key）；API 没配或都失败时工具不再静默改用浏览器，而是告诉模型必须先在对话里问用户「是否接受浏览器读取搜索引擎结果页」，同意后才带 `browser=true` 重新调用（三个引擎的参数 schema 都加了 `browser`）；无人值守的运行（定时任务、微信）忽略该参数、不能用浏览器搜索。提示词 `WEB_TOOLS_FLOW` 重写：先用模型自带的搜索，不存在 / 报错 / 无结果再用 Mario 的，不要两套都搜；同一问题换词最多再试一次；不用浏览器工具代替搜索。设置页「测试搜索」对必应 / 百度按浏览器路径测试，对 API 不做浏览器兜底，缺 Key 时直接提示「还没有保存 Key」。Exa 仍需 Key（未采用免 Key 方案）。④**测试**：类型检查通过；`test:web-tools` 全部通过（新增：无 Key 且无 `browser` 时不搜索并提示先问用户；坏博查 Key 无 `browser` 时报错并提示先问用户、带 `browser:true` 时回退必应并注明）；`test:agent-browser` 通过；`test-builtin-tools-electron` 通过（顺带修了其中过期的 MCP 内置行期望，补上 schedule / wechat 两行）；`shared-provider-smoke/stub-db.ts` 补 `SessionRepo`、`ScheduledTaskRepo` 桩以便构建。**未验证**：未构建、未打包、未发布（版本号已提升为 0.2.54，只提交）；macOS 上宿主窗口（x -12000）是否真的不可见；其他用户环境下的真实站点复现；回车前需 400ms 间隔的焦点竞态（宿主窗口不可聚焦，原因未深查）；三引擎里模型是否真的遵守「先问用户再带 browser=true」；新图标在 16 像素与金拱门联想的问题（见 TODO-073 ⑤）未重新评估。

**10/21 更新（v0.2.53 · 应用图标换为流线 M + 赤陶不规则圆底）**：用户要求「更新一个 icon」，前后看了九轮方案（`prototypes/icon-options*.html` 共 9 个文件，留档备查），最终选定第九轮的「赤陶」：细线流线 M（一笔、两拱一谷、线宽 52）、深赤陶不规则圆底（左右不对称、每个连接处光滑）、顶部微光、奶油白线条、浅橙圆点。`build/gen_icon.py` 整体重写：一个设计通用，输出 `icon-source.png`、`icon.png`（1024）、`icon.ico`（16 到 256 共 7 个尺寸）、`icon.icns`、应用内 `brand-logo.png`（512）、`favicon.png`（64）；圆底之外完全透明。应用内 logo 不再分深浅两版，`BrandLogo.tsx` 改为单张图，并删除不再引用的 `brand-logo-light.png`、`icon-source-light.png`、`icon-dark.svg`、`icon-light.svg`（git 历史可恢复）。验证：类型检查通过；`icon.ico` 的七个尺寸齐全，`icon.png` 圆外透明；16 到 96 像素的小尺寸对照图已看；开发版启动无渲染报错。**未验证**：打包后任务栏、安装包、Dock 里的实际显示；我没有亲眼看过开发窗口里的 logo。已知问题：这个造型与麦当劳金拱门接近（见 TODO-073 ⑤），用户在被提醒后仍选了该配色；16 像素下浅橙圆点基本不可见。下载页 `logo.svg` 未改。

**10/21 更新（v0.2.52 · TODO-044 配色基准改为 Claude Desktop + 技能 / 定时任务整页 + 模型品牌图标）**：用户要求「按照 Claude Desktop 的配色为基准」并「把 V4 做完」，随后「定为新版本」。本版本与此前未提交的 v0.2.51（TODO-063 插件页，见下条）及 TODO-064 第一批运行时加固（`runtimeInstaller` / `runtimeMutation` / `managedRuntimeRoots` 等）在工作区已交织、无法干净拆分，一并提交；这两批的验证记录见各自条目，本次提交前只重新跑了下面列出的项。未打包、未推送。①**配色**：先写 [design.md](design.md)，再落地。默认基调改为暖纸（`themeTone` 初值、渲染进程首帧守卫 `lib/theme.ts`、主进程 `getThemeTonePreference` 三处同时改，否则启动首帧会闪一下中性色；只有显式存过 `neutral` 的用户保持中性），默认强调色改为 Clay：`styles.css` 亮 / 暗两块的 `--accent` / `--accent-strong` / `--primary` / `--on-primary`，亮色主按钮为暖石墨、暗色为 Clay。Clay 上白字只有约 3.3:1，所以 `bg-accent text-white` 的三处（发送按钮、未读徽标、元素拾取条）改为 `bg-primary text-primary-on`。设置 → 外观的强调色预设新增 Clay 并置于首位，mint 保留为可选。原型 `ui-refresh-v4.html` 同步改为默认暖纸 + Clay。②**独立整页**：新增 `components/layout/ToolPage.tsx`，侧栏「技能与 MCP」「定时任务」不再弹设置浮窗，改为占满主区的整页，直接复用 `SkillsPanel` / `McpPanel` / `ScheduledTasksPanel`（未改面板逻辑），技能与 MCP 在页头用标签切换；store 新增 `toolPage` 与 `setToolPage`，和 `canvasOpen` / `settingsOpen` 互斥，切换会话由 App 根订阅统一关闭，`BrowserPanel` 的三处让位判断同步加上 `toolPage`，否则原生浏览器视图会盖住整页。面板自带的标题行由 `.tool-page` 样式隐藏以免与外壳标题重复，没有动作按钮的面板整条头部隐藏。设置页里原有的技能 / MCP / 定时任务分区保留。③**模型品牌图标**：输入框模型按钮原来写死芯片图标，现按模型 id 显示品牌图标——`ModelAvatar.tsx` 新增 `ModelBrandIcon`，`ModelDropdown.tsx` 新增 `chipModelId`，只看模型 id 不看端点或引擎，没选模型时跟随强调色提示；`modelFamily` 新增 grok / doubao / ernie，GLM 无图标仍为芯片。验证：类型检查、完整构建；新增真实 Electron 冒烟 `pnpm test:toolpage-electron`（打开、技能 / MCP 标签切换、与画布互斥、再点与 Esc 关闭）通过；`test:canvas-electron`、`test:settings-navigation-electron`（26 屏）、`test:workspace-walkthrough-electron` 通过；`scripts/model-anchor-smoke/run.sh`（package.json 里没有对应脚本，直接运行）50/50，含新增的 Grok / 豆包 / 文心 / GLM 断言；深色截图已看。**未验证**：浅色模式与窄窗口下的工具整页；配色色值是推定值，未用 Claude Desktop 取色校准；模型图标只确认类型检查与热更新无报错，未逐个模型肉眼核对。遗留见 TODO-072（长尾界面）、TODO-073（校准与图标收尾）、TODO-042（「聊天」卡片前置）。同时发现开发版日志里有两条与本轮无关的提示：手机遥控端口 7331 被占用（多半是正式版在运行）、开发版 Claude 引擎未登录。

**10/20 新功能（v0.2.51 · TODO-063 设置新增「插件」页，管理 CLI 已安装插件）**：v0.2.42 删除应用内插件管理器后，Claude CLI 仍按 `~/.mariocode/settings.json` 的 `enabledPlugins` 每轮加载插件，界面里没有入口可关（TODO-059 ③：本机 `text-to-cad` 的 12 个技能与 `cad` MCP 每次请求都带上）。用户要求「把插件加回来」，范围选定为「轻量：管理已装插件」。没有复原旧的 4114 行安装器，原因是目录冲突：旧管理器用 `plugins/<name>/<version>/` 与 `.mcode-install.json`，而 `CLAUDE_CONFIG_DIR` 已重定向到 `~/.mariocode`，CLI 把 `plugins/` 当作自己的 `cache/`、`marketplaces/`、`installed_plugins.json`，两套会互相读写。新实现只读 CLI 的状态：`main/plugins/pluginState.ts` 读取安装记录、各插件 `.claude-plugin/plugin.json` 与 `skills/`、`commands/`、`agents/`、MCP 配置，输出版本、作者、组件明细；唯一写操作是改 `enabledPlugins[id]`，保留 settings.json 其余键，同目录临时文件 + rename，无法解析的 settings.json 拒绝覆盖。安全边界：安装记录的路径只在 `~/.mariocode/plugins` 内才会被跟随，manifest 里越界的相对路径被忽略。接线：`packages/contracts/src/plugin.ts`（zod 校验 `name@marketplace`）、IPC `plugins.list` / `plugins.setEnabled`、preload `api.plugins`；手机端走 `webApi` 代理兜底。界面：设置 → AI 能力 → 插件（MCP 之后），`PluginsPanel.tsx` 每行含名称 / 版本 / 市场、描述、组件数量、可展开明细与启用开关，开关乐观更新、失败回滚；文案提醒改动下一轮生效、仅 Claude 引擎、已启用插件的定义会随每次请求发送。验证：contracts 构建与 `tsc --noEmit` 通过（同时校验中英文案键集一致）；新增 `pnpm test:plugins-state` 21 项离线冒烟全绿；对本机真实 `~/.mariocode` 只读运行，读出 `text-to-cad@earthtojake` v0.7.15、12 个技能、MCP `cad`、已启用，与 TODO-059 记录吻合。未验证：没有在真实应用里点开关并发起对话确认技能列表消失；未新增 Electron 界面测试（设置导航类测试在 master 上已失败，见 v0.2.50）。遗留：安装 / 更新 / 市场仍只能用 CLI（TODO-037 保留）；Hooks 只显示不管理；Codex 与 Pi 不使用 Claude 插件。同时从想法表删除已被 TODO-057 否决的「本地运行时探测补充」。未打包、未提交、未推送。

**10/20 新功能（v0.2.50 · TODO-057 引擎一律用最新版托管运行时，移除本机检测/本地安装模式）**：用户要求「去掉用户设备检测的功能，一律要更新最新版」，并在方案选择中确定：AUTO 自动更新到最新版、一并移除「本机安装」模式、设置面板保留本机安装检测但仅作信息展示。①`RuntimeMode` 收窄为 `auto | managed`（删去 `external`），`RuntimeAgentSource` 删去 `external`/`local`；`parseMode` 把历史存储的 `external` 降级读作 `auto`，旧选择永不报错、由托管副本接管。②三个引擎的 AUTO 解析链统一为：托管副本（`<userData>/runtimes/<agent>/<version>/`）→ 开发 node_modules / 打包内置兜底，彻底删掉 `autoLocalRuntimeSync`、`autoLocalPiPackage`、`resolveExternalRuntimeSync` 等本地安装探测与绑定逻辑；`installRuntime(agent, version?)` 支持显式目标版本。③新增后台自动更新：`listRuntimes()` 里 `triggerAutoUpdate`——仅当 AUTO 模式、托管副本存在、已装版本落后于最新版、且不在安装中时，每个进程每个引擎只触发一次，`installRuntime(agent, latest)` 后台静默执行，失败只记日志，下次最新版查询（10 分钟 TTL）自动重试；`finalizeInstall` 的原子改名 + backup 回滚保证失败不会动正在工作的副本。④设置面板：`runtimes.select` 契约只剩 `{agent, mode: "auto"|"managed"}`，`RuntimeSourceControls` 重写为 AUTO / 指定版本两个按钮 + 第三个「检测到本机安装」信息块（不可点击，仅展示探测结果，最低版本门槛只影响显示什么）；删除 path / nodePath 输入、验证绑定、所有权提示等全部本地安装 UI，i18n 中英同步精简。`discoverExternalRuntimes` / `probeCandidate` / `validateExternalSelection` 等保留仅供面板信息展示。验证：contracts 构建与桌面 `tsc --noEmit` 通过；`test:runtime-selection` 29 项全绿（含 legacy external 降级、模式往返、托管删除不碰用户程序等新增断言）；`test:shared-providers` 187 项、`test:pi-host`、`test:models` 45/45 通过。既有失败（与本次无关，已在 stash 后的 master 上复现）：`test-runtime-electron`（设置导航 UI 改版）、`test-legacy-providers-electron`（customModel.list 形状）、`test-shared-providers-electron`（协议编辑断言）。遗留：离线时自动更新静默跳过；外部二进制不再被探测绑定。未打包（待用户验收后打包）、未提交、未推送。

**10/20 架构（v0.2.49 · TODO-062 引擎只使用公共提供商）**：用户要求「三个 agent 都要用公共提供商，本地的不用，两套系统分开」，并在方案选择中确定「从引擎中完全移除」。此前共享 Provider 只在 UI 层是「默认」，运行时并没有强制：Claude 的 `customModels` 与共享投影一起由 `listPublic()` 返回，Pi 每轮把 `~/.pi/agent/models.json` 与共享项合并后交给 host，Codex 把 `codexProviders` 一并写进 `~/.mariocode/codex/config.toml`，再与共享项并列。现在把「引擎能看到什么」和「迁移面板能看到什么」拆成两个入口：三个 store 新增 `listShared()`，只返回共享 Provider 投影；`listPublic()` 保留「全部」语义，仅供「模型 → 旧配置」迁移面板使用。引擎侧所有读取点改走 `listShared()`——Claude `CUSTOM_MODEL_LIST` / 移动端 `customModel:list`，Pi `listAvailablePiModels` 与 `loadHostConfiguration`（host 每轮只收到共享 Provider 与内存密钥），Codex `CODEX_MODELS_LIST` / `startTurn` / `buildCodexEnv` / `materializeConfigToml`（旧 Provider 不再进入 config.toml）。会话若仍固定在旧本地配置，不再静默回退到内置端点或第一个共享模型：Claude 发 `CLAUDE_LEGACY_MODEL_DISABLED`、Pi 发 `PI_LEGACY_MODEL_DISABLED`、Codex 发 `CODEX_LEGACY_MODEL_DISABLED` 并直接结束本轮，文案统一引导用户去「设置 → 模型」复制为公共提供商；提交信息 / 会话标题等 Claude 辅助调用同样拒绝旧配置。旧文件、旧设置、旧密钥全部原样保留，迁移面板照常可读可复制；新建设共享 Provider 时 `enabledAgents` 默认勾选三个引擎。验证：`tsc --noEmit` 通过；`test:shared-providers` 187 项全绿，其中新增 8 项——植入旧 Claude 配置与旧 Codex Provider 后，`listShared()` 均不返回、`listPublic()` 仍返回，Pi 的引擎列表只由 `shared_` 项构成；`test:legacy-providers-electron`、`test:pi-host`、`test:runtime-selection` 通过。遗留：已有共享 Provider 中 cline / kimi / 8yes 未勾选 Codex，需用户在面板补勾（不改用户数据）；旧 Pi / Codex 文件暂无「一键删除」；固定旧配置的历史会话现在会在发送时明确报错。已打包 `apps/desktop/release/MarioCode-0.2.49-x64.exe`（190,487,006 字节，约 181.7 MiB），核对包内 `app.asar`：`version` 为 0.2.49，主进程包含 `listShared` 与三处 `*_LEGACY_MODEL_DISABLED` 错误码。未安装、未提交、未推送。

**10/20 修复（v0.2.48 · TODO-061 第三方网关 `400 developer is not one of [...]`）**：用户截图反馈频繁出现 `⚠ 400: {"message":"upstream returned 400: developer is not one of ['system', 'assistant', 'user', 'tool', 'function']","type":"upstream_error"}`。定位过程先排除了 Claude 引擎：本机 `claude.exe` 里根本没有 `developer` 角色字符串，桥接层 `requestTranslator.ts` 只会产出 system / user / assistant / tool，日志、调试目录与会话 JSONL 里也搜不到该角色；Codex 的桥接转换会把 developer 合并进 system，且本机没有 codex 会话。真正来源是 Pi：`pi-ai` 的 `openai-completions` / `openai-responses` 适配器在模型是 reasoning 时，会把系统提示词提升为 OpenAI 的 `developer` 角色，开关是 `model.compat.supportsDeveloperRole`，而该值由 `detectCompat` 依据 base URL 推断——不认识的第三方地址一律按标准 OpenAI 处理，即默认开启。MarioCode 的共享 Provider 全是第三方网关，后面接的通常是 vLLM / DeepSeek / Kimi 上游，角色词表止于 `system`，所以每个请求都 400。修复放在注册入口 `normalizePiRegisteredModel`（共享 Provider 进 Pi 的唯一的模型规范化函数，`piModelsStore.listPublic` 与 `piHost.createRuntime` 都走它）：统一写入 `compat: { supportsDeveloperRole: false, ...model.compat }`，显式 compat 仍可覆盖。验证：`tsc --noEmit` 通过；`test:pi-host` 把三条 wire 模型（chat-completions、anthropic-messages、openai-responses）都标为 `reasoning: true` 跑真实回合，断言请求体不含 `"developer"`、首条消息角色为 `system`，全项通过；反向验证把打包后的 host 临时改回 `supportsDeveloperRole: true`，测试立刻失败并打印出真实载荷 `{"role":"developer","content":"You are an expert coding assistant..."}`，确认断言有效。遗留：用户 `.pi/agent/models.json` 里的旧 Provider 不走此函数，需手工加 compat；Codex 在 `responses` 协议下直连 Provider 的路径尚未加同类约束。已打包 `apps/desktop/release/MarioCode-0.2.48-x64.exe`（190,487,168 字节，约 181.7 MiB），并核对包内 `app.asar`：`version` 为 0.2.48，主进程包与 `out/pi-host/piHost.mjs` 都含 `supportsDeveloperRole`。未安装、未提交、未推送。

**10/20 新功能（v0.2.47 · TODO-060 Mario Web 阅读器改为 HTTP 直读 + Chromium 降级）**：用户问「MarioCode 阅读器跟一般 Claude Code Agent 的 WebFetch 相比是否必要，为什么它不弹浏览器」，讨论后确认方向并实现为阅读器的主线特性。原来的做法是每条 `mario_web_fetch` 都开一个隐藏 Chromium 窗口渲染 0.6–2 秒：JS 站点能读，但静态页面也被当成 JS 应用，代价是一个渲染进程、一段不可预期的等待，以及一个必须永远不出现的原生窗口（v0.2.46 才把它的位置与焦点钉死）。现在先纯 HTTP 抓一次：新增 `apps/desktop/src/main/tools/httpPage.ts`（`readStaticPage`），用 `engineFetch` 走与引擎相同的代理路由，15 秒超时、6MB 上限、跟随跳转；解码顺序为响应头 charset → `<meta>` 嗅探（取前 4KB）→ UTF-8，gb2312 / gbk 一律按 gb18030 解，中文站点的乱码不会再出现；先剥掉 script / style / noscript / template / svg / iframe / nav / aside / footer / head 等站点外壳（最多 4 轮，处理嵌套与不闭合），再用一个手写分词器输出与 `MAIN_TEXT_JS` 同形的文本：`#` 标题、`- ` 列表、围栏代码块（保留缩进）、` | ` 表格单元格、`[文字](绝对链接)`、`---` 分隔线，`<main>` / `<article>` 正文占比达 30% / 25% 时优先取容器。只有三种情况降级回 Chromium：正文不足 1000 字且段落少于 3 个、响应不是 HTML、请求失败或超时；降级路径就是原来的 `withHiddenPage`，行为不变。顺带补了个安全洞：`mario_web_fetch` 是免审批工具，以前跳转到内网地址要等页面渲染完才拒绝，现在 `guard` 在读完响应头、读正文之前就检查落地 URL。结果头部显示「· HTTP 直读 / · Chromium 渲染」，日志记录耗时与降级原因，缓存条目带 `via`，便于事后解释一次慢读。验证：`tsc --noEmit` 通过；新增离线冒烟 `pnpm test:web-reader`（`scripts/web-reader-smoke/`，loopback 夹具、不依赖外网）——静态文章 4ms 读完且全程 0 个 BrowserWindow，JS 空壳降级到 Chromium 并读出脚本渲染的 3622 字，GB2312 页面正确解码出「中文编码测试」，PDF 与「跳转到被守卫拒绝的地址」都在读正文前抛出，短正文（约 450 字、5 个段落）不降级，降级后不残留窗口。未验证：本机无外网，真实中文站点的抽取质量与降级比例没有采样；`test:web-tools` 在 master 上因 `stub-db.ts` 缺 `SessionRepo` 导出无法编译（既有问题）。已打包 `apps/desktop/release/MarioCode-0.2.47-x64.exe`（190,486,417 字节，约 181.7 MiB），并核对包内 `app.asar`：`version` 为 0.2.47，主进程包里能找到 `readStaticPage`、`landedProblem` 与「HTTP 直读 / Chromium 渲染」文案。未安装、未提交、未推送。

**10/20 修复（v0.2.46 · TODO-051 截图把浏览器视图搬到主窗口上遮挡操作）**：用户反馈「截图时浏览器画面会在主窗口里弹出、压在最上层，导致其他地方没法操作」，并指出不只截图，`mario_web_fetch`（Mario Web 阅读器）时也会出现。排查：v0.2.41 的 `BrowserManager.screenshot()` 在视图隐藏或 1×1 时用 `defaultOnscreenBounds()` 把视图摆到主窗口右侧 42%、全高再截图，截完才还原——这段时间它是主窗口的原生子视图，盖住渲染层并吃掉点击，与用户描述完全一致；本机安装的正是 v0.2.41，隐形宿主窗口（v0.2.43）与截图超时兜底都没进这个包。修复：①`screenshot()` 不再把任何视图移进屏幕——需要渲染尺寸时只原地放大（隐藏视图放大到 1280×800 但仍停在 x/y -9999；宿主视图放大到宿主原点），100ms 后截图，`finally` 还原；②屏外视图的 `capturePage()` 常返回空图，改用 CDP `Page.captureScreenshot` 渲染当前视口兜底（与整页截图共用 debugger 会话），「失败才闪一下」的退路一并去掉；③`withHiddenPage()`（mario_web_fetch / mario_web_search 的后台窗口）补 `x/y -12000`、`skipTaskbar`、`focusable:false`、显式 `paintWhenInitiallyHidden`，即使被意外 show 也不会出现在屏幕里或抢焦点。验证：`tsc --noEmit` 通过；browser-lifecycle-smoke 新增「截图进行中视图 bounds.x 必须仍是 -9999」断言，临时上屏/还原/超时用例全部通过（截图中位耗时从约 1s 降到 60–170ms；卡死用例 3s+3s 内报错并还原）；打包 `apps/desktop/release/MarioCode-0.2.46-x64.exe`（190,483,602 字节，约 181.7 MiB）。未验证：未在真实对话里复现用户的 Web 阅读器场景——代码与日志里 `mario_web_fetch` 只用 show:false 的独立窗口，不会让主窗口出现浏览器视图，最可能是同一轮里模型随后调用 `browser_*` 截图所致；`test:web-tools` 在本机 master 上因 `stub-db.ts` 缺 `SessionRepo` 导出无法编译（与本次改动无关）。未安装、未提交、未推送。

**10/11 修复（v0.2.45 · TODO-056 上下文用量一直显示 0）**：用户反馈上下文圆环一直是 0。本机 `main.log` 的 496 条 pathC-merge 中 81 条 `final=0/0%`，全部 `deltaUsage>0`，集中在第三方网关会话，pathB 从未生效。根因是网关的 `message_delta.usage` 只带 `output_tokens`：`normalizeClaudeTokenUsage` 按总吞吐判断有无数据而占用只算提示词，得到 `usedTokens=0` 的快照，覆盖路径 A 的真实读数，被持久化后又因 `isValidSnapshot` 只查类型而在重开会话时恢复。修复为 `isOccupancyReport` 门禁（无提示词 token 的 usage 不发快照）、合并时零读数改用累计占用、路径 B 要求 `totalTokens>0`、持久化与渲染端拒绝「已处理 token 但占用为 0」的快照。验证：类型检查、`test:metrics`（新增 6 条断言）、`test:session-store` 81/81、`test-metrics-reload-electron` 通过。未覆盖：pathC-direct 把累计用量当占用的高估、完全不返回 usage 的网关仍无圆环、未用真实网关复现。未打包、未推送。

**10/11 GitHub 发布（v0.2.44，服务器继续暂缓）**：当前已提交源码为 v0.2.44，原本地安装包仍为 v0.2.41。本轮将功能提交 `e43dc4d` 推送到 GitHub master，并创建和推送标签 `v0.2.44`（目标为同一提交）。[Release 工作流](https://github.com/maxiaopang123/MarioCode/actions/runs/38068834844) 的 Windows x64、Apple 芯片、Intel Mac 三平台构建与 publish 均成功；[GitHub Release](https://github.com/maxiaopang123/MarioCode/releases/tag/v0.2.44) 已公开，含 Windows 安装包（194,214,575 字节，约 185.2 MiB）、两种 Mac DMG / zip、blockmap、latest.yml 与合并 latest-mac.yml。核对标签目标、清单 v0.2.44、清单文件大小与实际资产、三平台安装包下载 HEAD 长度；下载的两份清单 SHA256 与 GitHub 资产元数据一致，核验记录 `.turbo/github-v044-verification.json`。v0.2.44 安装包采用 CI 构建文件，未使用或改名上传旧的 v0.2.41 本地安装包。服务器按用户此前选择继续暂缓，待通过可信渠道确认变化的 SSH 主机指纹后再发布；未修改服务器。Mac 窗口与刘海适配仍待真机验收。

**10/11 文档清理（不递增软件版本）**：删除沿用旧名的 `docs/Mcode-功能介绍.md`、`docs/Mcode-公众号风介绍.md`（文件内标题已是 MarioCode，且无任何文档引用；可从 Git 历史恢复）。`AGENTS.md`、TODO、本文件中记录改名与旧数据目录迁移的 Mcode 字样保留。随后清理其余残留：删除 `scripts/mcp-sync-smoke/main.mjs`（`main.ts` 的构建产物，无任何引用，含旧名 `.mcode` 路径）；`prototypes/`（24 个文件）、`LICENSE`、`docs/推广` 里的 Mcode / mcode / MCODE 统一替换为 MarioCode / mariocode / MARIOCODE，`check.mjs` 语法检查通过。至此除上述改名记录外，仓库已无旧名。另按用户要求删除无引用文档：`docs/memory-system-design.md`、`docs/小红书-我这行的AI路-发布计划.md`、`docs/小红书-我这行的AI路-发布计划-v2.md`（均可从 Git 历史恢复）。新增根目录 `CLAUDE.md`（仅一行 `@AGENTS.md`），让 Claude Code 启动时自动加载交付约定，`AGENTS.md` 仍是唯一内容来源。

**10/11 修复（v0.2.44 · TODO-055 Mac 窗口适配）**：用户反馈 Mac 上看不到最小化 / 最大化 / 关闭、窗口不能改变大小、流体云没有与刘海合到一起。①主窗口：`window.ts` 新增 `initialBounds()`，按鼠标所在显示器 `workArea` 限制初始与最小尺寸并居中（原固定 1440×900 在 13 寸 MacBook 放不下，标题栏被顶到菜单栏下）；macOS 不再传 `titleBarOverlay`，并显式 `setWindowButtonVisibility(true)`。②流体云：`ProgressCapsule` 增加 `notchFor()`，由内置屏菜单栏高度推断刘海（宽 200pt 为估计值），居中贴顶、收起为刘海加两侧 48pt 黑条、展开从刘海向下长出卡片；窗口层级改 `screen-saver` 以盖过菜单栏；`setVisibleOnAllWorkspaces` 加 `skipTransformProcessType`；契约 `ProgressCapsuleState` 新增 `notch`，渲染端 `.notch` 样式。验证：electron-vite 构建、`tsc -p tsconfig.json`、胶囊冒烟测试在 Windows 通过（`tsconfig.node.json` 的 1120 条 `@contracts` 解析报错改动前后一致）。**未在真机 Mac 验证**，红绿灯、拖拽缩放、刘海对齐需验收。功能提交 `e43dc4d` 与标签 `v0.2.44` 已同步 GitHub，三平台安装包由 CI 构建发布，见上方发布记录。

**10/10 GitHub 发布（v0.2.41，服务器暂缓）**：核对本地 release 目录后，最新安装包为 `MarioCode-0.2.41-x64.exe`（190,479,091 字节，约 181.7 MiB），源码为 v0.2.43、尚未打包。将已提交源码 master 与本地标签 `v0.2.41`（`f9559d4`）推送至 `maxiaopang123/MarioCode`；[GitHub Release](https://github.com/maxiaopang123/MarioCode/releases/tag/v0.2.41) 已公开，Windows 安装包 / blockmap / latest.yml 在 CI 完成后替换为本地同一文件，逐项大小及 SHA256 一致；从 GitHub 资产 API 下载更新清单与本地逐字节一致，Windows 下载 HEAD 长度正确。标签触发的 [Release 工作流](https://github.com/maxiaopang123/MarioCode/actions/runs/38064223215) 三平台构建与 publish 均成功，Apple 芯片 / Intel DMG、zip 与合并 latest-mac.yml 已发布，清单 v0.2.41 与 DMG 大小核对通过。核验记录 `.turbo/github-v041-verification.json`，最终 Windows 上传记录 `.turbo/github-v041-final-upload.log`。服务器 SSH 严格校验发现主机指纹与本机记录不同，用户明确选择「暂不确认，先同步 GitHub」，因此未连接认证或上传，服务器网页仍为 Windows v0.2.10 / macOS v0.2.8；待可信核对指纹后再发布。发布脚本已在独立 v0.2.41 标签检出下 dry-run 通过，避免误用 v0.2.43 的源码版本。未生成新版本号、未安装本机应用。

**10/9 完善（v0.2.43 · TODO-051 隐形宿主窗口）**：用户追问「互斥是否真的做好」时排查发现 v0.2.35 起的"隐藏 Agent 视图"并不可靠：把 WebContentsView 停在主窗口屏外（x/y -9999）后，Chromium 视其为不可见，视口 0×0、`capturePage` 空图、真实点击约一半丢失（诊断脚本多轮实测）。改为：①`BrowserManager.ensureAgentHost()` 懒建不可见宿主窗口（opacity 0、x/y -12000、`focusable:false`、`skipTaskbar`、无边框，`showInactive()`），Agent 视图出生并静息其中（1280×800）；`LiveBrowser` 新增 `parent` / `hostable`，`show()` 搬入主窗口、`hide()` 搬回宿主、`takeoverBrowser` 清 `hostable` 搬入主窗口，`close()` 经 `detachFromParent` 从真实所在窗口摘除（从错的窗口摘会崩），`disposeAll` 销毁宿主与回收定时器；截图在宿主里原地进行（设备仿真临时 0,0,w,h）；②`applyAgentHostFlags()` 关闭 `CalculateNativeWinOcclusion`（app ready 前调用，`index.ts` 与冒烟各一次）——对照实测：不关则宿主视图 `capturePage` 报 "Current display surface not available for capture"、点击全丢，opacity / 尺寸 / 是否 showInactive 都不影响，关闭后截图与点击恒成功；③`presented` 交接改走 store：`App.tsx` 全局监听 `presented` / `continued` / `closed`，新增 store 的 `presentedBrowser`、`agentViewPresented`（收编活动标签 + 自动切到右栏浏览器页）、`agentViewReleased`（幂等），`BrowserPanel` 读 store、用 effect 切换原生视图，修复面板没打开时呈现事件被丢；④验证：类型检查、完整构建；`test:agent-browser` 新增宿主窗口断言（主窗口只含用户标签、视口 1280、4 次真实点击命中、截图非空、show / hide / 接管的窗口搬移）连跑 3 次通过；`test:agent-browser-panel-electron` 新增「右栏关闭时呈现 / 继续」；`test:browser-lifecycle-electron` 通过。未验证：三引擎真实对话里的 `browser_present`；观看模式（只读镜像）下一版做；未打包。

**10/9 完善（v0.2.42 · TODO-051 回收与交接收尾）**：针对「Agent 与用户操作互斥」补完方案 A 的生命周期。①回收：`BrowserManager` 为 agent 视图记录 `idleSince` / `lastUsedAt`，`reapIdleAgentViews()`（60 秒定时器，unref）销毁空闲超 10 分钟且未呈现的视图，`create()` 前 `evictForNewAgentView()` 按 LRU 保持每会话 ≤3，`closeAgentViewsForSession()` 接入 `RuntimeManager.dispose`（会话删除 / 归档），每次 agent 工具解析视图都 `touchAgentView()`；被呈现的视图（用户正在操作）不进回收。②交接：契约新增 `closed` 浏览器事件（仅在被回收的视图曾被呈现 / 收编时发送）；`BrowserPanel` 新增 `removeTabLocal`（只移除标签、不关原生视图）在 `continued` / `closed` 时清除被收编的标签；横幅新增「接管」按钮调用 `browser.takeover`（词条 `browser.presented.takeover` / `takeoverHint`）。③修复 `waitForLoad`：`loadUrl` 现把 `live.ready.then(() => wc.loadURL(url))` 的结果记为 `pendingLoad`（含 catch，消除未处理拒绝），`waitForLoad` 优先等它，ERR_ABORTED(-3) 视为被新导航取代再退回事件监听，事件路径改为先挂监听再判断 `isLoading()`；修复前同一用例 0.7 秒或 8 秒随机、误报空白页已加载。④验证：类型检查、完整构建；新增 `test:agent-browser`（无界面 Electron 真实 BrowserManager + agentBrowserTools，连跑 4 次均通过、7–10 秒、零未处理拒绝；修复前 15–107 秒且有 ERR_FAILED 警告）与 `test:agent-browser-panel-electron`（主进程推送真实事件形状，覆盖收编 / 继续 / 回收 / 未收编的 closed / 接管）；`test:browser-lifecycle-electron`、`test:workspace-walkthrough-electron`、`test:settings-navigation-electron` 通过。未验证：三引擎真实对话里的 `browser_present` 流程。未打包。

**10/9 本地安装包交付（v0.2.41）**：沿用已提交版本 v0.2.41（功能提交 `f9559d4`）与本地标签 `v0.2.41`，不因打包增加版本。Windows 安装包 `apps/desktop/release/MarioCode-0.2.41-x64.exe` 已生成（190,479,091 字节，约 181.7 MiB），SHA512 与 latest.yml 一致，blockmap 已生成，包内 app-update.yml 指向自建更新服务器。包含 TODO-053 删除手绘主题（v0.2.36）与 TODO-044 的 v0.2.37 中性色板、v0.2.38 单栏侧栏、v0.2.39 配色基调、v0.2.40 输入框简化、v0.2.41 取消工具条与状态栏。验证：打包 ASAR 下 `test:startup-electron` / `test:workspace-walkthrough-electron` / `test:canvas-electron` / `test:chat-display-electron` 通过。未安装或上传；上传需用户确认后再走 `release:upload`。

**10/9 更新（v0.2.41 · TODO-044 第三步·取消工具条与状态栏）**：删除 `ToolStrip.tsx`（右缘竖向工具条）与 `StatusBar.tsx`（底部状态栏）。新增 `TitlebarTools.tsx`（保留 `nav[aria-label="工具"]` 与图标，旧脚本选择器继续可用）：文件 / Git / 浏览器三个面板按钮（点击当前已激活面板 = 关闭右栏）、底部终端、右栏开关，渲染在 Titlebar 右侧，仅在全屏浏览器 overlay 下隐藏；`RightPanel` 默认恢复分段标签头（五个面板含「轮次流程」「子会话」，原 `legacyTabs` 默认值翻转为 true）；主区面板行补 `pr-2` 让右栏卡片不贴窗口边。状态栏的全局信息迁入侧栏：新 `lib/globalStatus.ts`（`useGlobalStatus` = 代理模式 / 今日 tokens 与费用 / 已启用定时任务数，刷新规则同原状态栏：挂载、窗口聚焦、60 秒、运行数变化）→ 设置行副标题显示「网络路由 · 今日用量」，定时任务行右侧显示启用数，Claude 引擎未安装时设置图标出现红点；「等你处理」仍在侧栏提醒行。验证：类型检查、完整构建，`test:workspace-walkthrough-electron`（面板 / 终端 / 子会话 / 设置走查，轮次与子会话改点右栏标签）、`test:text-preview-electron`、`test:startup-electron`、`test:settings-navigation-electron`（26 屏）、`test:canvas-electron` 通过，真实桌面截图（右栏 Git 页、聊天页）已检查。未验证：mac 上标题栏按钮与红绿灯 / 拖拽区的间距、窄窗口下标题栏按钮与面包屑的拥挤程度。未打包。

**10/9 更新（v0.2.40 · TODO-044 输入框简化）**：纯样式。`.composer-minipill` 去掉容器边框 / 底色、分段之间的竖线隐藏，模型 / 思考级别 / 权限 / 上下文环变成安静的文字按钮，hover 与展开态用 `--surface-hover` + 正文色（不再是强调色染色）；`.composer-card` 静息边框由「服务商色 28% 混合」改为中性 `--input-edge`，阴影 `--shadow-2` → `--shadow-1`，聚焦时仍出现服务商色描边与细光晕、忙碌扫光保留；发送键背景改用 `--primary`（浅色石墨 / 深色薄荷）并把图标色改为 `text-primary-on`。审批 / 提问就地替换输入框（`hasPendingPrompt && "hidden"`）V3 已有，原型的这一条无需改动。验证：类型检查、完整构建、`test:chat-display-electron`，另用隔离真实桌面对同一会话截图浅 / 深色并已检查。未打包。

**10/9 新增（v0.2.39 · TODO-044 配色基调）**：设置 → 外观新增「配色基调」（中性 / 暖纸，默认中性），与明暗主题正交。契约 `THEME_TONE_SETTING_KEY="ui.themeTone"` + `ThemeToneSchema` / `ThemeTone`；store `themeTone` / `setThemeTone`（first-paint getMany 水合）；`lib/theme.ts` 的 `applyThemeTone` 在 <html> 写 `data-tone="warm"`（中性时移除）并镜像到 localStorage `mariocode-theme-tone` 供启动首帧读取，`useThemeTone` 挂在 App / AppMobile 根；styles.css 新增两块暖纸 token（`html[data-tone="warm"]:not(.dark)` 米黄纸面 #faf9f5 / 侧栏 #f0eee6 / 文字 #2b2a27，`html[data-tone="warm"].dark` 暖深底 #262624 / #1f1e1d / 文字 #eeece4）与 `.chat-md` 衬线字体栈（代码因自带 font-mono 保持等宽）；main 侧 `getThemeTonePreference` 让窗口底色与 Windows / Linux 标题栏 overlay 跟随，`setting.set` 命中该 key 时刷新 overlay。强调色 / 状态色不动。验证：类型检查、完整构建、81 项 store、设置导航真实桌面回归（26 屏），另用隔离真实桌面对同一会话截图暖纸浅 / 深色并已检查。未验证：暖纸下 Windows 原生标题栏按钮区颜色的肉眼对比、编辑器 / Diff / 终端在暖纸下的配色。未打包。

**10/9 更新（v0.2.38 · TODO-044 第二步·侧栏）**：新增 `ProjectSidebar.tsx`，取代 V3 的 ProjectRail + StreamSidebar（两文件已删，`railVisible` / Titlebar 同名参数、rail CSS 与 MobileConnectButton 的 rail 变体一并清理）。单栏结构：品牌 + 收起 → 白底描边「新会话」→ 等你处理行 →「项目」卡片（彩色字母方块 + 引导线 + 当前线程强调色刻度，工作树组头显示分支与「未合并」，折叠的项目保留运行中 / 等你处理 / 未读指示）→ 归档 → 「工具」卡片（技能与 MCP / 画布 / 定时任务 / 连接手机）→ 设置 + 浅深色钮。数据沿用每项目首页 + 工作树分区 + 置顶 + 归档，store 零改动；挂载时清除 V3 遗留的 `ui.streamScope`，聚合缓存仍保留作第一页之外会话的查找兜底。验证：类型检查、完整构建、81 项 store、隔离真实桌面浅 / 深色截图（折叠展开、显示更多、右键菜单），以及改写后的 `test:startup-electron`（恢复上次会话、清除旧范围、仅展开当前项目、逐页加载到最旧一条）、`test:canvas-electron`、`test:chat-display-electron`、`test:metrics-reload-electron`、`test:workspace-walkthrough-electron`、`test:settings-navigation-electron`（26 屏）全部通过；多个脚本中按 `li` / 旧项目栏查找侧栏的写法已改为 `[role=button]` / `[data-nav=canvas]`。未验证：真实待审批 / 出错 / 工作树组 / 归档区的真机交互。未打包。

**10/9 更新（v0.2.37 · TODO-044 第一步·中性色板）**：界面 V4 的第一个实施版本，只换颜色不动布局。styles.css 的浅 / 深色 token 全部改为无色相偏向的中性灰（去掉 v3 的绿灰偏色）：浅色 surface-base #f6f6f5、muted #f3f3f1、content #1a1a19、subtle #70706b（白底约 5:1）、edge #e4e4e1；深色 base #121312、surface #181918、muted #202120、content #ecece9、subtle #868681；强调色 / primary 仍是薄荷与石墨。main/window.ts 的窗口底色与 Windows / Linux 原生标题栏 overlay 同步到新色值。验证：类型检查、完整构建、`test:settings-navigation-electron`（26 屏）通过，另用隔离真实桌面对同一会话分别截图浅 / 深色，已检查。未打包；暖纸基调、输入框与审批改造为后续版本。

**10/9 移除（v0.2.36 · TODO-053）**：删除手绘 / 牛皮纸主题，作为 TODO-044 界面 V4 的前置减法（用户在评审 V4 原型后确认，同时确认取消项目栏与状态栏、默认中性基调、不含标签栏模式）。移除范围：styles.css Sketch 区块与 `.sketch` 作用域选择器、`index.html` 的 `#sk-wobble`、`lxgw-wenkai-webfont` 依赖、`THEME_STYLE_SETTING_KEY` / `ThemeStyle` 契约、store 与 appearance / theme 中的 themeStyle 逻辑、main 的 `getThemeStylePreference` 与 window.ts 配色分支、设置页「界面风格」行与中英词条；启动清理旧 localStorage 缓存键。验证：类型检查、完整构建、81 项 store 检查、`test:settings-navigation-electron`（26 屏）通过，外观页截图已检查。未打包。

**10/8 本地安装包交付（v0.2.34）**：沿用已提交版本 v0.2.34（功能提交 `1f4d6ee`）与本地标签 `v0.2.34`，不因打包增加版本。Windows 安装包 `apps/desktop/release/MarioCode-0.2.34-x64.exe` 已生成（228,553,616 字节，约 218.0 MiB）；安装包版本、大小、SHA512 与 latest.yml 一致，blockmap 已生成；包内 app-update.yml 指向自建更新服务器（generic + `http://39.109.58.6:3458/`），ASAR 内 `canvas:backfill` 通道核对通过。本轮未安装、上传或主动关闭用户应用；安装时需从托盘退出旧版。

**10/8 修复（v0.2.34 · TODO-052）**：画布图库回填历史会话生成的图片。用户反馈「项目之前生成的图,画布图库显示为空」——`registerSessionImage` 只在 mario_image_generate 生成那一刻登记(v0.2.28 画布上线前、或该次调用缺 sessionId 的图永远进不了图库),且没有任何扫描输出目录补登记的机制。修复:新增 `canvasStore.backfillProjectSessionImages(projectId)`——枚举项目会话,扫每个会话的输出目录(`<工具输出目录>/<sessionId>/turn-回合号/`),只识别文件名带 `-image-` 标记的 mario_image_generate 产物(imageGenerate 的 `${ts}-image-${toolCallId}.<ext>` 唯一标记;browser_screenshot 的截图无此标记、PDF 非图片,刻意不收),按 `file_path` 幂等登记(已有行跳过),行指向原文件不复制,created_at 取文件 mtime、prompt 留空。登记逻辑抽成 `insertProjectGenerated` 与 `registerSessionImage` 共用。走新 IPC `canvas.backfill`(契约 `CanvasBackfillSchema` + `CANVAS_BACKFILL` 通道 + preload 白名单),`CanvasWorkbench.reload()` 在项目范围取列表前先回填——画布打开即补上存量,之后新生成仍走既有登记。类型检查与完整构建通过;canvas-smoke 38 项全绿(原 30 项 + 新增 8 项:识别 `-image-` 并登记 / kind=generated 指向原路径 / 尺寸读 IHDR / 不含浏览器截图 / 不含 PDF / 重复调用幂等 added=0 / 其它项目不受影响 / 不重复已登记会话图),fixture 在隔离 `SMOKE_PICTURES` 下构造真实 `turn-3/` 目录验证。独立功能提交与本地标签 `v0.2.34`,未打包、安装或上传;macOS 待验证。

**10/8 本地安装包交付（v0.2.33）**：沿用功能提交 `e3ccb59` 与本地标签 `v0.2.33`，不因打包增加版本。Windows 安装包 `apps/desktop/release/MarioCode-0.2.33-x64.exe` 已生成（228,553,324 字节，约 218.0 MiB），包含 TODO-038 / 039 与 v0.2.29–31 修复。安装包文件版本、大小与 SHA512 和 `latest.yml` 一致，blockmap 已生成；包内版本、自动更新地址及 1519 个最终构建文件逐字节核对通过，含 PDF / Office worker、PDF 字体 / CMap、预加载和 HTML 自定义协议资源。从打包 ASAR 启动独立测试数据的桌面，文档阅读 / 翻页 / 缩放 / 分页（`.turbo/document-preview/run-ubpcZA`）、HTML / Markdown 交互 / 未保存预览 / 撤销重做 / 保存及隔离边界（`.turbo/text-preview/run-0Sj5Kl`）、原项目 / 旧会话恢复 / 重开与自动分页（`.turbo/startup-recovery/run-AVbvMH`）全部通过，截图已检查。完整性记录 `.turbo/installer-v0.2.33-verification.json`，构建记录 `.turbo/package-v0.2.33.log`。本轮未安装、上传或主动关闭用户应用；安装时需从托盘退出旧版。

**10/8 新增（v0.2.33 · TODO-039）**：HTML / HTM 与 Markdown 文件默认预览，工具栏双语「编辑 / 预览」切换，恢复打开的标签也默认预览。`previewDraft` 只读取脏的 Monaco 缓存模型，预览不落盘、不重置模型；干净文件重读磁盘，返回编辑由既有 freshness 检查同步外部修改，保留撤销 / 重做、保存、行号定位和 Diff。HTML 通过 `file.htmlPreview / releasePreview` IPC 建立临时 `mariocode-preview://<随机令牌>/…` 地址，独立源 iframe 支持普通脚本 / 模块 / CSS / 图片 / JSON / 字体；页面不能访问父应用或 Node，摄像头 / 麦克风 / 剪贴板禁止，弹窗 / 下载 / 表单提交 / Worker 不开放。协议在 app ready 前注册、ready 后绑定，主应用 CSP 仅增加 frame-src，页面使用单独 CSP；只供已登记项目 / 工作树资源，realpath 检查防 junction 越界和隐藏目录别名绕过，HTML 限 2 MB、本地资源限 8 MB。关闭 / 切换吊销令牌并清理该随机源存储，窗口销毁清理全部令牌；每窗口最多保留 16 个，防过时请求积累。`file.readFile` 失败增加可选 error 字段，Markdown 读取失败能显示错误与重试。类型与完整构建通过；`test:text-preview-electron` 验证真实文件树点击、HTML 样式 / 中文路径图片 / 内联与外部脚本 / ES module / JSON / 存储 / 按钮交互、无应用 API / Node / 父窗口访问、两类文档未保存预览与模型身份 / 撤销重做 / 键盘保存、HTML 磁盘刷新、恢复默认模式、行号跳转与 Diff、超大 / 缺失文件、越界与隐藏文件 junction、令牌吊销、英文界面。已检查截图，记录 `.turbo/text-preview/run-ZGt7nN`。`test:document-preview-electron` 在最终构建回归通过（`.turbo/document-preview/run-hv3SyI`），`test:startup-electron` 通过（`.turbo/startup-recovery/run-jpnsoh`）；macOS 待验证。独立功能提交与本地标签 `v0.2.33`，未打包、安装或上传。

**10/8 新增（v0.2.32 · TODO-038）**：PDF、DOCX、XLSX / XLS、PPTX 点击即在文件区阅读。PDF.js 使用兼容 Electron 33 的 legacy 主文件与 worker，字体和 CMap 一并本地打包，支持翻页、缩放和复制本页文字；Office worker 使用 Mammoth / SheetJS / fflate，DOCX / PPTX 显示文字、表格和嵌入图片，PPTX 遵循 presentation 的实际顺序，Excel 切工作表与行列分页。文件通过新 `file.readDocument` IPC 读取，限 32 MB、校验 realpath 防符号链接越界，Office 压缩展开限 64 MB；Word HTML 经 DOMPurify 清洗，图片仅嵌入数据，不读取外部引用。快速切换、解析超时、损坏与密码文件有退出和错误提示。类型检查、完整构建与 `test:document-preview-electron` 通过：本地四类文件、中文内容 / 表格 / 图片、PDF 翻页缩放与重开刷新、Excel 205 行与后续列 / 缓存公式值 / 第二表、PPTX 顺序、快速切换、坏文件、超大与越界 / junction、英文界面；已检查截图。记录 `.turbo/document-preview/run-WJ6IlS`。阅读视图不保证复杂 Word / PPTX 原版式，Excel 不重新计算公式或绘制图表，旧 DOC / PPT、密码 / OCR / PDF 表单暂不支持，macOS 待验证。独立功能提交与本地标签 `v0.2.32`，未打包、安装或上传。

**10/8 修复（v0.2.31 · TODO-050）**：修复内置浏览器切换后在顶部残留和恢复空白的竞态：隐藏 / 卸载取消显示重试，延迟回调按当前容器归属判断，无法测量时不再显示主进程猜测位置；侧栏与全屏交接不让旧容器隐藏新容器，画布保活工作区也会隐藏原生浏览器。菜单截图在异步开始前登记序号，关闭 / 切换后丢弃过时回调；主进程截图临时位置不改写用户意图，恢复前核对布局版本，尊重期间新的显示 / 隐藏 / 调整尺寸。页面快照、选择元素与输入等改用 `mainFrame.executeJavaScript`，不再等待整页网络加载结束。类型检查与完整构建通过；原生浏览器测试验证未完成网络资源下两秒内快照 / 选择元素 / 输入、截图期间显示 / 隐藏 / 隐藏状态调整尺寸及默认恢复；隔离真实应用验证四轮侧栏 / 全屏 / 文件切换、设置 / 画布 / 关闭右栏、无法测量时的过时显示重试、菜单捕获尚未完成就关闭、页面内容与实际原生绘制保留，已查看原生截图。`test:startup-electron`、`test:canvas-electron` 同时通过。最终记录 `.turbo/browser-native/run-mx9Rtt/data`、`.turbo/browser-lifecycle/run-YF0SK9`；测试使用独立数据目录与本地页面，不调用付费模型。常用站点仍待日常使用验收；独立功能提交与本地标签 `v0.2.31`，未打包、安装或上传。

**10/8 优化（v0.2.30 · TODO-048）**：聊天左侧大纲横条改为 4px 圆点，书签 5px、当前条目 6px，保留 20×20 点击范围；悬停 / 焦点轻微放大，当前项尺寸、颜色与光晕过渡，遵循减少动态效果偏好。导航改为带双语名称的 nav 与原生 button，键盘可聚焦查看原有提示卡、Enter 跳转；保留消息顺序和回复书签。类型检查与完整构建通过；`test:message-timeline-electron` 验证圆点 / 命中区尺寸、书签、提示卡、真实键盘 Enter 跳转及减少动态效果，并回归两次重开、本会话展开 / 收起及书签、用量保留；已查看截图。记录 `.turbo/message-timeline/run-Z7y6B8`；独立功能提交与本地标签 `v0.2.30`，未打包、安装或上传。

**10/8 修复（v0.2.29 · TODO-047）**：按用户确认，右上角「本会话」展开面板移除重复大纲，保留聊天左侧 MessageTimeline 的消息 / 书签导航；删除大纲计算、专用跳转回调与双语词条，轮次回退计数改为直接计算用户消息。任务、子代理、计划、书签、缓存 / 速度与用量继续使用原入口。类型检查与完整构建通过；`test:session-overview-electron` 在隔离真实桌面验证两次重开、轮次数、展开 / Esc 收起、书签与性能 / 用量节保留，以及左侧两轮消息和回复书签入口保留，已查看截图。验证记录 `.turbo/session-overview/run-ka8S3R`；独立功能提交与本地标签 `v0.2.29`，未打包、安装或上传。

**10/8 本地安装包交付（v0.2.28）**：沿用功能提交 `5d84ce2` 与本地标签 `v0.2.28`，不因打包增加版本。Windows 安装包 `apps/desktop/release/MarioCode-0.2.28-x64.exe` 已生成（203,487,790 字节，约 194.1 MiB），大小、SHA512 与 `latest.yml` 一致；包内版本与画布工作台资源（canvas_images 表迁移、canvas:* IPC 通道、CanvasWorkbench、registerSessionImage、images/edits 端点路径）核对通过。本轮未安装、上传或主动关闭用户的应用；安装时需从托盘退出旧版。

**10/8 更新（v0.2.28 · TODO-033/041 + TODO-049）**：绘画画布与图库。项目栏（rail）底部新增「画布」入口（palette 图标，用户明确要求把原「暂缓（大版本）」的 TODO-033/041 与切图 TODO-049 合并为一个版本交付）。主区三视图：**文生图**——提示词、风格 chips（多选，以文本追加进提示词）、负面提示词（文本并入，images API 无独立参数，高级选项种子/引导强度刻意不做以免 UI 说谎）、画幅（自动/1:1/3:2/9:16）、数量 1/2/4（逐张调用，部分成功保留已出图并报原因）；**画布编辑**——真实蒙版画布（画笔/橡皮/笔刷大小/[/] 快捷键/撤销/重做/清空，笔画像素坐标随窗口缩放换算回原图），三种编辑方式：局部重绘（蒙版透明区=重绘区，POST images/edits multipart 手工编码，engineFetch 同 设置→网络 路由）、整图变换（不带 mask）、扩图（渲染端把原图贴进 1.5 倍画布居中、边区造蒙版，imageBase64 覆盖编辑输入）；**切图（TODO-049）为真实裁剪**——选框整体拖动 + 四角手柄缩放 + 比例约束，应用后 nativeImage 按原图像素裁出并另存为派生新版本（原图保留），Esc 退出；**图库**——卡片网格 + 搜索 + 最近/最早/派生链分组排序 + 导入本地图片 + 删除（连带派生链后代，文件移入 `<图库>/.trash/`，跨卷 rename 退回复制）+ 在文件夹中显示 + 复制提示词 + 打开图库文件夹。派生链（chainId=链根 id，parentId 指来源）串联原图与各版本，编辑视图底部派生链可切换编辑对象。图库分独立/项目两范围：文件默认落「图片/MarioCode-Gallery/{shared|projects/<pid>}」（known-folder 解析失败退 userData/gallery；画布内可改目录，settings `canvas.galleryDir`，只影响之后），元数据入新表 `canvas_images`（软删除 deleted_at）。会话里 mario_image_generate 生成的图自动登记进对应项目图库（不复制文件，行指向截图目录原图）。图片端点复用 设置→内置工具 的图片配置（resolveImageEndpoint），未配置时画布头部显示引导条且生成/编辑按钮禁用；真实编辑接口与模型兼容性按原 TODO 备注留待用户配置后人工验证。挂载方式：store `canvasOpen`，打开时 ThreePaneLayout CSS 隐藏保活（终端 PTY/聊天不断），CanvasWorkbench 懒加载作为兄弟节点占满面版行；切范围/切会话（App 根订阅 activeSessionId 变化）自动退出画布。验证：类型检查与完整构建通过；`test:canvas`（canvas-smoke）30 项——表迁移、仓储 CRUD、范围过滤、派生链递归、越界选区钳制、导入过滤、会话图登记、连带删除进 .trash、images API 请求体字段/multipart mask 有无/上游 400 中文错误；`test:canvas-electron` 隔离真应用三视图切换、未配置引导条、生成按钮禁用、返回会话卸载；`test:canvas-e2e-electron` 本地 mock 图片接口（纯 JS PNG 编码）走通配置 → 文生图 ×2 → 真实鼠标涂抹蒙版（已涂抹 1 处）→ 蒙版重绘 → 真实裁剪（256×160 → 179×112，显示坐标换算正确）→ 派生链同链 → 图库删除确认对话框，截图已逐张检查。未验证：真实收费图片端点出图与 edits 兼容性、macOS；未打包、安装或上传。

**10/7 本地安装包交付（v0.2.27）**：沿用功能提交 `0e21efa` 与本地标签 `v0.2.27`，不因打包增加版本。Windows 安装包 `apps/desktop/release/MarioCode-0.2.27-x64.exe` 已生成（203,422,277 字节，约 194.0 MiB），大小、SHA512 与 `latest.yml` 一致，blockmap 已生成。包内版本、主进程、胶囊 HTML / JS / CSS 与预加载及其共享资源逐字节匹配最终构建，SSH stdio 与自动更新地址正确。从打包 ASAR 启动隔离桌面，项目 / 原聊天恢复、重复重开、跨筛选、正常自动分页与无进展退出回归通过，已检查截图；测试记录 `.turbo/startup-recovery/run-7K1nrZ`，完整性记录 `.turbo/installer-v0.2.27-verification.json`。本轮未安装、上传或主动关闭用户的应用；安装时需从托盘退出旧版。

**10/7 更新（v0.2.27 · TODO-046）**：桌面进度胶囊改成顶边收放：默认只露出 160×12 的状态提示条，悬停展开 288×76 的流体卡片，离开后收起；顶部握柄拖动后吸附所在屏幕顶边，记录显示器与水平中心，旧自由浮窗位置迁移到对应顶边。多聊天支持左右滑动、横向或纵向滚轮、左右按钮与方向键，保留所选任务、移除已结束任务并回退到有效聊天，点击任务返回对应聊天并收起。真实归一化事件区分思考 / 输出 / 执行工具 / 等待响应，显示读取文件、运行命令等具体动作和并行工具数；工具审批、问题与计划审批优先呈现，等待审批显示对应工具，不借用另一执行中的工具。Windows 存在 [极小无边框窗口的最小高度限制](https://github.com/electron/electron/issues/32302)，使用 [setShape](https://www.electronjs.org/docs/latest/api/browser-window#winsetshaperects-windows-linux-experimental) 将收起后的绘制与鼠标命中范围裁剪到提示条；实际 OS 命中验证条内能点击、条下区域穿透。类型检查、完整构建和最终主进程构建、隔离真实窗口悬停 / 收起 / 三任务滑动与滚轮 / 点击防误触 / 独立状态 / 并行工具收尾 / 私有 IPC 拒绝 / 位置保存与重开 / 越界恢复 / 双语及启动恢复回归通过，已检查收起与展开截图。启动测试显式置前，避免后台动画帧暂停影响分页断言。独立功能提交与本地标签 `v0.2.27`；物理多屏拖动与 macOS 未验收，未打包、安装或上传。

**10/7 更新（v0.2.26 · TODO-045）**：会话列表首图标改为最近实际使用模型的品牌，与聊天模型图标共用映射；普通、置顶与归档会话统一。模型名称继续显示，图标悬停说明完整模型 ID 与执行引擎，输入区继续保留引擎选择。未知模型保留原名并显示通用芯片，尚无使用记录的新会话显示通用聊天图标，不以当前选择冒充使用历史。类型检查、完整构建、45 项模型与历史检查通过；隔离真实 Electron 验证 Qwen / Claude / Kimi、未知 / 新会话、置顶 Gemini 与归档 DeepSeek，以及引擎与模型不同、实际模型与下一次选择不同、中英文悬停及浅深色显示；界面截图已检查。启动恢复回归通过。本地独立功能提交与标签 `v0.2.26`，未打包、安装或上传。

**10/7 本地修复包交付（v0.2.25）**：功能提交 `75bd229`、本地标签 `v0.2.25`。Windows 安装包 `apps/desktop/release/MarioCode-0.2.25-x64.exe` 已生成（203,411,416 字节，约 194.0 MiB），安装包 SHA512、文件大小与 `latest.yml` 一致，blockmap 已生成。对应 ASAR 版本与 SSH stdio 资源核对通过；从打包 ASAR 启动隔离桌面，新增启动恢复、跨筛选原聊天、自动分页、无进展退出及重复重开回归通过，界面截图已检查。本轮未安装或上传，未主动关闭用户的应用；安装时需从托盘退出旧版。

**10/7 修复（v0.2.25）**：用户安装 v0.2.19 后停在零项目、问号会话与空白聊天区。只读检查确认现有数据库含 6 个项目、59 个会话且无孤立项目引用，并保存包含 WAL 数据的一致性备份。用备份的隔离副本启动已安装 ASAR 复现；调试器确认侧边栏自动定位在 `streamDirty=true`、`streamHasMore=true` 时反复等待立即返回的分页动作，形成无限微任务循环，项目虽已读取却不能绘制。修复为刷新中 / 无进展时结束定位，分页后让 React 绘制，筛选范围外不分页，切换聊天 / 范围或卸载时取消旧定位。类型检查、完整构建、81 项 store 回归通过；新增 `test:startup-electron` 用 32 会话旧配置验证两次重开、跨筛选恢复、正常自动分页、分页无进展与切换项目，旧 ASAR 出现同样的界面超时，修复版通过。真实备份副本也恢复全部 6 个项目、原聊天与输入框，界面截图已检查；测试副本关闭通知与定时任务并移除上游密钥，原用户数据未修改。修复已保存为本地标签 `v0.2.25`；本地安装包交付记录随后补充，未安装或上传，正在运行的安装版未关闭。

**10/7 收尾（v0.2.24 · TODO-026）**：用户确认首期只做 SSH 命令，SFTP 留后续。MCP 页「我的扩展」新增默认关闭的内置目录和 SSH 主机管理，配置探测并确认 SHA256 指纹，密码 / 私钥 / 口令只在主进程以 safeStorage 加密落库。独立 stdio server 随资源构建，每轮通过内存 token 访问本机 broker，配置文件不写密钥或 token；每条命令都在 broker 独立审批，Full Access 与始终允许不能跳过，无人值守直接拒绝，停止 / 回合结束撤销权限并取消连接。Pi 补齐用户与项目的 stdio / Streamable HTTP / SSE MCP 客户端并接入现有权限守卫；修正 Claude 必须先绑定再 query、Codex 真实 MCP elicitation 的 action 响应。类型检查、完整构建及最终主进程构建、16 项隔离 SSH / MCP 检查、三个真实引擎各两条 SSH 命令与独立审批、设置保存 / 编辑 / 重开 / 关闭 / 删除、81 项 store、179 项共享提供商、三引擎九条协议与 Codex 续聊回归通过，已查看界面截图。SSH 与模型上游均为本地测试服务，未使用生产服务器或真实付费模型；Pi OAuth / 交互式 elicitation 和旧明文技能迁移未做。本轮未打包、安装或上传。

**10/7 收尾（v0.2.23 · TODO-025）**：移除桌面 / 手机均无引用的 ActivityCluster，SessionFloat 继续负责桌面本会话，手机 ActivitySheet / ActivityConsole 与 activityShared 保留；AGENTS 补上现行入口，避免沿旧设计继续开发。类型检查、完整构建通过；隔离真 Electron 中真实指针检查会话浮窗展开 / Esc 收起、浅 / 深色聊天、文件编辑器、Git 状态、浏览器、轮次、子会话、终端，并遍历 20 个设置页，未出现 renderer 异常；另测浅 / 深色、1024 / 1680 宽窗口共 26 个设置界面绘制，已人工查看代表截图。本地 ui-refresh-v3 快进合入 master，未推送远端；用户原有 TODO 想法和安装包目录保留。未打包、安装或发布。

**10/7 收尾（v0.2.22 · TODO-024）**：模型配置页增加可折叠的旧配置列表，显示来源、主机、模型数量与导入状态；可完整转换的 Claude / Pi / Codex 配置复制到统一提供商并在表单继续编辑，密钥只在主进程解密再加密，序列化事务保证重复点击或两窗口不会重复导入。原配置不删除、不改旧会话引用；手写 Pi 文件、特殊请求头 / 兼容字段、外部凭据引用或无法解密的密钥不静默转换，列表说明原因。保留新 scheme+host+port 需重填密钥、同服务器改路径保留的既有规则。类型检查、构建、179 项共享提供商及 81 项 store 回归通过；真实隔离 Electron 验证三类导入、界面操作、并发去重、导入状态重开恢复、旧 metadata / ciphertext 原样保留、Pi 文件逐字节不变、复制后编辑及跨主机拒绝保存。图片模型下拉沿用原已完成实现。未打包、安装或发布。

**10/7 收尾（v0.2.21 · TODO-023）**：主进程统一记录文字 / 思考增量的生成跨度和首字延迟，工具、审批与长停顿不计入生成时间；写入 TurnUsageRecord 与回复元数据，三处速度显示重开后仍可恢复。以 endedAt 配对，避免借用其他回合耗时；未知缓存排除出缓存率平均。Codex inputTokens 已含缓存，修正重复加算，线程累计差值汇总同轮多次调用，最新调用仍决定上下文占用。类型检查、最终构建、81 项 store 和独立计时 / 缓存口径用例通过；隔离 Electron 下真实 Pi SDK、Claude CLI、Codex app-server 各自走 Chat / Messages / Responses 共九条路径，加 Codex 切换模型续聊，固定上游计数均与落盘记录一致；另测重开两次恢复平均速度、缓存率与首字延迟。使用本地协议服务，不消耗真实模型额度；生产网关缺失 / 自定义 usage 的兼容性仍需日常观察。统计口径参考 OpenAI 官方 protocol / token_usage 源码。未打包、安装或发布。

**10/7 收尾（v0.2.20 · TODO-022）**：补齐外观页回复显示设置，中英双语：默认点击加载网络图片，可选择精确匹配受信任域名或始终自动加载，正文路径识别可关闭而保留行内代码标签。读取网络图片沿用引擎网络设置，流式读取到 12 MiB 上限即停止。结束回合的正文图片只有成功解码后才折叠同一保存路径的工具缩略图，保留展开入口；损坏、未找到及无法确定来源的工具图仍保留。类型检查、最终构建、81 项会话 store 回归及真实隔离 Electron 桌面检查通过：默认零网络请求、非信任域名不加载、信任与总是加载、设置页修改与页面重开、路径开关和损坏图片回退；已检查界面截图。图片服务兼容性仍由 TODO-005 的真实服务验收维护。本次不打包、不安装、不发布。

**10/7 本地交付（v0.2.19）**：首批 TODO-028、029、030、031、032、034 分别保存为 v0.2.14–v0.2.19 的独立功能提交与本地标签，见下方 Git 表。Windows 安装包 `apps/desktop/release/MarioCode-0.2.19-x64.exe` 已生成（201,855,119 字节，约 192.5 MiB），安装包 SHA512、大小与 `latest.yml` 一致；包内版本、胶囊页面及独立 preload 已核对。从安装包的 ASAR 启动隔离桌面应用，三个真实引擎连接本地模拟服务，九条协议路径、分叉范围及 @ 文件夹发送 / 历史重开回归通过；本次包内自动截图未取得，源码构建界面截图已检查。跳过构建打包时首次缺少工作区依赖准备，补齐为应用内依赖副本后重新打包成功；未因此递增版本。未安装、未上传发布，也未关闭正在运行的 MarioCode。

**10/7 更新（v0.2.19 · TODO-034）**：@ 与添加上下文选择器支持文件夹、空目录及项目根目录，目录与文件使用不同图标；中文与空格名称可继续搜索，支持 Tab / Enter 确认、去重、移除及切换聊天恢复草稿。工作树聊天搜索自己的检出目录。只发送带完整路径的目录引用，让模型按需读相关文件；图片后缀目录不会加载成图片，历史及排队消息重新编辑保留目录类型和聊天引用来源。目录元数据缓存合并并发扫描、监听文件系统变化，沿用扫描数量与深度上限，并提示截断 / 未完全扫描，跳过忽略目录与目录链接。类型检查、最终构建、81 项会话 / 引用 / 草稿检查、45 项模型检查、真实 Electron / SQLite 文件与目录搜索检查通过；真实桌面验证中文空格路径、Tab / Enter 不自动发送、删除、草稿切换、Pi 请求收到路径且不自动注入目录内容、持久化及页面重开后的目录卡片，截图已检查。三真实引擎分叉历史及九条协议路径同时通过（本地模拟服务）。测试中首次 Pi 外部 SDK 冷加载超过既有 8 秒探测上限，预加载后通过；一次 Codex 原生状态库初始化失败，测试在回合完成后等待原生进程清理再连续启动后通过，均未调整引擎产品逻辑。未发送草稿的退出重开持久化仍不在本次实现范围。

**10/7 更新（v0.2.18 · TODO-032）**：新增独立桌面置顶呼吸胶囊，以 RuntimeManager 的实际运行回合决定显示，不依赖可能残留的数据库 running 状态；自动出现不抢焦点，全部结束后隐藏。支持拖动、位置保存与屏幕工作区约束，显示聊天标题、时长、模型、真实任务完成数和等待工具 / 计划审批 / 用户回答；多聊天切换及返回聊天按钮。中英双语与减少动态效果偏好已接入，独立 preload 仅开放读取状态和返回运行聊天，主进程校验来源窗口及入参。类型检查、构建、68 项会话 store 与真实 Electron 窗口检查通过（置顶、任务数、等待与恢复、多聊天返回、私有 IPC 拒绝其他窗口、空闲隐藏、位置保存恢复与越界修正、语言切换），实际窗口截图已检查。物理鼠标拖动及多显示器拔插留待使用验收；进度以聊天回合及其任务清单为准，无清单时不编造百分比。

**10/7 更新（v0.2.17 · TODO-031）**：会话右键支持整段历史分叉或引用，消息操作支持截至选定消息的范围。分叉拥有独立 ID 和引擎线程，复制显示历史并在首次运行注入最近最多 8 万字文本上下文；不注入原图与隐藏思考，原会话保持不变。引用保留来源及范围，先加入目标聊天草稿，由用户发送。68 项会话 store、45 项模型、真实 Electron / SQLite 保存检查、类型检查与构建通过；Claude、Pi、Codex 真实引擎连接本地模拟接口，均验证分叉历史可见且范围后的消息未进入请求。桌面三引擎 × 三协议回归同时通过；本次自动截图未取得，按钮视觉及手动交互仍需日常使用验收。

**10/7 更新（v0.2.16 · TODO-030）**：归档列表与数量使用同一项目 / 分组 / 工作树筛选结果，重复缓存去重，项目归档后保留当前范围。其他客户端新归档会话即时加入归档缓存，恢复即时移除。类型检查、构建、64 项会话 store 与归档筛选检查通过。

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

**版本（10/08）**：当前源码 `v0.2.33`；TODO-038 文件阅读、TODO-039 HTML / Markdown 预览切换已分别验证并独立提交与本地标签 v0.2.32 / v0.2.33，功能提交分别为 `93b2a67` / `e3ccb59`。TODO-047、048、050 分别对应 v0.2.29 / v0.2.30 / v0.2.31。当前 v0.2.33 本地 Windows 安装包已生成（约 218.0 MiB），包内资源、清单与桌面预览 / 启动恢复回归通过；待用户安装验收，未上传。

人工验收与发布事项见 [MarioCode 想法与待办](MarioCode-TODO.md)。本机打包用 `scripts\package-win.bat`（`--skip-build` 跳过构建），发布用 `pnpm --filter @mariocode/desktop run release:upload`。

### 待办入口

[新想法、未完成事项与验收清单](MarioCode-TODO.md) 已拆成独立文档。后续状态在新文档更新，完成结果再记入本页版本记录。

回归脚本（在 `apps/desktop` 下跑）：`pnpm test:sync-load`（TODO-004，同步产物被三个引擎加载）、`pnpm test:web-tools`（TODO-005，真实搜索 / 读网页 + 本地假图片接口）、`pnpm test:builtin-tools-electron`（TODO-005，先 `pnpm build`，真 app 设置页截图）。`pnpm test:pi-host` 自动检查可用的项目 / 全局 Pi 运行时，也可传入额外运行时路径；包含本地服务上的 Chat / Messages / Responses 请求及跨接口续聊。

### 历史功能进度快照

以下保留拆分前的功能进度、提交和备注，便于追溯。当前未完成事项以 [MarioCode 想法与待办](MarioCode-TODO.md) 为准，历史百分比不作为当前验收结论。

状态：⚪ 未开始　🟡 进行中　🟢 已完成　🔴 阻塞　⏸ 暂定（条件不具备，等条件到位再排期）

| ID | 功能 | 进度 | 状态 | 对应 Commit | 备注 |
|---|---|---:|---|---|---|
| `TODO-026` | 内置 MCP 目录（首个：SSH 远程服务器）+ Pi 接入 MCP | 100% | 🟢 已完成 | 本地标签 `v0.2.24` | 按已确认首期完成：默认关闭的内置 SSH 目录、主机列表与远程命令；每条命令独立审批（Full Access / 始终允许也不绕过）、指纹校验、密码 / 私钥加密保存，无人值守拒绝。Pi 支持 stdio / HTTP / SSE 与项目启停。类型、构建、16 项 SSH 检查、三真实引擎连续双命令、桌面保存 / 重开 / 删除及原协议回归通过；SFTP 后续，未连接生产 SSH 主机 |
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
| `TODO-022` | 回复里渲染图片 + 文件路径可点开（为生图铺路） | 100% | 🟢 已完成 | `0352622` · `v0.2.20` | 外观页新增网络图片从不 / 受信任域名 / 总是加载设置与正文路径识别开关；正文成功解码后折叠同一保存路径的工具图片，保留展开入口，损坏图不折叠。读取沿用网络设置并限制 12 MiB。类型检查、构建、81 项 store 与隔离桌面显示 / 设置 / 重开检查通过；真实图片服务兼容性由 TODO-005 后续验收维护 |
| `TODO-024` | 模型配置收尾三件（生图标记接入 / 密钥规则拍板 / 旧版数据清理） | 100% | 🟢 已完成 | `4ca9fa1` · `v0.2.22` | 保留换服务器重填密钥规则；增加旧 Claude、Pi、Codex 配置列表与复制到统一提供商入口，事务保存、串行去重并记录导入状态，旧会话和原配置保持可用；特殊字段或外部密钥引用不自动转换。类型检查、构建、179 项共享提供商、81 项 store 与真实桌面导入 / 加密 / 文件保留 / 重开验证通过 |
| `TODO-023` | 会话里显示缓存命中率与输出速度 | 100% | 🟢 已完成 | `994c288` · `v0.2.21` | 主进程逐轮记录生成耗时与首字延迟，回复与用量历史持久化，重开恢复测速；按 endedAt 配对，未知缓存不记为零；修正 Codex 缓存重复计数及多次调用累积。类型检查、构建、81 项 store、计时用例、三引擎九条协议路径加 Codex 续聊与真实桌面重开检查通过 |
| `TODO-025` | 界面焕新 v3 落地到真实代码 | 100% | 🟢 已完成 | `30629bc` · `v0.2.23` | 移除无引用的 ActivityCluster，保留手机 ActivityConsole 与共享活动逻辑；浅 / 深色检查聊天、会话浮窗、编辑器、Git、浏览器、轮次、子会话、终端及 20 个设置页，26 个不同尺寸设置绘制检查通过；已检查截图、类型与构建通过，本地快进合入 master |
| `TODO-027` | 静默自动更新 + 最低版本强制更新 | 0% | ⏸ 暂定 | - | 2026-09-29 立项，**依赖 TODO-016（先有自己的发布渠道）+ 旧数据目录迁移**。两层叠加：① 静默更新——`updater.ts` 已有 electron-updater 流程，开 `AUTO_UPDATE_ENABLED`、`autoDownload=true`，下载完提示「重启完成更新」或退出时自动装；② 最低版本拦截——服务器放一个小文件（如 `{"minVersion":"0.2.1","message":"…"}`），启动时读取，当前版本低于它就弹不可关闭的窗口，只给「立即更新」「退出」，以后要求全员升级只改这个数字、不用重新发版。**限制**：不开应用 / 离线的用户管不到（只能做到下次联网打开必须先更新）；国内访问 GitHub 不稳，建议更新包和版本文件放阿里云 OSS 或自己的服务器（electron-updater 的 generic provider）；Windows 安装包没签名，首次安装会被 SmartScreen 拦。**待拍板**：更新包放哪（GitHub Releases / 阿里云 OSS / 自己服务器）；版本文件拉取失败时放行还是拦截（建议放行，避免服务器挂了所有人打不开） |
| `TODO-010` | 聊天流渲染性能：行高估值与流式重算（原 TODO-007 第 5、6 项） | 0% | ⏸ 暂定 | - | P1。**解除条件：把应用跑起来采一次数**。两项都按「先量后改」的口径走，而行高分布与分组耗时都拿不到静态答案。文档里备了一段开发者工具即贴即用的行高统计脚本；分组耗时要现加 dev-only `performance.mark`。没有真实数字之前不要改 `estimatedItemSize`，也不要动分组切点——切错会让聊天记录错乱 |
| `TODO-011` | 文件树 / 会话树拍平虚拟化（原 TODO-007 第 7 项第二步） | 0% | ⏸ 暂定 | - | P3。**解除条件：出现真实的大仓库卡顿反馈**。第一步（删除确认框提到树根）已随 TODO-007 落地；第二步要把递归树拍平交给 LegendList，连带重写展开折叠、键盘导航、拖拽与右键菜单的掌控，估 3～5 天，属于「有人抱怨再做」的那类 |
| `TODO-012` | 前端 lint 基建：从零搭 ESLint + 禁止 JSX 文本出现 CJK | 0% | ⏸ 暂定 | - | P2。**解除条件：确认要不要引入这套工具链**。本仓库根本没装 ESLint——两个包都没有 `lint` script，也没有任何 `eslint.config.*` / `.eslintrc*`，`turbo.json` 里的 `lint` task 一直在跑空（源码里残留的 `// eslint-disable-next-line` 是上游留下的）。TODO-007 第 3 项欠的那条「挡中文回流」规则要落地，得先把这套装起来 |
| `TODO-016` | 自有发布渠道（重开自动更新） | 100% | � 已完成 | `d3e8599`（先关掉）→ v0.2.5–v0.2.8 | 2026-10-05 改为**自建更新服务器**：`publish` = generic `http://39.109.58.6:3458/`（亿联云，nginx 容器 `mariocode-updates`），`AUTO_UPDATE_ENABLED = true`；发布用 `pnpm --filter @mariocode/desktop run release:upload`（校验 + 流式断点续传 + latest.yml 最后传 + 公网复核）；macOS 由 GitHub Actions 打包后通过 `--mac` 自动镜像至服务器，下载页与应用内更新已全链路打通。 |
| `TODO-017` | 同步上游 M Code 新功能（v0.2.3–v0.2.5） | 0% | ⏸ 暂定 | - | **解除条件：拍板合不合、合哪些**。分叉点 `130fd90`（v0.2.2）之后上游又有 39 个提交、动了 168 个文件：Agent / 任务编排、定时任务 v2（和本仓库 TODO-001 重叠）、终端并入右栏 + 文件树分栏、Git 面板实时 diff、右栏会话级页签、外部文件拖进输入框、后台 bash 任务列表、Agent 启动服务的端口扫描、控制中心样式的活动区，以及两个社区修复（Codex 第三方模型上下文窗口、终端 Shell 路径设置反馈）。两边都大改过界面，建议先拉下来列冲突清单再挑 |
| `TODO-018` | 用户账户 + Token 计费（内嵌官方模型服务） | 0% | ⏸ 暂定 | - | 2026-09-26 立项，具体做法之后再定。用户在 MarioCode 里登录，使用你提供的模型服务，按 token 扣费；计费在服务端网关算，客户端只负责登录、拿到用户 Key、自动配成「MarioCode 官方」共享提供商。**解除条件：拍板规划详情里的 5 个问题**（「新的 tool」指什么、用户在国内还是海外、卖哪些模型、收费方式、是否保留自带 Key）。初步规划见下方规划详情 TODO-018 |

## 规划详情（2026-09-20 待排期）

以下为原有技术方案和决策背景，保留供实施时参考。当前范围、状态和剩余验收要求在 [MarioCode 想法与待办](MarioCode-TODO.md) 维护。

### TODO-026 内置 MCP 目录（首个：SSH）+ Pi 接入 MCP · 首期已完成（v0.2.24）

- **已确认范围**：2026-10-07 用户确认先做 SSH 命令，SFTP 后续。SSH 是默认关闭的可选独立 stdio MCP，设置 → MCP → 我的扩展 → 内置 MCP 目录中启用并管理主机；Claude / Codex / Pi 三端均可调用。
- **Pi 通用 MCP 已补齐**：`supportsMcp: true`，主进程 `McpToolSession.ts` 读取用户 `.claude.json` 与按当前会话目录启用的项目 `.mcp.json`，尊重启停与项目范围。支持 stdio（含 Windows `.cmd`）、Streamable HTTP 与 SSE、配置 headers，向 host 下发列出的工具 schema，反向调用仅允许该轮已列出的名字。普通 MCP 沿用现有权限守卫，取消或结束回合关闭客户端；Pi OAuth 登录与交互式 elicitation 不在首期。
- **目录与构建**：`build/build-mcp.mjs` 构建到 `out/mcp/mariocode-mcp-ssh/stdio.mjs`，Electron Builder 复制至 `resources/mcp/`，由 Electron 自带 Node 启动。目录只同步带归属标记的配置，同名外部 server 拒绝覆盖，关闭只删除本目录条目；`ssh2` 钉为 `1.17.0`，MCP SDK 钉为 `1.29.0`，Zod 升至 v3 `3.25.76` 以兼容 SDK 包导出。
- **SSH 工具**：`ssh_hosts` 返回别名、地址、用户、端口；`ssh_exec({host, command, timeoutSec})` 返回 stdout / stderr / 退出码与截断标记。超时 1–120 秒，输出合计上限 64 KiB，最多三个并发；截断不分页，未注册上传 / 下载工具。
- **凭据隔离**：密码 / 私钥 / 私钥口令以 Electron `safeStorage` 加密存在主进程 settings，界面与模型只拿 `hasCredential`，配置文件不写 token 或凭据。独立 server 不换取密钥，而是携带每轮内存 token 请求主进程代为执行；token 仅给目录 SSH server，结束 / 停止撤销并取消连接。首期运行依赖 MarioCode broker，尚未提供独立导出。
- **指纹与审批**：设置页先探测并勾选确认 SHA256 指纹；连接在认证前校验，变化直接拒绝。每条命令都由 broker 独立审批，Full Access / 已存始终允许均不能绕过，UI 隐藏始终允许且主进程禁止持久化；无人值守命令在审批前拒绝。报错与日志使用固定错误代码，不包含凭据。
- **真实引擎修复**：Claude 在 `query()` 前完成绑定并向目录 MCP 注入环境；Codex `mcpServer/elicitation/request` 使用实际 `{action, content:null}` 响应，SSH 原生重复审批接受后仍必须通过 broker。Codex 文件仅记录环境变量名。
- **验证**：类型检查、完整构建与最终主进程构建通过；`pnpm test:ssh-mcp` 16 项检查涵盖加密、指纹、密码 / 私钥、输出截断、取消、无人值守、审批拒绝、逐命令审批、token 撤销，以及 Pi 三种传输 / 项目与配置启停。`pnpm test:ssh-catalog-electron` 在真实隔离桌面完成保存 / 编辑 / 重开 / 关闭 / 删除，并以 Pi SDK、Claude CLI、Codex app-server 各执行两条命令、每条独立审批；已查看截图。81 项 store、179 项共享提供商及三引擎九条协议加 Codex 续聊回归通过。
- **后续边界**：上述 SSH 与上游模型均为本地测试服务，未连接用户生产服务器；SFTP 留后续。原有临时 SSH 技能 / `~/.ssh/config` 未读取或自动迁移，迁移删除明文另行安排。本轮未打包、安装或发布。

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
| `v0.2.44` | 2026-10-11 | `e43dc4d` / 标签 `v0.2.44` | TODO-055：Mac 窗口控制按钮、按工作区适配初始和最小尺寸、流体云贴合刘海 | 本地构建、渲染端类型检查与胶囊冒烟通过；GitHub 三平台构建和发布成功，清单与下载长度核对通过；服务器暂缓，Mac 真机待验收 |
| `v0.2.33` | 2026-10-08 | `e3ccb59` / 本地标签 `v0.2.33` | TODO-039：HTML / Markdown 默认预览与编辑切换，未保存内容预览与隔离网页交互 | 类型、完整构建、桌面网页与文档 / 模型及保存 / 读取和隔离边界、Office 阅读及启动恢复回归通过；本地 Windows 安装包约 218.0 MiB，包内资源 / 清单 / 预览及启动恢复通过，待用户安装验收 |
| `v0.2.32` | 2026-10-08 | `93b2a67` / 本地标签 `v0.2.32` | TODO-038：本地 PDF、Word、Excel、PPTX 文件点击阅读，后台解析与行列 / 页面导航 | 类型、完整构建、四类真实文件桌面阅读 / 翻页 / 缩放 / 切换 / 文件与内容安全边界通过；功能已包含在 v0.2.33 本地安装包，待用户安装验收 |
| `v0.2.31` | 2026-10-08 | 本地标签 `v0.2.31` | TODO-050：浏览器页面操作不等待整页加载，取消过时显示与截图恢复，修复容器交接与画布切换残留 | 类型、完整构建、原生浏览器与真实应用切换 / 截图竞态 / 菜单提前关闭、启动恢复及画布回归通过；未打包安装 |
| `v0.2.30` | 2026-10-08 | 本地标签 `v0.2.30` | TODO-048：大纲横条改为小圆点与轻量动效，保留点击与键盘导航 | 类型、完整构建、真实桌面尺寸 / 书签 / 键盘跳转 / 减少动态效果及本会话回归通过；未打包安装 |
| `v0.2.29` | 2026-10-08 | 本地标签 `v0.2.29` | TODO-047：本会话面板移除重复大纲，保留聊天左侧入口 | 类型、完整构建、隔离真实桌面重开 / 展开 / 收起、书签与用量保留检查通过；未打包安装 |
| `v0.2.27` | 2026-10-07 | `0e21efa` / 本地标签 `v0.2.27` | TODO-046：胶囊贴顶收放、紧凑流体样式、多任务左右切换与具体执行状态 | 类型、完整与最终主进程构建、原生窗口 / 三任务 / 滑动防误触 / 状态 / 私有 IPC / 点击穿透 / 位置重开及启动回归通过；本地 Windows 安装包约 194.0 MiB，包内资源 / 清单 / 启动恢复通过，待用户安装，多屏物理拖动与 macOS 待验收 |
| `v0.2.26` | 2026-10-07 | 本地标签 `v0.2.26` | TODO-045：会话首图标按最近实际模型显示，引擎收进悬停提示 | 类型、构建、45 项模型、真实桌面普通 / 置顶 / 归档 / 未知 / 新会话、英文与浅深色及启动恢复回归通过；未打包安装 |
| `v0.2.25` | 2026-10-07 | `75bd229` · 本地标签 `v0.2.25` | 修复恢复聊天时侧边栏无限循环，解除启动空白与零项目假象 | 类型、构建、81 项 store、旧配置桌面恢复 / 分页及真实备份副本检查通过；Windows 包、更新清单与打包 ASAR 启动回归通过，待安装验收 |
| `v0.2.24` | 2026-10-07 | 本地标签 `v0.2.24` | TODO-026：可选 SSH 命令扩展与 Pi 通用 MCP | 类型、构建、16 项 SSH / MCP、三引擎双命令审批、设置重开与删除、81 项 store、179 项共享提供商及九条协议回归通过；SFTP 后续 |
| `v0.2.23` | 2026-10-07 | `30629bc` · `v0.2.23` | TODO-025：界面 v3 走查与本地主分支收尾 | 类型、构建、七类工作区双主题、20 个设置页与 26 个设置绘制检查通过；截图已查看，已合入本地 master |
| `v0.2.22` | 2026-10-07 | `4ca9fa1` · `v0.2.22` | TODO-024：旧模型配置导入与密钥规则收尾 | 类型检查、构建、179 项共享提供商、81 项 store 与真实桌面迁移 / 重开 / 凭据验证通过 |
| `v0.2.21` | 2026-10-07 | `994c288` · `v0.2.21` | TODO-023：缓存率、输出速度与首字延迟收尾 | 类型、最终构建、81 项 store、计时 / 缓存用例及三引擎真实本地协议、桌面重开验证通过 |
| `v0.2.20` | 2026-10-07 | `0352622` · `v0.2.20` | TODO-022：回复图片与路径收尾 | 类型检查、最终构建、81 项 store 与真实桌面图片 / 设置 / 历史检查通过；默认手动加载、信任域名、损坏图片回退及同图折叠已验收 |
| `v0.2.13` | 2026-10-07 | `0d35e72` | 修复三协议桥的工具映射、并行工具流、SSE、异常断流、图片结果与思考强度 | 类型检查与构建、共享提供商 179 项、真实引擎本地协议桥 12 项、桌面 9 条接口路径及 Pi host 回归通过；Windows 本地包与更新清单校验通过，本轮未安装、未上传 |
| `v0.2.14` | 2026-10-07 | `01d169e` · 本地标签 `v0.2.14` | TODO-028：侧边栏最近实际模型及持久化 | 类型检查、构建、53 项 store 检查、真实 Electron / SQLite 保存检查通过 |
| `v0.2.15` | 2026-10-07 | `60e4de6` · 本地标签 `v0.2.15` | TODO-029：模型品牌图标与名称 | 类型检查、构建、45 项模型与历史锚点检查通过 |
| `v0.2.16` | 2026-10-07 | `21d169a` · 本地标签 `v0.2.16` | TODO-030：归档随范围筛选与计数 | 类型检查、构建、64 项 store / 归档筛选检查通过 |
| `v0.2.17` | 2026-10-07 | `0a20b2d` · 本地标签 `v0.2.17` | TODO-031：独立分叉与跨聊天上下文引用 | 类型检查、构建、68 项 store、45 项模型与真实保存检查通过；三真实引擎分叉历史及九条协议路径通过（本地模拟服务） |
| `v0.2.18` | 2026-10-07 | `6cacdf1` · 本地标签 `v0.2.18` | TODO-032：可拖动桌面置顶呼吸胶囊 | 类型检查、构建、68 项 store 与真实 Electron 窗口检查通过，实际窗口截图已检查 |
| `v0.2.19` | 2026-10-07 | `24be74c` · 本地标签 `v0.2.19` | TODO-034：@ 文件夹及引用类型保留 | 类型检查、最终构建、81 项 store、45 项模型、真实目录搜索及桌面发送 / 重开历史检查通过，截图已检查；三引擎分叉与九条协议路径通过（本地模拟服务）；Windows 包及 ASAR 内回归通过 |
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
