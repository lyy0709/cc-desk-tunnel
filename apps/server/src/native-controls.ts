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
type UsageReading = Awaited<
  ReturnType<Query['usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET']>
>;
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

// A public SDK rate-limit event describes the named window. Other windows are read through the SDK usage query.
export function observedQuota(
  event: SDKRateLimitEvent,
  previous: ObservedQuota | null,
  now = Date.now(),
): ObservedQuota | null {
  const { rateLimitType, utilization, resetsAt } = event.rate_limit_info;
  if (
    !rateLimitType ||
    rateLimitType === 'overage' ||
    utilization === undefined ||
    !Number.isFinite(utilization)
  )
    return null;
  return merged(
    [
      {
        name: rateLimitType,
        utilization: Math.max(0, utilization * 100),
        resetsAt: resetsAt ? new Date(resetsAt * 1000).toISOString() : null,
      },
    ],
    previous,
    now,
  );
}

// A window a reading leaves out keeps its last reading until it resets (see `unexpired`).
function merged(windows: Windows, previous: ObservedQuota | null, now: number) {
  if (!windows.length) return null;
  const kept = (previous?.windows ?? []).filter(
    (window) => !windows.some((row) => row.name === window.name),
  );
  return { windows: [...kept, ...windows], measuredAt: new Date(now).toISOString() };
}

// The quota last seen in the message stream, kept by the login it came under (see `loginOf`). A project whose
// settings sign in otherwise (an API key, another token) keeps apart, and a run still going under a login since
// replaced writes to its own, not to the new one's.
export class ObservedQuotas {
  private readings = new Map<string, { reading: ObservedQuota; times: Map<string, number> }>();
  of(login: string, after?: number): ObservedQuota | null {
    const held = this.readings.get(login);
    if (!held) return null;
    if (after === undefined) return held.reading;
    const windows = held.reading.windows.filter((window) => held.times.get(window.name)! > after);
    return windows.length ? { ...held.reading, windows } : null;
  }
  observe(login: string, event: SDKRateLimitEvent, now = Date.now()) {
    const reading = observedQuota(event, this.of(login), now);
    const name = event.rate_limit_info.rateLimitType;
    if (reading && name) {
      const times = new Map(this.readings.get(login)?.times);
      times.set(name, now);
      this.readings.set(login, { reading, times });
    }
  }
}

// A reading stops describing the current window once its reset time passes. Without a reset it cannot be dated.
export function unexpired(observed: ObservedQuota | null, now = Date.now()): ObservedQuota | null {
  const windows = (observed?.windows ?? []).filter(
    (window) => window.resetsAt !== null && Date.parse(window.resetsAt) > now,
  );
  return windows.length ? { ...observed!, windows } : null;
}

// The CLI's structured /usage answer includes windows not carried in every response, such as per-model limits.
function planQuota(usage: UsageReading, measuredAt: string): NonNullable<Metrics['rateLimits']> {
  const windows = usage.rate_limits
    ? Object.entries(usage.rate_limits).flatMap(([name, value]) => {
        if (!value || name === 'extra_usage') return [];
        if (name === 'model_scoped' && Array.isArray(value))
          return value.map((item) => ({
            name: `seven_day:${item.display_name}`,
            utilization: item.utilization,
            resetsAt: item.resets_at,
          }));
        if (!Array.isArray(value) && 'utilization' in value && 'resets_at' in value)
          return [{ name, utilization: value.utilization, resetsAt: value.resets_at }];
        return [];
      })
    : [];
  return { available: usage.rate_limits_available, windows, measuredAt };
}

export type QuotaAnswer = {
  rateLimits: Metrics['rateLimits'];
  error?: string;
  usage?: UsageReading;
};

// Every session and device shares one account reading. Replies update it for free; while a client wants active
// reads, the SDK's experimental /usage query fills the gaps at most once a minute. A manual refresh reads anew.
export class Quotas {
  wanted: () => boolean = () => true;
  private readonly interval: number;
  private observed = new ObservedQuotas();
  private limits = new Map<string, SDKRateLimitEvent['rate_limit_info']>();
  private reads = new Map<
    string,
    { at: number; rateLimits: Metrics['rateLimits']; pending?: Promise<unknown> }
  >();
  constructor(interval = 60_000) {
    this.interval = interval;
  }
  clear() {
    this.observed = new ObservedQuotas();
    this.limits.clear();
    this.reads.clear();
  }
  observe(login: string, event: SDKRateLimitEvent, now = Date.now()) {
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
  async through(
    login: string,
    query: Query,
    { asked = false, timeoutMs = 5000, now = Date.now() } = {},
  ): Promise<QuotaAnswer> {
    const held = this.reads.get(login);
    if (held?.pending) await held.pending;
    else if (asked || (this.wanted() && (!held || now - held.at >= this.interval))) {
      const measuredAt = new Date(now).toISOString();
      const entry: { at: number; rateLimits: Metrics['rateLimits']; pending?: Promise<unknown> } = {
        at: now,
        rateLimits: held?.rateLimits ?? null,
      };
      this.reads.set(login, entry);
      const pending = optionalStatus(
        () =>
          query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true }),
        timeoutMs,
      );
      entry.pending = pending;
      const { value, error } = await pending;
      entry.pending = undefined;
      // Failed reads keep the last reading and its original timestamp.
      if (value) entry.rateLimits = planQuota(value, measuredAt);
      return { rateLimits: this.of(login, now), error, ...(value ? { usage: value } : {}) };
    }
    return { rateLimits: this.of(login, now) };
  }
  of(login: string, now = Date.now()): Metrics['rateLimits'] {
    const held = this.reads.get(login)?.rateLimits ?? null;
    const read = held?.available
      ? {
          ...held,
          windows: held.windows.filter(
            (window) => !window.resetsAt || Date.parse(window.resetsAt) > now,
          ),
        }
      : held;
    // A single-window event must not promote older observations of the other windows over a newer query.
    const observed = unexpired(
      this.observed.of(login, read?.available ? Date.parse(read.measuredAt!) : undefined),
      now,
    );
    if (!observed) return read?.available && !read.windows.length ? null : read;
    if (!read?.available) return { available: true, ...observed };
    if (observed.measuredAt <= read.measuredAt!) return read;
    const carried = new Map(observed.windows.map((window) => [window.name, window]));
    return {
      available: true,
      windows: [
        ...read.windows.map((window) => carried.get(window.name) ?? window),
        ...observed.windows.filter(
          (window) => !read.windows.some((row) => row.name === window.name),
        ),
      ],
      measuredAt: observed.measuredAt,
    };
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

export async function optionalStatus<T>(
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

// Only the CLI that was queried may use its /usage session totals; other sessions keep their own last result.
export async function nativeMetrics(
  query: Query,
  result?: SDKResultMessage,
  {
    timeoutMs = 5000,
    quota = (query) => new Quotas().through('', query, { asked: true, timeoutMs }),
    previous = null,
  }: {
    timeoutMs?: number;
    quota?: (query: Query) => Promise<QuotaAnswer>;
    previous?: Metrics['usage'];
  } = {},
): Promise<EventPayload> {
  const [contextStatus, answer] = await Promise.all([
    optionalStatus(() => query.getContextUsage({ detail: 'summary' }), timeoutMs),
    quota(query),
  ]);
  const totals =
    result ??
    (answer.usage?.session
      ? ({
          total_cost_usd: answer.usage.session.total_cost_usd,
          modelUsage: answer.usage.session.model_usage,
        } as SDKResultMessage)
      : undefined);
  return eventPayloadSchema.parse({
    type: 'native.metrics',
    context: contextSummary(contextStatus.value),
    usage: totals ? resultUsage(totals) : previous,
    rateLimits: answer.rateLimits,
    ...(contextStatus.error || answer.error
      ? { errors: { context: contextStatus.error, usage: answer.error } }
      : {}),
  });
}
