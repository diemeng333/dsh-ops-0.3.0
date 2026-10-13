# dsh-ops 手动验收清单

0.2.5 已恢复 `npm run verify` 自动门禁：安装 devDependencies 后运行 `DSH_OPS_REQUIRE_RUNTIME=1 npm run verify`（PowerShell 用 `$env:DSH_OPS_REQUIRE_RUNTIME='1'; npm run verify`）。以下清单是另行人工验收，不等于这些操作都已执行。0.2.4 时“不补/改测试、不运行旧套件”的要求与记录仅属历史，现已被此次修复替代。替换已加载源码后按宿主要求重载/重启。

## 系统 shell 回退与载荷

- 默认 `allowSystemShellFallback=false`；临时隔离测试中缺少随包/provisioned bash、但 PATH/常见目录有 bash 时，插件不执行该系统副本，后台工具也不通过 FastCtx 自动探测绕过。
- `true` 是显式信任系统 bash 的选择；`bashPath` 是另一种显式选择。首次启动把无迁移标记的旧 `true` 改成 `false` 并通过 loader 写回 `configUpdateVersion: 1`；确认之后手动改回 `true`、重启/HMR 仍保留。未启用的后台行首次启用才迁移。更新配置修改区见 README 与 `lib/config-updates.js`。
- 此开关不控制宿主工具；`shellPolicy=deny-host-shell` 才拒绝宿主 pwsh/bash/pwsh_persistent，即使没有 ops 命令组也生效。它也不是文件系统沙箱。
- 主包 0.2.5 固定复用三个 0.2.1 载荷；逐个核对 `provenance.json` 与真实二进制哈希。对应表见 PROVENANCE；registry tarball 校验和见 release-0.2.1 文档。
- issue #4 的外部贡献者报告：DSH 0.2.0-rc.2 desktop / Windows x64 的 0.2.4 真实 profile 安装及无需重启热加载成功。属于外部观测，不冒充维护者本机 0.2.5 的端到端验收。

## 工具发布与提示词

- 组件列表恰为三个：shell/file 默认开启，background 默认关闭。分别核验组件名称、中文介绍、图标，以及实际版本。
- `workspace-write`、`read-only`：只有开启的四个 ops 文件工具；没有 ops_bash/后台工具，提示词不广告不存在的命令。
- `danger-full-access`：默认四个文件工具 + ops_bash；仅后台组件开且 enableShellTools=true 时增加四个后台工具。任何组合都不发布 ops_run。
- 文件与后台共享一个 FastCtx；关文件仍能管理后台，关后台仍能读搜改，重开不积累注册。
- `enableShellTools: false`、无 sandboxPolicy 服务、无会话：后台组不出现。
- 同时开受限会话与完全权限会话：两者目录互不污染。受限子 agent 不继承祖先的命令组。
- 同一会话切换受限 → 完全权限 → 受限：每次下一请求目录/提示词跟随变化，不重连 FastCtx；旧命令句柄不能继续调用。
- 受限会话不发布 `ops_bash`；完全权限 + publishBashTool=true + bash 可解析 + subprocess 可用时出现，通用命令优先走它。FastCtx 缺失或 enableShellTools=false 时 bash 层仍独立可用。
- 提示词按组件分段 `dsh-ops:repository-tooling:{file,shell,background}`：开关只移除对应段；bash/pwsh 路由仅 shell 开时出现，后台关闭不出现后台指导。不写 AGENTS.md，没有旧 host-shell 段或 mcp:fastctx。
- shell 开时宿主 pwsh-sandbox 采用随包 pwsh7，关时恢复最新宿主原配置；profile 文件不得被改动。开关期间用户更改执行器原配置后也应恢复新值。
- 极简预设 complete persona 可排除附加提示；PTC 通过 SDK 使用同一工具层，权限/组件开关仍应生效。
- publishBashTool=false 隐去 bash 这一层；bash 权限动态切换、受限子 agent 继承过滤和卸载清理一起验证。
- `promptPolicy: false`：不发布路由提示词。
- `deny-host-shell`：有无 ops 命令组都应拒绝配置的宿主 shell；若工具来自继承层，目录也应遮蔽。无可用执行器时不推荐不可调用的 ops 命令。

## 文件工具

- 多文件多区间 `files[]`，各自 offset/limit/encoding；重复路径读取不同区间，结果有序。
- GBK 文本显式 encoding；单文件 grep encoding、目录 fallback_encoding。
- grep `pattern` 是字符串，不传数组；`glob[]` 可混正负规则。
- glob `pattern[]`、`!` 排除、paths/details；没有 count 模式。
- grep schema 只公开 context；content/count/summary 与分页结果仍符合上游行为。
- PDF text、pages 翻页、hex；text 模式外不要让 ops 渲染图像。
- 普通图片路径：错误明确说使用宿主 read_image；改后缀的图像也不能返回成功占位符。图像 `view: hex` 可以读取字节。
- 跨文件替换先 dry_run，再在临时副本上应用；精确编辑走宿主 edit。
- 只读工具可并发；替换/命令不应声明并发安全。

## 任务与输出隔离

- 当前会话没启动 job：ops 结果没有别的会话的 Background 行。
- 启动 job，保留返回 ID；输出、列表、kill 只操作自己的 ID。
- A/B 两会话各启动 job：各自 footer/list 只见自己，不能读取/kill 对方 ID。
- 完成/kill 后仍能读取自己已有 ID 的日志。
- job_list status/limit/offset 是自己的分页，不暴露全局总数/offset；空列表明确为空。
- 大全局 job 存储扫描不完整时必须报告 Partial，不冒充完整；原工具结果的 Complete/Partial 续页提示不能丢。
- 关闭后台组件/卸载：等待已发调用，再尝试终止当前组件已知的自有 ID；不能杀别的会话或组件任务。清理失败有告警。断线后已丢归属的任务不保证终止。
- 重连后不认领旧 ID；操作者可通过上游工具清理持久 job。权限降级不自动杀已运行任务，须操作者管理。

## 进程生命周期（0.2.6）

- 同一宿主文件/后台组件共用连接；关一个组件连接仍能响应，最后一个释放后其 `serve` PID 消失。
- 连续短命 CLI/宿主调用后不新增残留 `serve`；正常退出和强杀宿主都核验，测试只追踪自有 PID。
- `FASTCTX_NO_PARENT_WATCH=1` 即使从宿主环境继承也不能关闭插件客户端的所有者监控。
- 不把 `runtime-host` 的死父 PID 误判为泄漏，不批量杀它；约十分钟空闲回收是上游设计。旧版本遗留进程不由新版自动清理。

## 生命周期与边界

- 服务端断线立即撤下工具与对应提示词项，恢复后重新出现。
- 卸载后工具/提示词/限制全部消失；共享注册表方法未改写，外来同名工具仍可按自己的 scope 注册。
- 未知配置键报错点名；required=true 的缺失/不可用二进制拒绝激活。
- 取消/传输超时只表明停止等待，不把它误读为命令已停止。ops_bash 的宿主执行器截止时间独立于 MCP 等待超时。

## 数字复核

运行 `node scripts/measure-schemas.mjs docs/schema-current.json`，对比 `schema-baseline.json`。不执行真实文件/命令操作。统计的是紧凑 schema JSON 的 UTF-8 字节，tokens≈bytes/4，不是使用频率或准确账单。基线来自修改前 dee3c57 + FastCtx 0.2.6；工具调用频率仍未知，不据此删除 ops_replace。

## 不可误读为已解决的边界

四个 FastCtx 文件工具仍是非宿主沙箱后端，ops_replace 没有 workspace confinement；命令权限门不解决这件事。没有文件系统约束设计前，不作为不可信受限环境的安全方案。宿主审批策略与 sandbox mode 独立，本插件没有新增逐命令审批升级。
