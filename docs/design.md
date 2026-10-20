# MarioCode 配色规范(以 Claude Desktop 为基准)

> 状态:已落地到原型和应用(2026-10-21,工作区 v0.2.51,未提交),色值待校准。目标是让 MarioCode 的观感与 Claude Desktop 保持一致:暖纸色底、陶土橙强调、低对比的柔和边线。
>
> **色值来源说明**:本机没有 Claude Desktop 安装包,以下色值来自 Anthropic 公开品牌色和对 claude.ai 界面的观察,属于推定值,不是从应用里提取的。落地前请用取色器对照 Claude Desktop 截图校准一遍,校准后改本文件即可,代码侧只认 token。

---

## 一、设计原则

1. **暖色中性色**:所有灰都偏黄(带一点 R>G>B),不使用纯灰或冷灰。
2. **强调色只有一个**:陶土橙(Clay)。它只负责品牌标识、焦点环、运行中状态和链接。
3. **主按钮不用强调色填充**:亮色下用深暖灰近黑,暗色下用 Clay。避免整屏橙色。
4. **层次靠明度,不靠阴影**:三层底(窗口底、内容面、凹陷井)明度差 2% 到 4%,阴影只给弹层。
5. **语义色独立**:成功、警告、危险、信息保持各自色相,不与 Clay 混用。

---

## 二、核心色板

### 2.1 亮色

| 角色 | 值 | 用途 |
|------|-----|------|
| surface | `#FAF9F5` | 中栏、右栏、弹层(Claude 的 ivory) |
| surface-base | `#F0EEE6` | 窗口底:左栏、标题栏 |
| surface-muted | `#E8E5DA` | 凹陷井、代码块底、输入框内嵌区 |
| surface-hover | `rgb(60 50 20 / .05)` | 悬停,active 为 `.085` |
| content | `#2B2A27` | 正文 |
| content-muted | `#5C5A52` | 列表、表格、工具卡标签(需 ≥ 7:1) |
| content-subtle | `#76726A` | 元信息、占位、提示(需 ≥ 4.5:1) |
| edge | `#E8E5DA` | 卡片描边、分隔线 |
| input-edge | `#D8D4C6` | 输入框描边,最强的一档边线 |

### 2.2 暗色

| 角色 | 值 | 用途 |
|------|-----|------|
| surface | `#262624` | 中栏、右栏、弹层 |
| surface-base | `#1F1E1D` | 窗口底 |
| surface-muted | `#30302D` | 凹陷井 |
| surface-hover | `rgb(255 255 255 / .055)` | 悬停,active 为 `.09` |
| content | `#EEECE4` | 正文 |
| content-muted | `#AAA69A` | 次级文字 |
| content-subtle | `#78746A` | 元信息(接近下限,小字需核对对比度) |
| edge | `#34332F` | 描边 |
| input-edge | `#44433E` | 输入框描边 |

### 2.3 强调色:Clay

| 角色 | 亮色 | 暗色 |
|------|------|------|
| accent(填充、图标、焦点环) | `#D97757` | `#E58A63` |
| accent-strong(小号强调文字) | `#A24A26` | `#F0AA8A` |
| accent-soft(选中底、徽标底) | `#FAECE5` | `#33211A` |
| primary(主按钮填充) | `#2B2A27` | `#D97757` |
| on-primary | `#FFFFFF` | `#1C0F09` |
| primary-hover | `#1A1917` | `#E99673` |

注意:`#D97757` 上放白字约 3.3:1,不满足正文对比度。Clay 只作填充或大于 18px 的文字,小号文字一律用 accent-strong。

### 2.4 语义色

沿用现有 token,不随基准改动,只把暗色底的对应背景调暖:

| 角色 | 亮色 | 暗色 |
|------|------|------|
| success / add | `#17794A` | `#5FC98D` |
| danger / del | `#BF3A2B` | `#F0847A` |
| warning | `#A85A0A` | `#EBA35B` |
| info | `#7C3AED` | `#A78BFA` |

---

## 三、使用规则

- **选中态**:accent-soft 底 + 左侧 2px accent 竖线(左栏会话行)。
- **焦点环**:2px accent,外加 2px 同色 30% 透明光晕。
- **运行中**:accent 圆点或细进度条,不使用旋转的整块色块。
- **用户气泡**:中性暖灰 `rgb(60 50 20 / .06)`(亮)与 `rgb(255 255 255 / .06)`(暗),不使用 accent。
- **Diff**:增删色用语义色,背景取 8% 到 12% 透明度,不另设高饱和底。
- **阴影**:仅弹层和悬浮条使用。亮色 `0 12px 40px -10px rgb(0 0 0 / .25)`,暗色加深到 `.7`。

---

## 四、落地映射

### 4.1 原型(`prototypes/ui-refresh-v4.html`)

V4 用 `data-tone` × `data-theme` × `data-accent` 三个正交维度。落地策略:

- 以 `data-tone="warm"` 为默认,并把本文件的数值回填到 `[data-theme][data-tone="warm"]` 块。
- 新增 `--ink`/`--c2`/`--c3` 与本文件的对应:`--ink`=content,`--c2`=content-muted,`--c3`=content-subtle。
- `data-accent="clay"` 设为默认;mint 和 blue 保留作对照,不再作为产品选项。

### 4.2 真实应用(`apps/desktop/src/renderer/styles.css`)

应用 token 使用 `R G B` 三元组(`rgb(var(--surface))`)。V4 已经在应用里分步落地(TODO-044),其中「暖纸」基调(`html[data-tone="warm"]`,v0.2.39)的表面、文字、边框值已经与本规范一致,所以底色不用再改,只需要:

1. **默认基调改为暖纸**:`sessionStore` 的 `themeTone` 初值、首帧 FOUC 守卫(`lib/theme.ts`)、主进程 `getThemeTonePreference`(窗口底色、标题栏按钮区)三处同时改,否则首帧会闪一下中性色。只有显式存过 `neutral` 的用户保持中性。
2. **强调色改为 Clay**:`styles.css` 的 `:root` 与 `.dark` 里 `--accent`、`--accent-strong`、`--primary`、`--on-primary`。
3. **Clay 填充上不放白字**:`bg-accent text-white` 的三处(发送按钮、未读徽标、元素拾取条)改用 `bg-primary text-primary-on`。
4. **设置页**:强调色预设新增 Clay 并设为第一项,默认值与「主题默认色」词条同步。

仍保留 mint 作为可选预设。写死 mint 的地方(图标、品牌渐变、`git-lane`)需要另行检查,见第五节。

---

## 五、待校准

1. 用 Claude Desktop 截图取色,核对 surface、surface-base、accent 三个主色。
2. 暗色 `content-subtle` 的对比度需要实测。
3. 品牌 logo 目前是 mint,是否随强调色改为 Clay,需要单独决定。
4. 手绘主题(纸面 / 牛皮纸)与本规范的关系:建议作为独立主题保留,不受本规范约束。
