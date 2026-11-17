# claude-code-status (ccs)

轻量、零依赖的 [Claude Code](https://github.com/anthropics/claude-code) 终端状态栏工具。

简体中文 | [English](README.en.md)

---

## 效果预览

### 默认模式 (核心 4 字段极简风)
```text
claude-3-7-sonnet | [██░░░░░░] 29% (58.0k/200.0k) | your-project | main*
```

### 完整特性模式 (取消注释全部可选特性后)
```text
Sonnet 3.7 | [██░░░░░░] 29% (58.0k/200.0k) | $0.18 (¥1.34) | 5h:28%(2h14m) | Cache:92% | your-project | main* | +185/-32 | MCP:2 | [effort: high]
```

---

## 核心设计与优势亮点

状态栏是终端在高频输入、命令执行和会话交互时反复被调用的子进程。`claude-code-status` 的设计核心是**极速的冷启动响应**、**零维护成本**与**稳定的跨平台表现**：

- **零外部依赖 (Zero Dependencies)**：仅使用 Node.js 原生内置模块（`fs`、`path`、`child_process`、`crypto`）。只要机器上能运行 Claude Code，就无需下载任何第三方包或配置额外运行环境。
- **低开销设计**：避免第三方运行时和常驻后台进程，并通过 Git 短时缓存和大文件尾部读取降低频繁刷新成本。
- **1~3ms 低延迟启动**：由于状态栏每次重绘都会以新进程拉起，几毫秒内的执行耗时能避免终端打字过程中的掉帧和迟滞感。
- **原生跨平台兼容**：在 Windows（PowerShell / CMD）、macOS 和 Linux 上开箱即用，无需安装 `bash`、`jq` 或 WSL，无论路径分隔符还是终端字符编码均原生适配。
- **大型代码库 Git 保护**：在超大单体仓库中，高频调用 `git status` 极易拖慢终端。本项目通过系统临时目录提供短时缓存（默认 2 秒 TTL），并配置了 2 秒超时熔断，兼顾信息实时性与系统流畅度。
- **安全读取长对话**：在回退读取会话 Token 消耗时，通过底层反向分块读取（仅读末尾 64KB 缓冲区），避免全量加载数十兆长对话 JSONL 文件导致的内存暴涨，有效降低大文件解析带来的 I/O 与性能开销。
- **中转站与代理倍率计费适配**：针对使用第三方 API 中转站或代理服务的场景，Claude Code 内部仅上报官方标准价（`total_cost_usd`）。本项目支持配置代理加价倍率（`costMultiplier`）与汇率（`exchangeRate`），直接按中转站实际倍率自动折算美元或人民币支出。

---

## 功能特性

- **精简默认项**：默认仅展示最核心的 4 项：模型名称、上下文进度条、项目目录名、Git 分支与脏状态。
- **极客短命令 `ccs` 与原生 Slash Command**：全局安装后支持使用 3 字符短别名 `ccs` 进行全部操作；安装时自动接入 Claude Code 原生斜杠命令（`~/.claude/commands/ccs.md`），在 Claude Code 内直接输入 `/ccs` 即可免切窗口即时调整配置。
- **交互式特性面板 `ccs menu`**：纯原生零依赖终端开关面板，免记长配置参数，一键开关 Git 冲突拦截、突增防线、标题同步等高级选项。
- **Git 冲突与暂存区防误丢警示**：零子进程原生感知 Git rebase/merge 冲突（`⚠️CONFLICT:2`）；可选开启暂存区防丢提醒（`showGitStagedAlert`，如 `(+2 staged)`），严防误重置与代码污染。
- **上下文暴增预警与安全轮次预估**：单轮 Token 暴增时触发红色 `⚠️SURGE(+35k)` 醒目标签；可选开启安全可用轮次预估（`showContextRunway`，如 `(~2 turns left)`），精准预判执行 `/compact` 时机。
- **单轮消费暴涨防线**：支持单轮次花费差值追踪（`showCostDelta`，如 `(+$0.15)`），单轮超额突增时高亮告警（`costSurgeThreshold`，如 `(+$0.82⚠️)`），防范 Extended Thinking 导致账单失控。
- **终端分屏/窗口标题同步**：可选开启 `syncTerminalTitle: true`，通过 ANSI OSC 0 协议直接同步终端窗口/标签页标题（如 `Claude: my-project [task] (main)`），彻底解决 3~5 个终端分屏任务混淆痛点且 0 字符宽度占用。
- **IDE 协议深度直达链接**：支持将项目路径超链接配置为 `ideLink: "vscode"` 或 `"cursor"`，在终端一键点击直接在代码编辑器中打开项目工程。
- **进度条质感风格多样化**：支持配置 `progressBarStyle` 为经典方块（`blocks` `[██░░]`）、极细线条（`smooth` `[━━┈┈]`）、圆点（`dots` `[●●○○]`）与 ASCII 等号（`ascii` `[==--]`）。
- **色彩主题预设**：内置 4 套精调调色板：`default`（标准兼容 ANSI）、`catppuccin`（Mocha 柔和马卡龙）、`nord`（北极光冷淡蓝灰）、`tokyo`（Tokyo Night 赛博暗夜）。
- **模型别名与美化**：自动剥离模型名称末尾的冗长日期后缀（如 `claude-3-7-sonnet-20250219` 自动简化为 `claude-3-7-sonnet`），并支持在配置文件中设置个性化别名。
- **会话费用换算与中转倍率计算**：以 Claude Code 上报的 `total_cost_usd` 为基准，支持设置中转站/代理倍率（`costMultiplier`，如 1.5 倍）和汇率（`exchangeRate`），自动计算实际消费金额（支持 USD、CNY 或双币种对照展示，亦可附带 `(x1.5)` 倍率角标；注：基于官方输出数据折算，非本地自主统计 Token 账单）。
- **多周期限额监控与消耗趋势**：展示 Claude Code 提供的 5 小时、7 天及月度限额信息，并显示重置倒计时（如 `5h:28%(2h14m)`），支持可选的消耗速度趋势指示（`showRateLimitTrend`，`↑` 偏快 / `↓` 偏慢）。
- **会话持续时间**：可选监控当前会话已运行时间（如 `38m`、`1h 24m`）。
- **Token 消耗明细**：可选展示 Input、Cache、Output 各环节 Token 用量（如 `I:12k C:320k O:18k`）。
- **MCP 服务扫描**：扫描用户级和项目级 MCP 配置，并统计其中配置的 MCP Server 数量（如 `MCP:2`）。
- **Prompt 缓存监控**：展示 Prompt Cache 缓存命中率（`Cache:92%`）。
- **代码吞吐量统计**：实时统计会话增删代码行数（`+185/-32`）。
- **自适应自动布局**：支持单行（`lines: 1`）、双行（`lines: 2`）及根据终端实际宽度智能自适应折行（`lines: "auto"`）。
- **宽容的 JSONC 配置**：配置文件支持 `//` 单行注释、`/* */` 多行注释与尾随逗号。

---

## 安装与使用

### 方式 1: npm 全局安装 (推荐)

```bash
npm install -g claude-code-status

# 自动写入 ~/.claude/settings.json 配置
ccs install
# 亦可使用完整命令名:
claude-code-status install
```

安装后，您可以在终端任意位置直接使用 **`ccs`** 命令：
```bash
ccs ui                   # 交互式选择排版风格 (单行、双行、圆点、斜杠、圆角胶囊、尖角箭头、窄屏紧凑、Unicode 符号)
ccs menu                 # 交互式特性面板 (一键切换突增告警、轮次预估、IDE跳转、进度条形状)
ccs theme catppuccin     # 切换色彩主题 (default, catppuccin, nord, tokyo)
ccs delimiter /          # 自定义分隔符号 (如 / 或 •)
ccs set <key> <val>      # 快速修改配置 (如 ccs set showRateLimitPace true 或 ccs set lines 2)
ccs get [key]            # 读取配置项当前生效值 (如 ccs get fields)
ccs config list          # 查看所有配置项、当前值与自定义状态
ccs export [file]        # 导出当前全部定制配置到文件或终端输出
ccs import <file>        # 从外部文件导入配置 (自动创建备份)
ccs reset [config|cache] # 重置配置为默认模板或清除 Git 状态缓存
ccs preview              # 终端全场景效果预览
ccs doctor               # 检查配置合法性、Settings绑定、Git运行状态与渲染延迟基准
ccs export [file]        # 导出当前生效配置为 JSONC 文件 (或输出至标准输出)
ccs import <file>        # 导入并应用配置文件 (自动保留 .bak 备份)
ccs reset [config|cache] # 重置配置为默认模板或清除 Git 状态缓存
ccs uninstall            # 从 Claude Code 设置中安全移除状态栏配置
```

### 方式 2: npx 体验

```bash
# 仅推荐用于临时快速体验或执行配置管理
npx claude-code-status install
```

> [!NOTE]
> 可以使用 `npx claude-code-status` 快速体验或运行安装与配置管理，但**不推荐**用 `npx` 作为长期的 statusLine 运行命令。由于状态栏在终端每次刷新时都会拉起进程，使用 `npx` 可能会引入额外的包解析与网络检查开销，导致状态栏卡顿。适合临时体验，不建议作为长期配置。

### 方式 3: Git 源码克隆

```bash
git clone https://github.com/PipiCraft/claude-code-status.git
cd claude-code-status
node ./bin/cli.js install
```

### 💡 CC-Switch 用户特别说明

如果你使用 [CC-Switch](https://github.com/tiann/cc-switch) 来管理和切换 Claude Code 供应商路由，CC-Switch 在切换或添加供应商时会重写 `~/.claude/settings.json`。为避免配置被覆盖失效，请按以下步骤配置：

1. 打开任意供应商卡片的 **「编辑」** 页面，滚动到**页面最下方**。
2. 选择以下任意一种方式添加状态栏配置：
   - **推荐（全局通用）**：点击下方的 **「编辑通用配置」**，在配置 JSON 中添加如下内容并保存。之后每次切换或添加任意供应商，CC-Switch 都会自动携带状态栏配置：
     ```json
     {
       "statusLine": {
         "type": "command",
         "command": "ccs"
       }
     }
     ```
   - **仅当前供应商生效**：直接在编辑页面最下方的 **配置 JSON** 输入框里加入 `"statusLine"` 代码块并保存。

> [!TIP]
> 如果是在单个供应商的配置 JSON 里直接添加，通常原有已有 `"env": { ... }`，只需在它后面用逗号 `,` 分隔加上 `"statusLine"` 这一段即可。

---

## 主题与排版

### 切换调色板主题
```bash
ccs theme default        # 经典标准 ANSI 16 色 (高兼容)
ccs theme catppuccin     # Mocha 柔和马卡龙 24-bit TrueColor
ccs theme nord           # 北极光冷淡蓝灰 24-bit TrueColor
ccs theme tokyo          # Tokyo Night 赛博暗夜 24-bit TrueColor
ccs theme dracula        # Dracula 吸血鬼暗紫 24-bit TrueColor
ccs theme gruvbox        # Gruvbox 复古胡桃木暖橙 24-bit TrueColor
ccs theme solarized-dark # Solarized 经典暗青蓝 24-bit TrueColor
```

### 修改分隔符 (Delimiter)
```bash
ccs delimiter /     # 斜杠分隔: claude-3-7-sonnet / [██░░░░░░] ...
ccs delimiter "•"   # 圆点分隔: claude-3-7-sonnet • [██░░░░░░] ...
ccs delimiter "|"   # 竖线分隔 (默认)
```

### 命令行快速配置 (ccs set / get / toggle / config)

您无需手动编辑 JSON 文件，可直接通过 CLI 命令修改与查看任意配置项（自动保留注释与结构格式）：

```bash
ccs toggle todo                      # 一键开启/关闭 todo 待办进度展示 (免繁琐配置)
ccs toggle cost                      # 一键开启/关闭 会话费用展示
ccs set showGitStatusStats true      # 开启 Git 细分文件计数 (+2 *1 ?3)
ccs set lines 2                      # 切换为双行模式 (窄屏/分屏极佳)
ccs set projectPathMode relative     # 切换为 Monorepo 相对路径模式
ccs set fields model,context,speed,repo,git # 快速自定义展示字段
ccs get fields                       # 读取当前生效的字段列表
ccs config list                      # 列出全部配置项及其是否被自定义
```

---

## 配置说明

首次运行或执行 `ccs install` 时，会在 `~/.claude/statusline.config.json` 自动生成带完整注释的配置文件。

配置文件默认支持 `//` 注释与尾随逗号：

```jsonc
{
  // 1. 字段显示与排列顺序 (默认开启核心 4 项，其余取消注释即可启用)
  "fields": [
    "model",        // 模型名称 (自动清理日期，支持别名)
    "context",      // 上下文使用量及进度条
    "project",      // 当前项目目录名
    "git",          // Git 分支与修改标记
    // "fast",      // Fast 极速模式标记 (例如: ⚡fast，对应 /fast 切换)
    // "todo",      // 任务与待办清单进度 (例如: todo: 2/5 或 ✓ 5/5)
    // "compact",   // 上下文满载压缩预警 (达到 80% 时显示 ⚠️compact)
    // "tokens",    // Token 消耗明细 (例如: I:12k C:320k T:8k O:3k，支持思考Token)
    // "session_duration", // 会话运行时间 (例如: 38m 或 1h 24m)
    // "api_duration",     // 纯 API 响应等待耗时 (例如: api:8m)
    // "cost",      // 会话费用 (基于 Claude Code 的 total_cost_usd，按中转倍率与汇率计算实际支出)
    // "rate_limit",// 展示 Claude Code 提供的 5 小时、7 天及月度限额与重置倒计时
    // "cache",     // Prompt Cache 缓存命中率
    // "lines",     // 会话代码增删吞吐量统计
    // "mcp",       // 扫描用户级和项目级配置的 MCP Server 数量
    // "effort",    // 思考级别/推理强度
    // "output_style", // 输出风格标签
    // "speed",     // 模型生成吞吐速率 (例如: 85 t/s)
    // "repo",      // 规范远程仓库标识 (例如: owner/repo)
    // "session_id",// 会话短哈希标识 (例如: id:8f3a1c92，多终端/tmux 协作跟踪极佳)
    // "session_name", // 会话自定义标题名称 (例如: [fix-auth]，多任务分屏极佳)
    // "version"    // Claude Code CLI 运行时版本 (例如: v2.1.92)
  ],

  // 2. 终端显示行数
  // 1: 单行模式 (默认)
  // 2: 双行模式 (针对窄屏或多分屏终端，自动在项目分界处折行)
  // "auto": 自动模式 (根据终端可用列宽自动判断并折行)
  "lines": 1,

  // 3. Git 状态设置
  "showGitAheadBehind": false, // 是否显示与远端分支的上下游同步差异 (如 main ↑2 ↓1*)
  "showGitStatusStats": false, // 是否细分显示暂存(+)/未暂存(*)/未跟踪(?)文件统计 (如 main +2 *1 ?3)
  "showGitStash": false,       // 是否检测并提示未恢复的 Git 暂存 stash 数量 (如 main* (stash:2)，默认: false)
  "maxBranchLength": 0,        // 分支名最大显示长度 (0 为不截断，>0 时超长自动中间省略，如 feat/auth...flow)
  "gitCacheTtl": 2,            // Git 状态磁盘缓存秒数 (0 为每次实时读取)
  "projectPathMode": "basename", // 项目显示模式: "basename" (仅目录名) 或 "relative" (Monorepo 相对路径: repo:apps/web)
  "clickableProjectPath": false, // 是否为项目路径启用终端 OSC 8 超链接 (支持 Ctrl/Cmd 点击跳转)
  "clickableRepoPath": false,    // 是否为仓库标识启用 GitHub/GitLab 终端超链接
  "showApiDuration": false,    // 是否在 session_duration 后附带显示 API 响应耗时 (例如: 1h 24m (api: 12m))

  // 4. 上下文上限 Token 数 (0 为原生自动感知，原生自适应 200k 及 1M 扩展上下文)
  "contextWindowSize": 0,
  "showCompactAlert": false,   // 上下文达到阈值时是否在 context 进度条旁追加 ⚠️compact 告警
  "compactAlertThreshold": 80, // 触发 compact 预警的百分比阈值 (默认: 80)
  "showContextDelta": false,   // 是否展示单轮对话 Token 增量 (例如: (+1.2k) 或突增告警 (+32.5k⚠️))
  "contextSurgeThreshold": 20000, // 单轮 Token 突增告警阈值 (默认: 20000)
  "contextDisplayMode": "used", // 上下文数值展示模式: "used" (已用量 58k/200k), "remaining" (可用余量 142k left), "both" (两者均显示)

  // 5. 费用与汇率计算 (基于 Claude Code 提供的 total_cost_usd 结合中转倍率折算，非独立统计 Token 账单)
  "currency": "USD",          // 货币单位: "USD", "CNY", 或 "BOTH" (双币种同时显示)
  "costMultiplier": 1.0,      // 中转站/代理加价倍率 (如使用 1.2 或 1.5 倍中转 API 时按此倍率计算实际花费)
  "exchangeRate": 7.25,       // 美元兑人民币汇率
  "showCostMultiplier": false,// 是否在费用后方标注倍率角标 (例如: $0.27 (x1.5))
  "costBudget": 0.0,          // 会话费用硬预算 (以有效美元计，0 为不限，超支标出 ❗ 警示，如: $3.50/$2.00❗)
  "costWarningThreshold": 1.0,// 费用黄色告警阈值 (以美元计，默认: 1.0)
  "costDangerThreshold": 5.0, // 费用红色告警阈值 (以美元计，默认: 5.0)

  // 6. 配额限额显示
  "rateLimitWindows": ["5h", "7d", "mo"],
  "showRateLimitCountdown": true,
  "showRateLimitTrend": false, // 是否显示消耗速度趋势 (↑ 偏快 / ↓ 偏慢)
  "showRateLimitPace": false,  // 是否显示健康步调预警 (当消耗速度明显快于重置时间时标出 ⚡)

  // 7. 外观风格与分隔符
  "delimiter": "|",
  "icons": "none",            // 图标风格: "none" (纯文本), "unicode" (原生字符)
  "progressBar": true,
  "progressBarLength": 8,
  "warningThreshold": 80,
  "dangerThreshold": 90,

  // 8. 终端颜色控制 (设为 false 彻底关闭所有颜色转义)
  "colors": true,

  // 9. 色彩主题预设 ("default", "catppuccin", "nord", "tokyo")
  "theme": "default",

  // 10. 模型名称自定义别名映射
  "modelAliases": {
    // "claude-3-7-sonnet": "Sonnet 3.7",
    // "claude-3-5-haiku": "Haiku 3.5"
  }
}
```

### 可用指标字段清单

| 字段名称 | 描述说明 | 默认状态 | 示例效果 |
| :--- | :--- | :---: | :--- |
| `model` | AI 模型名称 (自动清理日期，支持别名) | 开启 | `claude-3-7-sonnet` 或 `Sonnet 3.7` |
| `context` | 上下文使用量及进度条 (支持反向块读取、单轮 Token 增量/突增告警及可用余量模式) | 开启 | `[██░░░░░░] 29% (58.0k/200.0k)` 或 `(142.0k left)` |
| `project` | 当前工作区项目目录名 (支持 Monorepo 相对路径与多目录 +N dirs 标识) | 开启 | `your-project` 或 `repo:apps/web (+2 dirs)` |
| `git` | Git 分支与状态 (带磁盘缓存、按物理列宽超长省略、Worktree、细分暂存、stash 暂存盘点及 (merging)/(rebasing) 危险状态提示) | 开启 | `main*` 或 `main* (stash:2)` |
| `fast` | Fast 极速模式状态指示 (检测到 fast_mode 时显示 ⚡fast，原生对应 `/fast`) | 可选 | `⚡fast` |
| `todo` | Task / Todo 任务清单实时进度与计数 (会话无待办时自动隐形) | 可选 | `todo: 2/5` 或 `✓ 5/5 todos` |
| `compact` | 上下文满载压缩预警 (达到 80% 阈值时提示，提醒及时整理防性能衰减) | 可选 | `⚠️compact` |
| `tokens` | Token 消耗明细 (Input / Cache / Thinking 思考 / Output) | 可选 | `I:12k C:320k T:8k O:3k` |
| `session_id` | 会话短哈希标识 (提取 session_id 前 8 位，适合多窗口定位跟踪) | 可选 | `id:8f3a1c92` |
| `session_name` | 会话自定义名称 / 标题 (多窗口分屏标识任务极佳，无命名时自动隐形) | 可选 | `[fix-auth]` |
| `session_duration` | 会话持续运行时间 (支持可选展示 API 耗时) | 可选 | `38m` 或 `1h 24m (api: 12m)` |
| `api_duration` | 纯等待 Claude API 思考生成的响应耗时 | 可选 | `api:12m` |
| `speed` | 模型生成吞吐速率 (Tokens per second) | 可选 | `85 t/s` |
| `repo` | 规范远程 Git 仓库标识 (owner/repo) | 可选 | `PipiCraft/claude-code-status` |
| `version` | Claude Code CLI 运行时版本号 (无痛掌握底层工具版本) | 可选 | `v2.1.92` |
| `cost` | 会话费用 (以 total_cost_usd 为基准，支持中转倍率、汇率折算、硬预算上限及梯度变色告警) | 可选 | `$0.18 (¥1.34)` 或 `$2.40/$2.00❗` |
| `rate_limit` | 5 小时、7 天及月度限额、倒计时与可选消耗趋势 | 可选 | `5h:28%(2h14m)` 或 `5h:72%↑` |
| `cache` | Prompt Cache 命中率百分比 | 可选 | `Cache:92%` |
| `lines` | 代码吞吐量 (行数增删) | 可选 | `+185/-32` |
| `mcp` | 扫描用户级和项目级 MCP 配置，并统计其中配置的 MCP Server 数量 | 可选 | `MCP:2` |
| `effort` | 思考/推理强度级别 | 可选 | `[effort: high]` |
| `output_style` | 输出风格标签 | 可选 | `[concise]` |

---

## 开源协议

[MIT License](LICENSE)
