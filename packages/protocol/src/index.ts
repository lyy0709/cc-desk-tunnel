import { projectCall } from './project.ts';
export * from './project.ts';
import { z } from 'zod';
import { webCommandSchemas, webSettingsStateSchema, webTotpSetupSchema } from './web.ts';
import { webCertificateStateSchema } from './web-certificate.ts';
export * from './web.ts';
export * from './web-certificate.ts';

export const PROTOCOL_VERSION = 36;
// The release each protocol version began with, from 0.2.4 on: a client newer than its service signs in with
// the service's number to have it upgrade (see the README). A new number adds its line here.
export const PROTOCOL_HISTORY: Readonly<Record<string, number>> = {
  '0.2.4': 10,
  '0.2.6': 11,
  '0.2.9': 12,
  '0.2.10': 13,
  '0.2.11': 14,
  '0.2.12': 15,
  '0.3.0': 16,
  '0.3.2': 17,
  '0.3.3': 18,
  '0.3.5': 19,
  '0.3.6': 20,
  '0.3.7': 21,
  '0.3.8': 22,
  '0.3.10': 23,
  '0.3.12': 24,
  '0.3.14': 25,
  '0.3.15': 26,
  '0.3.17': 27,
  '0.3.18': 28,
  '0.3.19': 29,
  '0.3.20': 30,
  '0.3.21': 31,
  '0.3.23': 32,
  '0.4.0': 36,
};
export const MAX_FRAME_BYTES = 256 * 1024;
export const APPROVAL_PAGE_CHARS = 16000;
// The longest global instructions edited here, in characters; it keeps a frame of them within MAX_FRAME_BYTES.
export const INSTRUCTIONS_LIMIT = 64_000;
const id = z.uuid();
// A path tells its own system: a Windows one begins with a drive letter or two backslashes, anything else is
// a POSIX one. Sessions of both kinds can be in one list, each from the computer it is on.
export const isWindowsPath = (path: string) => /^[a-z]:[\\/]|^\\\\/i.test(path);
// Windows paths compare case-insensitively and may arrive with either separator; a POSIX path is taken as
// written, where a backslash is a character of a name like any other.
export const pathKey = (path: string) =>
  isWindowsPath(path)
    ? withoutTrailing(path.replaceAll('/', '\\'), '\\').toLowerCase()
    : withoutTrailing(path, '/') || '/';
// Counted off the end rather than matched: a pattern anchored at the end backtracks over every run of
// separators in a long path.
function withoutTrailing(path: string, separator: string) {
  let end = path.length;
  while (end && path[end - 1] === separator) end--;
  return path.slice(0, end);
}
const timestamp = z.iso.datetime();
export const fileAttachmentSchema = z
  .object({
    path: z
      .string()
      .min(1)
      .max(16000)
      .refine(
        (value) =>
          !value.includes('\0') &&
          (value.startsWith('/') ||
            isWindowsPath(value) ||
            /^attachment:[0-9a-f-]{36}$/.test(value) ||
            value.startsWith('project:/')),
      ),
    name: z.string().min(1).max(1024),
    size: z.number().int().nonnegative().optional(),
    deviceId: id,
    reference: z.number().int().positive().optional(),
  })
  .strict();
export type FileAttachment = z.infer<typeof fileAttachmentSchema>;
// Cards are presentation metadata. The native process still receives ordinary text and file references.
export function messageText(text: string, attachments: readonly FileAttachment[] = []) {
  if (!attachments.length) return text;
  const references = new Map(attachments.map((file) => [file.reference, file]));
  const used = new Set<FileAttachment>();
  const body = text.replace(/\[文件 #(\d+)\]/g, (token, number) => {
    const file = references.get(Number(number));
    if (!file) return token;
    used.add(file);
    return JSON.stringify(file.path);
  });
  return [
    body,
    attachments
      .filter((file) => !used.has(file))
      .map((file) => JSON.stringify(file.path))
      .join('\n'),
  ]
    .filter(Boolean)
    .join('\n\n');
}
// `bypassPermissions` asks about nothing at all; the client offers it only once the user allowed that.
export const permissionModeSchema = z.enum([
  'auto',
  'default',
  'plan',
  'acceptEdits',
  'bypassPermissions',
]);
export type PermissionMode = z.infer<typeof permissionModeSchema>;
export const planExecutionModeSchema = z.enum(['auto', 'default', 'acceptEdits']);
export type PlanExecutionMode = z.infer<typeof planExecutionModeSchema>;
export const effortSchema = z.enum(['low', 'medium', 'high', 'xhigh', 'max']);
export type Effort = z.infer<typeof effortSchema>;
export const modelInfoSchema = z.object({
  value: z.string(),
  displayName: z.string(),
  description: z.string(),
  resolvedModel: z.string().optional(),
  source: z.enum(['native', 'configured']),
  supportedEffortLevels: z.array(effortSchema),
});
export const nativeAccountSchema = z.object({
  email: z.string().optional(),
  organization: z.string().optional(),
  subscriptionType: z.string().optional(),
  apiProvider: z.string().optional(),
  apiKeySource: z.string().optional(),
  tokenSource: z.string().optional(),
});
export const accountStateSchema = z.object({
  loggedIn: z.boolean(),
  terminal: z
    .object({
      loggedIn: z.boolean(),
      authMethod: z.string().optional(),
      email: z.string().optional(),
      organization: z.string().optional(),
    })
    .optional(),
  authMethod: z.string().optional(),
  email: z.string().optional(),
  organization: z.string().optional(),
  subscriptionType: z.string().optional(),
  // When a stored claude.ai sign-in ends for good (ISO 8601), as `claude auth status` reads it: renewing the access
  // token does not move it, and the real end can be up to three days earlier. Absent for any other credential.
  loginExpiresAt: z.string().optional(),
  notice: z.string().optional(),
});
export type AccountState = z.infer<typeof accountStateSchema>;
// The part of the official CLI's user settings the GUI edits. null means unset: the CLI's own default applies.
const toggle = z.boolean().nullable();
export const nativeSettingsSchema = z.object({
  autoCompactEnabled: toggle,
  autoCompactWindow: z.number().int().min(100_000).max(1_000_000).nullable(),
  alwaysThinkingEnabled: toggle,
  // Whether the model is asked for a summary of its reasoning, which is what the conversation shows. The CLI
  // ignores this key in the runs the service starts; the service reads it and asks or does not.
  showThinkingSummaries: toggle,
  fastMode: toggle,
  autoContinueAtUsageLimit: toggle,
  switchModelsOnFlag: toggle,
  autoMemoryEnabled: toggle,
  fileCheckpointingEnabled: toggle,
  promptCacheTtl: z.enum(['5m', '1h']).nullable(),
  language: z.string().trim().min(1).max(60).nullable(),
  precomputeCompactionEnabled: toggle,
  autoDreamEnabled: toggle,
  subagentPromptCacheTtl: z.enum(['5m', '1h']).nullable(),
  fallbackModel: z.array(z.string().trim().min(1).max(200)).min(1).max(5).nullable(),
  askUserQuestionTimeout: z.enum(['60s', '5m', '10m', 'never']).nullable(),
  bashOutputMaxChars: z.number().int().min(4000).max(128_000).nullable(),
  // The CLI also takes an object of custom texts here; the GUI only offers hiding the attribution, and shows
  // anything else as unset.
  attribution: z.literal(false).nullable(),
  includeGitInstructions: toggle,
  // The Artifact tool, which publishes pages to claude.ai. The CLI turns it on by default once it is available to
  // the account; off in the user's settings keeps it off.
  enableArtifact: toggle,
  // Not a key of its own in the file: ENABLE_TOOL_SEARCH under `env`. Tools are then described to the model
  // only when it looks for them, instead of all of them with every request.
  toolSearch: toggle,
  // Under `permissions` in the file: the first from CLI 2.1.319, the second from 2.1.314.
  denyInsteadOfPrompting: toggle,
  blockWritesOutsideWorkingDirectories: toggle,
});
export type NativeSettings = z.infer<typeof nativeSettingsSchema>;
// The service's own setting, not the CLI's: before the prompt cache of an idle session lapses, it compacts the session
// with /compact, as the compact button does, so that the summary reads the cache instead of the whole context anew.
// Only a session whose last turn wrote a one-hour cache and holds `minTokens` or more, `afterMinutes` after that turn.
export const idleCompactionSchema = z.object({
  enabled: z.boolean(),
  afterMinutes: z.number().int().min(10).max(55),
  minTokens: z.number().int().min(20_000).max(1_000_000),
});
export type IdleCompaction = z.infer<typeof idleCompactionSchema>;
export const contextUsageSchema = z.object({
  model: z.string(),
  usedTokens: z.number().nonnegative(),
  windowTokens: z.number().positive(),
  percentage: z.number().nonnegative(),
  measuredAt: timestamp,
  categories: z.array(
    z.object({
      // The CLI's stable name for the row (CLI 2.1.304 and later), where `name` is English text that may change.
      id: z.string().optional(),
      name: z.string(),
      tokens: z.number().nonnegative(),
      kind: z.enum(['used', 'free', 'buffer', 'deferred']),
    }),
  ),
});
export const nativeUsageSchema = z.object({
  costUsd: z.number().nonnegative().nullable(),
  inputTokens: z.number().nonnegative(),
  outputTokens: z.number().nonnegative(),
  cacheReadTokens: z.number().nonnegative(),
  cacheWriteTokens: z.number().nonnegative(),
  // The cache writes that last an hour and those that last five minutes, which the API prices differently (CLI 2.1.311
  // and later). Writes a response did not say the lifetime of are in neither, so the two may add up to less.
  cacheWrite1hTokens: z.number().nonnegative().optional(),
  cacheWrite5mTokens: z.number().nonnegative().optional(),
  measuredAt: timestamp,
});
export const rateLimitsSchema = z.object({
  available: z.boolean(),
  windows: z.array(
    z.object({
      name: z.string(),
      utilization: z.number().nonnegative().nullable(),
      resetsAt: z.string().nullable(),
    }),
  ),
  measuredAt: timestamp.optional(),
});
const usageTotals = {
  requests: z.number().int().nonnegative(),
  inputTokens: z.number().nonnegative(),
  outputTokens: z.number().nonnegative(),
  cacheReadTokens: z.number().nonnegative(),
  cacheCreationTokens: z.number().nonnegative(),
  // The official CLI's API-price estimate, not a subscription bill.
  costUsd: z.number().nonnegative(),
};
// Sparse UTC slices can be regrouped on the viewer, including in quarter-hour time zones.
export const USAGE_SLICE_MINUTES = 15;
const serverMinute = z.iso.datetime({ local: true, precision: -1 }).length(16);
const usageRange = z.union([
  z.enum(['today', '24h', '7d', '30d']),
  // Absolute instants returned by the service for a quota window or a fixed page range.
  z.object({ from: timestamp, to: timestamp.optional() }).strict(),
  // Wall-clock values entered in the proxy's time zone.
  z.object({ serverFrom: serverMinute, serverTo: serverMinute }).strict(),
]);
export const usageSummarySchema = z.object({
  retentionDays: z.number().int().positive(),
  firstRecordAt: timestamp.nullable(),
  measuredAt: timestamp.optional(),
  // One entry per official quota period; totals cover requests since that period started.
  windows: z.array(
    z.object({
      name: z.string(),
      startedAt: timestamp,
      resetsAt: timestamp.nullable(),
      utilization: z.number().nonnegative().nullable(),
      ...usageTotals,
    }),
  ),
});
export const usagePageSchema = z.object({
  from: timestamp,
  to: timestamp,
  timeZone: z.string().min(1),
  rows: z.array(
    z.object({
      id: z.number().int().positive(),
      at: timestamp,
      sessionId: z.string().nullable(),
      sessionTitle: z.string().nullable(),
      model: z.string(),
      inputTokens: z.number().nonnegative(),
      outputTokens: z.number().nonnegative(),
      cacheReadTokens: z.number().nonnegative(),
      cacheCreationTokens: z.number().nonnegative(),
      costUsd: z.number().nonnegative(),
      durationMs: z.number().nonnegative(),
      ttftMs: z.number().nonnegative().nullable(),
      source: z.string().nullable(),
    }),
  ),
  hasMore: z.boolean(),
  totals: z.object({
    ...usageTotals,
    durationMs: z.number().nonnegative(),
    ttftMs: z.number().nonnegative().nullable(),
    outputPerSecond: z.number().nonnegative().nullable(),
  }),
  models: z.array(z.string()),
  // Every model of the time range, whatever the model filter, the costliest first.
  byModel: z.array(z.object({ model: z.string(), ...usageTotals })),
  series: z.array(
    z.object({
      at: timestamp,
      requests: z.number().int().nonnegative(),
      tokens: z.number().nonnegative(),
      inputTokens: z.number().nonnegative(),
      outputTokens: z.number().nonnegative(),
      cacheReadTokens: z.number().nonnegative(),
      cacheCreationTokens: z.number().nonnegative(),
      costUsd: z.number().nonnegative(),
    }),
  ),
});
export type UsageSummary = z.infer<typeof usageSummarySchema>;
export type UsagePage = z.infer<typeof usagePageSchema>;
export const runStatusSchema = z.enum([
  'running',
  'awaiting_approval',
  'completed',
  'cancelled',
  'failed',
]);
// What a run waits for. In `awaiting_approval`: a decision on a tool, or an answer to a question Claude asked.
// While `running`, `background`: Claude has finished its turn and only the background tasks it started go on.
export const waitingSchema = z.enum(['approval', 'question', 'background']);
// What the CLI of a terminal that continues its session is doing, as its hooks report it.
export const terminalActivitySchema = z.enum(['working', 'waiting', 'idle']);
export type TerminalActivity = z.infer<typeof terminalActivitySchema>;
export const terminalStatuses = new Set<RunStatus>(['completed', 'cancelled', 'failed']);
export type RunStatus = z.infer<typeof runStatusSchema>;

const scenarioSchema = z.enum(['chat', 'tool', 'question', 'error']);
export const messagePrioritySchema = z.enum(['next', 'later', 'now']);
export type MessagePriority = z.infer<typeof messagePrioritySchema>;
const toolSchema = z.object({
  toolId: z.string().min(1),
  name: z.string().min(1),
  input: z.string(),
  privateInput: z.literal(true).optional(),
  target: z.enum(['Windows (simulation)', 'Windows', 'Linux', '项目设备']),
});
export const mcpConnectionStatus = z.enum([
  'connected',
  'pending',
  'failed',
  'needs-auth',
  'disabled',
]);
export const eventPayloadSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('message.user'),
    messageId: id,
    text: z.string(),
    attachments: z.array(fileAttachmentSchema).optional(),
    scenario: scenarioSchema,
    scheduled: z.enum(['scheduled', 'manual']).optional(),
    priority: messagePrioritySchema.optional(),
    // Sent by the "continue" button rather than written: the page shows a mark in place of the text.
    continued: z.boolean().optional(),
  }),
  z.object({
    type: z.literal('message.delivery'),
    messageId: id,
    status: z.enum(['submitted', 'queued', 'received', 'not_sent', 'unconfirmed']),
  }),
  z.object({
    type: z.literal('run.status'),
    status: runStatusSchema,
    connectionId: id,
    surface: z.enum(['chat', 'terminal']).optional(),
    waiting: waitingSchema.optional(),
    activity: terminalActivitySchema.optional(),
    reason: z.string().optional(),
  }),
  z.object({ type: z.literal('text.delta'), messageId: id, text: z.string() }),
  z.object({ type: z.literal('thinking.delta'), messageId: id, text: z.string() }),
  z.object({
    type: z.literal('native.session'),
    nativeSessionId: id,
    model: z.string(),
    version: z.string(),
    requestedPermissionMode: permissionModeSchema.optional(),
    permissionMode: z.string().optional(),
    requestedEffort: effortSchema.nullable().optional(),
    effort: effortSchema.nullable().optional(),
  }),
  z.object({
    type: z.literal('native.permission'),
    permissionMode: permissionModeSchema,
  }),
  z.object({
    type: z.literal('native.context'),
    nativeSessionId: id,
    persisted: z.boolean(),
    updatedAt: timestamp.optional(),
  }),
  z.object({ type: z.literal('native.notice'), text: z.string() }),
  z.object({
    type: z.literal('native.project_mcp'),
    status: mcpConnectionStatus.or(z.enum(['missing', 'not_applied', 'policy', 'unknown'])),
  }),
  // The background tasks alive in the run's CLI; each list replaces the one before.
  z.object({
    type: z.literal('native.tasks'),
    tasks: z.array(z.object({ id: z.string().min(1), kind: z.string(), description: z.string() })),
  }),
  z.object({
    type: z.literal('native.capabilities'),
    models: z.array(modelInfoSchema),
    account: nativeAccountSchema,
    commands: z.array(z.string()),
    // What each command does and takes, in Claude Code's words; those bound to its own terminal are left out.
    commandDetails: z
      .array(
        z.object({
          name: z.string(),
          description: z.string(),
          argumentHint: z.string(),
          aliases: z.array(z.string()).optional(),
        }),
      )
      .optional(),
  }),
  z.object({
    type: z.literal('native.metrics'),
    profile: z.enum(['sdk', 'terminal']).optional(),
    context: contextUsageSchema.nullable(),
    usage: nativeUsageSchema.nullable(),
    rateLimits: rateLimitsSchema.nullable(),
    // How long the prompt cache the turn wrote lasts, as its requests were billed; only on a turn's end, and only when
    // it wrote one.
    cacheTtl: z.enum(['5m', '1h']).optional(),
    errors: z.object({ context: z.string().optional(), usage: z.string().optional() }).optional(),
  }),
  z.object({ type: z.literal('native.title'), title: z.string().min(1).max(120) }),
  z.object({
    type: z.literal('native.compact'),
    trigger: z.string(),
    previousTokens: z.number().nonnegative().nullable(),
  }),
  // What one question cost, summed from the model requests the CLI reported for it; the figures are the call log's.
  // A question runs on through the turns its background tasks start, and each of those turns sends the figures so far
  // under the same messageId; the last one received is the current one.
  z.object({
    type: z.literal('turn.stats'),
    // The user message the figures answer; a run that resumed without one reports under none.
    messageId: id.optional(),
    requests: z.number().int().nonnegative(),
    inputTokens: z.number().nonnegative(),
    outputTokens: z.number().nonnegative(),
    cacheReadTokens: z.number().nonnegative(),
    cacheCreationTokens: z.number().nonnegative(),
    modelMs: z.number().nonnegative(),
    // Averages over the requests that report a first-token time; null when none does.
    ttftMs: z.number().nonnegative().nullable(),
    outputPerSecond: z.number().nonnegative().nullable(),
    // Fewer requests were reported than the question made, or a background task is still running and may add more.
    partial: z.boolean(),
  }),
  z.object({ type: z.literal('tool.requested'), ...toolSchema.shape }),
  z.object({ type: z.literal('tool.input'), toolId: z.string().min(1), input: z.string() }),
  z.object({ type: z.literal('tool.input.delta'), toolId: z.string().min(1), text: z.string() }),
  z.object({
    type: z.literal('tool.progress'),
    toolId: z.string().min(1),
    elapsedSeconds: z.number().nonnegative(),
  }),
  // The task a tool call waits on in the foreground (a command, a subagent): while it runs, the user may end it or
  // send it to the background, and the call returns either way.
  z.object({
    type: z.literal('tool.task'),
    toolId: z.string().min(1),
    taskId: z.string().min(1).max(200),
  }),
  // What a background task says of itself while it runs. It is worth something only until the task ends, so
  // it reaches the windows as a fragment and is never recorded.
  z.object({
    type: z.literal('native.progress'),
    taskId: z.string().min(1),
    tool: z.string().max(100).optional(),
    toolUses: z.number().int().nonnegative().optional(),
    summary: z.string().max(300).optional(),
  }),
  z.object({ type: z.literal('approval.requested'), approvalId: id, toolId: z.string().min(1) }),
  z.object({
    type: z.literal('approval.resolved'),
    approvalId: id,
    allowed: z.boolean(),
    cancelled: z.boolean().optional(),
    executionMode: planExecutionModeSchema.optional(),
  }),
  z.object({
    type: z.literal('tool.result'),
    toolId: z.string().min(1),
    status: z.enum(['completed', 'denied', 'cancelled', 'failed', 'unknown', 'deferred']),
    output: z.string(),
    exitCode: z.number().int().nullable(),
  }),
  z.object({
    type: z.literal('tool.output'),
    toolId: z.string().min(1),
    stream: z.enum(['stdout', 'stderr']),
    text: z.string(),
  }),
  z.object({ type: z.literal('run.error'), code: z.string(), message: z.string() }),
]);
export type EventPayload = z.infer<typeof eventPayloadSchema>;
type Payload<T extends EventPayload['type']> = Extract<EventPayload, { type: T }>;
export type NativeSession = Payload<'native.session'>;
export type NativeContext = Payload<'native.context'>;
export type NativeCapabilities = Payload<'native.capabilities'>;
export type NativeMetrics = Payload<'native.metrics'>;
// Output that arrives in pieces. While it arrives, each piece goes to those watching as a `session.fragment`,
// which is neither stored nor numbered; once the stretch is over it is recorded as one event of the same
// type holding all of its text.
export const fragmentTypes = [
  'text.delta',
  'thinking.delta',
  'tool.input.delta',
  'tool.output',
] as const;
export type Fragment = Payload<(typeof fragmentTypes)[number]>;
export function isFragment(payload: EventPayload): payload is Fragment {
  return (fragmentTypes as readonly string[]).includes(payload.type);
}
// Whether `next` goes on where `open` stopped: the same message, or the same tool and stream.
export function continues(open: Fragment, next: Fragment) {
  if (open.type !== next.type) return false;
  if ('messageId' in open) return open.messageId === (next as typeof open).messageId;
  if (open.toolId !== (next as typeof open).toolId) return false;
  return open.type !== 'tool.output' || open.stream === (next as typeof open).stream;
}
export type TurnStats = Payload<'turn.stats'>;
export const eventSchema = z.object({
  sessionId: id,
  runId: id,
  sequence: z.number().int().positive(),
  createdAt: timestamp,
  payload: eventPayloadSchema,
});
export type SessionEvent = z.infer<typeof eventSchema>;
// The systems a device may run. What runs its scripts and how its paths are written follow from it.
export const devicePlatformSchema = z.enum(['win32', 'darwin', 'linux']);
export type DevicePlatform = z.infer<typeof devicePlatformSchema>;
// The shells a device runs Claude's scripts in, each under a host name of its own (`device-pwsh` and so on): PowerShell
// 7 on Windows, and Git Bash too where Git for Windows is installed; on macOS and Linux the user's own shell.
export const deviceShellSchema = z.enum(['pwsh', 'bash', 'zsh']);
export type DeviceShell = z.infer<typeof deviceShellSchema>;
// One of the user's computers: the client there makes the ID once and keeps it. Its system is recorded
// unless it is Windows, which is what every computer was before others were supported.
export const deviceSchema = z.object({
  id,
  name: z.string().trim().min(1).max(120),
  platform: devicePlatformSchema.optional(),
});
export const platformOf = (device?: { platform?: DevicePlatform } | null): DevicePlatform =>
  device?.platform ?? 'win32';
export type Device = z.infer<typeof deviceSchema>;
export const sessionSchema = z.object({
  // Latest recorded event known to the service, including when only the directory is sent.
  lastSequence: z.number().int().nonnegative().optional(),
  id,
  title: z.string().min(1).max(120),
  autoTitle: z.boolean().default(false),
  projectPath: z.string().min(1).max(2048),
  // The computer the project directory is on, and so where the session's runs and commands are, whichever of
  // the user's computers sends its messages. A session from before 0.2.11 has none until a computer sends it one.
  device: deviceSchema.optional(),
  permissionMode: permissionModeSchema.default('auto'),
  model: z.string().trim().min(1).max(200).nullable().default(null),
  effort: effortSchema.nullable().default(null),
  // The directory on the service that Claude Code works in, under its native/ folder: the one of the session's
  // project, which all sessions of the project share. A fork keeps it from the session it was forked from.
  // Sessions from before projects had one leave it out and work in a directory named after themselves.
  nativeRoot: id.optional(),
  projectAccess: z.literal(1).optional(),
  createdAt: timestamp,
  updatedAt: timestamp,
  // The last outcome lets a window pause its unsent queue while another session is selected.
  lastRunStatus: z.enum(['completed', 'cancelled', 'failed']).optional(),
  activeRun: z
    .object({
      id,
      status: runStatusSchema,
      connectionId: id,
      surface: z.enum(['chat', 'terminal']).optional(),
      waiting: waitingSchema.optional(),
      activity: terminalActivitySchema.optional(),
    })
    .nullable(),
});
export type Session = z.infer<typeof sessionSchema>;
// Whether a session's run is at work, so that the restart of a service upgrade would cut it off: a turn under way or
// waiting on the user, or a terminal whose CLI works or waits. A terminal open at rest, and a turn ended but for the
// background tasks it left, are not: an upgrade only ends them, and the session goes on after it.
export function runWorking(run: Session['activeRun']) {
  if (!run) return false;
  if (run.surface === 'terminal') return run.activity === 'working' || run.activity === 'waiting';
  return run.waiting !== 'background';
}
// The first release whose service takes `force` on `service.update.install`, and upgrades past what is at work.
export const FORCED_UPGRADE_SINCE = '0.3.15';
export const snapshotSchema = z.object({ session: sessionSchema, events: z.array(eventSchema) });
export type SessionSnapshot = z.infer<typeof snapshotSchema>;
export const historyPageSchema = snapshotSchema.extend({
  requestId: id,
  mode: z.enum(['replace', 'prepend', 'append']),
  firstSequence: z.number().int().nonnegative(),
  lastSequence: z.number().int().nonnegative(),
  hasEarlier: z.boolean(),
  reset: z.literal(true).optional(),
});
export type HistoryPage = z.infer<typeof historyPageSchema>;

export const outlineEntrySchema = z.object({
  id: z.string(),
  sequence: z.number().int().positive(),
  at: timestamp,
  ended: z.boolean(),
  question: z.string().max(180),
  answer: z.string().max(300),
});
export type OutlineEntry = z.infer<typeof outlineEntrySchema>;
const sessionOutlineSchema = z.object({
  type: z.literal('session.outline'),
  requestId: id,
  sessionId: id,
  throughSequence: z.number().int().nonnegative(),
  fromSequence: z.number().int().nonnegative(),
  entries: z.array(outlineEntrySchema),
});
export type SessionOutline = z.infer<typeof sessionOutlineSchema>;
const sessionReadSchema = snapshotSchema.extend({
  type: z.literal('session.read'),
  requestId: id,
  firstSequence: z.number().int().nonnegative(),
  lastSequence: z.number().int().nonnegative(),
  throughSequence: z.number().int().nonnegative(),
  hasEarlier: z.boolean(),
  hasLater: z.boolean(),
  totalEvents: z.number().int().nonnegative(),
  capturedAt: timestamp,
  fragment: eventSchema.optional(),
});
export type SessionRead = z.infer<typeof sessionReadSchema>;

const versionSchema = z.string().regex(/^\d+\.\d+\.\d+$/);
const installerSchema = z.object({
  version: versionSchema,
  size: z.number().int().positive(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});
// Where the service stands against the published releases. `manual` is a newer release this installation cannot
// install by itself; `installing` carries the step in `detail`, `failed` the reason.
export const serviceUpdateSchema = z.object({
  state: z.enum(['idle', 'checking', 'available', 'manual', 'installing', 'restarting', 'failed']),
  latest: versionSchema.optional(),
  detail: z.string().optional(),
  checkedAt: z.number().int().nonnegative().optional(),
});
export type ServiceUpdate = z.infer<typeof serviceUpdateSchema>;
const request = { requestId: id };
export const commandSchema = z.discriminatedUnion('type', [
  ...webCommandSchemas,
  z
    .object({
      type: z.literal('server.session.create'),
      ...request,
      title: z.string().trim().min(1).max(120),
    })
    .strict(),
  z
    .object({
      type: z.literal('session.create'),
      ...request,
      title: z.string().trim().min(1).max(120),
      projectPath: z.string().trim().min(1).max(2048),
    })
    .strict(),
  z.object({ type: z.literal('session.acceptHistory'), sessionId: id, ...request }).strict(),
  z.object({ type: z.literal('account.status'), ...request }).strict(),
  z
    .object({
      type: z.literal('approval.inspect'),
      ...request,
      sessionId: id,
      runId: id,
      approvalId: id,
      offset: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      type: z.literal('account.login'),
      ...request,
      sessionId: id,
      cols: z.number().int().min(20).max(400),
      rows: z.number().int().min(5).max(160),
    })
    .strict(),
  z.object({ type: z.literal('settings.get'), ...request }).strict(),
  z
    .object({
      type: z.literal('settings.update'),
      ...request,
      values: nativeSettingsSchema.partial().strict(),
    })
    .strict(),
  z.object({ type: z.literal('compaction.get'), ...request }).strict(),
  z
    .object({
      type: z.literal('compaction.update'),
      ...request,
      values: idleCompactionSchema.partial().strict(),
    })
    .strict(),
  // The shell the user prefers Claude to run scripts in on the computer of this connection; null leaves it to Claude.
  z
    .object({ type: z.literal('device.shell'), ...request, shell: deviceShellSchema.nullable() })
    .strict(),
  z.object({ type: z.literal('instructions.get'), ...request }).strict(),
  z
    .object({
      type: z.literal('instructions.update'),
      ...request,
      text: z.string().max(INSTRUCTIONS_LIMIT),
      // The version the text was edited from; the file is written only if it is still that one.
      version: z.string().max(100),
    })
    .strict(),
  z
    .object({
      type: z.literal('usage.summary'),
      ...request,
      profile: z.literal('terminal').optional(),
    })
    .strict(),
  z.object({ type: z.literal('session.stats'), ...request, sessionId: id }).strict(),
  z.object({ type: z.literal('service.update.check'), ...request }).strict(),
  z
    .object({
      type: z.literal('service.update.install'),
      ...request,
      version: versionSchema,
      // Upgrades even while sessions are at work, which the restart cuts off.
      force: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('usage.query'),
      ...request,
      range: usageRange,
      profile: z.enum(['sdk', 'terminal']).optional(),
      model: z.string().min(1).max(200).optional(),
      beforeId: z.number().int().positive().optional(),
      // Rows to skip from the newest, for a page of a range whose end is fixed.
      offset: z.number().int().min(0).max(10_000_000).optional(),
      limit: z.number().int().min(1).max(200).default(100),
    })
    .strict(),
  z.object({ type: z.literal('session.delete'), ...request, sessionId: id }).strict(),
  z
    .object({
      type: z.literal('session.rename'),
      ...request,
      sessionId: id,
      title: z.string().trim().min(1).max(120),
    })
    .strict(),
  z
    .object({
      type: z.literal('session.configure'),
      ...request,
      sessionId: id,
      permissionMode: permissionModeSchema,
      model: z.string().trim().min(1).max(200).nullable().optional(),
      effort: effortSchema.nullable().optional(),
    })
    .strict(),
  // Points a session at a project directory on the computer that asks, which the session is on from then.
  z
    .object({
      type: z.literal('session.move'),
      ...request,
      sessionId: id,
      projectPath: z.string().trim().min(1).max(2048),
    })
    .strict(),
  // Points a project of the computer that asks at another directory there, with all its sessions; what Claude
  // Code keeps of the project on the service goes along.
  z
    .object({
      type: z.literal('project.move'),
      ...request,
      from: z.string().trim().min(1).max(2048),
      to: z.string().trim().min(1).max(2048),
    })
    .strict(),
  z.object({ type: z.literal('session.compact'), ...request, sessionId: id }).strict(),
  // Copies a session under a new ID. With `beforeMessageId` the copy ends just before that user message,
  // which is how an earlier message is edited and sent again without losing the original. The copy is on the
  // computer that asks: `projectPath` is its directory there when that is not the one of the original.
  z
    .object({
      type: z.literal('session.fork'),
      ...request,
      sessionId: id,
      beforeMessageId: id.optional(),
      projectPath: z.string().trim().min(1).max(2048).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('session.status'),
      ...request,
      sessionId: id,
      // A manual refresh on the account page reads the plan quota anew.
      quota: z.boolean().optional(),
    })
    .strict(),
  z.object({ type: z.literal('quota.watch'), ...request, active: z.boolean() }).strict(),
  z
    .object({
      type: z.literal('terminal.open'),
      ...request,
      sessionId: id,
      // Sent by ccdt before 0.3.10, when a terminal could also be one apart from the session's conversation. Every
      // terminal continues it now, and what it adds is recorded in the session; the field is let through, unread.
      continueSession: z.boolean().optional(),
      cols: z.number().int().min(20).max(400),
      rows: z.number().int().min(5).max(160),
    })
    .strict(),
  z
    .object({ type: z.literal('terminal.close'), ...request, sessionId: id, terminalId: id })
    .strict(),
  z
    .object({
      type: z.literal('session.subscribe'),
      ...request,
      sessionId: id,
      afterSequence: z.number().int().nonnegative().default(0),
      afterCreatedAt: timestamp.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('session.history'),
      ...request,
      sessionId: id,
      beforeSequence: z.number().int().positive(),
      afterSequence: z.number().int().nonnegative().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('session.outline'),
      ...request,
      sessionId: id,
      // Re-read the last known turn's run and everything that followed it.
      afterSequence: z.number().int().nonnegative().default(0),
    })
    .strict(),
  z
    .object({
      type: z.literal('session.read'),
      ...request,
      sessionId: id,
      purpose: z.enum(['view', 'export']),
      direction: z.enum(['around', 'before', 'after']),
      sequence: z.number().int().nonnegative(),
      throughSequence: z.number().int().nonnegative().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('message.send'),
      ...request,
      sessionId: id,
      text: z.string().trim().max(16000),
      attachments: z.array(fileAttachmentSchema).optional(),
      scenario: scenarioSchema.default('chat'),
      scheduled: z.enum(['scheduled', 'manual']).optional(),
      priority: messagePrioritySchema.optional(),
    })
    .strict()
    .refine((value) => !value.scheduled || !value.priority, '定时任务不使用手动消息的发送方式')
    .refine((value) => {
      const length = messageText(value.text, value.attachments).length;
      return length > 0 && length <= 16000;
    }, '正文与文件路径合计须为 1–16000 字符')
    .refine((value) => {
      const references = (value.attachments ?? []).flatMap((file) =>
        file.reference ? [file.reference] : [],
      );
      return new Set(references).size === references.length;
    }, '附件引用编号不能重复'),
  z.object({ type: z.literal('run.cancel'), ...request, sessionId: id, runId: id }).strict(),
  // Takes up a session whose last turn was stopped or cut off, without the user writing a message.
  z.object({ type: z.literal('run.continue'), ...request, sessionId: id }).strict(),
  z
    .object({
      type: z.literal('run.task.stop'),
      ...request,
      sessionId: id,
      runId: id,
      taskId: z.string().min(1).max(200),
    })
    .strict(),
  // Sends the task a tool call waits on to the background: the call returns, and the turn goes on without it.
  z
    .object({
      type: z.literal('run.task.background'),
      ...request,
      sessionId: id,
      runId: id,
      toolId: z.string().min(1).max(200),
    })
    .strict(),
  z
    .object({
      type: z.literal('approval.reply'),
      ...request,
      sessionId: id,
      runId: id,
      approvalId: id,
      allowed: z.boolean(),
      executionMode: planExecutionModeSchema.optional(),
      // The answers to a question Claude asked, keyed by the question's text.
      answers: z.record(z.string().max(2000), z.string().max(4000)).optional(),
    })
    .strict(),
]);
export type Command = z.infer<typeof commandSchema>;
export const terminalControlSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('terminal.input'),
      sessionId: id,
      terminalId: id,
      data: z.string().min(1).max(8192),
    })
    .strict(),
  z
    .object({
      type: z.literal('terminal.resize'),
      sessionId: id,
      terminalId: id,
      cols: z.number().int().min(20).max(400),
      rows: z.number().int().min(5).max(160),
    })
    .strict(),
  z
    .object({
      type: z.literal('terminal.ack'),
      sessionId: id,
      terminalId: id,
      bytes: z.number().int().positive().max(MAX_FRAME_BYTES),
    })
    .strict(),
]);
export type TerminalControl = z.infer<typeof terminalControlSchema>;
export const authSchema = z
  .object({
    type: z.literal('auth'),
    // Any number is accepted here: a client of another version holding the right token is told how to upgrade.
    protocolVersion: z.number().int().positive(),
    token: z.string().min(24).max(512),
    deviceName: z.string().trim().min(1).max(120),
    // Older clients send this flag during version negotiation. It grants no capability.
    tunnel: z.boolean().optional(),
  })
  .strict();
// Which of the user's computers the connection is from, named by `auth.deviceName`. It follows `auth` as a
// frame of its own because the frame of `auth` has to stay what every version reads.
// The system is not the page's to say: the desktop's main process writes it into the frame on its way out.
export const deviceIdentitySchema = z
  .object({
    type: z.literal('device'),
    id,
    platform: devicePlatformSchema.optional(),
    files: z.literal(true).optional(),
    shells: z.array(deviceShellSchema).min(1).max(3).optional(),
  })
  .strict();
// The client is closing the connection on purpose. Without it a connection that ends is taken for a fault on
// the way, and what the device was running is kept for it to come back to.
export const leaveSchema = z.object({ type: z.literal('leave') }).strict();
// These controls only advance or discard a history owned by this authenticated connection.
export const historyControlSchema = z
  .object({
    type: z.enum(['session.history.next', 'session.history.cancel']),
    requestId: id,
  })
  .strict();
export const serverMessageSchema = z.discriminatedUnion('type', [
  projectCall,
  z
    .object({
      type: z.literal('approval.detail'),
      requestId: id,
      input: z.string().max(APPROVAL_PAGE_CHARS),
      next: z.number().int().positive().optional(),
      title: z.string().max(512).optional(),
      description: z.string().max(2048).optional(),
    })
    .strict(),
  z.object({ type: z.literal('project.cancel'), requestId: id }),
  sessionOutlineSchema,
  sessionReadSchema,
  z.object({
    type: z.literal('session.history.part'),
    requestId: id,
    sessionId: id,
    data: z
      .string()
      .min(1)
      .max(32 * 1024),
    last: z.boolean(),
  }),
  z.object({
    type: z.literal('web.settings.state'),
    requestId: id,
    values: webSettingsStateSchema,
  }),
  z.object({ type: z.literal('web.totp.setup'), requestId: id, ...webTotpSetupSchema.shape }),
  z.object({
    type: z.literal('web.certificate.state'),
    requestId: id,
    ...webCertificateStateSchema.shape,
  }),
  z.object({
    type: z.literal('ready'),
    protocolVersion: z.literal(PROTOCOL_VERSION),
    connectionId: id,
    adapter: z.enum(['simulation', 'claude-code']),
    model: z.string().optional(),
    // The service's own release version, and where it stands against the published releases if it follows them.
    version: versionSchema,
    update: serviceUpdateSchema.optional(),
    // The newest Windows installer the service holds, for clients that want to upgrade themselves.
    client: installerSchema.optional(),
    sessions: z.array(sessionSchema),
    historyId: id.optional(),
    browser: z.object({ sessionId: id, serverDeviceId: id, selfSigned: z.boolean() }).optional(),
  }),
  z.object({
    type: z.literal('response'),
    requestId: id,
    ok: z.boolean(),
    sessionId: id.optional(),
    code: z.string().optional(),
    message: z.string().optional(),
  }),
  z.object({ type: z.literal('session.snapshot'), ...historyPageSchema.shape }),
  z.object({ type: z.literal('session.updated'), session: sessionSchema }),
  z.object({ type: z.literal('session.deleted'), sessionId: id }),
  z.object({ type: z.literal('session.event'), event: eventSchema }),
  z.object({
    type: z.literal('session.fragment'),
    sessionId: id,
    runId: id,
    payload: eventPayloadSchema,
  }),
  z.object({ type: z.literal('account.state'), ...accountStateSchema.shape }),
  z.object({ type: z.literal('settings.state'), requestId: id, values: nativeSettingsSchema }),
  // Sent to every connection when it changes; the one that asked finds its request ID.
  z.object({
    type: z.literal('compaction.state'),
    requestId: id.optional(),
    values: idleCompactionSchema,
  }),
  z.object({
    type: z.literal('instructions.state'),
    requestId: id,
    text: z.string(),
    version: z.string(),
  }),
  z.object({ type: z.literal('usage.summary'), requestId: id, ...usageSummarySchema.shape }),
  z.object({ type: z.literal('usage.page'), requestId: id, ...usagePageSchema.shape }),
  // What a whole session has cost so far, summed from the model requests the call log holds for it.
  z.object({
    type: z.literal('session.stats'),
    requestId: id,
    sessionId: id,
    // Distinct prompts, which is how many turns the log has seen, and the model requests they made.
    turns: z.number().int().nonnegative(),
    requests: z.number().int().nonnegative(),
    inputTokens: z.number().nonnegative(),
    outputTokens: z.number().nonnegative(),
    cacheReadTokens: z.number().nonnegative(),
    cacheCreationTokens: z.number().nonnegative(),
    modelMs: z.number().nonnegative(),
    ttftMs: z.number().nonnegative().nullable(),
    outputPerSecond: z.number().nonnegative().nullable(),
    // The oldest record the call log holds at all. The log is pruned, so a session older than this is counted from here.
    firstRecordAt: timestamp.nullable(),
  }),
  z.object({ type: z.literal('terminal.opened'), sessionId: id, terminalId: id }),
  // The terminal is no longer shown here and goes on running: another connection shows it (`taken`), or this one
  // left its output unacknowledged for 30 s (`stalled`) and may open it again.
  z.object({
    type: z.literal('terminal.detached'),
    sessionId: id,
    terminalId: id,
    reason: z.enum(['taken', 'stalled']),
  }),
  z.object({
    type: z.literal('terminal.data'),
    sessionId: id,
    terminalId: id,
    data: z.string(),
    bytes: z.number().int().positive(),
  }),
  z.object({
    type: z.literal('terminal.closed'),
    sessionId: id,
    terminalId: id,
    exitCode: z.number().int().nullable(),
  }),
  // Every version must keep reading this frame: with code `version_mismatch` it is how a client of another
  // protocol version learns the service's version and the installer it may fetch.
  z.object({
    type: z.literal('connection.error'),
    code: z.string(),
    message: z.string(),
    service: versionSchema.optional(),
    // The installer of the service's version, while the service is still fetching it.
    preparing: z
      .object({
        version: versionSchema,
        received: z.number().int().nonnegative(),
        size: z.number().int().nonnegative(),
      })
      .optional(),
    client: installerSchema.optional(),
  }),
  z.object({ type: z.literal('service.update'), ...serviceUpdateSchema.shape }),
  // The user's computers connected now, each with whether commands reach it yet: sent on signing in and
  // whenever it changes. A computer not listed is away, and its sessions can only be read.
  z.object({
    type: z.literal('devices'),
    devices: z.array(
      deviceSchema.extend({
        ready: z.boolean(),
        server: z.literal(true).optional(),
        // The shells the computer runs scripts in, and the one its user prefers, if any; none for the service.
        shells: z.array(deviceShellSchema).optional(),
        shell: deviceShellSchema.optional(),
      }),
    ),
  }),
]);
export type ServerMessage = z.infer<typeof serverMessageSchema>;
