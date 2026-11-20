import {
  OWN_FILE_TOOLS,
  OWN_FILES_REFUSAL,
  ownDirectories,
  ownFile,
  ownFilesPrompt,
  projectBuiltinTools,
  projectPrompt,
} from './project-tools.ts';
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { query, getSessionInfo } from '@anthropic-ai/claude-agent-sdk';
import type {
  HookCallback,
  PermissionResult,
  Query,
  SDKSessionInfo,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import type {
  Effort,
  EventPayload,
  NativeMetrics,
  PermissionMode,
  PlanExecutionMode,
} from '@cc-desk-tunnel/protocol';
import { mcpConnectionStatus } from '@cc-desk-tunnel/protocol';
import { ClaudeStream } from './claude-stream.ts';
import { cacheTtl, cacheWrites } from './idle-compaction.ts';
import { loginExpiryWarnings } from './login-expiry.ts';
import {
  loginOf,
  nativeCapabilities,
  nativeMetrics,
  optionalStatus,
  Quotas,
} from './native-controls.ts';
import type { NativeInput } from './native-input.ts';
import { personalConfig, readNativeSettings } from './native-settings.ts';
import { questionTally } from './question.ts';

// Looks at every call of a built-in file tool before the CLI decides on it, whatever the approval mode: a file that
// is not Claude Code's own for the session is refused (see `ownFile`).
function guardOwnFiles(directories: string[], stored: string[]): HookCallback {
  return async (input) => {
    if (input.hook_event_name !== 'PreToolUse' || !OWN_FILE_TOOLS.includes(input.tool_name))
      return {};
    let reason = OWN_FILES_REFUSAL;
    try {
      if (ownFile(input.tool_input, directories, stored)) return {};
    } catch (error) {
      reason = `File access check failed: ${error instanceof Error ? error.message : String(error)}`;
    }
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: reason,
      },
    };
  };
}

// Whether the native session is on record once a run or a terminal let it go, for the clients to offer compacting it.
// It is recorded last, so that the page of history a client opens the session with holds it.
export function nativeContext(sessionId: string, info: SDKSessionInfo | undefined) {
  return {
    type: 'native.context',
    nativeSessionId: sessionId,
    persisted: !!info,
    updatedAt: info ? new Date(info.lastModified).toISOString() : undefined,
  } satisfies EventPayload;
}

// Whether reasoning summaries are asked for. A settings file that cannot be read leaves them on.
function thinkingShown() {
  try {
    return readNativeSettings().showThinkingSummaries !== false;
  } catch {
    return true;
  }
}

export type ClaudeOptions = {
  executable: string;
  model?: string;
  settingsPath?: string;
  // The deployment's provider file, read only for the names in it that the application runtime does not take.
  providerPath?: string;
  maxTurns?: number;
  contextRetentionDays?: number;
  // Added to the CLI's inherited environment; set by the service for its usage collector.
  environment?: Record<string, string>;
};
export type ClaudeRun = {
  sessionId: string;
  // The session whose Linux directory holds this session's native history; itself unless it is a fork.
  nativeRoot: string;
  permissionMode: PermissionMode;
  model?: string | null;
  effort?: Effort | null;
  input: NativeInput;
  scheduled?: 'scheduled' | 'manual';
  dataDir: string;
  resume: boolean;
  signal: AbortSignal;
  emit: (event: EventPayload) => void;
  // Asks the user about a tool call. A question Claude asks comes back with the answers chosen, or with how it went
  // unanswered.
  approve: (
    toolId: string,
    waiting: 'approval' | 'question',
    toolName: string,
    signal: AbortSignal,
    preview: ApprovalPreview,
  ) => Promise<{
    allowed: boolean;
    answers?: Record<string, string>;
    unanswered?: Unanswered;
    executionMode?: PlanExecutionMode;
  }>;
  // Absent only for a session owned by the service itself.
  projectTools?: { type: 'stdio'; command: string; args: string[] };
  // Whether Claude may start subagents in a run with project tools: the service's setting as the run began.
  subagents?: boolean;
  // Told when Claude has finished its turn and the run goes on only for background tasks, and when it resumes.
  waiting: (background: boolean) => void;
  // Told when a turn ends: the figures so far for the user message the turn answered. A turn that a background task
  // started adds to the question it belongs to, so these are running totals and `background` says more may follow.
  turnEnded: (turn: {
    messageId?: string;
    startedAt: number;
    endedAt: number;
    requests: number;
    outputTokens: number;
    promptIds: string[];
    background: boolean;
  }) => void;
  // Filled in while the CLI is running, so the service can refresh context and account quota mid-run and end
  // one of its background tasks.
  controls: {
    refresh?: (asked?: boolean) => Promise<void>;
    refreshProject?: () => Promise<void>;
    stopTask?: (taskId: string) => Promise<void>;
    backgroundTask?: (toolId: string) => Promise<boolean>;
  };
};
export type Unanswered = 'skipped' | 'replied_in_chat';
export type ApprovalPreview = {
  input: string;
  title?: string;
  description?: string;
  // The user may choose not to be asked about calls like this one for the rest of the session.
  rememberable?: boolean;
};
// A command on the project's computer is the one call a user may stop being asked about: that computer has already
// granted the session its commands, and takes the grant back whenever its user says. Not where the CLI wants every
// ask to be a deliberate one.
export function rememberableCall(
  name: string,
  context: { suppressAlwaysAllowRule?: boolean; defaultToNo?: boolean; matchedAskRule?: unknown },
) {
  return (
    name === 'mcp__project__command' &&
    !context.suppressAlwaysAllowRule &&
    !context.defaultToNo &&
    !context.matchedAskRule
  );
}
// User decisions are returned through the SDK's permission callback, including a plan's execution mode.
export function toolPermission(
  name: string,
  input: Record<string, unknown>,
  allowed: boolean,
  answers?: Record<string, string>,
  executionMode?: PlanExecutionMode,
): PermissionResult {
  if (!allowed)
    return {
      behavior: 'deny',
      message:
        name === 'AskUserQuestion'
          ? 'The user declined to answer.'
          : name === 'ExitPlanMode'
            ? 'The user wants to keep planning and has not approved execution.'
            : 'The user denied or cancelled this request.',
    };
  return {
    behavior: 'allow',
    updatedInput: name === 'AskUserQuestion' && answers ? { ...input, answers } : input,
    ...(name === 'ExitPlanMode' && executionMode
      ? {
          updatedPermissions: [
            { type: 'setMode' as const, mode: executionMode, destination: 'session' as const },
          ],
        }
      : {}),
  };
}
// What Claude reads of a question left unanswered.
const UNANSWERED: Record<Unanswered, string> = {
  skipped: 'The user skipped this question without answering it.',
  replied_in_chat:
    'The user did not answer here and replied in the chat instead; read their message.',
};
// A CLI that takes an answer saying how a question went unanswered.
const UNANSWERED_CAPABILITY = 'ask_user_question_unanswered_v1';
// How long a CLI whose input has ended is given to exit by itself.
const EXIT_MS = 5000;
// A mid-turn hook can drop an input without echoing its UUID. Bound that idle, unconfirmed wait.
const RECEIPT_WAIT_MS = 30_000;
const loginExpiry = loginExpiryWarnings();
// The plan quota, held by login for every session and device; the service tells it which clients want it current.
export const quotas = new Quotas();
export function nativeDirectory(dataDir: string, root: string) {
  return join(dataDir, 'native', root);
}

export function prepareNativeDirectory(options: ClaudeOptions, dataDir: string, sessionId: string) {
  const cwd = nativeDirectory(dataDir, sessionId);
  mkdirSync(cwd, { recursive: true, mode: 0o700 });
  const settingsDirectory = join(cwd, '.claude');
  mkdirSync(settingsDirectory, { recursive: true, mode: 0o700 });
  const localSettingsPath = join(settingsDirectory, 'settings.local.json');
  const settings = existsSync(localSettingsPath)
    ? JSON.parse(readFileSync(localSettingsPath, 'utf8'))
    : {};
  settings.cleanupPeriodDays = options.contextRetentionDays ?? 3650;
  writeFileSync(localSettingsPath, JSON.stringify(settings, null, 2) + '\n', { mode: 0o600 });
  return cwd;
}

export async function runClaude(
  options: ClaudeOptions,
  run: ClaudeRun,
): Promise<'completed' | 'failed' | 'cancelled'> {
  if (process.platform === 'win32') throw new Error('Native adapter must run on Linux.');
  const mapper = new ClaudeStream(run.emit, run.permissionMode, run.effort);
  const cwd = prepareNativeDirectory(options, run.dataDir, run.nativeRoot);
  // Where the built-in file tools may work in a session whose project is on a device: nowhere but there.
  const ownFiles = run.projectTools ? ownDirectories(personalConfig().directory, cwd) : undefined;
  const storedFiles =
    ownFiles && process.env.CCDT_PERSONAL_HOME && process.env.CLAUDE_CONFIG_DIR
      ? [ownFiles[0], ownDirectories(process.env.CLAUDE_CONFIG_DIR, cwd)[1]]
      : ownFiles;
  if (run.resume && !(await getSessionInfo(run.sessionId, { dir: cwd }))) {
    run.emit({
      type: 'run.error',
      code: 'native_context_missing',
      message:
        'Claude Code 原生上下文不存在；不会用界面记录伪造恢复或另开会话。请检查原生存储与备份。',
    });
    return 'failed';
  }
  const abortController = new AbortController();
  const stop = () => abortController.abort();
  run.signal.addEventListener('abort', stop, { once: true });
  if (run.signal.aborted) stop();
  let stderr = '',
    failure: Error | undefined;
  let session: Query | undefined;
  // The prompts the CLI took since the last turn ended; the OpenTelemetry records of their requests carry the same ids.
  let promptIds: string[] = [];
  const tally = questionTally();
  const written = cacheWrites();
  // Output tokens of every model call so far, subagents included, as the CLI's running total counts them; a turn's
  // share is the step from one result to the next. A resumed session's total already holds earlier runs.
  let outputSoFar: number | undefined = run.resume ? undefined : 0;
  // What the CLI says it supports, from the `init` that opens each turn.
  let capabilities: string[] = [];
  let settle: ReturnType<typeof setTimeout> | undefined;
  let exiting: ReturnType<typeof setTimeout> | undefined;
  let receiptWait: ReturnType<typeof setTimeout> | undefined;
  let settled = false;
  let confirmProject: ((applied: boolean) => void) | undefined;
  const projectReady =
    run.projectTools &&
    new Promise<boolean>((resolve) => {
      confirmProject = resolve;
    });
  async function* projectInput() {
    if ((await projectReady) && !run.signal.aborted) yield* run.input.stream();
  }
  type ProjectStatus = Extract<EventPayload, { type: 'native.project_mcp' }>['status'];
  let lastProjectStatus: ProjectStatus | undefined;
  const reportProject = (status: ProjectStatus) => {
    if (!run.projectTools || run.signal.aborted || lastProjectStatus === status) return;
    lastProjectStatus = status;
    run.emit({ type: 'native.project_mcp', status });
  };
  const reportServers = (servers: { name: string; status: string }[]) => {
    const project = servers.find((server) => server.name === 'project');
    reportProject(
      project ? (mcpConnectionStatus.safeParse(project.status).data ?? 'unknown') : 'missing',
    );
  };
  try {
    session = query({
      prompt: projectReady ? projectInput() : run.input.stream(),
      options: {
        cwd,
        pathToClaudeCodeExecutable: options.executable,
        abortController,
        includePartialMessages: true,
        permissionMode: run.permissionMode,
        // The SDK takes the mode that asks about nothing only with this said as well.
        allowDangerouslySkipPermissions: run.permissionMode === 'bypassPermissions',
        ...(run.projectTools && {
          tools: projectBuiltinTools({ subagents: !!run.subagents }, true),
          mcpServers: { project: run.projectTools },
          mcpServersDelivery: 'initialize',
          strictMcpConfig: true,
        }),
        persistSession: true,
        systemPrompt: {
          type: 'preset',
          preset: 'claude_code',
          ...(run.projectTools && { append: `${projectPrompt} ${ownFilesPrompt}` }),
          snapshot: false,
        },
        ...(run.resume ? { resume: run.sessionId } : { sessionId: run.sessionId }),
        model: run.model ?? options.model,
        effort: run.effort ?? undefined,
        // Newer models return no reasoning text unless a summary is asked for; headless runs ignore the
        // showThinkingSummaries setting, so this is the only switch. It follows that setting.
        extraArgs: thinkingShown() ? { 'thinking-display': 'summarized' } : {},
        settings: run.projectTools
          ? { cleanupPeriodDays: options.contextRetentionDays ?? 3650 }
          : options.settingsPath,
        settingSources: run.projectTools ? ['user'] : ['user', 'project', 'local'],
        hooks: {
          UserPromptSubmit: [
            {
              hooks: [
                async (input) => {
                  if (input.hook_event_name === 'UserPromptSubmit' && input.prompt_id)
                    promptIds.push(input.prompt_id);
                  return {};
                },
              ],
            },
          ],
          ...(ownFiles && {
            PreToolUse: [
              { hooks: [guardOwnFiles(ownFiles, storedFiles!)], onFailure: 'block' as const },
            ],
          }),
        },
        maxTurns: options.maxTurns,
        env: {
          ...process.env,
          ...options.environment,
          CCDT_RUNTIME_SESSION: run.sessionId,
          ...(run.projectTools && { CCDT_PROJECT_SOCKET: run.projectTools.args[1] }),
          ...(run.scheduled ? { CLAUDE_CODE_HOST_SCHEDULED_RUN: '1' } : {}),
        },
        stderr: (text) => {
          stderr = (stderr + text).slice(-8192);
        },
        canUseTool: async (name, input, context) => {
          const tool = mapper.tool(name, context.toolUseID);
          // The call as the CLI took it, which says more than the model wrote where the CLI read a plan from its file.
          mapper.parameters(tool, input);
          // The hook above has refused these already; this is for a CLI that asks all the same.
          if (ownFiles && OWN_FILE_TOOLS.includes(name) && !ownFile(input, ownFiles, storedFiles)) {
            tool.denied = true;
            return { behavior: 'deny', message: OWN_FILES_REFUSAL };
          }
          const question = name === 'AskUserQuestion';
          const signal = AbortSignal.any([context.signal, run.signal]);
          const { allowed, answers, unanswered, executionMode } = signal.aborted
            ? { allowed: false }
            : await run.approve(tool.id, question ? 'question' : 'approval', name, signal, {
                input: JSON.stringify(input, null, 2),
                title: context.title?.slice(0, 512),
                description: context.description?.slice(0, 2048),
                // Only the service's own project server: a server of that name from other configuration is not it.
                ...(run.projectTools && rememberableCall(name, context) && { rememberable: true }),
              });
          if (signal.aborted) {
            return { behavior: 'deny', message: 'The permission request was cancelled.' };
          }
          if (question && unanswered) {
            // A CLI that knows of it is told how the question went: the tool's result says so, and Claude reads
            // the answer given for each question. An older one refuses an answer that says it.
            const said = UNANSWERED[unanswered];
            if (!capabilities.includes(UNANSWERED_CAPABILITY))
              return { behavior: 'deny', message: said };
            const asked = Array.isArray(input.questions)
              ? (input.questions as { question?: unknown }[])
                  .map((item) => item?.question)
                  .filter((text): text is string => typeof text === 'string')
              : [];
            return {
              behavior: 'allow',
              updatedInput: {
                ...input,
                answers: Object.fromEntries(asked.map((text) => [text, said])),
                annotations: Object.fromEntries(asked.map((text) => [text, { unanswered }])),
              },
            };
          }
          tool.denied = !allowed;
          if (allowed && name === 'ExitPlanMode' && executionMode)
            mapper.requestedPermissionMode = executionMode;
          return toolPermission(name, input, allowed, answers, executionMode);
        },
      },
    });
    const initialized = await session.initializationResult();
    if (run.projectTools && initialized.mcp_servers_applied !== true) {
      reportProject('not_applied');
      throw new Error('原生进程未加载项目 MCP 配置，本次消息未发送。');
    }
    confirmProject?.(true);
    const login = loginOf(initialized.account);
    // The commands change while the run goes on: each turn's `init` names those bound to the CLI's terminal, and
    // skills found on the way bring a new list. A change is passed on once.
    let commands = initialized.commands;
    let terminal: string[] = [];
    let offered = '';
    const offer = () => {
      const payload = nativeCapabilities(
        initialized.models,
        initialized.account,
        commands,
        run.model ?? options.model,
        terminal,
      );
      const key =
        payload.type === 'native.capabilities' ? JSON.stringify(payload.commandDetails) : '';
      if (key === offered || run.signal.aborted) return;
      offered = key;
      run.emit(payload);
    };
    offer();
    let metrics: NativeMetrics | undefined;
    let refresh: Promise<void> | undefined;
    let refreshedAt = 0;
    const running = session;
    if (run.projectTools)
      run.controls.refreshProject = async () => {
        const before = lastProjectStatus;
        const result = await optionalStatus(() => running.mcpServerStatus(), 5000);
        if (lastProjectStatus !== before || run.signal.aborted || !run.controls.refreshProject)
          return;
        if (result.value) reportServers(result.value);
        else run.emit({ type: 'native.notice', text: '本次未能读取项目 MCP 状态。' });
      };
    run.controls.stopTask = (taskId) => running.stopTask(taskId);
    run.controls.backgroundTask = (toolId) => running.backgroundTasks(toolId);
    run.controls.refresh = async (asked) => {
      const payload = await nativeMetrics(running, undefined, {
        quota: (query) => quotas.through(login, query, { asked }),
        previous: metrics?.usage,
      });
      if (payload.type === 'native.metrics') metrics = payload;
      if (!run.signal.aborted) run.emit(payload);
    };
    // Background Bash tasks and subagents live in the CLI process, and the completion of one starts a turn of
    // its own. Closing the CLI with the turn that started them would kill them, so the run stays open until
    // none is left.
    let background = 0;
    let idle = false;
    let checkingReceipt = false;
    let told = false;
    let turnStartedAt = Date.now();
    const waitForReceipt = () => {
      if (!checkingReceipt || background || !run.input.awaitingReceipt) return;
      clearTimeout(receiptWait);
      receiptWait = setTimeout(() => {
        if (run.signal.aborted || background || !run.input.awaitingReceipt) return;
        failure = new Error(
          '原生已结束本轮，但后续消息在 30 秒内仍未确认接收；已停止等待，消息未自动重发。',
        );
        settled = true;
        run.input.close();
        running.close();
      }, RECEIPT_WAIT_MS);
    };
    run.input.onDrain = waitForReceipt;
    // What each background task last said of itself, and when it was passed on.
    const progress = new Map<string, { said: string; at: number }>();
    for await (const message of session) {
      if (message.type === 'rate_limit_event') quotas.observe(login, message);
      if (message.type === 'system' && message.subtype === 'init') {
        if (run.projectTools && Array.isArray(message.mcp_servers))
          reportServers(message.mcp_servers);
        capabilities = message.capabilities ?? [];
        terminal = message.terminal_slash_commands ?? [];
        offer();
      }
      if (
        message.type === 'system' &&
        message.subtype === 'informational' &&
        message.tag === 'managed_mcp_arrived'
      )
        reportProject('policy');
      if (message.type === 'system' && message.subtype === 'commands_changed') {
        commands = message.commands;
        offer();
      }
      if (message.type === 'system' && message.subtype === 'task_progress' && !run.signal.aborted) {
        const tool = message.last_tool_name?.slice(0, 100);
        const summary = message.summary?.slice(0, 300);
        const said = `${tool}\n${summary}`;
        const last = progress.get(message.task_id);
        // A task reports every few moments; the same word again is passed on at most every two seconds.
        if (!last || last.said !== said || Date.now() - last.at >= 2000) {
          progress.set(message.task_id, { said, at: Date.now() });
          run.emit({
            type: 'native.progress',
            taskId: message.task_id,
            tool,
            toolUses: message.usage.tool_uses,
            summary,
          });
        }
      }
      if (message.type === 'system' && message.subtype === 'background_tasks_changed') {
        const tasks = message.tasks.filter((task) => !task.ambient);
        background = tasks.length;
        for (const id of progress.keys())
          if (!tasks.some((task) => task.task_id === id)) progress.delete(id);
        if (!run.signal.aborted)
          run.emit({
            type: 'native.tasks',
            tasks: tasks.map((task) => ({
              id: task.task_id,
              kind: task.task_type,
              description: task.description,
            })),
          });
        // The turn a finished task starts follows at once, announced by the CLI's `init`. When none does,
        // as after the user ended the last task, nothing is left to wait for.
        clearTimeout(settle);
        if (idle && !background)
          settle = setTimeout(() => {
            settled = true;
            run.input.close();
            running.close();
          }, 3000);
      } else if (
        (message.type === 'system' && message.subtype === 'init') ||
        (['user', 'assistant', 'stream_event'].includes(message.type) &&
          !(message.type === 'stream_event' && String(message.event.type) === 'ping') &&
          !('parent_tool_use_id' in message && message.parent_tool_use_id))
      ) {
        if (told && !run.signal.aborted) run.waiting(false);
        told = false;
        idle = false;
        checkingReceipt = false;
        clearTimeout(receiptWait);
        clearTimeout(settle);
      }
      if (!run.signal.aborted) {
        run.input.observe(message);
        mapper.accept(message);
      }
      // Context grows with every model call; show it during a long turn, not only once the turn ends.
      if (
        message.type === 'assistant' &&
        !refresh &&
        !run.signal.aborted &&
        Date.now() - refreshedAt >= 5000
      ) {
        refreshedAt = Date.now();
        // Every run shares the account reading; the service queries it anew only when due.
        refresh = nativeMetrics(session, undefined, {
          quota: (query) => quotas.through(login, query),
          previous: metrics?.usage,
        })
          .then(
            (payload) => {
              if (payload?.type !== 'native.metrics' || !payload.context || run.signal.aborted)
                return;
              metrics = payload;
              run.emit(payload);
            },
            () => {},
          )
          .finally(() => {
            refresh = undefined;
          });
      }
      if (message.type === 'result') {
        clearTimeout(receiptWait);
        checkingReceipt = false;
        const endedAt = Date.now();
        await refresh;
        const done = run.input.endTurn(message, background > 0);
        const outputTotal = Object.values(message.modelUsage ?? {}).reduce(
          (sum, model) => sum + model.outputTokens,
          0,
        );
        const turnOutput =
          outputSoFar === undefined || outputTotal < outputSoFar
            ? (message.usage?.output_tokens ?? 0)
            : outputTotal - outputSoFar;
        outputSoFar = outputTotal;
        // Both are read every turn: the totals are counted from the turn before.
        const grown = written(message.modelUsage);
        const ttl = cacheTtl(message.usage) ?? grown;
        if (!run.signal.aborted) {
          // A turn that merged several messages answers them all; the last one is where the reply is shown.
          const answered = message.user_message_uuids ?? [message.user_message_uuid];
          const question = tally({
            messageId: answered.filter((id) => id).at(-1),
            startedAt: turnStartedAt,
            requests: mapper.requests,
            outputTokens: turnOutput,
            promptIds,
          });
          run.turnEnded({ ...question, endedAt, background: background > 0 });
        }
        turnStartedAt = endedAt;
        mapper.requests = 0;
        promptIds = [];
        if (!run.signal.aborted) {
          try {
            const payload = await nativeMetrics(session, message, {
              quota: (query) => quotas.through(login, query),
            });
            if (payload.type === 'native.metrics') {
              metrics = payload;
              run.emit(ttl ? { ...payload, cacheTtl: ttl } : payload);
            } else run.emit(payload);
          } catch {
            run.emit({ type: 'native.notice', text: '本轮原生状态未能读取；任务结果不受影响。' });
          }
          const expiry = loginExpiry(message.credential_expires_at);
          if (expiry) run.emit({ type: 'native.notice', text: expiry });
        }
        if (run.signal.aborted) break;
        if (done) {
          // The CLI ends once its input does, and says on the way out what it could not save (`session_writes_lost`),
          // so it is heard out for a few seconds rather than stopped. The run's outcome is known already: how the
          // process ends does not change it.
          settled = true;
          run.input.close();
          exiting = setTimeout(() => running.close(), EXIT_MS);
          continue;
        }
        idle = true;
        if (background) {
          told = true;
          run.waiting(true);
        }
        checkingReceipt = message.queued_turn_count === 0 && !background;
        waitForReceipt();
      }
    }
  } catch (error) {
    if (!settled)
      failure = error instanceof Error ? error : new Error('Native SDK process failed.');
  } finally {
    confirmProject?.(false);
    clearTimeout(settle);
    clearTimeout(exiting);
    clearTimeout(receiptWait);
    run.input.onDrain = undefined;
    run.controls.refresh = undefined;
    run.controls.refreshProject = undefined;
    run.controls.stopTask = undefined;
    run.controls.backgroundTask = undefined;
    run.input.close();
    session?.close();
    run.signal.removeEventListener('abort', stop);
  }
  const context = await getSessionInfo(run.sessionId, { dir: cwd });
  run.emit(nativeContext(run.sessionId, context));
  if (context?.summary?.trim())
    run.emit({ type: 'native.title', title: context.summary.trim().slice(0, 120) });
  for (const tool of mapper.tools.values())
    if (!tool.finished) {
      run.emit({
        type: 'tool.result',
        toolId: tool.id,
        status: 'unknown',
        output:
          '运行结束；该工具最终执行结果未确认。已发出的本机命令可能继续执行，副作用未撤销，不能自动重放。',
        exitCode: null,
      });
    }
  if (run.signal.aborted) return 'cancelled';
  if (failure || !mapper.result) {
    run.emit({
      type: 'run.error',
      code: 'cli_process_failed',
      message: failure?.message ?? (stderr.trim() || 'Claude Code exited without a result.'),
    });
    return 'failed';
  }
  return mapper.result.failed ? 'failed' : 'completed';
}

export async function readNativeStatus(
  options: ClaudeOptions,
  dataDir: string,
  nativeRoot: string,
  sessionId: string,
  signal: AbortSignal,
  // The user asked on the account page; `previous` is the session's last totals, kept if no new ones come. Without
  // `resume` the CLI does not take up the native session, which a terminal may hold.
  {
    asked = false,
    previous = null,
    resume = true,
  }: { asked?: boolean; previous?: NativeMetrics['usage']; resume?: boolean } = {},
) {
  const cwd = prepareNativeDirectory(options, dataDir, nativeRoot);
  const saved = resume && (await getSessionInfo(sessionId, { dir: cwd }));
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  async function* input(): AsyncGenerator<SDKUserMessage> {
    await waiting;
  }
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  const timer = setTimeout(abort, 15000);
  let process: Query | undefined;
  let drain: Promise<void> | undefined;
  try {
    process = query({
      prompt: input(),
      options: {
        cwd,
        pathToClaudeCodeExecutable: options.executable,
        ...(saved ? { resume: sessionId } : {}),
        abortController: controller,
        settings: options.settingsPath,
        settingSources: ['user'],
        env: {
          ...globalThis.process.env,
          ...options.environment,
          CCDT_RUNTIME_SESSION: sessionId,
          ...(saved && { CLAUDE_CODE_DISABLE_DEFERRED_TOOL_RESUME: '1' }),
        },
      },
    });
    // Keep draining while control requests are in flight; no model prompt is submitted.
    const session = process;
    drain = (async () => {
      for await (const _message of session) {
      }
    })().catch(() => {});
    const initialized = await process.initializationResult();
    const login = loginOf(initialized.account);
    return [
      nativeCapabilities(
        initialized.models,
        initialized.account,
        initialized.commands,
        options.model,
      ),
      await nativeMetrics(process, undefined, {
        quota: (query) => quotas.through(login, query, { asked }),
        previous,
      }),
    ];
  } finally {
    clearTimeout(timer);
    release();
    process?.close();
    signal.removeEventListener('abort', abort);
    await drain;
  }
}
