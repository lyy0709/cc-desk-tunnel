import { projectTools, projectPrompt } from './project-tools.ts';
import { randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import {
  createReadStream,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  unwatchFile,
  watchFile,
} from 'node:fs';
import { createServer } from 'node:http';
import { totalmem, homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { IncomingMessage, RequestListener } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { WebSocket, WebSocketServer } from 'ws';
import {
  deleteSession,
  forkSession,
  getSessionInfo,
  getSessionMessages,
  renameSession,
} from '@anthropic-ai/claude-agent-sdk';
import {
  authSchema,
  APPROVAL_PAGE_CHARS,
  projectCommands,
  projectReply,
  type ProjectOperation,
  commandSchema,
  continues,
  deviceIdentitySchema,
  isFragment,
  historyControlSchema,
  leaveSchema,
  MAX_FRAME_BYTES,
  messageText,
  pathKey,
  platformOf,
  PROTOCOL_VERSION,
  runWorking,
  terminalControlSchema,
  webActivitySchema,
  webAuthSchema,
} from '@cc-desk-tunnel/protocol';
import type {
  Command,
  Device,
  EventPayload,
  PlanExecutionMode,
  TerminalActivity,
  Fragment,
  ServerMessage,
  Session,
  TerminalControl,
} from '@cc-desk-tunnel/protocol';
import {
  runClaude,
  nativeContext,
  nativeDirectory,
  prepareNativeDirectory,
  quotas,
  readNativeStatus,
} from './claude.ts';
import type { ApprovalPreview, ClaudeOptions, Unanswered } from './claude.ts';
import { ClientReleases } from './client-release.ts';
import { DomainError } from './errors.ts';
import { HistoryDelivery } from './history-delivery.ts';
import { IdleCompactions } from './idle-compaction.ts';
import { NativeInput } from './native-input.ts';
import { loginOf } from './native-controls.ts';
import { accountStatus } from './native-account.ts';
import { readNativeSettings, updateNativeSettings } from './native-settings.ts';
import { readInstructions, writeInstructions } from './native-instructions.ts';
import type { NativeTerminal } from './native-terminal.ts';
import {
  statusLineContext,
  subscriptionSnapshot,
  terminalActivity,
  terminalHooks,
  terminalRecord,
  terminalSettings,
  TerminalTranscript,
} from './terminal-transcript.ts';
import { inOrder } from './question.ts';
import { simulate } from './simulation.ts';
import { SessionStore } from './store.ts';
import { Throttle } from './throttle.ts';
import { ServiceUpdates, serviceVersion } from './updates.ts';
import type { UpdateOptions } from './updates.ts';
import { UsageLog, createUsageReceiver, telemetryEnvironment } from './usage.ts';
import { WebAccess } from './web-access.ts';
import { browserActivity, browserCommands, isWebCommand } from './web-commands.ts';

type Peer = {
  socket: WebSocket;
  id: string;
  address: string;
  authenticated: boolean;
  browser?: string;
  origin?: string;
  // A browser that came through a trusted proxy, which serves it the proxy's certificate.
  proxied?: boolean;
  // The computer it is from: the name it signed in with, and the identity that follows in a frame of its own.
  name: string;
  device?: Device;
  files?: boolean;
  commandGrants: Map<string, string>;
  // The client said it was closing the connection: nothing is kept for it to come back to.
  left: boolean;
  // This client wants the account quota kept current while runs go on.
  quotaWanted?: boolean;
  subscriptions: Set<string>;
  history?: HistoryDelivery;
  reads?: Partial<
    Record<
      'outline' | 'view' | 'export',
      { requestId: string; delivery: HistoryDelivery; controller: AbortController }
    >
  >;
  responses: Map<string, { command: string; response: Promise<ServerMessage> }>;
};
// A run belongs to the computer its session is on, not to the connection that started it: connections come
// and go with the network, and the CLI goes on working here meanwhile. `connectionId` only names the one that
// started it, in the record.
// What holds a service upgrade back, as a refusal says it: sessions at work, a session being moved or changed, a
// sign-in under way. Null when nothing does. Open terminals at rest and background tasks only end with the restart.
export function upgradeHeld(sessions: Session[], mutating: boolean, signingIn: boolean) {
  const working = sessions.filter((session) => runWorking(session.activeRun));
  const named =
    working
      .slice(0, 3)
      .map((session) => `「${session.title}」`)
      .join('') + (working.length > 3 ? ` 等 ${working.length} 个会话` : '');
  const parts = [
    ...(working.length ? [`${named}正在运行`] : []),
    ...(mutating ? ['有会话正在移动或修改'] : []),
    ...(signingIn ? ['Claude 账号正在登录'] : []),
  ];
  return parts.length
    ? `${parts.join('，')}。升级会重启服务端并中断它们：等结束后再升级，或选择强行升级。`
    : null;
}
export type Run = {
  id: string;
  sessionId: string;
  device: string;
  connectionId: string;
  controller: AbortController;
  // Simulation keeps its single tool and approval here; native runs use `approvals` and `input`.
  toolId?: string;
  toolFinished: boolean;
  approvalId?: string;
  decide?: (allowed: boolean, answers?: Record<string, string>) => void;
  approvals: Map<
    string,
    {
      toolName: string;
      preview: ApprovalPreview;
      decide: (
        allowed: boolean,
        answers?: Record<string, string>,
        unanswered?: Unanswered,
        executionMode?: PlanExecutionMode,
        cancelled?: boolean,
      ) => void;
    }
  >;
  // The approvals that are Claude's questions, answered or left unanswered rather than allowed or denied.
  questions: Set<string>;
  // Approvals and questions answered already: a second answer, from another window or computer, came late.
  answered: Set<string>;
  cancelReason?: string;
  // Output still arriving in pieces: sent on as it comes, recorded once it is whole.
  open?: Fragment;
  input?: NativeInput;
  scheduled?: 'scheduled' | 'manual';
  controls: {
    refresh?: (asked?: boolean) => Promise<void>;
    refreshProject?: () => Promise<void>;
    stopTask?: (taskId: string) => Promise<void>;
    backgroundTask?: (toolId: string) => Promise<boolean>;
  };
  // Turn figures are reported one after another, so a later report for the same question never lands before an earlier one.
  stats: ReturnType<typeof inOrder>;
};
type Terminal = {
  openedAt: number;
  subscriptionAtOpen: Promise<string | null>;
  id: string;
  sessionId: string;
  // The connection showing it. The terminal outlives a lost connection by `graceMs`.
  owner?: Peer;
  device: string;
  process?: NativeTerminal;
  idle?: ReturnType<typeof setTimeout>;
  // How the terminal continues its session: the native session's messages already recorded and the last of them, its
  // own files and how far its hooks were read, what its CLI was last doing, the time of the last of its turns' events
  // recorded, and whether it moved to another native session (and the session was told).
  continued: {
    known: Set<string>;
    last?: string;
    settingsPath: string;
    hooksPath: string;
    // Context-window figures reported by the interactive CLI.
    statusPath: string;
    offset: number;
    heard: Promise<void>;
    activity?: TerminalActivity;
    at: string;
    connectionId: string;
    elsewhere?: boolean;
    toldElsewhere?: boolean;
    // The native session held no message when last looked at.
    empty?: boolean;
    // The CLI's record of the session, which a hook names, and how far it was read as the CLI wrote it; what was read
    // of it goes through `transcript`.
    record?: string;
    recordOffset: number;
    transcript: TerminalTranscript;
  };
};
const INTERRUPTS = new Set(['\x1b', '\x03', '\x1b[27u', '\x1b[99;5u']);
// One of the user's computers, while it is connected or expected back: its connections, the door its commands
// go through, and the wait that ends its runs if it stays away.
type Seat = {
  device: string;
  peers: Set<Peer>;
  away?: NodeJS.Timeout;
};
type CommandOf<T extends Command['type']> = Extract<Command, { type: T }>;
export type ServerOptions = {
  token: string;
  dataDir: string;
  stepMs?: number;
  allowedOrigins?: string[];
  claude?: ClaudeOptions;
  tls?: { cert: Buffer; key: Buffer };
  reverseProxy?: boolean;
  host?: string;
  // Where an administrator puts the Windows installer offered to clients; defaults to <dataDir>/client.
  clientDir?: string;
  // How many native runs and terminals may be going at once, over all connections; by default what the
  // memory of this machine holds.
  maxRuns?: number;
  // Following the published releases; absent, the service neither looks for nor installs newer versions.
  updates?: Omit<UpdateOptions, 'clientDir'>;
  // How long the runs of a computer go on after its last connection broke, for it to come back to. By default
  // five minutes with the real CLI and none in simulation.
  graceMs?: number;
  // Defaults to the frontend shipped beside the server. Tests can provide a small fixture directory.
  webDirectory?: string;
};

// How many answered requests a connection remembers, to answer a resend of one the same way.
const REMEMBERED = 256;
// How much unfinished output a run holds before recording it, in characters.
const OPEN_LIMIT = 64 * 1024;
// What the "continue" button sends in the user's place. The turn before it was stopped or cut off, and a
// command that was under way then may or may not have taken effect.
const CONTINUE =
  'Continue from where the last turn stopped. A command that was running when it stopped may or may not have taken effect: check its result before repeating it.';

export function createProxyServer(options: ServerOptions) {
  if (options.token.length < 24)
    throw new Error('PROXY_TOKEN must contain at least 24 characters.');
  if (options.claude && !options.tls && !options.reverseProxy)
    throw new Error('Native mode requires TLS or explicit reverse proxy mode.');
  const store = new SessionStore(options.dataDir);
  const usage = new UsageLog(store.database);
  const usageReceiver = options.claude ? createUsageReceiver(usage) : undefined;
  const peers = new Set<Peer>();
  const pendingFiles = new Map<
    string,
    { peer: Peer; sessionId: string; settle: (ok: boolean, text: string) => void }
  >();
  const projectViews = new Set<() => void>();
  async function openTools(session: Session, preferred: string) {
    const directory = join(store.directory, 'project-sockets');
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const projectPeer = () => {
      const candidates = [...(seats.get(session.device?.id ?? '')?.peers ?? [])].filter(
        (p) => p.files && p.socket.readyState === WebSocket.OPEN,
      );
      return candidates.find((p) => p.id === preferred) ?? candidates.at(-1);
    };
    const endpoint = await projectTools(
      directory,
      (operation: ProjectOperation, signal: AbortSignal) => {
        const peer = projectPeer();
        if (!peer || signal.aborted) throw new Error('项目设备未连接。');
        const requestId = randomUUID();
        return new Promise<string>((resolve, reject) => {
          const stop = () => {
            send(peer, { type: 'project.cancel', requestId });
            settle(false, '执行中断，结果未知。');
          };
          const timer = setTimeout(stop, 150000);
          const settle = (ok: boolean, text: string) => {
            clearTimeout(timer);
            signal.removeEventListener('abort', stop);
            pendingFiles.delete(requestId);
            if (ok) resolve(text);
            else reject(new Error(text));
          };
          pendingFiles.set(requestId, { peer, sessionId: session.id, settle });
          signal.addEventListener('abort', stop, { once: true });
          const shell =
            operation.op === 'command'
              ? store.execution(session.device?.id, platformOf(session.device)).shell
              : undefined;
          send(peer, {
            type: 'project.call',
            requestId,
            sessionId: session.id,
            project: session.projectPath,
            operation:
              operation.op === 'command'
                ? { ...operation, shell: operation.shell ?? shell }
                : operation,
          });
        });
      },
    );
    const sync = () =>
      endpoint.setCommands(projectPeer()?.commandGrants.get(session.id) === session.projectPath);
    projectViews.add(sync);
    sync();
    return {
      config: endpoint.config,
      close() {
        projectViews.delete(sync);
        endpoint.close();
      },
    };
  }
  function checkHistory(session: Session) {
    if (options.claude && !session.projectAccess)
      throw new DomainError('history_consent', '旧会话可能包含绝对路径和用户名，请先确认续聊。');
  }
  quotas.wanted = () => [...peers].some((peer) => peer.quotaWanted);
  // One run or one terminal per session, each a CLI process of its own in the session's directory. What reads
  // or changes the state the CLI keeps for all of them — a status read or session change (`mutations`), an
  // account change — waits until none is going.
  const runs = new Map<string, Run>();
  const mutations = new Map<string, 'status' | 'session'>();
  const terminals = new Map<string, Terminal>();
  let statusPending: ReturnType<typeof accountStatus> | undefined;
  function personalAccount() {
    statusPending ??= accountStatus(options.claude!.executable, 'terminal').finally(() => {
      statusPending = undefined;
    });
    return statusPending;
  }
  async function captureSubscription(terminal: Terminal, scope: string | null) {
    if (!scope) return;
    const snapshot = subscriptionSnapshot(terminal.continued.statusPath);
    if (!snapshot) return;
    const at = Date.parse(snapshot.measuredAt);
    const callScope = usage.terminalScopeAt(terminal.sessionId, terminal.openedAt, at);
    if (callScope && callScope !== 'terminal' && callScope !== scope) return;
    if ((await terminal.subscriptionAtOpen) !== scope && callScope !== scope) return;
    usage.observe(snapshot, at, scope);
  }
  // A login PTY belongs only to its live connection and has no conversation, transcript or screen replay.
  let login: { owner: Peer; sessionId: string; id: string; process: NativeTerminal } | undefined;
  const seats = new Map<string, Seat>();
  const compactions = new IdleCompactions(store.directory, compactIdle, (sessionId) =>
    quotas.blockedUntil(loginOf(store.lastAccount(sessionId) ?? {}), store.lastQuota(sessionId)),
  );
  armCompactions();
  const graceMs = options.graceMs ?? (options.claude ? 300_000 : 0);
  // Each run or terminal is a CLI process that keeps some 250 MB; more of them than the memory holds would
  // take the machine down, and every one of them with it.
  const capacity =
    options.maxRuns ?? Math.max(1, Math.floor((totalmem() - 300 * 2 ** 20) / (300 * 2 ** 20)));
  // Background work that close() waits for.
  const tasks = new Set<Promise<unknown>>();
  let closing = false;
  const adapter = options.claude ? 'claude-code' : 'simulation';
  const origins = options.allowedOrigins ?? [
    'http://127.0.0.1:5173',
    'http://localhost:5173',
    'file://',
    'null',
  ];
  const expectedToken = createHash('sha256').update(options.token).digest();
  const authorized = (token: string) =>
    timingSafeEqual(expectedToken, createHash('sha256').update(token).digest());
  const clientDir = options.clientDir ?? join(options.dataDir, 'client');
  const releases = new ClientReleases(clientDir);
  const version = serviceVersion();
  const updates = options.updates
    ? new ServiceUpdates(
        // The next client of another version is offered the installer the moment it is here.
        { ...options.updates, clientDir, installed: () => void releases.refresh() },
        (state) => broadcast({ type: 'service.update', ...state }),
      )
    : undefined;
  const throttle = new Throttle();
  const web = new WebAccess({
    database: store.database,
    token: options.token,
    directory: options.webDirectory ?? fileURLToPath(new URL('../web/', import.meta.url)),
    dataDir: options.dataDir,
    tls: options.tls,
    reverseProxy: options.reverseProxy,
    host: options.host ?? '127.0.0.1',
  });
  const serverDevice: Device = { id: web.serverDeviceId, name: '服务端', platform: 'linux' };
  const originOf = (request: IncomingMessage) =>
    `${options.tls || options.reverseProxy ? 'https' : 'http'}://${request.headers.host}`;
  // Behind the reverse proxy every socket comes from the proxy itself; it passes the client on in X-Real-IP.
  const addressOf = (request: IncomingMessage) =>
    (options.reverseProxy && [request.headers['x-real-ip']].flat()[0]) ||
    request.socket.remoteAddress ||
    'unknown';
  function refuse(address: string, what = 'service token') {
    const count = throttle.fail(address);
    const wait = throttle.blocked(address);
    console.log(
      `Sign-in refused from ${address}: wrong ${what}, ${count} in a row${wait ? `; blocked for ${wait}s` : ''}`,
    );
  }

  const handler: RequestListener = (request, response) => {
    if (request.method === 'GET' && request.url === '/health') {
      response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      response.end(JSON.stringify({ status: 'ok', protocolVersion: PROTOCOL_VERSION, adapter }));
    } else if (request.method === 'GET' && request.url === '/client/installer') {
      // The same secret as the WebSocket: only a signed-in client can fetch the installer.
      const release = releases.current;
      const address = addressOf(request);
      if (throttle.blocked(address)) {
        response.writeHead(429, { 'Retry-After': throttle.blocked(address) }).end();
      } else if (!authorized(request.headers.authorization?.replace(/^Bearer /, '') ?? '')) {
        refuse(address);
        response.writeHead(401).end();
      } else if (!release) {
        response.writeHead(404).end();
      } else {
        response.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Content-Length': release.size,
          'Cache-Control': 'no-store',
        });
        createReadStream(release.path)
          .on('error', () => response.destroy())
          .pipe(response);
      }
    } else {
      void web
        .handle(request, response)
        .then((handled) => {
          if (!handled) response.writeHead(404).end();
        })
        .catch(() => {
          if (response.headersSent) response.destroy();
          else response.writeHead(500).end();
        });
    }
  };
  const server = options.tls
    ? createHttpsServer(
        {
          ...options.tls,
          SNICallback: (servername, done) => done(null, web.certificates.context(servername)),
        },
        handler,
      )
    : createServer(handler);
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_FRAME_BYTES,
    perMessageDeflate: { serverNoContextTakeover: true, clientNoContextTakeover: true },
  });
  server.on('upgrade', (request, socket, head) => {
    if (!closing && web.matchesUpgrade(request)) {
      const address = web.address(request);
      const session = web.authenticate(request);
      if (!session) {
        socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
        return;
      }
      if (web.throttle.blocked(address) || !web.throttle.enter(address)) {
        socket.end('HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n');
        return;
      }
      wss.handleUpgrade(request, socket, head, (ws) =>
        wss.emit('connection', ws, address, {
          browser: session.id,
          origin: originOf(request),
          proxied: web.proxied(request),
        }),
      );
      return;
    }
    if (
      closing ||
      request.url !== '/ws' ||
      (request.headers.origin && !origins.includes(request.headers.origin))
    ) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    const address = addressOf(request);
    if (throttle.blocked(address) || !throttle.enter(address)) {
      socket.end(
        `HTTP/1.1 429 Too Many Requests\r\nRetry-After: ${throttle.blocked(address) || 5}\r\nConnection: close\r\n\r\n`,
      );
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) =>
      wss.emit('connection', ws, address, { origin: originOf(request) }),
    );
  });

  function send(peer: Peer, message: ServerMessage) {
    // History and usage series can span many records.
    if (peer.socket.readyState === WebSocket.OPEN)
      peer.socket.send(JSON.stringify(message), {
        compress: [
          'session.snapshot',
          'session.history.part',
          'session.outline',
          'session.read',
          'usage.page',
        ].includes(message.type),
      });
  }
  function broadcast(message: ServerMessage, sessionId?: string) {
    if (message.type === 'session.updated')
      message = {
        ...message,
        session: { ...message.session, lastSequence: store.lastSequence(message.session.id) },
      };
    for (const peer of peers) {
      if (peer.authenticated && (!sessionId || peer.subscriptions.has(sessionId)))
        send(peer, message);
    }
  }
  function deviceOf(peer: Peer) {
    if (!peer.device) throw new DomainError('device_unknown', '客户端没有报告设备标识。');
    return peer.device;
  }
  // A session's commands run on the computer its project directory is on, whichever of the user's computers
  // asks; that computer has to be connected and its execution channel ready. One from before computers were
  // told apart becomes that of the first to use it. Gives the computer's ID.
  function target(peer: Peer, session: Session) {
    if (session.device?.id === serverDevice.id) return serverDevice.id;
    const device = peer.browser ? undefined : deviceOf(peer);
    if (!session.device) {
      // Before computers were told apart they were all Windows ones, and so is the session's project path.
      if (!device || platformOf(device) !== 'win32')
        throw new DomainError(
          'other_device',
          '此会话在一台 Windows 电脑上。要在本机接着做，请先为它选择本机的项目目录，或把它分叉到本机。',
        );
      updated(store.claim(session.id, device).id);
    }
    const place = session.device ?? device!;
    const seat = seats.get(place.id);
    if (place.id === device?.id) {
      if (options.claude && !peer.files)
        throw new DomainError(
          'execution_offline',
          '本机的执行通道尚未就绪，请稍候；客户端正在建立或重新建立连接。',
        );
    } else if (!seat?.peers.size)
      throw new DomainError(
        'device_offline',
        `设备“${place.name}”不在线。它连上服务后才能在这里操作它的会话；也可以把会话接到本机或分叉到本机。`,
      );
    else if (options.claude && ![...seat.peers].some((p) => p.files))
      throw new DomainError(
        'execution_offline',
        `设备“${place.name}”的执行通道尚未就绪，请稍候再试。`,
      );
    return place.id;
  }
  // Which of the user's computers are connected and whether commands reach them, told to every window when
  // it changes. A computer whose runs wait for it to come back is not connected.
  let presence = '';
  function devices(): ServerMessage {
    return {
      type: 'devices',
      devices: [
        // The service itself is always there. It is listed once it has sessions, with Web on or off, so a
        // desktop that never used it is told of its computers just as before.
        ...(store.list().some((session) => session.device?.id === serverDevice.id)
          ? [{ ...serverDevice, ready: true, server: true as const }]
          : []),
        ...[...seats.values()].flatMap((seat) => {
          const device = [...seat.peers].findLast((peer) => peer.device)?.device;
          if (!device) return [];
          const { shells, shell } = store.execution(device.id, platformOf(device));
          return [
            {
              ...device,
              ready: !options.claude || [...seat.peers].some((p) => p.files),
              shells,
              ...(shell ? { shell } : {}),
            },
          ];
        }),
      ],
    };
  }
  function announce() {
    for (const sync of projectViews) sync();
    const message = devices();
    const text = JSON.stringify(message);
    if (closing || text === presence) return;
    presence = text;
    broadcast(message);
  }
  function room() {
    if (options.claude && runs.size + terminals.size + Number(!!login) >= capacity)
      throw new DomainError(
        'capacity',
        `服务端同时最多进行 ${capacity} 个运行或终端（按服务器内存估算，可用 PROXY_MAX_RUNS 调整）。请等其他任务结束后再试。`,
      );
  }
  function track(task: Promise<unknown>, group = tasks) {
    group.add(task);
    void task.finally(() => group.delete(task));
  }
  function updated(sessionId: string) {
    broadcast({ type: 'session.updated', session: store.get(sessionId).session });
  }

  // Stores an event and sends it to the session's subscribers; quota readings also drive the usage periods.
  function record(sessionId: string, runId: string, payload: EventPayload, createdAt?: string) {
    if (payload.type === 'native.metrics' && !payload.profile && payload.rateLimits?.available)
      usage.observe(payload.rateLimits);
    const event = store.append(sessionId, runId, payload, createdAt);
    broadcast({ type: 'session.event', event }, sessionId);
    if (payload.type === 'native.metrics' && payload.cacheTtl)
      compactions.arm(sessionId, Date.parse(event.createdAt), payload);
    else if (payload.type === 'message.user' || payload.type === 'native.compact')
      compactions.cancel(sessionId);
    return event;
  }
  // Each session's last turn sets when it is compacted while idle, as after the service starts or the setting changes.
  function armCompactions() {
    if (!compactions.settings.enabled) return;
    for (const session of store.list()) if (!session.activeRun) armCompaction(session.id);
  }
  function armCompaction(sessionId: string) {
    const turn = store.lastCachedTurn(sessionId);
    if (turn) compactions.arm(sessionId, turn.endedAt, turn.metrics);
  }
  // Compacts an idle session before its prompt cache lapses, as the compact button does; see idle-compaction.ts. It
  // runs here whether or not a window or the session's computer is there. A session that runs is left alone, and so
  // is one a terminal holds: the terminal's CLI compacts it by the same setting (see `terminalSettings`), and when the
  // terminal ends first, its last turn is looked at again.
  function compactIdle(sessionId: string, endedAt: number) {
    if (closing || !options.claude) return;
    try {
      const { session } = store.get(sessionId);
      if (
        !session.projectAccess ||
        session.activeRun ||
        terminals.has(sessionId) ||
        !session.device
      )
        return;
      submit(undefined, { type: 'session.compact', requestId: randomUUID(), sessionId }, session);
      const run = runs.get(sessionId);
      if (run) {
        const minutes = Math.floor((Date.now() - endedAt) / 60_000);
        emit(run, {
          type: 'native.notice',
          text: `上一轮结束已 ${minutes} 分钟，提示缓存即将过期：按设置自动压缩上下文，压缩读取的是缓存。`,
        });
      }
    } catch {
      // As many runs as the service holds are going, or the session's native record is gone: left as it is.
    }
  }
  // Records what has arrived of the output the run is in the middle of.
  function settle(run: Run) {
    const open = run.open;
    if (!open) return;
    run.open = undefined;
    record(run.sessionId, run.id, open);
  }
  function emit(run: Run, payload: EventPayload) {
    // A background task's word of itself is for whoever is watching now.
    if (payload.type === 'native.progress') {
      broadcast(
        { type: 'session.fragment', sessionId: run.sessionId, runId: run.id, payload },
        run.sessionId,
      );
      return;
    }
    if (isFragment(payload)) {
      if (run.open && !continues(run.open, payload)) settle(run);
      run.open = run.open ? { ...run.open, text: run.open.text + payload.text } : payload;
      broadcast(
        { type: 'session.fragment', sessionId: run.sessionId, runId: run.id, payload },
        run.sessionId,
      );
      // Very long output is recorded a part at a time, so that what is held here stays small.
      if (run.open.text.length >= OPEN_LIMIT) settle(run);
      return;
    }
    settle(run);
    record(run.sessionId, run.id, payload);
    if (payload.type === 'native.title' && store.get(run.sessionId).session.autoTitle)
      broadcast({
        type: 'session.updated',
        session: store.renameNative(run.sessionId, payload.title),
      });
    if (payload.type === 'run.status' || payload.type === 'native.permission')
      updated(run.sessionId);
  }
  // The CLI reports its model requests a moment after the turn ends. Wait for as many as the turn made, then
  // record what they add up to; whatever has not come by then is left out and the figures are marked partial.
  async function turnStats(
    run: Run,
    turn: {
      messageId?: string;
      startedAt: number;
      endedAt: number;
      requests: number;
      outputTokens: number;
      promptIds: string[];
      background: boolean;
    },
  ) {
    // Complete once every request of the main loop is there and the records add up to the output the CLI counted for the
    // turn, which includes its subagents. Subagent records must not stand in for a main request that is still on its way.
    const complete = (stats: { mainRequests: number; outputTokens: number }) =>
      stats.mainRequests >= turn.requests && stats.outputTokens >= turn.outputTokens;
    let stats = usage.turnStats(run.sessionId, turn);
    // Without a count of requests to wait for, give the usual export delay one chance.
    for (let waited = 0; waited < 8000; waited += 500) {
      if (turn.requests ? complete(stats) : waited >= 3000) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
      stats = usage.turnStats(run.sessionId, turn);
    }
    const { mainRequests, ...figures } = stats;
    if (figures.requests)
      emit(run, {
        type: 'turn.stats',
        messageId: turn.messageId,
        ...figures,
        partial: turn.background || !complete(stats),
      });
  }
  function finish(run: Run, status: 'completed' | 'cancelled' | 'failed', reason?: string) {
    if (runs.get(run.sessionId) !== run) return;
    run.input?.close();
    if (run.toolId && !run.toolFinished) {
      emit(run, {
        type: 'tool.result',
        toolId: run.toolId,
        status: 'cancelled',
        output: '模拟工具未执行。',
        exitCode: null,
      });
    }
    emit(run, { type: 'run.status', status, reason, connectionId: run.connectionId });
    runs.delete(run.sessionId);
    run.controller.abort();
    run.decide?.(false);
    for (const { decide } of run.approvals.values())
      decide(false, undefined, undefined, undefined, true);
    run.approvals.clear();
  }
  // A native run ends through its own adapter, which reports what is known about in-flight tools first.
  function cancel(run: Run, reason: string) {
    if (!options.claude) {
      finish(run, 'cancelled', reason);
      return;
    }
    run.cancelReason = reason;
    run.input?.close();
    run.controller.abort();
    for (const { decide } of run.approvals.values())
      decide(false, undefined, undefined, undefined, true);
    run.approvals.clear();
  }
  function nativeRoot(sessionId: string) {
    return store.get(sessionId).session.nativeRoot ?? sessionId;
  }
  async function native(run: Run) {
    let tools: Awaited<ReturnType<typeof openTools>> | undefined;
    try {
      const { session } = store.get(run.sessionId);
      if (run.device !== serverDevice.id) tools = await openTools(session, run.connectionId);
      const status = await runClaude(options.claude!, {
        sessionId: run.sessionId,
        nativeRoot: session.nativeRoot ?? session.id,
        permissionMode: session.permissionMode,
        model: session.model,
        effort: session.effort,
        input: run.input!,
        scheduled: run.scheduled,
        controls: run.controls,
        waiting: (background) =>
          emit(run, {
            type: 'run.status',
            status: 'running',
            connectionId: run.connectionId,
            ...(background ? { waiting: 'background' as const } : {}),
          }),
        turnEnded: (turn) => track(run.stats(() => turnStats(run, turn))),
        dataDir: store.directory,
        resume: store.hasNativeContext(run.sessionId),
        signal: run.controller.signal,
        projectTools: tools?.config,
        emit: (event) => emit(run, event),
        approve: (toolId, waiting, toolName, signal, preview) => {
          if (signal.aborted) return Promise.resolve({ allowed: false });
          const approvalId = randomUUID();
          if (waiting === 'question') run.questions.add(approvalId);
          return new Promise((resolve) => {
            const abort = () =>
              answerApproval(
                run,
                approvalId,
                false,
                undefined,
                undefined,
                run.connectionId,
                undefined,
                true,
              );
            run.approvals.set(approvalId, {
              toolName,
              preview,
              decide: (allowed, answers, unanswered, executionMode, cancelled) => {
                signal.removeEventListener('abort', abort);
                run.questions.delete(approvalId);
                emit(run, {
                  type: 'approval.resolved',
                  approvalId,
                  allowed,
                  executionMode,
                  ...(cancelled ? { cancelled } : {}),
                });
                resolve({ allowed, answers, unanswered, executionMode });
              },
            });
            signal.addEventListener('abort', abort, { once: true });
            emit(run, { type: 'approval.requested', approvalId, toolId });
            emit(run, {
              type: 'run.status',
              status: 'awaiting_approval',
              connectionId: run.connectionId,
              waiting,
            });
          });
        },
      });
      finish(run, status, run.cancelReason);
    } catch {
      emit(run, {
        type: 'run.error',
        code: 'native_adapter_failed',
        message: '原生进程适配失败；请检查服务配置和 CLI 版本。',
      });
      finish(run, run.controller.signal.aborted ? 'cancelled' : 'failed', run.cancelReason);
    } finally {
      tools?.close();
    }
  }

  // Starts the CLI without a prompt to read its account, model and quota state.
  async function readStatus(peer: Peer, command: CommandOf<'session.status'>) {
    if (!options.claude) throw new DomainError('native_unavailable', '离线模拟没有原生账号状态。');
    // During a run its own CLI answers, so quota can be reread without waiting for the turn to end.
    const active =
      runs.get(command.sessionId) ?? [...runs.values()].find((run) => run.controls.refresh);
    if (active?.controls.refresh && !mutations.size) {
      await Promise.all([
        active.controls.refresh(command.quota),
        active.sessionId === command.sessionId ? active.controls.refreshProject?.() : undefined,
      ]);
      return;
    }
    // A terminal's session is read by a CLI of its own that does not take it up (its figures stay as they were).
    if (runs.size || mutations.size)
      throw new DomainError('native_busy', '运行结束后再刷新原生状态。');
    const resume =
      !!store.get(command.sessionId).session.projectAccess && !terminals.has(command.sessionId);
    const last = resume ? null : store.lastMetrics(command.sessionId);
    mutations.set(command.sessionId, 'status');
    const controller = new AbortController();
    const closed = () => controller.abort();
    peer.socket.once('close', closed);
    try {
      const events = await readNativeStatus(
        options.claude,
        store.directory,
        nativeRoot(command.sessionId),
        command.sessionId,
        controller.signal,
        { asked: command.quota, previous: store.lastMetrics(command.sessionId)?.usage, resume },
      );
      for (const read of events) {
        const payload: EventPayload =
          resume || read.type !== 'native.metrics'
            ? read
            : { ...read, context: last?.context ?? null, usage: last?.usage ?? null };
        const event = record(command.sessionId, command.requestId, payload);
        if (!peer.subscriptions.has(command.sessionId))
          send(peer, { type: 'session.event', event });
      }
      updated(command.sessionId);
    } finally {
      peer.socket.removeListener('close', closed);
      mutations.delete(command.sessionId);
    }
  }
  async function closeTerminal(peer: Peer, command: CommandOf<'terminal.close'>) {
    const terminal = terminals.get(command.sessionId);
    if (!terminal || terminal.id !== command.terminalId)
      throw new DomainError('terminal_inactive', '终端已结束。');
    if (terminal.owner !== peer) throw new DomainError('not_owner', '终端属于另一连接。');
    await terminal.process?.close();
  }
  // The terminal occupies its session like a run does, so other connections see it as busy.
  async function openTerminal(peer: Peer, command: CommandOf<'terminal.open'>, session: Session) {
    if (!options.claude) throw new DomainError('native_unavailable', '离线模拟不启动终端。');
    const running = terminals.get(command.sessionId);
    if (running?.process) return attachTerminal(peer, running, command);
    // The terminal's own CLI takes care of the session while it is held.
    compactions.cancel(command.sessionId);
    if (terminals.has(command.sessionId) || runs.has(command.sessionId) || mutations.size)
      throw new DomainError('native_busy', '请先结束这个会话的运行或会话管理，再打开终端。');
    const device = target(peer, session);
    checkHistory(session);
    room();
    const id = randomUUID();
    const directory = join(store.directory, 'terminals', id);
    const current: Terminal = {
      openedAt: Date.now(),
      subscriptionAtOpen: personalAccount().then(
        (result) => result.scope,
        () => null,
      ),
      id,
      sessionId: command.sessionId,
      owner: peer,
      device,
      continued: {
        known: new Set(),
        settingsPath: join(directory, 'settings.json'),
        hooksPath: join(directory, 'events', 'hooks'),
        statusPath: join(directory, 'events', 'status'),
        offset: 0,
        heard: Promise.resolve(),
        activity: 'idle',
        at: new Date().toISOString(),
        connectionId: peer.id,
        recordOffset: 0,
        transcript: new TerminalTranscript((payload, at) => terminalEvent(current, payload, at)),
      },
    };
    let tools: Awaited<ReturnType<typeof openTools>> | undefined;
    terminals.set(current.sessionId, current);
    try {
      const { NativeTerminal, terminalArguments, terminalEnvironment } =
        await import('./native-terminal.ts');
      const cwd = prepareNativeDirectory(options.claude, store.directory, nativeRoot(session.id));
      const resume = !!(await getSessionInfo(session.id, { dir: cwd }));
      const messages = await getSessionMessages(session.id, {
        dir: cwd,
        includeSystemMessages: true,
      }).catch(() => []);
      // A record of the session with nothing in it, which a terminal that ended without a word left when it could
      // not clear it away (see the end below), makes the CLI refuse the session's ID as one in use.
      if (!resume && !messages.length)
        await deleteSession(session.id, { dir: cwd }).catch(() => {});
      current.continued.known = new Set(messages.map((message) => message.uuid));
      current.continued.last = messages.at(-1)?.uuid;
      mkdirSync(join(directory, 'events'), { recursive: true, mode: 0o700 });
      terminalSettings(
        current.continued.settingsPath,
        current.continued.hooksPath,
        options.claude.settingsPath,
        current.continued.statusPath,
        undefined,
        compactions.settings,
      );
      if (closing || peer.socket.readyState !== WebSocket.OPEN)
        throw new Error('Connection closed');
      if (device !== serverDevice.id) tools = await openTools(session, peer.id);
      const args = terminalArguments(options.claude, session, {
        resume,
        settingsPath: current.continued.settingsPath,
      });
      if (tools)
        args.push(
          '--tools',
          'AskUserQuestion,EnterPlanMode,ExitPlanMode',
          '--setting-sources',
          'user',
          '--strict-mcp-config',
          '--mcp-config',
          JSON.stringify({ mcpServers: { project: tools.config } }),
          '--append-system-prompt',
          projectPrompt,
        );
      current.process = new NativeTerminal(
        options.claude.executable,
        args,
        {
          cwd,
          cols: command.cols,
          rows: command.rows,
          env: {
            ...terminalEnvironment(options.claude, process.env),
            CCDT_RUNTIME_SESSION: session.id,
            ...(tools && { CCDT_PROJECT_SOCKET: tools.config.args[1] }),
          },
          status: (activity) => void heardTerminal(current, false, activity),
          screen: {
            detached: () => {
              if (current.owner)
                send(current.owner, {
                  type: 'terminal.detached',
                  sessionId: current.sessionId,
                  terminalId: current.id,
                  reason: 'stalled',
                });
              detachTerminal(current);
            },
          },
        },
        (data, bytes) =>
          current.owner &&
          send(current.owner, {
            type: 'terminal.data',
            sessionId: current.sessionId,
            terminalId: current.id,
            data,
            bytes,
          }),
        async (exitCode) => {
          tools?.close();
          if (terminals.get(current.sessionId) !== current) return;
          clearTimeout(current.idle);
          unwatchFile(current.continued.hooksPath);
          if (current.continued.record) unwatchFile(current.continued.record);
          await heardTerminal(current, true);
          try {
            await captureSubscription(current, (await personalAccount()).scope);
          } catch {
            console.warn('Unable to retain the closing terminal’s subscription reading.');
          }
          // A terminal that said nothing leaves no native session: its record, with nothing in it, would keep the
          // session's ID from a chat run or the next terminal, which the CLI refuses it to as one in use.
          if (current.continued.empty)
            await deleteSession(current.sessionId, { dir: cwd }).catch(() => {});
          else
            record(
              current.sessionId,
              current.id,
              nativeContext(
                current.sessionId,
                await getSessionInfo(current.sessionId, { dir: cwd }).catch(() => undefined),
              ),
            );
          rmSync(directory, { recursive: true, force: true });
          store.append(current.sessionId, current.id, {
            type: 'run.status',
            status: 'completed',
            surface: 'terminal',
            connectionId: peer.id,
          });
          updated(current.sessionId);
          if (current.owner)
            send(current.owner, {
              type: 'terminal.closed',
              sessionId: current.sessionId,
              terminalId: current.id,
              exitCode,
            });
          terminals.delete(current.sessionId);
          // What the terminal's CLI did not compact before it ended is the service's again.
          if (compactions.settings.enabled) armCompaction(current.sessionId);
        },
      );
      store.append(command.sessionId, current.id, {
        type: 'run.status',
        status: 'running',
        surface: 'terminal',
        activity: current.continued.activity,
        connectionId: peer.id,
      });
      updated(command.sessionId);
      watchFile(current.continued.hooksPath, { interval: 500 }, () => void heardTerminal(current));
      send(peer, { type: 'terminal.opened', sessionId: command.sessionId, terminalId: current.id });
    } catch {
      tools?.close();
      await current.process?.close();
      if (!current.process) rmSync(directory, { recursive: true, force: true });
      if (terminals.get(current.sessionId) === current) terminals.delete(current.sessionId);
      throw new DomainError('terminal_failed', '终端启动失败，请检查 Linux PTY 组件与 CLI。');
    }
  }
  // Another look at a terminal that keeps running. The connection that showed it is told it no longer does.
  async function attachTerminal(
    peer: Peer,
    terminal: Terminal,
    command: CommandOf<'terminal.open'>,
  ) {
    const { sessionId, id: terminalId } = terminal;
    if (terminal.owner && terminal.owner !== peer)
      send(terminal.owner, { type: 'terminal.detached', sessionId, terminalId, reason: 'taken' });
    terminal.owner = peer;
    clearTimeout(terminal.idle);
    send(peer, { type: 'terminal.opened', sessionId, terminalId });
    await terminal.process!.attach(command.cols, command.rows);
  }
  // The connection that showed a terminal that continues its session was lost, or stopped taking its output. As
  // with a run, the CLI goes on for `graceMs`, for the client to come back and show it again; then it ends.
  function detachTerminal(terminal: Terminal) {
    terminal.owner = undefined;
    terminal.process?.detach();
    clearTimeout(terminal.idle);
    terminal.idle = setTimeout(() => {
      const task = terminal.process?.close();
      if (task) track(task);
    }, graceMs);
  }
  // What the hooks of a terminal that continues its session wrote since they were last read: the session shows what
  // its CLI is doing, and what a turn added is read whole once it ended (see `importTerminal`). Reads go one at a time,
  // and the last, when the terminal `ended`, records what is left. `told` is what the CLI is doing as it says so itself
  // (see `programStatus`), or as a key that interrupts it implies; it holds when no hook came since. A turn the user
  // stops runs no hook, so its end is known only this way.
  function heardTerminal(terminal: Terminal, ended = false, told?: TerminalActivity) {
    const { continued } = terminal;
    const task = continued.heard
      .then(async () => {
        const { hooks, offset } = terminalHooks(continued.hooksPath, continued.offset);
        continued.offset = offset;
        let activity: TerminalActivity | undefined;
        for (const hook of hooks) {
          if (typeof hook.session_id === 'string' && hook.session_id !== terminal.sessionId)
            continued.elsewhere = true;
          else if (!continued.record && typeof hook.transcript_path === 'string' && !ended)
            followRecord(terminal, hook.transcript_path);
          activity = terminalActivity(hook) ?? activity;
        }
        if (told && !hooks.length) activity = told;
        const stopped = told === 'idle' && !hooks.length && continued.activity !== 'idle';
        if (ended || stopped || hooks.some((hook) => terminalActivity(hook) === 'idle')) {
          await importTerminal(terminal);
          terminalTurnEnded(terminal);
        }
        if (ended || !activity || activity === continued.activity) return;
        continued.activity = activity;
        record(terminal.sessionId, terminal.id, {
          type: 'run.status',
          status: 'running',
          surface: 'terminal',
          activity,
          connectionId: continued.connectionId,
        });
        updated(terminal.sessionId);
      })
      .catch(() => {});
    continued.heard = task;
    return task;
  }
  // The CLI's record of the session, read as the CLI writes it, from where it is when a hook names it: a turn shows
  // here part by part as it goes, a moment after the terminal (see `terminalRecord`). Nothing the CLI writes before
  // its first hook is a turn's. Reads go one at a time, with those of the hooks.
  function followRecord(terminal: Terminal, path: string) {
    const { continued } = terminal;
    const projects = join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'projects');
    try {
      const project = nativeDirectory(store.directory, nativeRoot(terminal.sessionId)).replaceAll(
        '/',
        '-',
      );
      const record = terminal.sessionId + '.jsonl';
      if (!path.endsWith('/projects/' + project + '/' + record)) return;
      const canonical = join(realpathSync(projects), project, record);
      path = realpathSync(canonical);
      if (path !== canonical) return;
    } catch {
      return;
    }
    continued.record = path;
    try {
      continued.recordOffset = statSync(path).size;
    } catch {
      continued.recordOffset = 0;
    }
    watchFile(path, { interval: 1000 }, () => void readRecord(terminal));
  }
  function readRecord(terminal: Terminal) {
    const { continued } = terminal;
    const task = continued.heard
      .then(() => {
        if (!continued.record) return;
        const { messages, offset } = terminalRecord(continued.record, continued.recordOffset);
        continued.recordOffset = offset;
        continued.transcript.accept(messages, continued.known);
        for (const message of messages) continued.known.add(message.uuid);
        // The CLI writes the end of a turn a moment after it says the turn is over.
        if (continued.activity === 'idle') terminalTurnEnded(terminal);
      })
      .catch(() => {});
    continued.heard = task;
    return task;
  }
  // Records what a terminal's CLI wrote, each at the time the CLI recorded it, after what was recorded of its turns
  // before and no later than now. What the terminal was doing is recorded as it happens, and does not move them: a
  // turn keeps the times it took.
  function terminalEvent(terminal: Terminal, payload: EventPayload, at?: string) {
    const { continued } = terminal;
    const now = new Date().toISOString();
    const time = at && !Number.isNaN(Date.parse(at)) ? new Date(at).toISOString() : now;
    continued.at = time < continued.at ? continued.at : time > now ? now : time;
    record(terminal.sessionId, terminal.id, payload, continued.at);
  }
  // How full the context is, as the terminal's CLI last showed it in its status line.
  function terminalContext(terminal: Terminal) {
    try {
      return statusLineContext(
        JSON.parse(readFileSync(terminal.continued.statusPath, 'utf8')),
        readNativeSettings().autoCompactWindow,
      );
    } catch {
      return null;
    }
  }
  // A terminal's turn is over, as a chat run's: the context it left and how long the cache it wrote lasts, from which
  // the session tells how long it has been idle (see idle.ts). A turn that asked the model nothing says nothing.
  function terminalTurnEnded(terminal: Terminal) {
    const ttl = terminal.continued.transcript.cacheTtl();
    if (!ttl) return;
    const last = store.lastMetrics(terminal.sessionId);
    record(terminal.sessionId, terminal.id, {
      type: 'native.metrics',
      profile: 'terminal',
      context: terminalContext(terminal) ?? last?.context ?? null,
      usage: last?.usage ?? null,
      rateLimits: null,
      cacheTtl: ttl,
    });
  }
  // A turn the user interrupts runs no hook and leaves nothing in the CLI's record (CLI 2.1.293). A key that
  // interrupts it, typed while the CLI works, with no hook after it in a while, is taken for the end of the turn:
  // Esc and Ctrl+C, as they arrive plain or in the kitty keyboard protocol.
  function interruptingTerminal(terminal: Terminal, data: string) {
    const { continued } = terminal;
    if (continued.activity !== 'working' || !INTERRUPTS.has(data)) return;
    const { offset } = continued;
    setTimeout(() => {
      if (continued.activity === 'working' && continued.offset === offset)
        void heardTerminal(terminal, false, 'idle');
    }, 2000).unref();
  }
  // What a terminal that continued its session added to the native session since it was last looked at, recorded in
  // the session as the events of a chat run; see terminal-transcript.ts. A compaction can leave out what was there; a
  // rewind does too, and is told, as is moving on to another native session, whose turns do not belong here.
  async function importTerminal(terminal: Terminal) {
    const { continued } = terminal;
    const { known } = continued;
    const { sessionId } = terminal;
    const emit = (payload: EventPayload) => terminalEvent(terminal, payload);
    const dir = nativeDirectory(store.directory, nativeRoot(sessionId));
    const messages = await getSessionMessages(sessionId, { dir, includeSystemMessages: true });
    continued.empty = !messages.length;
    if (messages.length && !store.hasNativeContext(sessionId)) {
      const answer = messages.findLast((message) => message.type === 'assistant')?.message as
        { model?: unknown } | undefined;
      emit({
        type: 'native.session',
        nativeSessionId: sessionId,
        model: typeof answer?.model === 'string' ? answer.model : '',
        version: '',
      });
    }
    // A compaction, read here or as the CLI wrote it, leaves out what was there: that is no rewind.
    const compacted =
      continued.transcript.compactedSince() ||
      messages.some(
        (message) =>
          !known.has(message.uuid) && (message as { isCompactSummary?: boolean }).isCompactSummary,
      );
    if (
      continued.last &&
      !compacted &&
      !messages.some((message) => message.uuid === continued.last)
    )
      emit({ type: 'native.notice', text: '终端里回退了对话，上面有些内容已不在上下文中。' });
    continued.transcript.accept(messages, known);
    continued.transcript.settle();
    continued.transcript.compactedSince();
    for (const message of messages) known.add(message.uuid);
    continued.last = messages.at(-1)?.uuid ?? continued.last;
    if (continued.elsewhere && !continued.toldElsewhere) {
      continued.toldElsewhere = true;
      emit({
        type: 'native.notice',
        text: '终端里换到了另一段对话（/clear 或 /resume），那之后的内容不在这个会话中。',
      });
    }
  }
  // Rename and delete change the native session first; the proxy record follows only when that succeeded.
  async function manageSession(
    command: CommandOf<'session.delete' | 'session.rename'>,
    session: Session,
  ) {
    if (session.activeRun) throw new DomainError('run_active', '请先结束当前运行再管理会话。');
    mutations.set(command.sessionId, 'session');
    try {
      if (options.claude && store.hasNativeContext(command.sessionId)) {
        const nativeOptions = {
          dir: nativeDirectory(store.directory, nativeRoot(command.sessionId)),
        };
        if (command.type === 'session.delete')
          await deleteSession(command.sessionId, nativeOptions);
        else await renameSession(command.sessionId, command.title, nativeOptions);
      }
      if (command.type === 'session.delete') {
        store.delete(command.sessionId);
        broadcast({ type: 'session.deleted', sessionId: command.sessionId });
        for (const other of peers) other.subscriptions.delete(command.sessionId);
      } else {
        broadcast({
          type: 'session.updated',
          session: store.rename(command.sessionId, command.title),
        });
      }
    } catch (error) {
      if (error instanceof DomainError) throw error;
      throw new DomainError(
        'native_mutation_failed',
        '原生会话更新失败，代理记录保留。请检查原生存储与权限。',
      );
    } finally {
      mutations.delete(command.sessionId);
    }
  }
  // A fork is the native session copied under a new ID, together with the proxy's record of it. The SDK cuts
  // a copy after a message and only knows the source's message IDs, so stopping before a message takes two
  // copies: one through that message, then one of it up to the entry before its last.
  async function fork(peer: Peer, command: CommandOf<'session.fork'>, session: Session) {
    if (session.activeRun) throw new DomainError('run_active', '请先结束当前运行再分叉会话。');
    const place = { device: deviceOf(peer), projectPath: command.projectPath };
    const existing = store.created(command.requestId);
    if (existing) return existing.id;
    const before = command.beforeMessageId
      ? store.forkPoint(command.sessionId, command.beforeMessageId)
      : undefined;
    const title = `${session.title.slice(0, 116)}（分叉）`;
    let id: string = randomUUID();
    let resumable = false;
    mutations.set(command.sessionId, 'session');
    try {
      if (options.claude && store.hasNativeContext(command.sessionId)) {
        const dir = nativeDirectory(store.directory, nativeRoot(command.sessionId));
        if (!command.beforeMessageId) {
          id = (await forkSession(command.sessionId, { dir, title })).sessionId;
          resumable = true;
        } else {
          const through = await forkSession(command.sessionId, {
            dir,
            upToMessageId: command.beforeMessageId,
          });
          try {
            const kept = (await getSessionMessages(through.sessionId, { dir })).at(-2);
            // Nothing before the message: the fork starts a native session of its own.
            if (kept) {
              id = (await forkSession(through.sessionId, { dir, upToMessageId: kept.uuid, title }))
                .sessionId;
              resumable = true;
            }
          } finally {
            await deleteSession(through.sessionId, { dir });
          }
        }
      }
      const created = store.fork(
        command.requestId,
        command.sessionId,
        id,
        title,
        resumable,
        place,
        before,
      );
      broadcast({ type: 'session.updated', session: created });
      return created.id;
    } catch (error) {
      if (error instanceof DomainError) throw error;
      throw new DomainError(
        'native_mutation_failed',
        '原生会话分叉失败，未创建新会话。该位置可能不在原生记录中。',
      );
    } finally {
      mutations.delete(command.sessionId);
    }
  }
  // A message starts a run on the computer the session is on, or joins the native run going there. Compacting
  // is the native /compact command sent as a message. The service compacts an idle session from no connection
  // (`peer` absent; see `compactIdle`).
  function submit(
    peer: Peer | undefined,
    command: CommandOf<'message.send' | 'session.compact' | 'run.continue'>,
    session: Session,
  ) {
    if (command.type === 'session.compact' && !options.claude)
      throw new DomainError('native_unavailable', '离线模拟不提供原生上下文压缩。');
    if (command.type === 'session.compact' && !store.hasNativeContext(command.sessionId))
      throw new DomainError('native_context_missing', '先建立原生会话再压缩上下文。');
    const continued = command.type === 'run.continue';
    if (continued && session.activeRun) throw new DomainError('run_active', '当前会话正在运行。');
    const text =
      command.type === 'session.compact' ? '/compact' : continued ? CONTINUE : command.text;
    const scenario = command.type === 'message.send' ? command.scenario : 'chat';
    const attachments = command.type === 'message.send' ? (command.attachments ?? []) : [];
    const scheduled = command.type === 'message.send' ? command.scheduled : undefined;
    const priority = command.type === 'message.send' ? command.priority : undefined;
    // A repeated request ID is the same message arriving again, not a second message.
    const existing = store.userMessage(command.sessionId, command.requestId);
    if (existing?.payload.type === 'message.user') {
      if (
        existing.payload.text !== text ||
        existing.payload.scenario !== scenario ||
        existing.payload.scheduled !== scheduled ||
        existing.payload.priority !== priority ||
        JSON.stringify(existing.payload.attachments ?? []) !== JSON.stringify(attachments)
      )
        throw new DomainError('request_conflict', '请求 ID 已被其他内容使用。');
      return;
    }
    if (
      attachments.length &&
      (!peer?.device ||
        peer.browser ||
        (session.device && session.device.id !== peer.device.id) ||
        attachments.some((file) => file.deviceId !== peer.device!.id))
    )
      throw new DomainError('attachment_device', '只能向本机执行的会话添加这台电脑上的文件。');
    checkHistory(session);
    if (
      options.claude &&
      attachments.some((f) => !f.path.startsWith('attachment:') && !f.path.startsWith('project:/'))
    )
      throw new DomainError('attachment_binding', '请从已绑定项目或附件选择器重新添加文件。');
    const prompt = messageText(
      text,
      attachments.map((f) => ({ ...f, path: f.path.replace(/^project:\//, '') })),
    );
    if (session.activeRun) {
      if (scheduled) throw new DomainError('run_active', '当前会话正在运行。');
      const active = runs.get(command.sessionId);
      if (!options.claude || command.type !== 'message.send' || !active?.input)
        throw new DomainError('run_active', '当前会话正在运行。');
      if (active.controller.signal.aborted)
        throw new DomainError('run_finishing', '原生运行正在停止，请稍后发送。');
      active.input.assertWritable();
      peer?.subscriptions.add(command.sessionId);
      emit(active, {
        type: 'message.user',
        messageId: command.requestId,
        text,
        scenario,
        ...(attachments.length ? { attachments } : {}),
        ...(priority ? { priority } : {}),
      });
      active.input.submit(command.requestId, prompt, undefined, priority);
      // A message sent while Claude waits on its question is the user's answer in the chat instead.
      for (const approvalId of [...active.questions])
        answerApproval(active, approvalId, false, undefined, 'replied_in_chat', peer?.id);
      return;
    }
    if (options.claude && mutations.size)
      throw new DomainError('native_busy', '原生状态正在读取，请稍后发送。');
    const device = peer ? target(peer, session) : session.device!.id;
    room();
    peer?.subscriptions.add(command.sessionId);
    const run: Run = {
      id: randomUUID(),
      sessionId: command.sessionId,
      device,
      connectionId: peer?.id ?? serverDevice.id,
      controller: new AbortController(),
      toolFinished: false,
      approvals: new Map(),
      questions: new Set(),
      answered: new Set(),
      controls: {},
      stats: inOrder(),
      ...(scheduled ? { scheduled } : {}),
    };
    runs.set(command.sessionId, run);
    if (options.claude) run.input = new NativeInput(run.sessionId, (event) => emit(run, event));
    emit(run, {
      type: 'message.user',
      messageId: command.requestId,
      text,
      scenario,
      ...(attachments.length ? { attachments } : {}),
      ...(continued ? { continued } : {}),
      ...(scheduled ? { scheduled } : {}),
      ...(priority ? { priority } : {}),
    });
    emit(run, { type: 'run.status', status: 'running', connectionId: run.connectionId });
    run.input?.submit(command.requestId, prompt, scheduled, priority);
    track(
      options.claude
        ? native(run)
        : simulate(
            run,
            { ...command, type: 'message.send', text: prompt, scenario },
            {
              stepMs: options.stepMs ?? 110,
              projectPath: () => store.get(run.sessionId).session.projectPath,
              emit: (payload) => emit(run, payload),
              finish: (status, reason) => finish(run, status, reason),
            },
          ),
    );
  }
  // Any window of any of the user's computers may stop a run or answer it. Two may do so at once: stopping
  // what has already stopped is nothing, and of two answers the first counts.
  function controlRun(
    peer: Peer,
    command: CommandOf<'run.cancel' | 'run.task.stop' | 'run.task.background' | 'approval.reply'>,
  ) {
    const run = runs.get(command.sessionId);
    if (!run || run.id !== command.runId) {
      if (command.type !== 'approval.reply') return;
      throw new DomainError('run_inactive', '运行已结束，操作未生效。');
    }
    if (command.type === 'approval.reply' && run.answered.has(command.approvalId))
      throw new DomainError('approval_answered', '这一项已经处理过了，可能是在另一台设备上。');
    if (
      command.type === 'approval.reply' &&
      command.executionMode !== undefined &&
      (!command.allowed || run.approvals.get(command.approvalId)?.toolName !== 'ExitPlanMode')
    )
      throw new DomainError('invalid_approval_mode', '只有批准执行计划时可以选择执行模式。');
    if (command.type === 'run.task.stop') {
      if (!run.controls.stopTask) return;
      // The CLI reports the task gone through its task list; a task already over is not an error.
      void run.controls.stopTask(command.taskId).catch(() => {});
      return;
    }
    if (command.type === 'run.task.background') {
      if (!run.controls.backgroundTask) return;
      // A call that has returned meanwhile is nothing to send; the CLI refuses only when background tasks are off.
      void run.controls.backgroundTask(command.toolId).catch(() => {
        if (runs.get(run.sessionId) === run)
          emit(run, {
            type: 'native.notice',
            text: '未能转到后台：这台电脑的 Claude Code 关闭了后台任务。',
          });
      });
      return;
    }
    if (command.type === 'run.cancel') {
      cancel(
        run,
        options.claude
          ? '用户停止；已发出的本机命令可能继续执行，副作用未撤销，不能自动重试。'
          : '用户停止',
      );
      return;
    }
    if (options.claude) {
      // A question the user declines is one they skipped.
      const skipped = !command.allowed && run.questions.has(command.approvalId);
      if (
        !answerApproval(
          run,
          command.approvalId,
          command.allowed,
          command.answers,
          skipped ? 'skipped' : undefined,
          peer.id,
          command.executionMode,
        )
      )
        throw new DomainError('approval_inactive', '审批已失效。');
      return;
    }
    if (!run.decide || run.approvalId !== command.approvalId)
      throw new DomainError('approval_inactive', '审批已失效。');
    const decide = run.decide;
    run.decide = undefined;
    run.answered.add(command.approvalId);
    decide(command.allowed, command.answers);
  }

  function answerApproval(
    run: Run,
    approvalId: string,
    allowed: boolean,
    answers: Record<string, string> | undefined,
    unanswered: Unanswered | undefined,
    connectionId = run.connectionId,
    executionMode?: PlanExecutionMode,
    cancelled = false,
  ) {
    const approval = run.approvals.get(approvalId);
    if (!approval) return false;
    run.approvals.delete(approvalId);
    run.answered.add(approvalId);
    approval.decide(allowed, answers, unanswered, executionMode, cancelled);
    if (!run.controller.signal.aborted && runs.get(run.sessionId) === run)
      emit(run, {
        type: 'run.status',
        status: run.approvals.size ? 'awaiting_approval' : 'running',
        connectionId,
        ...(run.approvals.size
          ? { waiting: run.questions.size ? ('question' as const) : ('approval' as const) }
          : {}),
      });
    return true;
  }

  // Resolves to the session ID carried in the response frame; account and usage commands have none.
  async function execute(peer: Peer, command: Command): Promise<string | undefined> {
    if (isWebCommand(command)) {
      send(
        peer,
        web.execute(command, {
          desktop: !peer.browser,
          address: peer.address,
          sessionId: peer.browser,
          origin: peer.origin,
        }),
      );
      return undefined;
    }
    if (options.claude) {
      const project =
        command.type === 'project.move'
          ? command.to
          : 'projectPath' in command
            ? command.projectPath
            : undefined;
      if (
        project !== undefined &&
        !/^project:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
          project,
        )
      )
        throw new DomainError('project_binding', '请从项目所在电脑选择并绑定目录。');
    }
    switch (command.type) {
      case 'server.session.create': {
        const session = store.createOnServer(command.requestId, command.title, serverDevice);
        peer.subscriptions.clear();
        peer.subscriptions.add(session.id);
        broadcast({ type: 'session.updated', session });
        announce();
        return session.id;
      }
      case 'account.login': {
        if (!options.claude) throw new DomainError('native_unavailable', '离线模拟没有原生登录。');
        const { NativeTerminal, terminalEnvironment } = await import('./native-terminal.ts');
        if (login) throw new DomainError('native_busy', '已有普通登录正在进行。');
        if (closing || peer.socket.readyState !== WebSocket.OPEN)
          throw new Error('Connection closed');
        room();
        const id = randomUUID();
        const identity = { sessionId: command.sessionId, terminalId: id };
        const process = new NativeTerminal(
          options.claude.executable,
          ['auth', 'login'],
          {
            cwd: store.directory,
            cols: command.cols,
            rows: command.rows,
            env: { ...terminalEnvironment(options.claude), CCDT_ACCOUNT_PROFILE: 'terminal' },
          },
          (data, bytes) => send(peer, { type: 'terminal.data', ...identity, data, bytes }),
          (exitCode) => {
            if (login?.id === id) login = undefined;
            send(peer, { type: 'terminal.closed', ...identity, exitCode });
          },
        );
        login = { owner: peer, sessionId: command.sessionId, id, process };
        send(peer, { type: 'terminal.opened', ...identity });
        return;
      }
      case 'account.status': {
        if (!options.claude)
          throw new DomainError('native_unavailable', '离线模拟没有原生账号状态。');
        const [sdk, terminal] = await Promise.all([
          accountStatus(options.claude.executable, 'sdk'),
          personalAccount(),
        ]);
        send(peer, { type: 'account.state', ...sdk.account, terminal: terminal.account });
        return;
      }
      case 'settings.get':
      case 'settings.update': {
        if (!options.claude) throw new DomainError('native_unavailable', '离线模拟没有原生设置。');
        try {
          const values =
            command.type === 'settings.get'
              ? readNativeSettings()
              : updateNativeSettings(command.values);
          send(peer, { type: 'settings.state', requestId: command.requestId, values });
        } catch {
          throw new DomainError(
            'settings_failed',
            '原生设置文件无法读取或写入；请在 ccdt 里用 /config 检查。',
          );
        }
        return undefined;
      }
      case 'compaction.get':
        send(peer, {
          type: 'compaction.state',
          requestId: command.requestId,
          values: compactions.settings,
        });
        return undefined;
      case 'compaction.update': {
        const values = compactions.update(command.values);
        armCompactions();
        broadcast({ type: 'compaction.state', requestId: command.requestId, values });
        return undefined;
      }
      // Sessions on the computer are told with the user's next message to each (see `store.notice`).
      case 'device.shell':
        store.prefer(deviceOf(peer).id, command.shell);
        announce();
        return undefined;
      case 'instructions.get':
      case 'instructions.update': {
        if (!options.claude) throw new DomainError('native_unavailable', '离线模拟没有全局说明。');
        try {
          const state =
            command.type === 'instructions.get'
              ? readInstructions()
              : writeInstructions(command.text, command.version);
          send(peer, { type: 'instructions.state', requestId: command.requestId, ...state });
        } catch (error) {
          if (error instanceof DomainError) throw error;
          throw new DomainError('instructions_failed', '全局说明文件无法读取或写入。');
        }
        return undefined;
      }
      case 'usage.summary': {
        const scope =
          command.profile === 'terminal'
            ? options.claude
              ? (await personalAccount()).scope
              : null
            : 'sdk';
        if (scope && command.profile === 'terminal')
          await Promise.all([...terminals.values()].map((t) => captureSubscription(t, scope)));
        send(peer, {
          type: 'usage.summary',
          requestId: command.requestId,
          ...usage.summary(Date.now(), scope),
        });
        return undefined;
      }
      case 'quota.watch':
        peer.quotaWanted = command.active;
        return undefined;
      case 'session.stats':
        store.get(command.sessionId);
        send(peer, {
          type: 'session.stats',
          requestId: command.requestId,
          sessionId: command.sessionId,
          ...usage.sessionStats(command.sessionId),
        });
        return undefined;
      case 'service.update.check':
        if (!updates) throw new DomainError('updates_unavailable', '此服务未启用版本跟踪。');
        await updates.check();
        return undefined;
      case 'service.update.install': {
        if (!updates) throw new DomainError('updates_unavailable', '此服务未启用版本跟踪。');
        // The restart at the end cuts off whatever goes on. What is at work holds it back unless the user forces it;
        // an open terminal at rest, and background tasks a finished turn left, only end.
        const held = upgradeHeld(store.list(), mutations.size > 0, !!login);
        if (held && !command.force) throw new DomainError('native_busy', held);
        try {
          updates.install(command.version);
        } catch (error) {
          throw new DomainError('update_unavailable', (error as Error).message);
        }
        return undefined;
      }
      case 'usage.query': {
        const scope =
          command.profile === 'terminal' && options.claude ? (await personalAccount()).scope : null;
        const titles = new Map(store.list().map((session) => [session.id, session.title]));
        send(peer, {
          type: 'usage.page',
          requestId: command.requestId,
          ...usage.query(command, (sessionId) => titles.get(sessionId) ?? null, Date.now(), scope),
        });
        return undefined;
      }
      case 'project.move': {
        const from = pathKey(command.from);
        if (
          store
            .list()
            .some((session) => mutations.has(session.id) && pathKey(session.projectPath) === from)
        )
          throw new DomainError('session_busy', '会话正在更新，请稍后重试。');
        for (const session of store.moveProject(command.from, command.to, deviceOf(peer)))
          broadcast({ type: 'session.updated', session });
        return undefined;
      }
      case 'session.create': {
        const session = store.create(
          command.requestId,
          command.title,
          command.projectPath,
          deviceOf(peer),
        );
        peer.subscriptions.clear();
        peer.subscriptions.add(session.id);
        broadcast({ type: 'session.updated', session });
        return session.id;
      }
    }
    const { session } = store.get(command.sessionId);
    // Native status reads leave the stored history available, including to other windows.
    const readingHistory = [
      'session.subscribe',
      'session.history',
      'session.outline',
      'session.read',
    ].includes(command.type);
    if (
      mutations.has(command.sessionId) &&
      !(readingHistory && mutations.get(command.sessionId) === 'status')
    )
      throw new DomainError('session_busy', '会话正在更新，请稍后重试。');
    switch (command.type) {
      case 'session.status':
        await readStatus(peer, command);
        return command.sessionId;
      case 'approval.inspect': {
        const run = runs.get(session.id);
        const preview = run?.id === command.runId && run.approvals.get(command.approvalId)?.preview;
        if (!peer.subscriptions.has(session.id) || !preview)
          throw new DomainError('approval_inactive', '此审批已结束或当前连接未订阅该会话。');
        const end = Math.min(preview.input.length, command.offset + APPROVAL_PAGE_CHARS);
        send(peer, {
          type: 'approval.detail',
          requestId: command.requestId,
          input: preview.input.slice(command.offset, end),
          ...(end < preview.input.length && { next: end }),
          ...(command.offset === 0 && { title: preview.title, description: preview.description }),
        });
        return session.id;
      }
      case 'session.acceptHistory':
        if (
          options.claude &&
          session.device?.id !== serverDevice.id &&
          !session.projectPath.startsWith('project:')
        )
          throw new DomainError(
            'project_binding',
            '请先在项目所在电脑上重新选择目录，再继续旧会话。',
          );
        store.acceptHistory(session.id);
        updated(session.id);
        return session.id;
      case 'terminal.close':
        await closeTerminal(peer, command);
        return command.sessionId;
      case 'terminal.open':
        await openTerminal(peer, command, session);
        return command.sessionId;
      case 'session.subscribe': {
        const reset =
          !!command.afterCreatedAt &&
          !store.holds(command.sessionId, command.afterSequence, command.afterCreatedAt);
        peer.subscriptions.clear();
        peer.subscriptions.add(command.sessionId);
        const messages: ServerMessage[] = [
          {
            type: 'session.snapshot',
            ...store.history(
              command.sessionId,
              command.requestId,
              reset ? 0 : command.afterSequence,
            ),
            ...(reset ? { reset: true as const } : {}),
          },
        ];
        // The history ends where the run's unfinished output begins.
        {
          const run = runs.get(command.sessionId);
          if (run?.open)
            messages.push({
              type: 'session.fragment',
              sessionId: run.sessionId,
              runId: run.id,
              payload: run.open,
            });
        }
        peer.history ??= new HistoryDelivery((message) => send(peer, message));
        await peer.history.deliver(command.requestId, command.sessionId, messages);
        return command.sessionId;
      }
      case 'session.history':
        peer.history ??= new HistoryDelivery((message) => send(peer, message));
        await peer.history.deliver(command.requestId, command.sessionId, [
          {
            type: 'session.snapshot',
            ...store.history(
              command.sessionId,
              command.requestId,
              0,
              command.beforeSequence,
              command.afterSequence,
            ),
          },
        ]);
        return command.sessionId;
      case 'session.outline':
      case 'session.read': {
        const lane = command.type === 'session.outline' ? 'outline' : command.purpose;
        peer.reads ??= {};
        peer.reads[lane]?.controller.abort();
        peer.reads[lane]?.delivery.cancel();
        const read = {
          requestId: command.requestId,
          delivery: new HistoryDelivery((message) => send(peer, message)),
          controller: new AbortController(),
        };
        peer.reads[lane] = read;
        try {
          const result =
            command.type === 'session.outline'
              ? await store.outline(
                  command.sessionId,
                  command.requestId,
                  command.afterSequence,
                  read.controller.signal,
                )
              : store.read(
                  command.sessionId,
                  command.requestId,
                  command.direction,
                  command.sequence,
                  command.throughSequence,
                );
          if (peer.reads[lane] !== read)
            throw new DomainError('history_cancelled', '历史读取已取消。');
          if (
            result.type === 'session.read' &&
            command.type === 'session.read' &&
            command.throughSequence === undefined
          ) {
            const run = runs.get(command.sessionId);
            if (run?.open)
              result.fragment = {
                sessionId: run.sessionId,
                runId: run.id,
                sequence: result.throughSequence + 1,
                createdAt: result.capturedAt,
                payload: { ...run.open },
              };
          }
          await read.delivery.deliver(command.requestId, command.sessionId, [result]);
        } finally {
          if (peer.reads[lane] === read) delete peer.reads[lane];
        }
        return command.sessionId;
      }
      case 'run.cancel':
      case 'run.task.stop':
      case 'run.task.background':
      case 'approval.reply':
        controlRun(peer, command);
        return command.sessionId;
    }
    if (terminals.has(command.sessionId))
      throw new DomainError('native_busy', '这个会话在 ccdt 里开着，请先退出终端再操作它。');
    if (
      updates?.installing &&
      (command.type === 'message.send' || command.type === 'session.compact')
    )
      throw new DomainError('service_upgrading', '服务端正在升级，重启完成后再发送。');
    switch (command.type) {
      case 'session.configure':
        broadcast({
          type: 'session.updated',
          session: store.configure(
            command.sessionId,
            command.permissionMode,
            command.model,
            command.effort,
          ),
        });
        break;
      case 'session.move':
        broadcast({
          type: 'session.updated',
          session: store.move(command.sessionId, command.projectPath, deviceOf(peer)),
        });
        break;
      case 'session.delete':
      case 'session.rename':
        await manageSession(command, session);
        break;
      case 'session.fork':
        return fork(peer, command, session);
      case 'message.send':
      case 'session.compact':
      case 'run.continue':
        submit(peer, command, session);
        break;
    }
    return command.sessionId;
  }

  const installer = () =>
    releases.current
      ? (({ version, size, sha256 }) => ({ version, size, sha256 }))(releases.current)
      : undefined;
  // The first frame must authenticate; a desktop client also asks for its execution channel here.
  function authenticate(peer: Peer, value: unknown) {
    if (peer.browser) {
      const auth = webAuthSchema.safeParse(value);
      if (
        !auth.success ||
        auth.data.protocolVersion !== PROTOCOL_VERSION ||
        !web.active(peer.browser)
      ) {
        peer.socket.close(4001, 'Invalid browser authentication');
        return false;
      }
      peer.authenticated = true;
      send(peer, {
        type: 'ready',
        protocolVersion: PROTOCOL_VERSION,
        connectionId: peer.id,
        adapter,
        model: options.claude?.model,
        version,
        sessions: store.list(true),
        historyId: store.historyId,
        browser: {
          sessionId: peer.browser,
          serverDeviceId: serverDevice.id,
          selfSigned: web.selfSigned(peer.origin, peer.proxied),
        },
      });
      send(peer, devices());
      return true;
    }
    const auth = authSchema.safeParse(value);
    // Only a wrong token counts against the address: an outdated client holding the right one is not guessing.
    const token = (value as { token?: unknown } | null)?.token;
    if (typeof token !== 'string' || !authorized(token)) refuse(peer.address);
    else throttle.succeed(peer.address);
    if (!auth.success || !authorized(auth.data.token)) {
      send(peer, {
        type: 'connection.error',
        code: 'unauthorized',
        message:
          '服务凭据不正确。\n请核对安装时给出的服务凭据，注意不要带上首尾空格；在服务器上更换过凭据后要用新的。连续失败多次会被暂时拒绝。',
      });
      peer.socket.close(4001, 'Unauthorized');
      return false;
    }
    // A client of another version is told which version runs here and, if held, the installer to fetch.
    if (auth.data.protocolVersion !== PROTOCOL_VERSION) {
      // The installer of this version may still be on its way here, or its download may have failed: the
      // client is told how far it is and the download is started again if it is not running.
      const held = installer();
      if (held?.version !== version) updates?.prepareInstaller();
      send(peer, {
        type: 'connection.error',
        code: 'version_mismatch',
        message: `客户端与服务端（${version}）的版本不一致，需要升级其中一方。`,
        service: version,
        client: held,
        ...(held?.version !== version && updates?.preparing
          ? { preparing: updates.preparing }
          : {}),
      });
      peer.socket.close(4002, 'Version mismatch');
      return false;
    }
    peer.authenticated = true;
    peer.name = auth.data.deviceName;
    send(peer, {
      type: 'ready',
      protocolVersion: PROTOCOL_VERSION,
      connectionId: peer.id,
      adapter,
      model: options.claude?.model,
      version,
      update: updates?.state,
      client: installer(),
      sessions: store.list(true),
      historyId: store.historyId,
    });
    send(peer, devices());
    return true;
  }
  // Keystrokes, resizes and flow-control acknowledgments carry no request ID and get no response.
  function controlTerminal(peer: Peer, control: TerminalControl) {
    const current =
      login?.sessionId === control.sessionId && login.id === control.terminalId
        ? login
        : terminals.get(control.sessionId);
    if (!current || current.owner !== peer || current.id !== control.terminalId) {
      send(peer, {
        type: 'connection.error',
        code: 'terminal_inactive',
        message: '终端已结束或属于另一连接。',
      });
      return;
    }
    try {
      if (control.type === 'terminal.input') {
        current.process?.write(control.data);
        if ('continued' in current) interruptingTerminal(current, control.data);
      } else if (control.type === 'terminal.resize')
        current.process?.resize(control.cols, control.rows);
      else current.process?.acknowledge(control.bytes);
    } catch {
      const task = current.process?.close();
      if (task) track(task);
    }
  }
  // A request ID is answered once: a resend gets the same response, never a second execution.
  function dispatch(peer: Peer, command: Command) {
    // Reauthentication proofs and imported private keys must not stay in the request cache.
    const serialized = command.type.startsWith('web.')
      ? createHash('sha256').update(JSON.stringify(command)).digest('hex')
      : JSON.stringify(command);
    const previous = peer.responses.get(command.requestId);
    if (previous) {
      if (previous.command === serialized)
        void previous.response.then((response) => send(peer, response));
      else
        send(peer, {
          type: 'response',
          requestId: command.requestId,
          ok: false,
          code: 'request_conflict',
          message: '请求 ID 已被其他内容使用。',
        });
      return;
    }
    const response = execute(peer, command).then(
      (sessionId): ServerMessage => ({
        type: 'response',
        requestId: command.requestId,
        ok: true,
        sessionId,
      }),
      (error): ServerMessage => ({
        type: 'response',
        requestId: command.requestId,
        ok: false,
        code: error instanceof DomainError ? error.code : 'internal_error',
        message: error instanceof DomainError ? error.message : '服务处理失败。',
      }),
    );
    peer.responses.set(command.requestId, { command: serialized, response });
    // A resend follows its request closely: the latest few are all that can still be asked for again.
    if (peer.responses.size > REMEMBERED)
      peer.responses.delete(peer.responses.keys().next().value!);
    track(response.then((value) => send(peer, value)));
  }
  // The computer's place here, made when the first of its connections says which computer it is.
  function enter(peer: Peer) {
    const device = deviceOf(peer).id;
    let seat = seats.get(device);
    if (!seat) {
      seat = { device, peers: new Set() };
      seats.set(device, seat);
    }
    clearTimeout(seat.away);
    seat.away = undefined;
    seat.peers.add(peer);
    return seat;
  }
  // Nothing more is kept for a computer: its runs end and its door closes.
  function vacate(seat: Seat, reason: string) {
    clearTimeout(seat.away);
    if (seats.get(seat.device) !== seat) return;
    seats.delete(seat.device);
    for (const run of runs.values()) if (run.device === seat.device) cancel(run, reason);
    for (const terminal of terminals.values())
      if (terminal.device === seat.device) {
        const task = terminal.process?.close();
        if (task) track(task);
      }
    announce();
  }
  // What belongs to the connection itself ends with it: its terminal, a sign-in it began. The runs
  // of its computer go on. If no other connection of that computer is here they are given `graceMs` for one
  // to come back, unless the client said it was leaving; nothing is replayed for a later connection either way.
  function release(peer: Peer) {
    peers.delete(peer);
    peer.history?.cancel();
    for (const read of Object.values(peer.reads ?? {})) {
      read.controller.abort();
      read.delivery.cancel();
    }
    peer.reads = {};
    if (login?.owner === peer) track(login.process.close());
    for (const terminal of terminals.values())
      if (terminal.owner !== peer) continue;
      // A client that said it is leaving closed its window: the terminal ends, as a local CLI's would.
      else if (!peer.left) detachTerminal(terminal);
      else {
        const task = terminal.process?.close();
        if (task) track(task);
      }
    const seat = peer.device && seats.get(peer.device.id);
    if (seat?.peers.delete(peer)) {
      if (!seat.peers.size) {
        const waiting =
          [...runs.values()].some((run) => run.device === seat.device) ||
          [...terminals.values()].some((terminal) => terminal.device === seat.device);
        const gone = options.claude
          ? '连接断开，运行未重放；在途命令结果可能未知。'
          : '连接断开，运行未重放。';
        if (peer.left || !waiting || !graceMs) vacate(seat, gone);
        else
          seat.away = setTimeout(
            () =>
              vacate(
                seat,
                `设备离线超过 ${Math.round(graceMs / 1000)} 秒，运行已停止；在途命令结果可能未知。`,
              ),
            graceMs,
          );
      }
    }
    announce();
  }

  wss.on(
    'connection',
    (
      socket: WebSocket,
      address: string,
      context?: { browser?: string; origin: string; proxied?: boolean },
    ) => {
      void releases.refresh();
      const peer: Peer = {
        socket,
        id: randomUUID(),
        address,
        authenticated: false,
        browser: context?.browser,
        origin: context?.origin,
        proxied: context?.proxied,
        name: '',
        left: false,
        commandGrants: new Map(),
        subscriptions: new Set(),
        responses: new Map(),
      };
      peers.add(peer);
      // Browsers wait for sign-in in places of their own, so that they cannot crowd out desktops.
      const gate = peer.browser ? web.throttle : throttle;
      if (peer.browser && !web.attach(peer.browser, socket)) {
        peers.delete(peer);
        gate.leave(address);
        socket.close(4001, 'Browser session unavailable');
        return;
      }
      const opened = Date.now();
      const authTimer = setTimeout(() => socket.close(4001, 'Authentication timeout'), 5000);
      // A long unattended run should survive a brief network stall: only two pings in a row without an answer,
      // about 45 seconds of silence, end the connection.
      let missed = 0;
      let timedOut = false;
      // Whether this connection still holds one of the places for those that have not signed in.
      let signedIn = false;
      let greeted = false;
      socket.on('pong', () => {
        missed = 0;
      });
      const heartbeat = setInterval(() => {
        if (missed >= 2) {
          timedOut = true;
          socket.terminate();
          return;
        }
        missed++;
        socket.ping();
      }, 15000);
      socket.on('error', () => socket.terminate());
      socket.on('message', (data, isBinary) => {
        let value: unknown;
        try {
          if (isBinary) throw new Error('Binary frame');
          value = JSON.parse(data.toString('utf8'));
        } catch {
          send(peer, {
            type: 'connection.error',
            code: 'invalid_json',
            message: '消息必须是 JSON 文本。',
          });
          socket.close(4002, 'Invalid frame');
          return;
        }
        if (!peer.authenticated) {
          // Only the first frame signs in. What a refused client sent after it is not another attempt.
          if (greeted) return;
          greeted = true;
          if (authenticate(peer, value)) {
            clearTimeout(authTimer);
            signedIn = true;
            gate.leave(address);
          }
          return;
        }
        if (peer.browser) {
          if (!web.active(peer.browser)) {
            socket.close(4001, 'Browser session ended');
            return;
          }
          if (webActivitySchema.safeParse(value).success) {
            web.touch(peer.browser);
            return;
          }
          const type = (value as { type?: unknown } | null)?.type;
          if (
            type === 'device' ||
            type === 'auth' ||
            type === 'web.auth' ||
            type === 'project.commands' ||
            (typeof type === 'string' && type.startsWith('tunnel.'))
          ) {
            socket.close(4003, 'Browser execution frames are not allowed');
            return;
          }
        }
        const grant = projectCommands.safeParse(value);
        if (grant.success) {
          if (!peer.browser && peer.files && peer.device) {
            const { sessionId, project, enabled } = grant.data;
            if (enabled) {
              try {
                const { session } = store.get(sessionId);
                if (session.device?.id !== peer.device.id || session.projectPath !== project)
                  return;
              } catch (error) {
                if (error instanceof DomainError && error.code === 'not_found') return;
                throw error;
              }
              peer.commandGrants.set(sessionId, project);
            } else if (peer.commandGrants.get(sessionId) === project)
              peer.commandGrants.delete(sessionId);
            for (const sync of projectViews) sync();
          }
          return;
        }
        const fileResult = projectReply.safeParse(value);
        if (fileResult.success) {
          const reply = fileResult.data;
          const waiting = pendingFiles.get(reply.requestId);
          if (!peer.browser && waiting?.peer === peer && waiting.sessionId === reply.sessionId)
            waiting.settle(!reply.error, reply.text);
          return;
        }
        const identity = deviceIdentitySchema.safeParse(value);
        if (identity.success) {
          if (
            identity.data.id === serverDevice.id ||
            (peer.device && peer.device.id !== identity.data.id)
          ) {
            socket.close(4003, 'Reserved device');
            return;
          }
          peer.files = identity.data.files;
          peer.device = {
            id: identity.data.id,
            name: peer.name,
            ...(identity.data.platform ? { platform: identity.data.platform } : {}),
          };
          // With the line written when it closes, this tells which computer a connection was and how long it held.
          if (!closing)
            console.log(
              `Connection ${peer.id.slice(0, 8)} opened: device "${peer.name}" (${identity.data.id.slice(0, 8)}) from ${address}`,
            );
          if (identity.data.shells) store.equip(peer.device.id, identity.data.shells);
          for (const session of store.named(peer.device))
            broadcast({ type: 'session.updated', session });
          enter(peer);
          announce();
          return;
        }
        if (leaveSchema.safeParse(value).success) {
          peer.left = true;
          return;
        }
        const control = terminalControlSchema.safeParse(value);
        if (control.success) {
          if (peer.browser && control.data.type === 'terminal.input') web.touch(peer.browser);
          controlTerminal(peer, control.data);
          return;
        }
        const historyControl = historyControlSchema.safeParse(value);
        if (historyControl.success) {
          const { type, requestId } = historyControl.data;
          if (type === 'session.history.next') peer.history?.next(requestId);
          else peer.history?.cancel(requestId);
          for (const lane of ['outline', 'view', 'export'] as const) {
            const read = peer.reads?.[lane];
            if (!read || read.requestId !== requestId) continue;
            if (type === 'session.history.next') read.delivery.next(requestId);
            else {
              read.controller.abort();
              read.delivery.cancel(requestId);
              delete peer.reads![lane];
            }
          }
          return;
        }
        const command = commandSchema.safeParse(value);
        if (!command.success) {
          send(peer, {
            type: 'connection.error',
            code: 'invalid_command',
            message: '请求格式无效。',
          });
          return;
        }
        if (peer.browser) {
          if (!browserCommands.has(command.data.type)) {
            send(peer, {
              type: 'response',
              requestId: command.data.requestId,
              ok: false,
              code: 'web_forbidden',
              message: '浏览器不支持这项操作，请使用桌面客户端。',
            });
            return;
          }
          if (browserActivity.has(command.data.type)) web.touch(peer.browser);
        }
        dispatch(peer, command.data);
      });
      socket.on('close', (code) => {
        for (const call of pendingFiles.values())
          if (call.peer === peer) call.settle(false, '设备连接中断，操作结果未知。');
        clearTimeout(authTimer);
        clearInterval(heartbeat);
        if (!signedIn) gate.leave(address);
        // Why a connection ended is the first thing needed when a run was cut short.
        const device = peer.device?.id;
        const before = [...runs.values()].filter((run) => run.device === device).length;
        release(peer);
        // A native run that is being ended takes a moment to go: what became of the runs is told by whether the
        // computer still has a place here.
        const seat = device ? seats.get(device) : undefined;
        if (peer.authenticated && !closing)
          console.log(
            `Connection ${peer.id.slice(0, 8)} closed after ${Math.round((Date.now() - opened) / 1000)} s: ${peer.left ? 'the client left' : timedOut ? 'no heartbeat answer for 45s' : `code ${code}`}; runs of its device: ${before}${!before ? '' : !seat ? ', ended' : seat.away ? `, kept for ${Math.round(graceMs / 1000)} s` : ', going on over another connection'}`,
          );
      });
    },
  );
  return {
    store,
    async listen(port = 8787): Promise<string> {
      await releases.refresh();
      updates?.start();
      if (usageReceiver)
        options.claude!.environment = telemetryEnvironment(await usageReceiver.listen());
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, options.host ?? '127.0.0.1', () => {
          server.off('error', reject);
          resolve();
        });
      });
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('No listening address');
      return `${options.tls ? 'https' : 'http'}://${options.host ?? '127.0.0.1'}:${address.port}`;
    },
    async close() {
      closing = true;
      web.close();
      updates?.stop();
      const terminalCleanup = Promise.all([
        login?.process.close(),
        ...[...terminals.values()].map((terminal) => terminal.process?.close()),
      ]);
      for (const run of runs.values()) cancel(run, '服务停止，运行未重放。');
      for (const seat of seats.values()) clearTimeout(seat.away);
      compactions.clear();
      for (const peer of peers) peer.socket.terminate();
      await Promise.all([...tasks]);
      await terminalCleanup;
      await usageReceiver?.close();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      store.close();
    },
  };
}
