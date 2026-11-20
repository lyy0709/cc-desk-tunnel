# Linux Docker 部署

Ubuntu amd64 优先；arm64 为实验性支持：镜像构建、部署自测和服务端测试在 arm64 上自动运行通过，还没有人在 arm64 服务器上用真实账号跑过会话。代理与官方 Claude Code 分别运行在 `proxy` 和 `runtime` 两个容器里；不改 Claude 本体。宿主机需要内核 6.2 或更新（Landlock ABI 3）和 Docker Compose 2.23.2 或更新。容器有可写层和较完整工具环境，不是只读沙箱；代理以 uid 1000 普通用户运行，运行容器的启动进程把每个 CLI 降为 uid 1000 并用 Landlock 限制它能访问的文件；无宿主 Docker socket、特权模式或宿主项目挂载。

## 准备

最省事的方式是一条命令。脚本检查 Docker 等依赖（缺少时给出安装命令，不代为安装），从发布页下载最新的服务端程序包并校验，解压到 `/opt/cc-desk-tunnel`，随后进入下面的交互安装；已有部署时改为询问是否升级。程序目录可用环境变量 `CC_DESK_TUNNEL_DIR` 更改，`CC_DESK_TUNNEL_VERSION=X.Y.Z` 可指定版本（写在 `sudo env` 之后）。

```sh
sudo bash -c "$(curl -fsSL https://raw.githubusercontent.com/lyy0709/cc-desk-tunnel/main/deploy/install.sh)"
```

镜像用 GitHub 上预先构建好的 `ghcr.io/lyy0709/cc-desk-tunnel:X.Y.Z`，版本与程序包相同，x86_64 和 arm64 用同一个标签，Docker 自动选择。拉取不到时（服务器连不上 ghcr.io，或这个版本发布时还没有镜像），改为在服务器上从程序包构建，首次需要几分钟，期间联网下载系统包、Node.js、Claude Code 和 npm 依赖。想始终在本机构建（例如改过 Dockerfile）时设置 `CC_DESK_TUNNEL_BUILD=1`；只用预构建镜像、拉取不到就停下时设置 `CC_DESK_TUNNEL_BUILD=0`。

镜像不含 Windows 安装包：服务启动后自己下载同版本的安装包，放在数据目录里供客户端升级，下载失败不影响服务。

以 root 安装后多一个命令 `/usr/local/bin/cc-desk-tunnel`，就是 `deploy/manage.sh` 的快捷方式，下文的 `sudo bash deploy/manage.sh …` 都可以写成 `sudo cc-desk-tunnel …`，在任何目录下运行。卸载时一并删除。

也可以手动准备：从项目的 GitHub 发布页取同一版本的三个文件：服务端程序包 `cc-desk-tunnel-server-X.Y.Z.tar.gz`、Windows 安装包 `CC-Desk-Tunnel-Setup-X.Y.Z-x64.exe` 和 `SHA256SUMS`。放到 VPS 的同一目录后先校验，再把程序包解压到专用程序目录：

```sh
sha256sum -c SHA256SUMS
sudo mkdir -p /opt/cc-desk-tunnel
sudo tar -xzf cc-desk-tunnel-server-X.Y.Z.tar.gz -C /opt/cc-desk-tunnel
cd /opt/cc-desk-tunnel
```

程序包不含秘密、Windows UI、开发测试和依赖。也可以自己打包：本机运行 `npm run package:server`，或直接使用完整仓库。

交互安装：不带参数运行，脚本依次询问公网地址（默认自动探测）、入口方式、端口、数据目录和服务凭据（留空自动生成），随后取得镜像、启动，并在结尾汇总客户端要填的地址 / 指纹 / 凭据、需放行的端口和下一步。已有部署配置时跳过问答，只重新取得镜像并启动。

```sh
sudo bash deploy/install.sh
```

升级与客户端分发：

```sh
# 原地升级到最新版本：下载并校验程序包、解包覆盖程序目录、换上新镜像并替换容器；数据、账号和配置不动
sudo bash deploy/manage.sh upgrade
# 用手上的程序包升级（例如服务器连不上 GitHub）
sudo bash deploy/manage.sh upgrade --from /path/cc-desk-tunnel-server.tar.gz
# 把 Windows 安装包交给服务端；已连接的旧客户端下次连接时在左下角连接菜单看到“升级到 x.y.z”
sudo bash deploy/manage.sh client /path/CC-Desk-Tunnel-Setup-X.Y.Z-x64.exe
# 更换服务凭据（留空则随机生成）并重启；已保存旧凭据的客户端需重新填写
sudo bash deploy/manage.sh token
# 随时重看汇总
sudo bash deploy/manage.sh summary
```

nginx 模式需按示例配置反代 `/client/installer`，客户端自升级才能下载。服务端只保留最近 3 个版本的安装包，更旧的自动删除。

### 从客户端升级

服务端每 6 小时查询一次项目的 GitHub 发布页；有人在用客户端（图形客户端的窗口开在前台，或 `ccdt` 的终端开着）时，客户端在上一次查询满 1 小时后请服务端再查一次，同时在线的客户端再多也是约每小时一次。客户端连接菜单里的“检查更新”立即查询一次。有新版本时：

- 菜单出现“升级服务端到 x.y.z”：确认后服务端下载程序包并按清单校验、安装依赖、取回同版本的客户端安装包，然后重启，全程几分钟；重启后重新连接，客户端按提示升级自己。有会话正在运行（正在回答、等你确认，或 `ccdt` 里的 Claude Code 正在执行）时，菜单项会注明几个会话在运行，点了会列出它们，确认后强行升级，正在运行的会被中断；只是开着 `ccdt` 终端、或在等后台任务的，不挡升级，它们随重启结束，会话本身保留。账号正在登录时也要等登录结束或强行升级。
- 客户端比服务端新、登录页提示“此客户端较新”时：点登录页的“升级服务端”，服务端同样升级到最新的正式版并重启，然后照常连接。多个连接各连一台服务端时，从其中一台升级客户端后，其余服务端都这样升级。
- 菜单显示“服务端 x.y.z 需在服务器上升级”：新版本需要更新的镜像（Node.js 或系统组件有变化），在服务器上运行 `sudo cc-desk-tunnel upgrade`；还没有这个命令的旧部署，重新运行上面的一键安装命令，它会识别已有部署并升级。

升级后的程序放在数据目录的 `program/` 下，镜像不变。容器启动时比较两处的版本，运行较新的一个：重建或替换容器不会回到旧版本，用更新的程序包重建镜像后则以镜像为准。升级后的程序连续三次启动失败时退回镜像里的版本，日志里有一行说明。失败的升级不改动正在运行的程序，原因显示在客户端。

改为跟踪自己的私有仓库（例如私有的 fork）时，服务端需要一个只读令牌才能读取发布页：在 GitHub 创建只授权该仓库、Contents 只读的细粒度令牌，存成 VPS 上的一个文件后执行下面的命令，随后删除该文件。令牌只保存在数据目录的 `config/service.env`（0600），不会传给客户端或 Claude Code。

```sh
sudo bash deploy/manage.sh release-token /path/token.txt   # 不带参数则移除
```

跟踪的仓库可在 `config/service.env` 里用 `PROXY_RELEASE_REPO='所有者/仓库'` 更改，设为 `none` 则不查询也不提供升级。容器没有宿主 Docker 的控制权，替换镜像始终要在宿主上执行。

同时进行的运行和终端有上限，默认按服务器内存估算（每个约占 300 MB，1 GB 内存的服务器是 2 个）。要改就在 `config/service.env` 里加 `PROXY_MAX_RUNS='数量'` 并重启服务。

电脑断线后，它的任务在服务端继续，等它连回来；离线超过 5 分钟才停止。要改这个时间就加 `PROXY_GRACE_SECONDS='秒数'`（0 到 3600，0 表示断线即停止）并重启服务。

需要脚本化或分步执行时仍可用参数形式：

```sh
sudo bash deploy/install.sh init --host VPS_IP
# 上一步打印数据目录；默认 sudo 安装为 /srv/cc-desk-tunnel
# 按需编辑 <数据目录>/config/provider.json，不把 API key 放进镜像。
# up 先取得镜像（拉取，拉不到则构建），再启动
sudo bash deploy/manage.sh up
sudo bash deploy/manage.sh connection
```

`install.sh` 只检查 Docker / Compose 等依赖，缺少或 Docker 未运行时给出安装命令后退出；不安装系统软件，不修改 nginx、防火墙、SSH 或账号。在服务器上构建镜像时联网下载系统包、固定 Node / CLI 和锁定 npm 依赖；非 JS 编译安装，node-pty 在镜像构建阶段准备。Node 24 原生执行 TypeScript；发行检查仍必须 typecheck。

默认一个公网 TCP 端口：WSS / HTTPS `8787`，登录、对话和执行通道都经它。运维 SSH 遵循服务器已有端口。云防火墙与主机策略自行放行，项目所在设备仅需出站 WSS。从 0.2.9 及更早版本升级的部署原先还放行了 `7000`，不再使用，可以去掉；用 `manage.sh upgrade` 升级时容器也不再发布它。Docker 发布端口可能绕过 UFW 的常规 INPUT 规则，应采用云安全组或 Docker 对应防火墙策略，不把启用 UFW 当成已限制发布端口。

nginx 模式下服务按 `X-Real-IP` 区分来源地址做登录限速，请保留示例里的这一行。

## 三种 TLS 入口

初始化只能进行一次，避免覆盖长期上下文或秘密；另一个安装用 `PROXY_DEPLOY_CONFIG=/绝对路径/docker.env`，并选独立数据目录 / 端口。

```sh
# 无域名：自签证书，客户端明确固定 SHA256 指纹
sudo bash deploy/manage.sh init --host VPS_IP --data /srv/cc-desk-tunnel

# 真实域名证书：检查证书/私钥配对、到期及域名，复制进私有数据目录
sudo bash deploy/manage.sh init --host proxy.example.com --mode certificate \
  --cert /path/fullchain.pem --key /path/privkey.pem --data /srv/cc-desk-tunnel

# 已有 nginx：只将上游 HTTP 发布至宿主回环，WSS 证书由 nginx 管理
sudo bash deploy/manage.sh init --host proxy.example.com --mode nginx \
  --url wss://proxy.example.com/ws --data /srv/cc-desk-tunnel
```

nginx 的配置步骤、检查方法和常见问题见[用 nginx 反代](nginx.md)。容器内监听 `0.0.0.0:8787` 是为 Docker bridge 接入，不是宿主公网 HTTP。同一 Docker 网络的可信边界也需考虑；不要把未知容器接入此网络。nginx 模式默认宿主 `127.0.0.1:8787`、公网 `443`；已有 nginx 入口端口由用户决定。不自动申请证书或改现有 nginx。

客户端填 `connection` 输出的 URL / token。自签模式填指纹；真实可信 CA 或 nginx 域名证书将指纹留空，使用 CA、有效期和主机名校验。私有 CA 可选择明确指纹；指纹模式不额外验证有效期 / 域名，首次信任应由可信 SSH 渠道获得。没有任何关闭验证且不校验指纹的模式。

对话和项目工具请求共用设备发起的已认证 WSS 连接。自签证书默认一年。

## 模型与可写空间

在客户端「设置 → 账号与额度」登录 Claude 账号，或在 `ccdt` 里运行 `ccdt auth login`；两者都运行官方 `claude auth login`，图形客户端与 ccdt 共用这一个登录。要改用 API key 或受支持的云提供方，写进服务器数据目录的 `config/provider.json`，例如 `{"env":{"ANTHROPIC_API_KEY":"<your-console-key>"}}`，对两者都生效；其他设置不会传入，账号页会列出它们的名字。文件应仅对部署账户可读；不要在桌面、聊天或 issue 中填写凭据。

从 0.3.x 升级：

1. 确认宿主机内核为 6.2 或更新（`uname -r`），Docker Compose 为 2.23.2 或更新（`docker compose version`）。Ubuntu 22.04 的默认内核是 5.15，可以安装 HWE 内核；Ubuntu 24.04 默认满足。需要升级内核时先升级并重启，0.3.x 在此期间照常运行。管理脚本在替换容器前检查这两项，不满足时停止，原服务不受影响。
2. 保持 0.3.x 服务在线。它自带的 `cc-desk-tunnel upgrade` 读取上游仓库的发布页，取不到这一版：从本仓库的发布页下载 `cc-desk-tunnel-server-0.4.0.tar.gz` 和 `SHA256SUMS`，用 `sha256sum -c --ignore-missing SHA256SUMS` 校验。
3. 执行 `sudo cc-desk-tunnel upgrade --from cc-desk-tunnel-server-0.4.0.tar.gz`。
4. 升级客户端和 `ccdt`。原来的 Claude 登录、用户设置和全局说明继续使用。

0.4 管理脚本会在替换容器前记录旧环境。如果升级前要备份或停机，先完成内核升级，再用 0.4 管理脚本对仍在线的原部署运行 `manage.sh hardware`，然后运行 `manage.sh backup`。旧版的备份命令会停启容器，Docker 可能在此时重新分配动态 MAC。同步升级 Compose 文件、proxy/runtime 镜像及客户端后，两容器都应报告 healthy。新环境保留原有 home，只导入项目历史，命令授权需在设备上重新给予。回退使用旧镜像、旧 Compose 和升级前备份。

**保留服务端硬件环境。** 在同一个 Docker Engine、同一份部署配置上用 `manage.sh upgrade` 升级或指定旧版包回退。首次升级请保持 0.3.x 服务在线，让 Docker 能返回原容器的主机名及各项目网络的实际 MAC。Docker 在容器停止或删除后可能已经清空动态 MAC，此时管理脚本会停止升级，并提示先用 `docker start` 启动原容器。已记录的部署可以从停止状态重建。需要支持按网络设置 MAC 的 Docker Compose 2.23.2 或更新版本。

宿主机内核升级或调整配置后，总内存和 CPU 特性列表会与记录不同，管理脚本只作提示，不阻止启动。Docker Engine、架构或 CPU 数量变化时会停止。确认要在当前环境继续运行时，执行 `manage.sh hardware --reset` 重新记录：部署有容器时按它当前的主机名、MAC 和配额重新采集，容器需在运行；原容器已被删除时，下次启动后记录 Docker 新分配的值。

管理脚本将真实架构、CPU 能力和配额、亲和性、内存、交换区、共享内存及网络配置保存在宿主机部署配置旁的 `.hardware/` 目录。0.4 的运行容器与代理共享网络，0.3 的代理使用同一组参数。启动后会在运行容器内核对主机名和 MAC。请保留部署配置及这个目录。Docker 重建会分配新的容器 ID。部署配置与客户端的设备编号分别保存在各自机器上。迁移到另一台服务器时使用备份还原流程和新服务器自己的硬件环境。

持久数据位于指定 `--data`：

- `home/`：云端 Claude Code 的登录、用户设置和全局说明（图形客户端与 ccdt 共用），用户安装工具及缓存。
- `app-home/`：全部会话的原生记录。
- `state/`：代理 SQLite / WAL、原生工作目录、每次运行的项目工具 socket。
- `workspace/`：代理容器的工作目录，在服务端执行的会话看不到它。
- `config/`、`tls/`：服务秘密、模型配置和两套 TLS 身份。

预装 Git / SSH / rsync、Node / npm、Python / pip / venv、GCC / make、curl / wget、jq / rg、文本编辑器、压缩工具、SQLite、网络与进程工具。在服务端执行的会话运行在运行容器里，可写的位置是会话自己的工作目录、它的 home 和 `/tmp`；工作目录和 home 里不能创建符号链接，所以 `npm install` 和建 venv 要放在 `/tmp` 下进行。不能直接 apt 安装系统软件。需要更多系统组件时扩展 Dockerfile。容器 root 文件层也并非全盘只读，但升级重建会丢弃其中临时修改；重要工具和记忆须存 `/data`。设备项目的文件与命令由所在设备经 MCP 执行。

## 运维

```sh
sudo bash deploy/manage.sh status
sudo bash deploy/manage.sh logs
sudo bash deploy/manage.sh stop
sudo bash deploy/manage.sh up
sudo bash deploy/manage.sh restart
sudo bash deploy/manage.sh upgrade
sudo bash deploy/manage.sh backup
sudo bash deploy/manage.sh restore cc-desk-tunnel-backup-….tar.gz
sudo bash deploy/manage.sh uninstall
```

Compose 崩溃 / 主机重启恢复，`tini -g` 管理信号与孤儿进程；停止给代理 30 秒正常回收，强杀则 Docker 回收容器中全部进程。日志上限 3 × 10MB。健康检查不发模型请求，也不是深度外部可用性探测；Docker 不会仅因 unhealthy 自动重启进程。

升级先拉取（或构建）新镜像，失败时不改配置、不停旧容器；成功后替换容器，数据保留，被替换下来的本项目镜像随后删除，以免每次升级多占几 GB。数据迁移在新程序启动时进行，换回旧镜像不等于回到旧数据，需要回退时用升级前的备份。没有外网的服务器可在别处 `docker save`、在服务器上 `docker load`，再在私有 `docker.env` 中把 `PROXY_IMAGE` 改成导入的标签后 `up`。

仅导入镜像、手工 Compose 管理时，使用 `deploy/compose.yml`（无 build）。在独立部署目录复制为 `compose.yml`，将初始化生成的 `docker.env` 复制为同目录 `.env`，确认 `PROXY_IMAGE` 为 `ghcr.io/lyy0709/cc-desk-tunnel:X.Y.Z` 或已导入的标签；该配置不含 token / API key，但目录和文件仍保持私有。运行 `sudo docker compose up -d` / `ps` / `logs` / `stop`。调用备份等脚本时设置 `PROXY_DEPLOY_CONFIG=/部署目录/.env`、`PROXY_COMPOSE_FILE=/部署目录/compose.yml`，确保使用相同数据和项目。升级时改 `.env` 里的版本号，执行 `sudo docker compose pull` 和 `sudo docker compose up -d`。

镜像构建后，`sudo bash deploy/test.sh` 可运行不调用模型的隔离部署回归；占用测试端口 19871..19874，创建临时数据并在结束时回收。不会改既有服务；测试数据被删除，不用来测试生产数据。`sudo bash deploy/test-image.sh` 用临时的本地镜像仓库走一遍拉取、拉取失败、替换容器和旧数据迁移；`bash deploy/test-scripts.sh` 不需要 Docker，用替身检查部署脚本的各种选择。三者都在 CI 里运行。

### 备份、还原与迁移

`sudo cc-desk-tunnel backup` 把整个数据目录打成一个压缩包，放在当前目录，文件名带主机名和时间，例如 `cc-desk-tunnel-backup-vm-0-12-20261118-153012.tar.gz`；也可以给一个目录或完整文件名。包里有原生 Claude Code 的登录、设置和记忆，全部会话与工作目录，服务凭据、证书和本项目的设置；不含临时 SSH 凭据、缓存和升级时留下的会话库副本（`state/backups`）。备份期间服务暂停，保证 SQLite / WAL 与原生数据一致，结束后恢复原来的运行状态。备份**含 token、API / 账号秘密、证书私钥和历史**，权限 0600，需安全离线保存。

`sudo cc-desk-tunnel restore 备份文件` 用备份替换这台服务器上的数据。它先列出备份来源和要覆盖的目录，输入 `yes` 才继续；覆盖之前把现有数据另存为备份文件旁边的 `…-before-restore.tar.gz`，还原后自动启动服务并打印部署汇总。脚本里调用加 `--yes`。比当前程序新的版本做的备份会被拒绝，先升级再还原。

还原保留这台服务器自己的入口：访问地址、端口、入口方式和证书都不变，服务凭据、账号和会话来自备份。两边都是自签证书（指纹模式）时证书也来自备份，客户端记下的指纹不用改。

迁移到新服务器：在旧服务器 `backup`，在新服务器照常安装，把备份文件拷过去（例如 `scp`）后 `restore`。客户端只需把服务地址改成新服务器；用证书或 nginx 入口时还要核对域名与证书。

还原只接受自己可信的备份，不执行未知归档。卸载仅删除容器与网络，保留数据、配置、镜像和宿主 Docker；要永久删除数据必须由用户确认准确目录后单独删除，不自动卸载其他程序依赖的 Docker。

自签续期：`manage.sh renew`，重启后重新交付客户端指纹。真实证书续期：`manage.sh certificate FULLCHAIN KEY`；可在既有 ACME deploy hook 中调用。nginx 的证书由既有 ACME / nginx 续期流程处理，无需重建容器。替换会断开在途会话，先结束任务。

原生开发部署仍有 `scripts/install-linux.sh` 与 `scripts/deploy-linux.mjs`，目前为普通用户 nohup 调试方式，不是生产部署方案。
