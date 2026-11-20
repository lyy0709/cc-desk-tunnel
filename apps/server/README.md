# Linux 服务

Linux 上的代理服务：认证客户端、管理会话、驱动官方 Claude Code、维护到 Windows 的执行通道，并记录调用统计。`src/throttle.ts` 按来源地址限制凭据错误的重试和未认证连接的数量。

## 开发入口

根目录 `npm run dev` 同时启动模拟服务和浏览器 GUI，生成随机服务凭据并写入被忽略的 `.local/dev-connection.json`，控制台不输出 token。默认端口 8787 / 5173，已占用时寻找后续可用端口；以启动输出和本地连接文件为准。会话记录在 `.local/sessions/`。

仅启动服务：在 PowerShell 7 设置 `$env:PROXY_TOKEN`（至少 24 字符）后，从根目录运行 `npm run server`。可选 `PROXY_PORT`、`PROXY_DATA_DIR`、逗号分隔的 `PROXY_ORIGINS`。默认数据目录不受 npm workspace 的 cwd 影响。

模拟只监听 `127.0.0.1`，`GET /health` 报告适配模式，`/ws` 用首帧认证。默认浏览器来源为本机 5173，以及 Electron 文件页面的 `file://` / 不透明来源 `null`；没有 Origin 的程序客户端也必须认证。不要将模拟 HTTP 原样暴露公网。

## 浏览器入口

正式 Web 首次默认关闭，在桌面设置中启用，选择保存到现有 SQLite 数据库，服务重启后保持。服务端在同一 HTTPS 端口提供与桌面共用的前端、登录接口和单独的浏览器 WebSocket，不改变桌面 `/ws`、健康检查或 Docker 端口映射。镜像和升级包包含同版本前端构建，运行环境不需要 Electron 或 Vite。

`web-access.ts` 管登录、Cookie 会话、域名 / 子路径和静态资源；`web-totp.ts` 管可选验证器动态码；`web-commands.ts` 明确浏览器命令白名单；`web-certificate.ts` 管指定域名的 SNI 证书，原默认 TLS 上下文和健康检查保持原样。Web 状态不放进客户端的通用会话仓库。启用步骤、权限和部署边界见[浏览器访问](../../docs/server-web.md)。

## 原生连接

服务器上的 Claude Code 只有一个登录，图形客户端的运行与 ccdt 的终端共用：桌面账号页由服务端运行官方 `claude auth login`，交回授权页给出的代码（`src/native-login.ts`），ccdt 在终端里运行同一条命令；也可以在 `config/provider.json` 配置 API key 或受支持的云提供方。双容器部署、目录授权、首次继续旧会话及凭据迁移见[原生运行时](../../docs/native-runtime.md)。服务端和客户端需使用相同协议版本。

- `project-tools.ts` 为每次运行分配工具端点。GUI SDK 与原生 CLI 通过 `project-mcp.ts` 转接工具请求。
- `runtime-worker.ts` 在独立容器接收运行请求，分配进程身份并启动官方 CLI。`runtime-relay.mjs` 负责 SDK 字节流、PTY 输入输出、尺寸和进程结束通知。
- `src/native-input.ts`：同一运行可追加 async user message，带客户端 UUID、human origin，原生负责调度 / 合并。结果按 `user_message_uuids` 和 `queued_turn_count` 处理，不能首个 result 就丢弃后续输入；收尾同步停止接收。取消 / 断连 / 重启不重放，未送达与接收未确认分别记录。
- `src/claude-stream.ts`：适配公开文字 / 思考 / 工具入参和结果。不解析未公开隐藏推理，不把自建结果格式塞回原生工具。
- 工具进度来自原生 `tool_progress`；Bash 输出按原生工具结果展示，不承诺每行 stdout 实时接出。
- 原生 session ID / resume / abort 均由官方组件管理。改名 / 删除已有原生会话先调用官方 renameSession / deleteSession，再更新代理索引；原生更新失败保留代理记录，运行中禁止管理。
- 默认请求原生 auto，可选 default / plan / acceptEdits；回传 requested / actual 模式，不自建 AI 审批。原生 canUseTool 仍转发需要用户的请求。
- `src/native-controls.ts` 从官方 SDK 的结构化用量接口和公开的 `rate_limit_event` 字段读取订阅额度，并用这些读数决定自动任务是否等待。ccdt 终端状态栏里的五小时和每周读数记入同一组额度周期（`usage.ts`），图形客户端与终端的调用合并统计；按模型的完整明细可在官方用量页或终端 `/usage` 查看。
- 会话 model / effort 偏好在下轮传给 SDK，实际值仅按原生报告展示。主动压缩发送原生 `/compact`，转接真实 compact boundary，不自行总结上下文。命令目录带说明、参数提示与别名传给客户端，去掉 CLI 标为只用于其终端的命令，并随 `commands_changed` 更新；`/context`、`/usage` 这类本地命令的输出（`local_command_output`）作为一条回复显示。
- 原生持久化开启；恢复前官方 getSessionInfo 验证上下文存在，不存在则明确失败，不用 GUI 历史重建。每轮回传原生保存状态。
- 不改 CLI 或注入代码；已安装可执行文件与官方同版本 Linux 包 SHA256 一致，实际进程 / 环境核对见[原生运行](../../docs/native-runtime.md)。
- `src/native-terminal.ts` 管理服务器内官方 CLI 的 PTY。设备项目通过 `--mcp-config` 注册项目工具，交互和终端输出通过 WSS 中继。
- 终端原始输出仅发所属连接；128 KiB 未确认输出暂停 PTY，低于 32 KiB 恢复，30 秒无回执回收进程。ccdt 在输出写入终端后发送回执；终端输入 / 尺寸 / 回执不创建逐键响应缓存。关闭、断连与服务退出结束进程组，不保存终端画面或授权代码。

当前个人自用，多会话，同一使用者的几台设备可以同时在线，各有各的执行通道。会话记着它所在的设备（`device`），它的 CLI 在服务端运行，项目工具操作由绑定设备执行；任何设备都可以向它发消息、答复审批、停止运行或打开终端，前提是那台设备在线且执行通道就绪。服务端把在线设备的列表（`devices`）推给所有连接。要换到另一台设备上做，用 `session.move` 给出本机的项目目录把它接过来，或用带 `projectPath` 的 `session.fork` 分叉到本机。升级前没有设备信息的会话归第一个使用它的设备。设备标识在登录之后由单独的 `device` 帧给出，登录帧保持各版本都能读的形状。运行和终端合计有上限，默认按“（内存 − 300 MB）÷ 300 MB”取整，至少 1，可用 `PROXY_MAX_RUNS` 指定。运行属于会话所在的设备而不是某条连接：设备断线后运行继续，在途工具操作可能结果未知，命令授权在断线后失效，离线超过宽限期（默认 5 分钟，`PROXY_GRACE_SECONDS`）才停止。停止或断连不会静默重放；未确认的工具结果标记 unknown。撤销命令授权时，设备会终止受管进程。

浏览器只有控制连接，不注册设备或执行通道。启用 Web 后，它可新建归属稳定「服务端」设备的普通会话，直接在容器工作目录里运行 Claude，使用服务器自己的工作目录。桌面也可操作这些会话；退出浏览器或关闭 Web 不停止已有模型运行，浏览器终端仍随连接结束。服务端普通会话各有独立目录；项目目录分配与记忆共享沿用主线 `native_roots`，不另建浏览器项目模型。

## 实现与验证

- 模块：`main.ts` / `config.ts` 读环境并启动；`server.ts` 是连接与命令的唯一入口；`store.ts` 持久化；`claude.ts`（SDK 运行）、`claude-stream.ts`（原生消息转协议事件）、`native-input.ts`（运行中追加输入）、`native-controls.ts`（账号 / 模型 / 额度）、`native-terminal.ts`、`native-account.ts`、`login-expiry.ts`（登录到期提醒） 组成原生适配；`project-tools.ts` 路由本机文件工具；`usage.ts` 收集调用统计；`simulation.ts` 是离线模拟；`errors.ts` 是可回给客户端的错误。
- `src/server.ts`：认证、请求、连接归属和广播；每类命令一个处理函数，`execute` 只做分发。模拟器在 `src/simulation.ts`。三种场景为聊天、一次 PowerShell 审批、上游错误。PowerShell 仅显示固定 `Get-Location` 和模拟结果，从不创建命令进程。
- `src/store.ts`：Node 24 内置 SQLite / WAL，摘要与原始事件分表、每事件事务落盘，不逐 token 重写整份历史。旧 UTF-8 JSON 一次性事务导入、原文件保留作迁移备份；日后备份以 SQLite 和原生 CLI 存储为准。启动恢复未结束轮次，不重放。
- 状态读取不改变会话的最近使用时间。升级时修正旧的活动时间和用量周期边界，原始事件与调用记录保留。提前重置的时间靠额度读数推断，历史读数缺失时不能精确恢复。
- 登录只发会话目录，打开会话取最近页且仅订阅当前会话；向上加载完整轮次。1000 事件 / 512 KiB（UTF-8 字节）软预算，单个大轮次不切断；重连小差量按游标补齐，大差量回到最近页。分页用现有索引寻找轮次，只统计填满当前页所需的正文大小；原生状态刷新不阻挡订阅和翻页，改名、删除、分叉期间仍互斥。
- `src/history-delivery.ts` 交付历史：小页直接发送，大页切成最多 32 Ki UTF-16 code units 的 JSON 文本块，最多 4 块在途，接收端确认一块再补一块。首屏、向前翻页、断线补读沿用完整轮次和原游标；订阅同时捕获未完成输出，客户端收齐后按原顺序衔接后续事件。切换、取消、断连或连续 30 秒未确认会释放该页。
- 历史快照及历史块在控制连接协商成功后使用标准 `permessage-deflate` 压缩，沿用组件默认压缩级别和小消息阈值，消息间不复用压缩上下文。服务端其他事件和控制响应不压缩；不支持扩展的连接仍可读取同样内容。历史分批限制主动排队量，不提供独立 TCP 流的隔离，也不限制实时工具结果的大小。
- 分片到达的输出只转发、不落盘：运行在内存里攒着当前这一段（`run.open`），一段结束时记为一条事件；会话元数据在内存里留一份，记一条事件不再读回并校验它。此前逐片落盘的旧库在启动时合并一次（`store.ts` 的 `mergeFragments`），合并前用 `VACUUM INTO` 把整库复制到 `backups/history-<时间>/`，同目录写入 `README.txt`。
- `session.fork` 用 SDK 的 `forkSession` 复制原生会话并复制事件记录，可截到某条用户消息之前。分叉的原生记录在源会话的 Linux 目录里，会话元数据的 `nativeRoot` 指向它。带截取点的分叉分两步：先截到该消息，再截到它的前一条，中间副本随即删除；该消息之前没有内容时新会话不带原生上下文。
- 同时允许多会话，单会话只有一个运行。审批 / 取消可由同一服务下的其他已认证连接操作，终端输入只属于正在显示它的 ccdt 连接。断线的在途模拟工具标记未执行；真实执行的“结果未知”语义由 P2 定义，不能套用模拟结论。
- 15 秒 ping，下一次仍未收到 pong 则终止连接。桌面设备最后一条连接明确离开时，立即终止该设备的运行；浏览器连接关闭不终止服务端会话的模型运行。删除原生会话及代理展示记录，不碰 Windows 项目目录。
- 保存内容损坏会明确启动失败，不自动覆盖历史；Docker 部署提供停服一致性备份与覆盖前自动另存的还原，可用于迁移服务器。Claude 登录凭据在数据目录的原生 HOME 里，重建容器后保持。

根目录 `npm test` 覆盖认证、UTF-8、原生事件适配、项目 MCP、流、审批、取消、恢复和持久化；真实 Ubuntu / API 测试需显式启用，协议见[协议模块](../../packages/protocol/README.md)，连接设计见[架构](../../docs/architecture.md)。

VPS 默认端口、脚本能力、TLS 信任、Windows 用户权限和待验证范围见[部署与安全说明](../../docs/deployment.md)。
