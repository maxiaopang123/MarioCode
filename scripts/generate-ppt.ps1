#Requires -Version 5.1
<#
  MarioCode 介绍 PPT（v2）——通过 COM 驱动 PowerPoint.Application 生成。
  窗口保持可见，可以看到每一页的生成过程。保存为 UTF-8 with BOM，否则 PowerShell 5.1 会把中文当 ANSI 读。
  用法：powershell -NoProfile -ExecutionPolicy Bypass -File scripts/generate-ppt.ps1
#>
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$outFile = Join-Path $root 'MarioCode-介绍-v2.pptx'
$script:idx = 0
$script:warn = @()

# ---- 配色：取自 styles.css（石墨主色 + 薄荷强调 + 暖灰中性色） ----
function Rgb([int]$r, [int]$g, [int]$b) { return $r + 256 * $g + 65536 * $b }
$NONE = -1
$INK = Rgb 26 26 25
$MUTED = Rgb 82 82 78
$SUBTLE = Rgb 112 112 107
$EDGE = Rgb 228 228 225
$SURFACE = Rgb 246 246 245
$WHITE = Rgb 255 255 255
$GRAPH = Rgb 40 56 51
$GRAPH2 = Rgb 49 68 62
$MINT = Rgb 139 192 163
$MINTD = Rgb 92 160 128
$MINTL = Rgb 226 240 232
$ACC = Rgb 44 112 83
$ONDARK = Rgb 176 196 186
$FONT = 'Microsoft YaHei UI'

function New-Slide($bg) {
  $script:idx++
  $s = $pres.Slides.Add($script:idx, 12)
  $s.FollowMasterBackground = 0
  $s.Background.Fill.Solid()
  $s.Background.Fill.ForeColor.RGB = $bg
  Start-Sleep -Milliseconds 400
  return $s
}

# 矩形 / 圆角矩形 / 其他形状；$text 非空时在形状内居中写字
function Box($s, $x, $y, $w, $h, $fill, $line = -1, $round = 0.0, $shape = 1, $text = '', $size = 11, $color = 0, $bold = $false) {
  $type = $shape
  if ($round -gt 0) { $type = 5 }
  $b = $s.Shapes.AddShape($type, $x, $y, $w, $h)
  if ($round -gt 0) { $b.Adjustments.Item(1) = $round }
  if ($fill -lt 0) { $b.Fill.Visible = 0 } else { $b.Fill.Solid(); $b.Fill.ForeColor.RGB = $fill }
  if ($line -lt 0) { $b.Line.Visible = 0 } else { $b.Line.ForeColor.RGB = $line; $b.Line.Weight = 0.75 }
  $b.Shadow.Visible = 0
  if ($text -ne '') {
    $tf = $b.TextFrame
    $tf.WordWrap = -1
    $tf.MarginLeft = 4; $tf.MarginRight = 4; $tf.MarginTop = 1; $tf.MarginBottom = 1
    $tf.VerticalAnchor = 3
    $r = $tf.TextRange
    $r.Text = $text
    $r.Font.Name = $FONT; $r.Font.NameFarEast = $FONT
    $r.Font.Size = $size; $r.Font.Color.RGB = $color
    if ($bold) { $r.Font.Bold = -1 } else { $r.Font.Bold = 0 }
    $r.ParagraphFormat.Alignment = 2
  }
}

# 文本框；超出高度会记入告警，结束时统一报告
function Txt($s, $x, $y, $w, $h, $text, $size = 14, $color = 0, $bold = $false, $align = 1, $space = 0, $font = $FONT) {
  $t = $s.Shapes.AddTextbox(1, $x, $y, $w, $h)
  $tf = $t.TextFrame
  $tf.WordWrap = -1
  $tf.AutoSize = 0
  $tf.MarginLeft = 0; $tf.MarginRight = 0; $tf.MarginTop = 0; $tf.MarginBottom = 0
  $t.Height = $h
  $r = $tf.TextRange
  $r.Text = $text
  $r.Font.Name = $font; $r.Font.NameFarEast = $font
  $r.Font.Size = $size; $r.Font.Color.RGB = $color
  if ($bold) { $r.Font.Bold = -1 } else { $r.Font.Bold = 0 }
  $r.ParagraphFormat.Alignment = $align
  $r.ParagraphFormat.SpaceWithin = 1.15
  if ($space -gt 0) { $r.ParagraphFormat.SpaceAfter = $space }
  if ($r.BoundHeight -gt ($h + 2)) {
    $head = $text.Substring(0, [Math]::Min(18, $text.Length)) -replace "`r", ' '
    $script:warn += ('第 {0} 页文字溢出（需要 {1:N0}，可用 {2}）：{3}' -f $script:idx, $r.BoundHeight, $h, $head)
  }
}

function Ln($s, $x1, $y1, $x2, $y2, $color, $w = 1.0, $arrow = $false) {
  $l = $s.Shapes.AddLine($x1, $y1, $x2, $y2)
  $l.Line.ForeColor.RGB = $color
  $l.Line.Weight = $w
  if ($arrow) { $l.Line.EndArrowheadStyle = 2 }
}

# 内容页统一页头：小标题 + 大标题 + 一句话说明
function Head($s, $kicker, $title, $sub = '') {
  Txt $s 60 38 600 16 $kicker 11 $ACC $true
  Txt $s 60 58 840 44 $title 30 $INK $true
  if ($sub -ne '') { Txt $s 60 104 840 22 $sub 14 $MUTED }
}

function Footer($s, $dark = $false) {
  $c = $SUBTLE
  if ($dark) { $c = $ONDARK }
  Txt $s 60 508 400 14 'MarioCode · v0.2.45' 9 $c
  Txt $s 800 508 100 14 ('{0:00}' -f $script:idx) 9 $c $false 3
}

# ---- 启动 PowerPoint（窗口可见） ----
$app = New-Object -ComObject PowerPoint.Application
$app.Visible = -1
$app.WindowState = 3
$pres = $app.Presentations.Add(-1)
$pres.PageSetup.SlideWidth = 960
$pres.PageSetup.SlideHeight = 540
Write-Host 'PowerPoint 已打开，开始生成幻灯片……'

# ===== 第 1 页：封面 =====
$s = New-Slide $GRAPH
Box $s 560 -150 520 520 $GRAPH2 $NONE 0 9
Box $s 730 330 330 330 (Rgb 44 62 56) $NONE 0 9
Txt $s 60 78 500 18 'FREE · OPEN SOURCE · DESKTOP' 12 $MINT $true
Txt $s 60 168 700 100 'MarioCode' 76 $WHITE $true
Txt $s 60 282 760 40 '把 Claude Code、Codex 与 Pi 装进同一个桌面应用' 24 $MINTL
Txt $s 60 334 760 24 '免费开源的编程 Agent 桌面客户端 · MIT 协议' 15 $ONDARK
Box $s 60 440 92 30 $NONE $MINT 0.5 1 'v0.2.45' 12 $MINT $true
Box $s 164 440 150 30 $NONE $MINT 0.5 1 'Windows · macOS' 12 $MINT $true
Box $s 326 440 236 30 $NONE $MINT 0.5 1 'Electron · React · TypeScript' 12 $MINT $true

# ===== 第 2 页：定位 =====
$s = New-Slide $SURFACE
Head $s '01 · 定位' '不重造 Agent，把 Agent 的操作界面做好' '基于官方 SDK 驱动 Agent；会话、审批、编辑器、浏览器等交互层由 MarioCode 负责。'
$cards = @(
  @('1', '官方 SDK 驱动', 'Claude Agent SDK、Codex app-server、Pi Coding Agent。不改写 Agent 的推理与工具循环，只做界面与集成。'),
  @('2', '完整的交互界面', '实时流式输出、工具审批、计划模式，加上文件树、Monaco 编辑器、Git、终端和内置浏览器。'),
  @('3', '一个应用，多个引擎', '新会话开始前选择引擎；同一套界面按各引擎声明的能力自动适配。')
)
for ($i = 0; $i -lt 3; $i++) {
  $x = 60 + $i * 286
  Box $s $x 152 268 232 $WHITE $EDGE 0.04
  Box $s ($x + 22) 174 34 34 $MINTL $NONE 0.3 1 $cards[$i][0] 15 $ACC $true
  Txt $s ($x + 22) 226 224 26 $cards[$i][1] 18 $INK $true
  Txt $s ($x + 22) 262 224 110 $cards[$i][2] 13 $MUTED
}
Box $s 60 410 840 62 $GRAPH $NONE 0.12 1 'Codex 与 Pi 可自定义模型服务商（OpenAI 兼容 / Responses API），第三方网关同样可用' 14 $WHITE $false
Footer $s

# ===== 第 3 页：三引擎 =====
$s = New-Slide $SURFACE
Head $s '02 · 引擎' '三个引擎，一套界面' '会话开始前选一个引擎；运行时按需下载，安装包不内置。'
$prov = @(
  @('Claude', 'Claude Agent SDK', '官方 Agent SDK。支持思考强度、权限模式和内置模型选择，也可以配置自定义端点。', $GRAPH),
  @('Codex', 'OpenAI Codex app-server', '支持第三方模型服务商（OpenAI 兼容 / Responses API），可按模型覆盖上下文窗口（如 1M），生成的图片直接显示在对话里。', $MINTD),
  @('Pi', 'Pi Coding Agent', '在 设置 → 模型 中配置服务商与模型；API Key 通过 Electron safeStorage 加密保存。', $MINT)
)
for ($i = 0; $i -lt 3; $i++) {
  $x = 60 + $i * 286
  Box $s $x 150 268 252 $WHITE $EDGE 0.04
  Box $s $x 150 268 10 $prov[$i][3]
  Txt $s ($x + 22) 182 224 36 $prov[$i][0] 28 $INK $true
  Txt $s ($x + 22) 224 224 18 $prov[$i][1] 12 $ACC $true
  Txt $s ($x + 22) 256 224 130 $prov[$i][2] 13 $MUTED
}
Box $s 60 424 840 50 $MINTL $NONE 0.14 1 'AgentProvider 抽象层：引擎声明各自能力，界面自动适配（思考强度、权限模式、模型、自定义端点）' 13 $ACC $true
Footer $s

# ===== 第 4 页：对话与审批 =====
$s = New-Slide $SURFACE
Head $s '03 · 对话' '看得见 Agent 在做什么，也管得住' '逐字流式输出，每一次工具调用都可以审批，改坏了可以回退。'
$feat = @(
  @('实时流式', '回复、思考、工具调用和结果以结构化卡片逐字呈现，长任务不用盯终端。'),
  @('工具审批', '允许 / 始终允许 / 拒绝；多个请求按会话排队，不会漏掉。'),
  @('计划模式', 'Agent 先调研并给出方案，你确认后才开始动手。'),
  @('逐轮回退', '每轮保留文件快照，一键恢复该轮 Agent 改过的文件。')
)
for ($i = 0; $i -lt 4; $i++) {
  $x = 60 + ($i % 2) * 274
  $y = 150 + [Math]::Floor($i / 2) * 166
  Box $s $x $y 262 150 $WHITE $EDGE 0.05
  Box $s ($x + 20) ($y + 22) 6 22 $MINTD
  Txt $s ($x + 36) ($y + 20) 210 26 $feat[$i][0] 17 $INK $true
  Txt $s ($x + 20) ($y + 60) 224 80 $feat[$i][1] 13 $MUTED
}
# 审批卡片示意
Box $s 620 150 280 316 $WHITE $EDGE 0.05
Txt $s 640 166 240 14 '示意 · 工具审批' 10 $SUBTLE
Box $s 640 192 56 22 $MINTL $NONE 0.3 1 'Bash' 11 $ACC $true
Txt $s 706 196 180 16 'Agent 请求执行命令' 12 $MUTED
Box $s 640 230 240 74 $SURFACE $EDGE 0.08
Txt $s 652 242 216 52 'pnpm test --filter desktop' 12 $INK $false 1 0 'Consolas'
Box $s 640 328 240 36 $GRAPH $NONE 0.18 1 '允许' 13 $WHITE $true
Box $s 640 372 116 34 $WHITE $EDGE 0.18 1 '始终允许' 12 $INK $false
Box $s 764 372 116 34 $WHITE $EDGE 0.18 1 '拒绝' 12 (Rgb 220 38 38) $false
Txt $s 640 424 240 32 '待审批请求按会话排队，切换会话也不会丢失。' 11 $SUBTLE
Footer $s

# ===== 第 5 页：IDE =====
$s = New-Slide $SURFACE
Head $s '04 · 工作区' '一个窗口里的完整开发环境' '不用在编辑器、终端和 Git 工具之间来回切换。'
Box $s 60 150 440 316 $WHITE $EDGE 0.02
Box $s 60 150 440 22 $SURFACE $EDGE
Box $s 60 172 100 294 $SURFACE $EDGE
Box $s 160 172 190 210 $WHITE $EDGE
Box $s 350 172 150 210 $WHITE $EDGE
Box $s 160 382 340 84 (Rgb 24 25 24) $EDGE
Txt $s 70 182 80 14 '项目 / 会话' 10 $SUBTLE
Txt $s 170 182 100 14 '对话' 10 $SUBTLE
Txt $s 360 182 130 14 '文件 · 编辑器 · Git' 10 $SUBTLE
Txt $s 170 392 100 14 '终端' 10 $MINT $true
Box $s 74 204 72 14 $EDGE $NONE 0.4
Box $s 74 224 56 14 $MINTL $NONE 0.4
Box $s 74 244 66 14 $EDGE $NONE 0.4
Box $s 174 206 110 14 $EDGE $NONE 0.4
Box $s 174 232 160 40 $MINTL $NONE 0.1
Box $s 174 286 130 14 $EDGE $NONE 0.4
Box $s 174 316 160 40 $MINTL $NONE 0.1
Box $s 364 206 122 14 $EDGE $NONE 0.4
Box $s 364 232 122 96 $SURFACE $NONE 0.06
Txt $s 176 414 150 14 '$ pnpm dev' 10 $MINT $false 1 0 'Consolas'
$areas = @(
  @('左 · 项目与会话', '多项目管理、分组与置顶；会话随时恢复；用 Git worktree 并行跑多个会话。'),
  @('中 · 对话', '流式回复、工具卡片、审批与计划模式都在这一栏。'),
  @('右 · 文件与 Git', 'Monaco 编辑器（编辑 / 对比 / 预览），多仓库 Git，AI 生成提交信息。'),
  @('下 · 终端', '多标签终端（xterm.js + node-pty），切换项目不会中断后台任务。')
)
for ($i = 0; $i -lt 4; $i++) {
  $y = 150 + $i * 80
  Box $s 540 ($y + 2) 4 60 $MINTD
  Txt $s 558 $y 342 20 $areas[$i][0] 15 $INK $true
  Txt $s 558 ($y + 26) 342 40 $areas[$i][1] 12 $MUTED
}
Footer $s

# ===== 第 6 页：内置浏览器 =====
$s = New-Slide $SURFACE
Head $s '05 · 浏览器' '内置浏览器：你能用，Agent 也能用' '同一个窗口里看网页、选元素，也让 Agent 操作页面。'
Box $s 60 150 410 218 $WHITE $EDGE 0.04
Box $s 490 150 410 218 $WHITE $EDGE 0.04
Txt $s 82 168 366 22 '你可以' 16 $ACC $true
Txt $s 82 202 366 156 ('多标签页，登录状态跨重启保留' + "`r" + '书签、历史、下载与隐私清理' + "`r" + '桌面 / iPhone / Android 预设，带视口与触摸模拟' + "`r" + '元素拾取：点选页面元素，把 HTML 与选择器发进对话') 13 $MUTED $false 1 9
Txt $s 512 168 366 22 'Agent 可以' 16 $ACC $true
Txt $s 512 202 366 156 ('导航、页面快照、点击、输入、滚动、截图（真实输入事件）' + "`r" + '每个会话使用独立的浏览器视图，互不干扰' + "`r" + '空闲视图自动回收，单个会话最多同时保留 3 个' + "`r" + '遇到登录或验证码，可以把页面交给你') 13 $MUTED $false 1 9
Txt $s 60 392 400 16 '接管流程' 12 $INK $true
$flow = @('Agent 操作页面', '遇到登录 / 验证', '页面交给你', '你完成操作', 'Agent 继续')
for ($i = 0; $i -lt 5; $i++) {
  $x = 60 + $i * 172
  $fill = $WHITE
  $tc = $INK
  if ($i -eq 2 -or $i -eq 3) { $fill = $MINTL; $tc = $ACC }
  Box $s $x 418 140 44 $fill $EDGE 0.2 1 $flow[$i] 12 $tc $true
  if ($i -lt 4) { Ln $s ($x + 144) 440 ($x + 168) 440 $SUBTLE 1.25 $true }
}
Footer $s

# ===== 第 7 页：扩展能力 =====
$s = New-Slide $SURFACE
Head $s '06 · 扩展' '插件、MCP、语言服务与并行会话' '把团队常用的能力装进来，三个引擎同样可用。'
$ext = @(
  @('插件与 MCP', '从市场 / Git 仓库 / 本地文件夹 / zip 安装。一个插件可带技能、斜杠命令、子代理、MCP 服务器和 hooks。' + "`r" + '安装后默认禁用，先看组件清单再启用。'),
  @('语言服务器 LSP', 'TypeScript / JavaScript、Python（basedpyright）、Go（gopls）、Java（jdtls），一键安装启用。' + "`r" + '编辑器里有跳转定义、查找引用、悬停提示和实时诊断。'),
  @('Worktree 并行会话', '在同一仓库的独立 worktree 里开会话，多条线并行互不干扰。' + "`r" + '完成后一键合并回主分支，未提交改动会先自动提交。')
)
for ($i = 0; $i -lt 3; $i++) {
  $x = 60 + $i * 286
  Box $s $x 150 268 262 $WHITE $EDGE 0.04
  Box $s ($x + 22) 172 40 40 $MINTL $NONE 0.28 1 ('{0}' -f ($i + 1)) 16 $ACC $true
  Txt $s ($x + 22) 226 224 26 $ext[$i][0] 18 $INK $true
  Txt $s ($x + 22) 262 224 142 $ext[$i][1] 12 $MUTED $false 1 6
}
Box $s 60 430 840 44 $SURFACE $EDGE 0.14 1 '另有：AI 提交信息、AI 合并冲突解决、语音输入、鼠标手势、用量统计' 13 $MUTED $false
Footer $s

# ===== 第 8 页：手机远程 =====
$s = New-Slide $SURFACE
Head $s '07 · 移动端' '用手机远程控制桌面上的会话' '局域网扫码配对，或通过自己的 VPS 在任何地方连回来。'
# 手机示意
Box $s 96 140 168 340 $GRAPH $NONE 0.14
Box $s 106 160 148 300 $WHITE $NONE 0.08
Box $s 150 148 60 5 $GRAPH2 $NONE 0.5
Box $s 116 176 92 14 $EDGE $NONE 0.4
Box $s 116 202 128 44 $MINTL $NONE 0.12
Box $s 116 256 108 14 $EDGE $NONE 0.4
Box $s 116 282 128 62 $SURFACE $NONE 0.1
Box $s 116 372 128 32 $GRAPH $NONE 0.3 1 '批准' 11 $WHITE $true
Box $s 116 412 128 30 $WHITE $EDGE 0.3 1 '拒绝' 11 (Rgb 220 38 38) $false
Txt $s 96 488 168 14 '示意 · 手机端审批' 9 $SUBTLE $false 2
# 两种连接方式
Box $s 320 150 280 150 $WHITE $EDGE 0.05
Txt $s 340 168 240 22 '局域网' 18 $INK $true
Txt $s 340 202 240 90 ('桌面端提供伴侣网页应用' + "`r" + '手机扫二维码完成配对' + "`r" + '设备令牌认证') 13 $MUTED $false 1 5
Box $s 620 150 280 150 $WHITE $EDGE 0.05
Txt $s 640 168 240 22 '远程（SSH 反向隧道）' 18 $INK $true
Txt $s 640 202 240 90 ('通过你自己的 VPS 连接' + "`r" + '不依赖第三方穿透服务' + "`r" + '随时随地接入') 13 $MUTED $false 1 5
Box $s 320 320 580 150 $GRAPH $NONE 0.05
Txt $s 344 338 532 22 '手机上能做什么' 16 $MINT $true
$mob = @('实时查看会话输出', '发消息 · 中断 · 回退', '批准 / 拒绝工具调用', '浏览文件与 Diff', '执行 Git 操作', 'AI 生成提交信息')
for ($i = 0; $i -lt 6; $i++) {
  $x = 344 + ($i % 3) * 180
  $y = 376 + [Math]::Floor($i / 3) * 40
  Box $s $x ($y + 6) 6 6 $MINT $NONE 0 9
  Txt $s ($x + 16) $y 160 20 $mob[$i] 13 $WHITE
}
Footer $s

# ===== 第 9 页：技术栈 =====
$s = New-Slide $SURFACE
Head $s '08 · 技术' '一套类型贯穿的 Electron 应用' '主进程负责 Agent、数据与系统能力；渲染进程只通过校验过的 IPC 调用。'
$stack = @(
  @('外壳', 'Electron 33 · electron-vite · electron-builder 25'),
  @('前端', 'React 19 · Zustand 5 · Tailwind CSS 3 · @base-ui/react'),
  @('编辑与终端', 'Monaco Editor · xterm.js 6 · node-pty'),
  @('Agent', 'claude-agent-sdk 0.3.258 · Codex 0.153.4 · Pi 0.83.0'),
  @('数据', 'better-sqlite3（同步 SQLite，会话持久化）'),
  @('契约与工程', 'zod 跨进程 IPC 校验 · pnpm 11 · Turbo · TypeScript 5 strict')
)
for ($i = 0; $i -lt 6; $i++) {
  $y = 150 + $i * 54
  Box $s 60 $y 540 46 $WHITE $EDGE 0.12
  Txt $s 78 ($y + 14) 110 20 $stack[$i][0] 13 $ACC $true
  Txt $s 190 ($y + 14) 400 20 $stack[$i][1] 12 $INK
}
# 进程边界示意
Box $s 630 150 270 316 $WHITE $EDGE 0.05
Txt $s 650 166 230 14 '进程边界' 10 $SUBTLE
Box $s 650 190 230 72 $SURFACE $EDGE 0.1 1 '渲染进程' 14 $INK $true
Txt $s 650 232 230 16 'React · Zustand' 10 $SUBTLE $false 2
Box $s 650 292 230 26 $MINTL $NONE 0.3 1 'IPC · zod 校验' 11 $ACC $true
Ln $s 765 262 765 292 $SUBTLE 1.25 $true
Ln $s 765 318 765 348 $SUBTLE 1.25 $true
Box $s 650 348 230 100 $GRAPH $NONE 0.1
Txt $s 650 362 230 22 '主进程' 14 $WHITE $true 2
Txt $s 662 392 206 48 'Agent 提供方 · SQLite · 浏览器 · 终端 · Git' 11 $ONDARK $false 2
Footer $s

# ===== 第 10 页：开始使用 =====
$s = New-Slide $GRAPH
Box $s 600 -120 480 480 $GRAPH2 $NONE 0 9
Txt $s 60 72 500 16 'GET STARTED' 12 $MINT $true
Txt $s 60 100 700 60 '现在就试试' 44 $WHITE $true
Txt $s 60 168 640 24 '安装包不内置 Agent 运行时，首次使用时按需下载。' 15 $ONDARK
Box $s 60 224 400 156 $GRAPH2 $NONE 0.05
Txt $s 82 240 356 20 '下载安装包' 15 $MINT $true
Txt $s 82 272 356 100 ('GitHub Releases' + "`r" + 'Windows：NSIS 安装包（x64）' + "`r" + 'macOS：dmg（Apple 芯片 / Intel）') 13 $WHITE $false 1 6
Box $s 480 224 420 156 $GRAPH2 $NONE 0.05
Txt $s 502 240 376 20 '从源码运行' 15 $MINT $true
Txt $s 502 272 376 40 'pnpm install' 14 $WHITE $false 1 6 'Consolas'
Txt $s 502 302 376 40 'pnpm dev' 14 $WHITE $false 1 6 'Consolas'
Txt $s 502 340 376 30 '需要 Node.js 22.13+ 与 pnpm 9+' 12 $ONDARK
Txt $s 60 412 840 20 'github.com/maxiaopang123/MarioCode' 16 $MINT $true
Txt $s 60 440 840 36 '安装包未做代码签名，首次打开系统会给出警告，属预期现象；README 里有各系统的放行方法。MIT 开源，欢迎 Star。' 12 $ONDARK
Footer $s $true

# ---- 保存并报告 ----
if (Test-Path $outFile) { Remove-Item $outFile -Force }
$pres.SaveAs($outFile)
Write-Host ('已保存：{0}（{1} 页）' -f $outFile, $pres.Slides.Count)
if ($script:warn.Count -gt 0) {
  Write-Host '文字溢出告警：' -ForegroundColor Yellow
  $script:warn | ForEach-Object { Write-Host ('  ' + $_) -ForegroundColor Yellow }
} else {
  Write-Host '未检测到文字溢出。'
}
# 保持窗口打开，便于查看；需要关闭时手动关

