import type {
  AccountInfo,
  ModelInfo,
  Query,
  SDKRateLimitEvent,
  SDKResultMessage,
  SlashCommand,
} from '@anthropic-ai/claude-agent-sdk';
import { eventPayloadSchema } from '@cc-desk-tunnel/protocol';
import type {
  EventPayload,
  NativeCapabilities,
  NativeMetrics as Metrics,
} from '@cc-desk-tunnel/protocol';

type ContextUsage = Awaited<ReturnType<Query['getContextUsage']>>;
type Windows = NonNullable<Metrics['rateLimits']>['windows'];
export type ObservedQuota = { windows: Windows; measuredAt: string };

// Who the CLI is signed in as. A reading seen under one login says nothing about another.
export function loginOf(account: NativeCapabilities['account']) {
  const { apiProvider, tokenSource, apiKeySource, email, organization, subscriptionType } = account;
  return JSON.stringify([
    apiProvider,
    tokenSource,
    apiKeySource,
    email,
    organization,
    subscriptionType,
  ]);
}

// Quota comes only from the public event fields, in fractions and Unix seconds.
export function observedQuota(
  event: SDKRateLimitEvent,
  previous: ObservedQuota | null,
  now = Date.now(),
): ObservedQuota | null {
  const info = event.rate_limit_info;
  const windows =
    info.rateLimitType && info.rateLimitType !== 'overage' && Number.isFinite(info.utilization)
      ? [
          {
            name: info.rateLimitType,
            utilization: Math.max(0, info.utilization! * 100),
            resetsAt: info.resetsAt ? new Date(info.resetsAt * 1000).toISOString() : null,
          },
        ]
      : [];
  return merged(windows, previous, now);
}

// A window a reading leaves out keeps its last reading until it resets (see `unexpired`).
function merged(windows: Windows, previous: ObservedQuota | null, now: number) {
  if (!windows.length) return null;
  const kept = (previous?.windows ?? []).filter(
    (window) => !windows.some((row) => row.name === window.name),
  );
  return { windows: [...kept, ...windows], measuredAt: new Date(now).toISOString() };
}

// The quota the CLI hands its status line (`rate_limits`, CLI 2.1.293), from the same replies as `rate_limit_event`:
// the session and weekly windows, in percent, with resets in Unix seconds; one without a reset could not be told from
// one that has passed (see `unexpired`). A terminal has no message stream to carry the event, so this is how its
// replies' quota is heard (see `terminalSettings`).
export function statusLineQuota(status: unknown): Windows {
  const limits = (status as { rate_limits?: Record<string, unknown> } | null)?.rate_limits;
  return ['five_hour', 'seven_day'].flatMap((name) => {
    const window = limits?.[name] as { used_percentage?: unknown; resets_at?: unknown } | undefined;
    return typeof window?.used_percentage === 'number' &&
      Number.isFinite(window.used_percentage) &&
      typeof window.resets_at === 'number'
      ? [
          {
            name,
            utilization: Math.max(0, window.used_percentage),
            resetsAt: new Date(window.resets_at * 1000).toISOString(),
          },
        ]
      : [];
  });
}

// The quota last seen in the message stream, kept by the login it came under (see `loginOf`). A project whose
// settings sign in otherwise (an API key, another token) keeps apart, and a run still going under a login since
// replaced writes to its own, not to the new one's.
export class ObservedQuotas {
  private readings = new Map<string, ObservedQuota>();
  of(login: string) {
    return this.readings.get(login) ?? null;
  }
  observe(login: string, event: SDKRateLimitEvent, now = Date.now()) {
    const reading = observedQuota(event, this.of(login), now);
    if (reading) this.readings.set(login, reading);
  }
  observeWindows(login: string, windows: Windows, now = Date.now()) {
    const reading = merged(windows, this.of(login), now);
    if (reading) this.readings.set(login, reading);
  }
  // What was heard before the login was known becomes that login's, unless it has its own.
  adopt(from: string, to: string) {
    const reading = this.readings.get(from);
    this.readings.delete(from);
    if (reading && !this.readings.has(to)) this.readings.set(to, reading);
  }
}

// A reading stops describing the current window once its reset time passes. Without a reset it cannot be dated.
export function unexpired(observed: ObservedQuota | null, now = Date.now()): ObservedQuota | null {
  const windows = (observed?.windows ?? []).filter(
    (window) => window.resetsAt !== null && Date.parse(window.resetsAt) > now,
  );
  return windows.length ? { ...observed!, windows } : null;
}

// One account's observations are shared across its sessions. No account endpoint is polled.
export class Quotas {
  private observed = new ObservedQuotas();
  private limits = new Map<string, SDKRateLimitEvent['rate_limit_info']>();
  private login?: string;
  // Setup tokens need not expose an account identity, so replacing one can keep the same login key.
  clear() {
    this.observed = new ObservedQuotas();
    this.limits.clear();
    this.login = undefined;
  }
  identify(login: string) {
    if (this.login === undefined) this.observed.adopt('', login);
    this.login = login;
  }
  observe(login: string, event: SDKRateLimitEvent, now = Date.now()) {
    this.identify(login);
    this.limits.set(login, event.rate_limit_info);
    this.observed.observe(login, event, now);
  }
  // Automatic work must wait for a known rejection or an exhausted account-wide window. A rejection can omit
  // utilization entirely; without a reset time there is no time at which to schedule it safely.
  blockedUntil(login: string, previous: Metrics['rateLimits'], now = Date.now()): number | null {
    const limit = this.limits.get(login);
    let until: number | null = null;
    if (limit?.status === 'rejected') {
      const reset =
        limit.rateLimitType === 'overage'
          ? (limit.overageResetsAt ?? limit.resetsAt)
          : limit.resetsAt;
      if (reset === undefined) return Infinity;
      if (reset * 1000 > now) until = reset * 1000;
    } else if (limit?.isUsingOverage || limit?.overageInUse) {
      // A full subscription window is not a rejection when native requests are using extra usage.
      return null;
    }
    const reading = this.of(login, now) ?? previous;
    if (reading?.available)
      for (const window of reading.windows) {
        if (!['five_hour', 'seven_day'].includes(window.name) || (window.utilization ?? 0) < 100)
          continue;
        const reset = window.resetsAt === null ? NaN : Date.parse(window.resetsAt);
        if (!Number.isFinite(reset)) return Infinity;
        if (reset > now) until = Math.max(until ?? 0, reset);
      }
    return until;
  }
  // The windows a terminal's status line showed (see `statusLineQuota`), and the quota as it now stands.
  observeTerminal(windows: Windows, now = Date.now()) {
    const login = this.login ?? '';
    this.observed.observeWindows(login, windows, now);
    return this.of(login, now);
  }
  of(login: string, now = Date.now()): Metrics['rateLimits'] {
    const observed = unexpired(this.observed.of(login), now);
    return observed ? { available: true, ...observed } : null;
  }
}

export function nativeCapabilities(
  models: ModelInfo[],
  account: AccountInfo,
  commands: SlashCommand[],
  configuredModel?: string,
  // Commands whose use is bound to the CLI's own terminal, as the CLI names them.
  terminal: string[] = [],
): EventPayload {
  const usable = commands.filter((command) => !terminal.includes(command.name));
  const catalog: NativeCapabilities['models'] = models.map((model) => ({
    value: model.value,
    resolvedModel: model.resolvedModel,
    displayName: model.displayName,
    description: model.description,
    source: 'native',
    supportedEffortLevels: model.supportedEffortLevels ?? [],
  }));
  if (
    configuredModel &&
    !catalog.some(
      (model) =>
        model.value === configuredModel ||
        models.find((row) => row.value === model.value)?.resolvedModel === configuredModel,
    )
  )
    catalog.unshift({
      value: configuredModel,
      displayName: configuredModel,
      description: '',
      source: 'configured',
      supportedEffortLevels: [],
    });
  // Send named public identity fields only; no credentials or arbitrary initialization payload.
  return eventPayloadSchema.parse({
    type: 'native.capabilities',
    models: catalog,
    commands: usable.map((command) => command.name),
    commandDetails: usable.map(({ name, description, argumentHint, aliases }) => ({
      name,
      description: description ?? '',
      argumentHint: argumentHint ?? '',
      ...(aliases?.length ? { aliases } : {}),
    })),
    account: {
      email: account.email,
      organization: account.organization,
      subscriptionType: account.subscriptionType,
      apiProvider: account.apiProvider,
      apiKeySource: account.apiKeySource,
      tokenSource: account.tokenSource,
    },
  });
}

export function resultUsage(result: SDKResultMessage): Metrics['usage'] {
  if (!result.modelUsage) return null;
  const values = Object.values(result.modelUsage);
  return {
    costUsd: Number.isFinite(result.total_cost_usd) ? result.total_cost_usd : null,
    inputTokens: values.reduce((sum, value) => sum + value.inputTokens, 0),
    outputTokens: values.reduce((sum, value) => sum + value.outputTokens, 0),
    cacheReadTokens: values.reduce((sum, value) => sum + value.cacheReadInputTokens, 0),
    cacheWriteTokens: values.reduce((sum, value) => sum + value.cacheCreationInputTokens, 0),
    ...lifetimes(values),
    measuredAt: new Date().toISOString(),
  };
}
// The cache writes by lifetime, from a CLI that counts them so.
function lifetimes(values: NonNullable<SDKResultMessage['modelUsage']>[string][]) {
  if (!values.some((value) => value.cacheCreationEphemeral1hInputTokens !== undefined)) return {};
  const sum = (
    key: 'cacheCreationEphemeral1hInputTokens' | 'cacheCreationEphemeral5mInputTokens',
  ) => values.reduce((total, value) => total + (value[key] ?? 0), 0);
  return {
    cacheWrite1hTokens: sum('cacheCreationEphemeral1hInputTokens'),
    cacheWrite5mTokens: sum('cacheCreationEphemeral5mInputTokens'),
  };
}

async function optionalStatus<T>(
  read: () => Promise<T>,
  timeoutMs: number,
): Promise<{ value: T | null; error?: string }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve()
        .then(read)
        .then(
          (value) => ({ value }),
          () => ({ value: null, error: '原生接口读取失败' }),
        ),
      new Promise<{ value: null; error: string }>((resolve) => {
        timer = setTimeout(() => resolve({ value: null, error: '原生接口读取超时' }), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function contextSummary(context: ContextUsage | null): Metrics['context'] {
  return context && context.rawMaxTokens > 0
    ? {
        model: context.model,
        usedTokens: context.totalTokens,
        windowTokens: context.rawMaxTokens,
        percentage: context.percentage,
        measuredAt: new Date().toISOString(),
        categories: context.categories.map(({ id, name, tokens, kind }) => ({
          ...(id && { id }),
          name,
          tokens,
          kind,
        })),
      }
    : null;
}

// Context is a native summary; usage totals come from results, while refresh keeps the last totals.
export async function nativeMetrics(
  query: Query,
  result?: SDKResultMessage,
  {
    timeoutMs = 5000,
    rateLimits = null,
    previous = null,
  }: {
    timeoutMs?: number;
    rateLimits?: Metrics['rateLimits'];
    previous?: Metrics['usage'];
  } = {},
): Promise<EventPayload> {
  const contextStatus = await optionalStatus(
    () => query.getContextUsage({ detail: 'summary' }),
    timeoutMs,
  );
  return eventPayloadSchema.parse({
    type: 'native.metrics',
    context: contextSummary(contextStatus.value),
    usage: result ? resultUsage(result) : previous,
    rateLimits,
    ...(contextStatus.error ? { errors: { context: contextStatus.error } } : {}),
  });
}
