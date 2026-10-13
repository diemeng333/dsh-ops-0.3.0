# dsh-ops

**中文** | [English](README.en.md)

致力优化dsh插件token效率，提升ai性能，减少token消耗，减少任务总时间的插件，解决 Windows 下 DSH 反复使用 PowerShell 报错造成的 token、时间和模型注意力浪费，会持续更新。

> tips：本项目的 ops 是广义 operations （运行操作）的缩写，代指本插件处于dsh和系统/代码/文件操作的基础工具位置。本项目不是 operations（运维）插件。

本插件的主要功能：

- 提供独立 **bash 5.3.15** 和 独立 **PowerShell 7.6.6** ，优先使用bash，必要时回退pwsh7，让你的AI不再和PowerShell打架——不改变系统path路径和终端指向，环境变量安全（仅windows）
- 一些 Rust 编写的性能更好的，更快的读取、查找、替换工具，渐进式纰漏以减少系统prompt的工具定义占用，加速任务运行，减少不必要的输入输出，减少报错率来减少运行过程中的token浪费，以及提供和原版dsh一样的沙箱和权限机制。（windows、linux、mac三平台）

> [!IMPORTANT]
> main的代码已经是0.3.0的结构，由于 0.3.0 开始把fastctx工具替换为自己实现的dsh原生工具，可能有奇怪bug——不过从源码构建的小伙伴应该不惧怕bug吧！
> 0.3.0的ptc模式在 `dv4.1f官方渠道 high推理努力 固定总行数，代码结构和复杂度和实现的功能 超燃生成mc！` 三次测试取平均值测试中取得了：
> 
> 97% token减免（开启ops插件的ptc专用工具 对比 windows原装标准模式）
> 
> 65% token减免（开启ops插件的ptc专用工具 对比 linux 原装ptc模式）
> 
> 的成绩

<img width="1603" height="1028" alt="247c1326cca5b66e60d330c3f32150e2" src="https://github.com/user-attachments/assets/7c9ba485-5323-42a2-b5a8-6dcda07f91c4" />

执行顺序：**工具包 → bash → PowerShell 7**。

旧组件仍面向 **Windows x64**。新增的 **0.3.0 PTC 增强组件**以独立原生 Rust 面向 Windows、macOS、Linux（包允许 x64/arm64），不依赖 FastCtx 或 shell。Linux x64、macOS arm64 编译检查已通过，平台实机运行／沙箱验收仍待完成。目标宿主 DSH `0.2.0-rc.2`。见 [PTC 设计与使用](docs/native-ptc.md)。

## 安装、更新、卸载

### 官方插件市场

在目标 DSH 应用的插件市场中输入 npm 包名 **`dsh-ops`**，安装后选择启用。安装归属于当前运行的 profile，桌面端为 `desktop`。发布包依赖完整 FastCtx、bash 和 PowerShell 7 载荷；不使用安装脚本下载，不改系统 PATH。

### npm 一键安装

```console
npx --yes dsh-ops@latest install --profile desktop
npx --yes dsh-ops@latest install --profile web
npx --yes dsh-ops@latest install --profile tui
```

必须显式选择目标 profile；`tui` 映射到 **dsh-TUI 产品的 `dsh-tui` profile**，不是旧的 `tui` 目录。请先初始化目标应用。该入口委托官方 DSH CLI 安装，不另写一套 profile 锁与回滚逻辑。

桌面端必须使用桌面应用自带的 CLI；默认探测 `%LOCALAPPDATA%\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd`。安装在其它位置时加 `--dsh-cli "<安装目录>\resources\runtime\cli\bin\dsh.cmd"`。Web/TUI 需要可用的 DSH CLI，可同样显式指定。

也可以直接使用官方命令：

```console
dsh plugin --profile web add dsh-ops
dsh plugin --profile dsh-tui add dsh-ops
"<桌面安装目录>\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop add dsh-ops
```

普通 DSH CLI 不能管理保留的 `desktop` profile；不要把它与桌面自带入口混淆。

**更新**：重新运行相同的 `npx --yes dsh-ops@latest install --profile ...`，或用官方 CLI `add dsh-ops@latest`。按应用提示重载；替换已加载代码时重启应用。

本地 `0.3.0` 开发版新增独立原生 Rust PTC 组件：`ops_batch` 安全批处理、`ops_result` 有界引用／投影，适配 DSH 原生权限、沙箱、取消，提供逐项持久清单与保守恢复。旧 Windows 二进制依赖仍固定 `0.2.1`，不代表完成全部 FastCtx 迁移或已对外发布。新组件须构建并显式启用，见 [使用说明](docs/native-ptc.md)。

**卸载与查看状态**：

```console
npx --yes dsh-ops@latest status --profile desktop
npx --yes dsh-ops@latest uninstall --profile desktop
```

把 `desktop` 换成 `web` 或 `tui` 即可。也可在市场卸载，或执行官方 `dsh plugin --profile ... remove dsh-ops`。二进制随 profile 的插件依赖管理；卸载移除依赖引用，不误删系统 shell、其它 profile 的副本或包管理器共享缓存。

旧版显式 provision 的 `<DSH_HOME>/dsh-ops/` 文件需单独清理：`npx --yes dsh-ops@latest uninstall --yes`。默认不删 `~/.fastctx/` 持久状态；需要时显式加 `--purge-fastctx`。关闭后台组件会等待已发出的调用，然后尝试终止该组件当前连接记住的自有任务；失败会告警。断线丢失归属的旧任务及单纯降权不保证终止，先处理自己的任务。

## 组件开关与提示词

Bundle 声明四个组件，分别启停，首次安装默认开启前两个旧组件；PTC 增强须显式启用并提供原生 worker：

| 组件 | 介绍 | 默认 | 发布的工具 |
| --- | --- | --- | --- |
| `dsh-ops-bash & powershell 7` | 将默认终端改为bash，以及bash覆盖不到时提供powershell7 | 开 | `ops_bash`；宿主 `pwsh` 使用随包 PowerShell 7 |
| `dsh-ops-file` | 更快、更高性能、输出更精简更省token的rust文件检索 | 开 | 四个文件工具 |
| `dsh-ops-background` | 为科研仿真、模型训练及其他长进程后台任务提供托管 | 关 | 启动、输出、列出、终止后台任务 |
| `dsh-ops-ptc` | 独立 Rust 安全批处理和有界结果引用，仅纯 PTC 会话加载 | 关 | `ops_batch`、`ops_result` |

“默认终端改为 bash”指模型提示优先使用 `ops_bash`，**不修改系统默认终端、PATH 或宿主原有 shell 工具名称**。Shell 组件开时，通过官方配置生命周期临时指定 `pwsh-sandbox` 的 PowerShell 7 路径；关时按执行器最新原配置恢复，不写 profile 配置。执行器配置切换不代表取消已在运行的宿主命令。

提示词注册为独立运行时段，**不写 AGENTS.md**：Shell 关就撤销 bash/pwsh 路由；文件关就撤销原生文件说明；后台关就不发布后台工具及自有 job 指导。文件组件使用独立 Rust worker；FastCtx 仅由默认关闭的 background 组件保留。默认新增四个原生文件工具和 `ops_bash`，不发布重复前台 `ops_run`。这些改变减少固定声明成本。极简预设会覆盖附加 system sections；PTC 模式经 SDK 调用底层工具，权限门不变。

## 配置方式与工具列表

在 DSH 的配置编辑器中找到对应的 `dsh-ops/shell`、`dsh-ops/file` 或 `dsh-ops/background` 行，调整 `config` 后保存；未知配置键会点名报错。也可直接在市场切换组件。主要配置：

```yaml
config:
  # background component only; its market row is disabled by default
  enableShellTools: true
  publishBashTool: true
  promptPolicy: true
  toolCallTimeoutMs: 300000
  required: false
  shellPolicy: advise
  allowSystemShellFallback: false
  # Managed update metadata; do not remove after the first startup self-check
  # configUpdateVersion: 1
  # binaryPath: 'C:\tools\fastctx.exe'
  # bashPath: 'C:\tools\bash.exe'
```

- `enableShellTools`：后台组件的部署开关，开启仍须会话 `danger-full-access` 才发布四个后台工具；文件组件不发布命令工具。
- `publishBashTool`：是否发布 `ops_bash`，同样要求完全权限和宿主 subprocess 服务。
- `promptPolicy`：是否注入该组件的运行时说明；可用 `extraGuidance` 追加指导。
- `toolCallTimeoutMs`：FastCtx RPC 等待超时，不代表服务端工作已终止。
- `required`：运行时不可用时是否拒绝激活。
- `shellPolicy`：默认 `advise`；`deny-host-shell` 拒绝 `deniedHostTools` 列表中的宿主 shell（默认 `[pwsh, bash, pwsh_persistent]`）。这也会禁用第三层 pwsh，谨慎开启。
- `allowSystemShellFallback`：默认 `false`，随包/已 provision 的 bash 缺失时不探测系统 PATH 或常见安装目录；后台组件也不绕过此选择调用 FastCtx 的自动探测。只有显式设 `true` 才使用未固定摘要的系统 bash，请自行信任与维护该执行器。显式 `bashPath` 是另一种操作者选择，并非自动回退。首次升级启动的迁移见下方“更新配置修改区”。
- `shellPolicy` 与此开关独立：`deny-host-shell` 遮蔽/拒绝宿主工具；禁止系统回退只约束插件自己的 bash 解析，不关闭宿主 `pwsh`，也不提供文件系统沙箱。
- `binaryPath` / `bashPath`：可选显式路径；不可用时报错，不悄悄换执行器。一般无需配置。

| 工具 | 用途 | 完全权限要求 |
| --- | --- | --- |
| `ops_inspect_local_file` | 批量文本范围、编码、PDF 文本、hex | 无命令权限门¹ |
| `ops_grep` | Rust 正则搜索、多文件过滤、计数/摘要 | 无命令权限门¹ |
| `ops_glob` | 多模式找路径，支持排除 | 无命令权限门¹ |
| `ops_replace` | 跨文件批量替换；精确编辑仍用宿主 edit | 无命令权限门¹ |
| `ops_bash` | 优先的通用 bash 命令执行器；短命令用 `command`，长脚本用 `script_path` | 是 |
| `ops_run_background` | 启动后台任务 | 是 |
| `ops_job_output` / `ops_job_list` / `ops_job_kill` | 查看、列出、停止当前会话启动的任务 | 是 |
| 宿主 `pwsh` | 使用随包 PowerShell 7 的 Windows 原生操作 | 沿用宿主策略 |

¹ **文件工具使用 DSH 原生 sandbox/subprocess 边界。** host 负责 session cwd、策略解析、精确 worker argv 的 confinement、取消和结果映射；Rust core 仍额外拒绝 link/reparse/special object，并执行预算和 CAS 完整性保护。`workspace-write` 只允许当前 workspace root 内的路径；外部绝对路径需要 `danger-full-access`。

## 长脚本与 JSON 稳定性

`ops_bash` 的 `command` 适合短命令和短管道。对于超过约 1 KB，或包含 heredoc、引号、反斜杠、中文等内容的多行脚本，请先用宿主的文件工具写入脚本文件，再传入 `script_path` 执行；不要把整段 heredoc 塞进 `command`。这样可以显著减少模型在工具调用 JSON 中进行多层转义的负担，降低整轮因 `MALFORMED_RESPONSE` 作废的概率。

当随包 bash 载荷在 profile 的声明/lockfile 中存在、但实际 `node_modules` 已被宿主包管理器清理时，`ops_bash` 会返回可读的 `ENOENT` 诊断，而不是把裸的 `spawn` 异常抛给模型。此时应使用 profile 的 frozen install 或官方插件管理器恢复依赖；不会静默切换到未授权的系统 bash。

`script_path` 只接收脚本路径，脚本内容不会重复进入 `ops_bash` 的工具参数；`command` 与 `script_path` 必须二选一。该接口不会替模型修复非法 JSON，工具调用本身若未能解析，仍需由宿主或模型重试。

`ops_bash` 的参数是**严格**的：传入 schema 未声明的键会在执行前被拒绝，错误信息同时点出未知键与可接受的键，不会静默忽略。**本工具没有 `run_in_background`，也没有 job id**，命令一律前台执行。宿主 `bash` / `pwsh` 工具接受 `run_in_background`，因此模型容易把该参数套到 `ops_bash` 上；这样调用会被明确拒绝而不是静默当前台执行。服务、监听器、watch 等常驻进程请改用宿主 `pwsh` 工具的 `run_in_background`，或在命令内部自行脱离（例如 `nohup ... & disown`）。否则该次调用会一直占用到 `timeoutMs`（上限 `MAX_BASH_TIMEOUT_MS`，约 24.9 天）。


插件只回收自己启动的 `fastctx serve` 客户端：组件最后一个连接引用释放、连接关闭、宿主正常退出或强制退出时均有回收路径。`runtime-host` 是上游可复用的共享进程，父进程已退出不等于泄漏；无客户端且空闲约十分钟后自行退出。不要按进程名批量杀它。新版不自动清理旧版本已留下的进程。

## 更新配置修改区

`lib/config-updates.js` 集中维护一次性配置迁移。0.2.5 首次启动时逐个自有配置行执行自检：

- 未完成迁移（无 `configUpdateVersion` 或值为 `0`）：把旧 `allowSystemShellFallback: true` 改为 `false`，在任何执行器解析/工具发布前生效。
- 通过官方 loader 的配置生命周期写回该行，并加入 `configUpdateVersion: 1`；保留其它字段，不修改外来插件、PATH 或全局配置。未启用的组件在它首次启动时迁移。
- 完成后重启/热加载不再覆盖；你之后主动改回 `true` 会被保留。不要删除迁移标记，否则会重新自检。
- 没有 loader 配置行时只应用本次运行的安全值并告警；写入失败由迁移/loader 日志报告，未落盘的标记不能保证跨重启一次性。

## 许可证

插件源码分发采用 **`MIT AND Apache-2.0`**：`vendor/fastctx/` 之外为 MIT；vendored FastCtx 为 Apache-2.0。见 [NOTICE](NOTICE)、`vendor/fastctx/LICENSE-APACHE` 与 `vendor/fastctx/NOTICE`。

独立的 Windows 载荷包另按上游组件许可证分发：Git for Windows 包含 GPL 等许可组件，PowerShell 包含 MIT 与第三方组件。其原始许可证、声明及来源记录随载荷保留；插件的 MIT 许可不替代这些许可。详见 [PROVENANCE.md](PROVENANCE.md)。

## 致谢

Rust 工具基于 [yc-duan](https://github.com/yc-duan) 的 Codex 插件 FastCtx 并使用其源代码。vendor 标识与删除型分发改动记在 [vendor/fastctx/FORK.md](vendor/fastctx/FORK.md) 和 [vendor/fastctx/UPSTREAM.md](vendor/fastctx/UPSTREAM.md)。需要转载的 FastCtx 声明如下：

> This product includes FastCtx
> (https://github.com/yc-duan/fastctx), Copyright (c) 2026 yc-duan,
> used under the Apache License 2.0.
>
> FastCtx is redistributed and/or modified here by the maintainer of
> this distribution. Any such change is that maintainer's own work
> and their sole responsibility. It is not endorsed by, not
> supported by, and not attributable to the author of FastCtx, who
> accepts no liability of any kind arising from this distribution or
> from anything built on top of it.

## Star 趋势

[![Star 趋势图](https://api.star-history.com/svg?repos=T-Auto/dsh-ops&type=Date)](https://star-history.com/#T-Auto/dsh-ops&Date)
