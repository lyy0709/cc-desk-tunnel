# macOS 客户端（实验性）

macOS 上的客户端与 Windows 上的是同一套界面和同一条连接，服务端不需要另行配置。它目前是实验性支持：维护者没有 Mac，构建和自动测试都在 GitHub 的 macOS 机器上完成，真机上的使用情况靠使用者反馈。执行端的实现来自 [#40](https://github.com/sun168567/cc-desk-tunnel/pull/40)（@dcomdjl）。

需要 macOS 13 或更新的系统，Apple 芯片与 Intel 各有一个安装包。两端版本要一致，与 Windows 相同。

## 安装与首次打开

安装包没有 Apple 开发者签名，也没有公证，系统第一次打开时会拦下它：

1. 打开 `CC-Desk-Tunnel-<版本>-mac-<arm64|x64>.dmg`，把应用拖进“应用程序”。
2. 打开应用，系统提示无法验证开发者；到“系统设置 → 隐私与安全性”，在页面下方点“仍要打开”。
3. 如果提示的是“已损坏，无法打开”，在终端执行 `xattr -cr "/Applications/CC Desk Tunnel.app"` 后再打开。

是否信任一个未签名的应用由你决定；源码和构建脚本都在本仓库，也可以[自己构建](#从源码运行与打包)。

升级需要手动：到发布页下载新版本的安装包，把应用再拖进“应用程序”替换旧的；设置会保留。应用内的“升级客户端”只在 Windows 上提供，服务端仍可以在“设置 → 关于与更新”里升级。两端版本不一致时登录页会提示去发布页下载。

## 与 Windows 的不同

两端都由随包的 `project-files` 访问绑定项目。macOS 上已授权的命令使用本机登录 shell（zsh 或 bash），运行前读取该 shell 的环境，以便使用终端中的 Homebrew、nvm 等工具。Windows 使用 PowerShell 7，也可以选择已安装的 Git Bash。

macOS 的快捷键使用 Command，⌘[ 和 ⌘] 分别后退和前进。升级通过手动下载安装包完成。

## 文件夹授权

macOS 对“桌面”“文稿”“下载”、外接磁盘和网络磁盘里的文件单独授权。Claude 的命令第一次访问这些位置时，系统会弹出询问，授权对象是 CC Desk Tunnel。拒绝之后命令会得到“Operation not permitted”，可以到“系统设置 → 隐私与安全性 → 文件与文件夹”里改回来。

因为没有开发者签名，升级到新版本后系统可能把它当作另一个应用，需要重新授权。把项目放在主目录下的其他位置（例如 `~/projects`）可以避开这些询问。

## 从源码运行与打包

需要 Node.js 24 和 Go 1.25 或更新版本。

```sh
npm ci
npm run setup:desktop
npm run build
node scripts/build-project-files.mjs
npm run desktop           # 从源码运行
npm run package:macos     # 打出本机架构的 dmg 与 zip，在 artifacts/macos/
```

打包只能在 macOS 上进行，可用 `--arm64` / `--x64` 指定架构、`--dir` 只生成应用目录。本机架构的包会做离线启动检查，验证界面和随包的项目文件工具。

没有 Mac 时由 GitHub 代为构建：`package` 工作流在两种架构的机器上各打一个包并启动检查，产物和一张窗口截图随该次运行保留 3 天；发布时由同一个工作流把安装包挂到发布页（见[开发约定](development.md#发布)）。

## 实现

- `project-access.mjs` 核验会话与项目绑定，调用随包的文件工具，并检查本机命令授权。
- `process-supervisor.mjs` 用进程组管理命令。断开或撤权时回收受管进程，已脱离进程组的后台程序可能继续运行。
- `shell-environment.mjs` 通过私有 Unix socket 读取登录 shell 环境。

[Linux 客户端](linux.md)使用同一套执行器。

## 已验证与未验证

跨设备的测试覆盖 WSS 连接、项目内读写、授权附件、图片完整性、命令撤权和断线后禁止重放写入。

尚未验证，需要真机：

- 断线重连、定时任务、长时间的任务。
- 手动升级到新版本之后设置与凭据的保留。
- 未签名应用在各版本 macOS 上的首次打开，以及升级后的文件夹授权。
- 钥匙串里保存的服务凭据、系统通知、托盘图标、Dock、标题栏与窗口按钮的贴合、休眠唤醒。
- 大小写敏感的磁盘、外接与网络磁盘上的项目。
- 一个会话在 Windows 与 Mac 之间接管、分叉后的表现。

遇到问题请到 [#18](https://github.com/sun168567/cc-desk-tunnel/issues/18) 反馈，附上“设置 → 关于与更新”里的连接日志。
