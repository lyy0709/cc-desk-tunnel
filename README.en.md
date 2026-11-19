# CC Desk Tunnel

[简体中文](README.md) | **English**

Claude Code runs on your Linux server. Your desktop or terminal client provides project-scoped MCP file tools over outbound WSS. Running build and test commands requires a grant on the project device for that session.

**Download**: [Desktop client](#desktop-client) · [Terminal client ccdt](#terminal-client-ccdt) · [Server](#1-deploy-the-service) · [All releases](https://github.com/lyy0709/cc-desk-tunnel/releases) | [Quick start](#quick-start) · [Security](#security) · [Documentation](#documentation) · License: [Apache-2.0](LICENSE)

> [!WARNING]
> **This project is mostly written by AI**, maintained by one person, and has not had a professional security audit. It may contain undiscovered defects. It gives a server the ability to run commands on your computer: read [Security](#security) and [Your account](#your-account) first and judge the risk for yourself.
>
> This project is not affiliated with Anthropic. "Claude" and "Claude Code" are trademarks of Anthropic.
>
> The client interface, the installer prompts and the detailed documentation are currently in Chinese only.

## What it solves

| The usual way | What gets in the way | With CC Desk Tunnel |
| --- | --- | --- |
| Move the project to a server and let Claude Code develop there | You set up the toolchain again; builds and tests need an expensive machine; your local editor, emulators and desktop software are out of reach | Project and toolchain stay local and commands run locally; the server only runs Claude Code, so a small one is enough |
| Use the CLI on the server through remote desktop or an SSH terminal | Lag, awkward input methods and copy-paste, long output that is hard to read back | A local desktop app with native input, scrolling and copying |
| Use the command-line interface as it is | Several projects and sessions are hard to keep apart; tool calls and thinking scroll by in one stream of text | Sessions grouped by project; the process folded into summaries you can expand |

## Screenshots

Desktop client: sessions grouped by project, including sessions from another computer that you can pick up here.

![Desktop client: sessions grouped by project and sessions on other devices on the left, the conversation and input box on the right](docs/images/desktop-client.png)

Terminal client `ccdt`: the official Claude Code in your own terminal, sharing sessions with the desktop client (its interface is in Chinese).

![ccdt help: commands to continue or create a session, list sessions, show usage, sign in and sign out](docs/images/ccdt-help.png)

![In ccdt, Claude Code creates and runs a PowerShell script in a local project directory](docs/images/ccdt-session.png)

## How it works

The broker authenticates clients and routes tool requests to their project device. The unmodified CLI runs in a separate server container. Local file tools use relative paths and check edits against the version read. Command grants expire on disconnect or project change.

This repository publishes all of its own client, server, build and deployment source, with no separate closed-source features. **This does not make Claude Code open source**: the official CLI and Agent SDK are installed from official channels and remain subject to Anthropic's terms. Bundled third-party components retain their own licenses; see [NOTICE](NOTICE).

## Features

| | |
| --- | --- |
| **Projects and sessions** | Grouped by Windows folder; create, rename, delete, search, fork; edit and resend any of your own messages |
| **The conversation** | Streaming replies, thinking summaries, tool calls with their input and results; add messages during a run, stop at any time |
| **Native controls** | Model, reasoning effort, approval mode, context usage and manual compaction, common Claude Code settings; one click opens the session in the terminal client `ccdt` when you need it |
| **Terminal client** | `ccdt` opens the official Claude Code in your own terminal, sharing sessions, context and usage statistics with the desktop client |
| **Account and usage** | Sign the server's Claude account in or out from the client; see quota, reset times and usage statistics |
| **Scheduled tasks** | Send a prepared prompt to a session, or a new one, at a set time; Claude can set these up for you |
| **Convenience** | Runs in the tray, remembers the sign-in, keeps unsent text per session |
| **One-click upgrades** | The service follows the release page; upgrade service and client from the client, without logging in to the server |

## Quick start

You need a Linux server with a public IP or domain name (x86_64, or arm64 as experimental support; Ubuntu recommended, Docker installed) and a Windows 10 / 11 x64 PC. The desktop client and `ccdt` also run on macOS and Linux, as experimental support.

**The server can be small.** Builds, tests and development tools all run on your Windows PC; the server only hosts Claude Code and a lightweight proxy service, so an entry-level machine with 2 vCPUs and 1 GB of memory is enough. Size it for heavier work only if you plan to have Claude build or run demanding tasks on the server itself.

### 1. Deploy the service

On the server:

```sh
sudo bash -c "$(curl -fsSL https://raw.githubusercontent.com/lyy0709/cc-desk-tunnel/main/deploy/install.sh)"
```

The script:

1. Checks for Docker, Docker Compose and a few tools. If something is missing it tells you the command to install it; it does not install system software itself.
2. Downloads the newest server archive from this repository's releases, verifies it and unpacks it to `/opt/cc-desk-tunnel`.
3. Asks for the public address, certificate mode, ports and data directory (every question has a default), then pulls the image of that version and starts it.
4. Prints what the client needs — **service address, certificate fingerprint, service token** — and the TCP port to open in the firewall (8787 by default, the only one).

The image is prebuilt on GitHub (`ghcr.io/lyy0709/cc-desk-tunnel`, x86_64 or arm64 as your server needs), so installing takes a few minutes. If the server cannot reach ghcr.io, the script builds the image on the server instead, which takes a few minutes more the first time. The script does not touch the firewall, nginx or SSH.

Once installed, manage the service with the `cc-desk-tunnel` command, from any directory:

```sh
sudo cc-desk-tunnel status    # is it running
sudo cc-desk-tunnel logs      # follow the log (Ctrl+C to stop)
sudo cc-desk-tunnel upgrade   # upgrade to the newest release; data, accounts and settings stay
sudo cc-desk-tunnel help      # every command: new token, backup and restore, certificates
```

Usually you do not need the server for upgrades: the client's Settings → About and updates upgrades the service too. Manual installation, the three certificate modes, backup and restore are covered in the [deployment manual](deploy/README.md); if you already run nginx with a domain, see [reverse proxying with nginx](deploy/nginx.md).

### 2. Install a client

There are two clients; install either or both. Each must be the same version as the service.

- **Desktop client**: a desktop app that groups sessions by project and folds each conversation's work into summaries you can expand.
- **Terminal client `ccdt`**: the official Claude Code in your own terminal, sharing sessions with the desktop client.

#### Desktop client

Download it from the [latest release](https://github.com/lyy0709/cc-desk-tunnel/releases/latest); the table at the top of the page lists the installer for each system, one click each:

- Windows 10 / 11 x64: the `.exe` installer.
- macOS (experimental): the Apple silicon or Intel `.dmg`; see [macOS client](docs/macos.md) (in Chinese).
- Linux x64 (experimental): the `.deb`; see [Linux client](docs/linux.md) (in Chinese).

The Windows installer bundles the project file helper and PowerShell 7; nothing else is needed. Start it, enter the three values from step 1 and connect. Expect a SmartScreen prompt on first run; see [Antivirus and SmartScreen](#antivirus-and-smartscreen). The macOS and Linux clients are unsigned and upgraded by downloading and installing the new package.

#### Terminal client ccdt

On Windows, in PowerShell:

```powershell
irm https://raw.githubusercontent.com/lyy0709/cc-desk-tunnel/main/deploy/install-ccdt.ps1 | iex
```

On macOS and Linux (experimental):

```sh
curl -fsSL https://raw.githubusercontent.com/lyy0709/cc-desk-tunnel/main/deploy/install-ccdt.sh | sh
```

The script downloads the newest release, checks it against `SHA256SUMS`, installs it for the current user and puts `ccdt` on the PATH; no administrator rights are needed. Then run `ccdt login`. If the service is not on the newest release, install the same version as the service; see [Terminal client](docs/cli.md#安装) (in Chinese).

### 3. Configure the model provider

For GUI requests, configure your own Console API key or supported cloud provider on the server in `config/provider.json`. The ccdt terminal uses the server user’s native Claude Code login. Open its authorization URL in your browser and paste a code back into the same terminal if prompted. Select the project folder on the desktop. To enable commands for one session, use the desktop session permission control or start `ccdt --allow-commands` in the project directory.

## Security

The [connection and privacy notes](SECURITY.md#连接与隐私) describe which party can see a device IP address, UTC offset, or location data.

Use a server you control. Protect the service credential and backups. Selected file contents and command output travel through the server to the model provider. A local command grant lets project scripts run with your OS account privileges. The desktop requires outbound WSS only.

Hosting and authentication are subject to [Anthropic’s Claude Code terms](https://code.claude.com/docs/en/legal-and-compliance). Eligibility also depends on the user's physical location and applicable entity criteria under [Anthropic’s supported regions policy](https://www.anthropic.com/legal/supported-regions).

## Antivirus and SmartScreen

- **frpc is no longer bundled.** Clients up to 0.2.9 shipped `frpc.exe` from the tunnelling tool frp, which Windows Defender and other antivirus products often quarantine as "hack tool / riskware". From 0.2.10 the client sets up the execution channel itself through the service address; neither the installer nor the server image contains frp, and the installer removes the old `frpc.exe` on upgrade.
- **Verify before allowing a bundled component.** Windows packages include the project file helper and a checksum-verified PowerShell 7 distribution. They are rarely blocked; if it happens, check that the installer comes from this repository's [releases page](https://github.com/lyy0709/cc-desk-tunnel/releases/latest), verify it against `SHA256SUMS`, and identify the file that was blocked. After checking the source, make only the necessary exception for the verified component file; do not disable antivirus or exclude a whole drive. Restore quarantined files or reinstall only after verification.
- **SmartScreen.** The installer is not code-signed. On first run Windows shows "Windows protected your PC": choose "More info → Run anyway".
- The project never changes the settings of any security software. If in doubt, build from source.

### When a working connection drops

The client reconnects automatically and catches up on session events. A running task stays on the server. A local operation interrupted by a disconnect may already have changed a file. After reconnecting, check the file before repeating the operation and grant command access again if the session needs it.

A task stops only after the computer has been away for more than 5 minutes (`PROXY_GRACE_SECONDS` on the server changes this). Back in the session, the "continue" button at the lower right of the message box takes it up again without writing anything; the same goes for a task stopped by hand. Choosing "Disconnect" or quitting the client ends a task at once.

The client checks every 15 seconds that the service is still there and, after about 45 seconds without any answer, treats the connection as lost; the service does the same for the client. It returns to the sign-in page only when the service refuses it outright (wrong token, another version).

To find which part of the way failed, compare both records:

- **Client**: `client.log` under "Settings → About and updates → Open log folder". For each connection it records when it was made, when it ended, whether the window or the service side ended it first, and why. It contains no credentials, conversations or commands.
- **Server**: `sudo docker logs <container> 2>&1 | grep Connection`. For each connection it records which computer it was, the address it came from, how long it lasted and how it ended. `no heartbeat answer for 45s` means the service got no answer from the client; `code 1006` means the other side went away without saying so, usually somewhere on the network, a proxy or a reverse proxy in between.

When connecting through a proxy or a reverse proxy, make sure it does not cut connections that carry little data for a long time; see [nginx as a reverse proxy](deploy/nginx.md) for nginx.

## Scope

- **Single user.** One service serves one person, who may have several of their computers connected at once; each session runs on the computer its project directory is on. There are no multiple users, permission levels or tenant isolation, and none are planned.
- **No modification of the official client, no evasion.** Nothing here is designed to get around risk controls or detection, or to get past the service's regional restrictions.

## Documentation

| Document | Contents |
| --- | --- |
| [Deployment manual](deploy/README.md) | Installation, upgrades, three TLS modes, backup and restore, operations |
| [Deployment and security boundaries](docs/deployment.md) | Ports, certificates, credentials, data and trust boundaries |
| [Security](SECURITY.md) | Threat model, protections, known gaps, reporting a vulnerability |
| [Architecture](docs/architecture.md) | Components, how a connection is established, key design decisions |
| [Native runtime and session storage](docs/native-runtime.md) | How the official CLI is driven, who owns context, approvals, retention |
| [Windows client](apps/desktop/README.md) · [Linux service](apps/server/README.md) · [Message contract](packages/protocol/README.md) | Implementation notes per module |
| [Terminal client `ccdt`](docs/cli.md) | Installation, sign-in, commands, sessions shared with the desktop client |
| [Roadmap and status](docs/roadmap.md) · [Changelog](CHANGELOG.md) | Done, unverified and planned; changes per version |
| [Development conventions](docs/development.md) | Branches, commits, checks, releases |

These documents are in Chinese.

## Building from source

You need Git, Node.js 24 and npm; on Windows, PowerShell 7.

```powershell
npm ci
npm run dev               # local simulated service + browser UI, no account needed
npm test                  # unit tests; also typecheck, test:ui, check
npm run package:windows   # builds the Windows installer; preparation in apps/desktop/README.md
npm run package:server    # builds the server archive; on the server, run its deploy/install.sh
```

```text
apps/desktop/       Windows client: UI (React), Electron main process, connection bridge, local execution components
apps/server/        Linux service: sessions, Claude Code adapter, Windows tunnel, usage statistics, release tracking
packages/protocol/  Message contract between the two sides (Zod)
deploy/             Docker deployment and operations scripts
scripts/            Checks, development launcher, packaging, release
docs/               Architecture, deployment and development documentation
```

## Community

We recognize [LINUX DO](https://linux.do/) and its values of sincerity, friendliness, solidarity and professionalism, and appreciate the community's discussions of remote development and open-source tools. Feedback is welcome; redact account details, service tokens, server addresses and private project information first. Report security vulnerabilities through the [private reporting channel](SECURITY.md#报告漏洞).

## Star history

[![Star history chart](https://api.star-history.com/svg?repos=sun168567/cc-desk-tunnel&type=Date)](https://star-history.com/#sun168567/cc-desk-tunnel&Date)

## License

[Apache License 2.0](LICENSE). Bundled third-party components and their licenses are listed in [NOTICE](NOTICE).
