import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Query, SDKResultMessage, SDKRateLimitEvent } from '@anthropic-ai/claude-agent-sdk';
import {
  nativeCapabilities,
  nativeMetrics,
  loginOf,
  observedQuota,
  ObservedQuotas,
  Quotas,
  unexpired,
  resultUsage,
} from '../src/native-controls.ts';

test('native model and account mapping preserves capability boundaries and does not pass through secrets', () => {
  const capabilities = nativeCapabilities(
    [
      {
        value: 'sonnet',
        displayName: 'Sonnet',
        description: 'native',
        supportsEffort: true,
        supportedEffortLevels: ['low', 'high'],
      },
    ],
    {
      email: 'test@example.invalid',
      apiProvider: 'firstParty',
      apiKeySource: 'environment',
      secret: 'must-not-leave-sdk',
    } as never,
    [
      { name: 'compact', description: 'Compact', argumentHint: '' },
      { name: 'context', description: 'Context', argumentHint: '' },
    ],
    'deepseek-chat',
  );
  assert.ok(capabilities.type === 'native.capabilities');
  assert.equal(capabilities.models[0].source, 'configured');
  assert.deepEqual(capabilities.models[0].supportedEffortLevels, []);
  assert.deepEqual(capabilities.models[1].supportedEffortLevels, ['low', 'high']);
  assert.equal(JSON.stringify(capabilities).includes('must-not-leave-sdk'), false);
});

test('commands go with what they do and take, without those bound to the CLI terminal', () => {
  const event = nativeCapabilities(
    [],
    {},
    [
      { name: 'review', description: 'Review a pull request', argumentHint: '<pr>' },
      { name: 'usage', description: 'Show usage', argumentHint: '', aliases: ['cost', 'stats'] },
      { name: 'statusline', description: 'Set up the status line', argumentHint: '' },
    ],
    undefined,
    ['statusline'],
  );
  assert.ok(event.type === 'native.capabilities');
  assert.deepEqual(event.commands, ['review', 'usage']);
  assert.deepEqual(event.commandDetails, [
    { name: 'review', description: 'Review a pull request', argumentHint: '<pr>' },
    { name: 'usage', description: 'Show usage', argumentHint: '', aliases: ['cost', 'stats'] },
  ]);
});

test('context comes from the native summary and is distinct from cumulative usage totals', async () => {
  let detail: unknown, skip: unknown;
  const query = {
    async getContextUsage(options: unknown) {
      detail = options;
      return {
        model: 'test',
        totalTokens: 2500,
        rawMaxTokens: 10000,
        percentage: 25,
        categories: [{ id: 'messages', name: 'Messages', tokens: 2500, kind: 'used' }],
      };
    },
    async usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET(options: unknown) {
      skip = options;
      return { rate_limits_available: false, rate_limits: null };
    },
  } as unknown as Query;
  const result = {
    total_cost_usd: 0.5,
    modelUsage: {
      test: {
        inputTokens: 100000,
        outputTokens: 500,
        cacheReadInputTokens: 1000,
        cacheCreationInputTokens: 500,
        cacheCreationEphemeral1hInputTokens: 400,
        cacheCreationEphemeral5mInputTokens: 50,
      },
    },
  } as unknown as SDKResultMessage;
  const metrics = await nativeMetrics(query, result);
  assert.ok(metrics.type === 'native.metrics');
  assert.equal(metrics.context?.usedTokens, 2500);
  assert.deepEqual(metrics.context?.categories, [
    { id: 'messages', name: 'Messages', tokens: 2500, kind: 'used' },
  ]);
  assert.equal(metrics.usage?.cacheWrite1hTokens, 400);
  assert.equal(metrics.usage?.cacheWrite5mTokens, 50);
  assert.equal(metrics.context?.percentage, 25);
  assert.equal(metrics.usage?.inputTokens, 100000);
  assert.equal(metrics.usage?.costUsd, 0.5);
  assert.deepEqual(detail, { detail: 'summary' });
  assert.deepEqual(skip, { skipBehaviors: true });
  assert.equal(metrics.rateLimits?.available, false);
});

test('unavailable native telemetry stays unavailable rather than fabricating quotas or context', async () => {
  const query = {
    async getContextUsage() {
      throw new Error('unsupported');
    },
    async usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET() {
      throw new Error('unavailable');
    },
  } as unknown as Query;
  const metrics = await nativeMetrics(query);
  assert.deepEqual(metrics, {
    type: 'native.metrics',
    context: null,
    usage: null,
    rateLimits: null,
    errors: { context: '原生接口读取失败', usage: '原生接口读取失败' },
  });
  assert.equal(resultUsage({} as SDKResultMessage), null);
});

test('optional native telemetry has a bounded wait and cannot hold a completed turn indefinitely', async () => {
  const query = {
    getContextUsage() {
      return new Promise(() => {});
    },
    async usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET() {
      return { rate_limits_available: false, rate_limits: null };
    },
  } as unknown as Query;
  const metrics = await nativeMetrics(query, undefined, { timeoutMs: 10 });
  assert.ok(metrics.type === 'native.metrics');
  assert.equal(metrics.context, null);
  assert.equal(metrics.rateLimits?.available, false);
  assert.equal(metrics.errors?.context, '原生接口读取超时');
});

test('refresh preserves its own result totals when the shared quota reading has no session totals', async () => {
  const calls: string[] = [];
  const query = new Proxy(
    {},
    {
      get(_target, name) {
        calls.push(String(name));
        assert.equal(name, 'getContextUsage');
        return async () => null;
      },
    },
  ) as Query;
  const previous = {
    costUsd: 9,
    inputTokens: 1,
    outputTokens: 2,
    cacheReadTokens: 3,
    cacheWriteTokens: 4,
    measuredAt: '2026-10-03T00:00:00Z',
  };
  const rateLimits = {
    available: true,
    windows: [{ name: 'five_hour', utilization: 7, resetsAt: '2026-10-03T02:00:00Z' }],
    measuredAt: '2026-10-03T01:00:00Z',
  };
  const metrics = await nativeMetrics(query, undefined, {
    previous,
    quota: async () => ({ rateLimits }),
  });
  assert.ok(metrics.type === 'native.metrics');
  assert.deepEqual(metrics.usage, previous);
  assert.deepEqual(metrics.rateLimits, rateLimits);
  assert.deepEqual(calls, ['getContextUsage']);
});

test('native additive quota arrays cannot hide all account and context metrics', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-01T00:00:00Z') });
  const query = {
    async getContextUsage() {
      return {
        model: 'opus',
        totalTokens: 1000,
        rawMaxTokens: 1000000,
        percentage: 0.1,
        categories: [],
      };
    },
    async usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET() {
      return {
        rate_limits_available: true,
        session: {
          total_cost_usd: 0.3,
          model_usage: {
            opus: {
              inputTokens: 100,
              outputTokens: 20,
              cacheReadInputTokens: 30,
              cacheCreationInputTokens: 40,
            },
          },
        },
        rate_limits: {
          five_hour: { utilization: 3, resets_at: '2026-10-03T02:00:00Z' },
          seven_day: { utilization: 0, resets_at: '2026-10-10T02:00:00Z' },
          limits: [{ type: 'five_hour', status: 'allowed', utilization: 0.03 }],
          spend: { balance: 0 },
          future: [1, 2, 3],
        },
      };
    },
  } as unknown as Query;
  const metrics = await nativeMetrics(query);
  assert.ok(metrics.type === 'native.metrics');
  assert.equal(metrics.context?.windowTokens, 1000000);
  assert.equal(metrics.usage?.inputTokens, 100);
  assert.equal(metrics.rateLimits?.windows.length, 2);
  assert.equal(metrics.rateLimits?.windows[0].utilization, 3);
});

test('the service reads the quota once a minute for every run under a login, and only while it is wanted', async () => {
  let reads = 0,
    spent = 0;
  let answer = () => {};
  const query = {
    async getContextUsage() {
      throw new Error('unsupported');
    },
    async usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET() {
      reads++;
      await new Promise<void>((resolve) => (answer = resolve));
      return {
        rate_limits_available: true,
        rate_limits: { five_hour: { utilization: 24, resets_at: '2026-10-05T20:20:00Z' } },
        session: { total_cost_usd: ++spent, model_usage: {} },
      };
    },
  } as unknown as Query;
  // The CLI is asked a moment after the read starts.
  const settle = async () => {
    await new Promise((resolve) => setImmediate(resolve));
    answer();
  };
  const quotas = new Quotas(60_000);
  const first = quotas.through('a', query, { now: 0 });
  const joined = quotas.through('a', query, { now: 10, asked: true });
  await settle();
  assert.equal((await first).usage?.session?.total_cost_usd, 1);
  assert.equal((await joined).usage, undefined, 'a read under way is waited for, not repeated');
  assert.equal((await joined).rateLimits?.windows[0]?.utilization, 24);
  assert.equal((await quotas.through('a', query, { now: 30_000 })).usage, undefined);
  assert.equal(reads, 1, 'one read a minute serves every run');
  const other = quotas.through('b', query, { now: 30_000 });
  await settle();
  await other;
  assert.equal(reads, 2, 'another login has its own');
  quotas.wanted = () => false;
  assert.equal((await quotas.through('a', query, { now: 120_000 })).usage, undefined);
  assert.equal(reads, 2, 'no client wants it kept current');
  const asked = quotas.through('a', query, { now: 120_000, asked: true });
  await settle();
  assert.ok((await asked).usage, 'the user asked');
  assert.equal(reads, 3);
  // Totals come only with this CLI's own answer; otherwise the session keeps those it had.
  const previous = {
    costUsd: 9,
    inputTokens: 1,
    outputTokens: 1,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    measuredAt: '2026-10-03T00:00:00Z',
  };
  const kept = await nativeMetrics(query, undefined, {
    quota: (query) => quotas.through('a', query, { now: 130_000 }),
    previous,
  });
  assert.ok(kept.type === 'native.metrics');
  assert.deepEqual(kept.usage, previous);
  assert.equal(kept.rateLimits?.windows[0]?.utilization, 24);
});

test('native quota windows retain reset times and per-model rows without exposing spend credentials', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-01T00:00:00Z') });
  const query = {
    async getContextUsage() {
      return null;
    },
    async usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET() {
      return {
        rate_limits_available: true,
        rate_limits: {
          five_hour: { utilization: 37, resets_at: '2026-10-02T15:00:00Z' },
          seven_day: { utilization: 12, resets_at: '2026-10-09T15:00:00Z' },
          model_scoped: [
            { display_name: 'Fable', utilization: 41, resets_at: '2026-10-09T15:00:00Z' },
            { display_name: 'Test model', utilization: null, resets_at: null },
          ],
          extra_usage: { is_enabled: true, used_credits: 1234 },
        },
      };
    },
  } as unknown as Query;
  const metrics = await nativeMetrics(query);
  assert.ok(metrics.type === 'native.metrics');
  assert.deepEqual(metrics.rateLimits?.windows, [
    { name: 'five_hour', utilization: 37, resetsAt: '2026-10-02T15:00:00Z' },
    { name: 'seven_day', utilization: 12, resetsAt: '2026-10-09T15:00:00Z' },
    { name: 'seven_day:Fable', utilization: 41, resetsAt: '2026-10-09T15:00:00Z' },
    { name: 'seven_day:Test model', utilization: null, resetsAt: null },
  ]);
});

test('what the replies carry stands in where the quota is not read or does not apply', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-01T00:00:00Z') });
  const query = (available: boolean) =>
    ({
      async getContextUsage() {
        throw new Error('unsupported');
      },
      async usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET() {
        return {
          rate_limits_available: available,
          rate_limits: available
            ? { five_hour: { utilization: 7, resets_at: '2026-10-03T02:00:00Z' } }
            : null,
        };
      },
    }) as unknown as Query;
  const now = Date.now();
  const later = Math.floor(now / 1000) + 3600;
  const event = (utilization: number, resetsAt = later) =>
    rateLimitEvent({ status: 'allowed', rateLimitType: 'five_hour', utilization, resetsAt });
  // Not read: only what the replies carried, or nothing.
  const passive = new Quotas();
  passive.wanted = () => false;
  assert.equal((await passive.through('a', query(true), { now })).rateLimits, null);
  passive.observe('a', event(0.02), now);
  const carried = (await passive.through('a', query(true), { now })).rateLimits;
  assert.deepEqual(carried?.windows, [
    { name: 'five_hour', utilization: 2, resetsAt: new Date(later * 1000).toISOString() },
  ]);
  // The CLI says the plan quota does not apply, as with a long-lived token: the replies stand in.
  const token = new Quotas();
  token.observe('a', event(0.02), now);
  assert.equal((await token.through('a', query(false), { now })).rateLimits?.available, true);
  // A new setup token may have the same public identity. Its old readings must not survive an account change.
  token.clear();
  assert.equal(token.of('a', now), null);
  assert.equal((await token.through('a', query(false), { now })).rateLimits?.available, false);
  // A reading whose windows have all reset leaves the native answer as it is.
  const stale = new Quotas();
  stale.observe('a', event(0.9, later - 7200), now);
  assert.equal((await stale.through('a', query(false), { now })).rateLimits?.available, false);
  // The replies since a read replace its windows at once; the rows only a read gives stay.
  const read = new Quotas();
  read.observe('a', event(0.02), now - 1000);
  const withModels = {
    ...query(true),
    async usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET() {
      return {
        rate_limits_available: true,
        rate_limits: {
          five_hour: { utilization: 7, resets_at: '2026-10-03T02:00:00Z' },
          model_scoped: [{ display_name: 'Fable', utilization: 3, resets_at: null }],
        },
      };
    },
  } as unknown as Query;
  assert.deepEqual(
    (await read.through('a', withModels, { now })).rateLimits?.windows.map(
      (window) => window.utilization,
    ),
    [7, 3],
    'replies older than the read do not replace it',
  );
  read.observe('a', event(0.5), now + 1000);
  assert.deepEqual(
    read.of('a', now + 1000)?.windows.map((window) => [window.name, window.utilization]),
    [
      ['five_hour', 50],
      ['seven_day:Fable', 3],
    ],
  );
  assert.equal(read.of('a', now + 1000)?.measuredAt, new Date(now + 1000).toISOString());
});

test('partial observations never promote older windows over a newer query, including while it is pending', async () => {
  for (const duringRead of [false, true]) {
    const quotas = new Quotas();
    quotas.observe('a', daily, 0);
    quotas.observe('a', weekly, 0);
    let release;
    const query = {
      usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: () =>
        new Promise((resolve) => {
          release = () =>
            resolve({
              rate_limits_available: true,
              rate_limits: {
                five_hour: { utilization: 37, resets_at: '2026-10-25T15:30:00Z' },
                seven_day: { utilization: 50, resets_at: '2026-10-30T02:00:00Z' },
              },
            });
        }),
    } as unknown as Query;
    const reading = quotas.through('a', query, { now: 1000 });
    await new Promise((resolve) => setImmediate(resolve));
    if (!duringRead) {
      release!();
      await reading;
    }
    quotas.observe('a', rateLimitEvent({ ...weekly.rate_limit_info, utilization: 0.51 }), 2000);
    if (duringRead) {
      release!();
      await reading;
    }
    assert.deepEqual(
      quotas.of('a', 2000)?.windows.map(({ name, utilization }) => [name, utilization]),
      [
        ['five_hour', 37],
        ['seven_day', 51],
      ],
    );
    assert.equal(quotas.of('a', 2000)?.measuredAt, new Date(2000).toISOString());
  }
});

test('failed quota reads keep their timestamp, expire on reset and clear with the account', async () => {
  let failure: 'error' | 'timeout' | null = null;
  const query = {
    async usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET() {
      if (failure === 'error') throw new Error('unavailable');
      if (failure === 'timeout') return new Promise(() => {});
      return {
        rate_limits_available: true,
        rate_limits: { five_hour: { utilization: 37, resets_at: new Date(10000).toISOString() } },
      };
    },
  } as unknown as Query;
  const quotas = new Quotas();
  const first = await quotas.through('a', query, { now: 0 });
  failure = 'error';
  const failed = await quotas.through('a', query, { now: 1000, asked: true });
  assert.equal(failed.error, '原生接口读取失败');
  assert.deepEqual(failed.rateLimits, first.rateLimits);
  failure = 'timeout';
  const timedOut = await quotas.through('a', query, { now: 2000, asked: true, timeoutMs: 10 });
  assert.equal(timedOut.error, '原生接口读取超时');
  assert.deepEqual(timedOut.rateLimits, first.rateLimits);
  assert.equal(quotas.of('a', 10000), null);
  quotas.clear();
  assert.equal(quotas.of('a', 0), null);
});

test('a resolved native model remains native instead of appearing as provider configuration', () => {
  const event = nativeCapabilities(
    [
      {
        value: 'opus',
        resolvedModel: 'claude-opus-5-5',
        displayName: 'Opus',
        description: 'native',
        supportsEffort: true,
        supportedEffortLevels: ['low', 'high', 'xhigh'],
      },
    ],
    {},
    [],
    'claude-opus-5-5',
  );
  assert.ok(event.type === 'native.capabilities');
  assert.equal(event.models.length, 1);
  assert.equal(event.models[0].source, 'native');
  assert.equal(event.models[0].resolvedModel, 'claude-opus-5-5');
});

test('new models and their effort levels pass through the native catalog without a host allowlist', () => {
  const models = [
    {
      value: 'haiku',
      resolvedModel: 'claude-haiku-5-5',
      displayName: 'Haiku',
      description: 'native',
      supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] as const,
    },
    { value: 'future-native-model', displayName: 'New model', description: 'native' },
  ];
  const result = nativeCapabilities(models as never, {}, [], 'claude-haiku-5-5');
  assert.ok(result.type === 'native.capabilities');
  assert.deepEqual(
    result.models.map(({ value }) => value),
    ['haiku', 'future-native-model'],
  );
  assert.equal(result.models[0].resolvedModel, 'claude-haiku-5-5');
  assert.deepEqual(result.models[0].supportedEffortLevels, [
    'low',
    'medium',
    'high',
    'xhigh',
    'max',
  ]);
});

const rateLimitEvent = (info: Record<string, unknown>) =>
  ({
    type: 'rate_limit_event',
    rate_limit_info: info,
    uuid: 'u',
    session_id: 's',
  }) as unknown as SDKRateLimitEvent;
const daily = rateLimitEvent({
  status: 'allowed',
  rateLimitType: 'five_hour',
  utilization: 0.02,
  resetsAt: 1792942200,
});
const weekly = rateLimitEvent({
  status: 'allowed',
  rateLimitType: 'seven_day',
  utilization: 0.44,
  resetsAt: 1793325600,
});

// A slow context read keeps the source timestamp; it must not make an older quota appear newer.
test('context refresh leaves observation timestamps and per-model public windows intact', async () => {
  const quotas = new Quotas();
  quotas.observe('a', daily, 0);
  quotas.observe('a', weekly, 0);
  quotas.observe(
    'a',
    rateLimitEvent({
      status: 'allowed',
      rateLimitType: 'seven_day_opus',
      utilization: 0.41,
      resetsAt: 1793325600,
    }),
    0,
  );
  let release!: () => void;
  const query = {
    getContextUsage: () =>
      new Promise<null>((resolve) => {
        release = () => resolve(null);
      }),
  } as unknown as Query;
  const first = nativeMetrics(query, undefined, {
    quota: async () => ({ rateLimits: quotas.of('a', 0) }),
  });
  await new Promise((resolve) => setImmediate(resolve));
  quotas.observe(
    'a',
    rateLimitEvent({
      status: 'allowed',
      rateLimitType: 'five_hour',
      utilization: 0.1,
      resetsAt: 1792942200,
    }),
    1000,
  );
  release();
  const older = await first;
  assert.ok(older.type === 'native.metrics');
  assert.equal(older.rateLimits?.measuredAt, new Date(0).toISOString());
  assert.equal(quotas.of('a', 1000)?.measuredAt, new Date(1000).toISOString());
  assert.deepEqual(
    older.rateLimits?.windows.map((window) => [window.name, window.utilization]),
    [
      ['five_hour', 2],
      ['seven_day', 44],
      ['seven_day_opus', 41],
    ],
  );
});

test('undocumented fields do not create an SDK quota without a named public window', () => {
  assert.deepEqual(
    observedQuota(
      rateLimitEvent({
        status: 'allowed',
        unifiedWindows: {
          five_hour: { utilization: 0.02, resetsAt: 1792942200 },
          seven_day: { utilization: 0.44, resetsAt: 1793325600 },
        },
        secret: 'must-not-leave-sdk',
      }),
      null,
      0,
    ),
    null,
  );
});

test('automatic work waits for exhausted account windows and ignores expired readings', () => {
  const quotas = new Quotas();
  const window = (name: string, utilization: number | null, resetsAt: string | null) => ({
    name,
    utilization,
    resetsAt,
  });
  const reading = {
    available: true,
    windows: [
      window('five_hour', 100, new Date(10_000).toISOString()),
      window('seven_day', 101, new Date(20_000).toISOString()),
      window('seven_day:Fable', 100, new Date(30_000).toISOString()),
    ],
  };
  assert.equal(quotas.blockedUntil('account', reading, 0), 20_000);
  assert.equal(quotas.blockedUntil('account', reading, 10_000), 20_000);
  assert.equal(quotas.blockedUntil('account', reading, 20_000), null);
  assert.equal(quotas.blockedUntil('account', null, 0), null);
  assert.equal(
    quotas.blockedUntil('account', { available: false, windows: reading.windows }, 0),
    null,
  );
  assert.equal(
    quotas.blockedUntil(
      'account',
      { available: true, windows: [window('five_hour', 100, null)] },
      0,
    ),
    Infinity,
  );
  assert.equal(
    quotas.blockedUntil(
      'account',
      { available: true, windows: [window('five_hour', null, null)] },
      0,
    ),
    null,
  );
});

test('native rejection without utilization holds its login until reset; allowed overage can continue', () => {
  const quotas = new Quotas();
  quotas.observe(
    'a',
    rateLimitEvent({ status: 'rejected', rateLimitType: 'five_hour', resetsAt: 10 }),
    0,
  );
  assert.equal(quotas.blockedUntil('a', null, 0), 10_000);
  assert.equal(quotas.blockedUntil('b', null, 0), null);
  assert.equal(quotas.blockedUntil('a', null, 10_000), null);
  quotas.observe('a', rateLimitEvent({ status: 'rejected' }), 0);
  assert.equal(quotas.blockedUntil('a', null, 0), Infinity);
  quotas.observe(
    'a',
    rateLimitEvent({
      status: 'allowed_warning',
      utilization: 0.9,
      rateLimitType: 'five_hour',
      resetsAt: 20,
    }),
    0,
  );
  assert.equal(quotas.blockedUntil('a', null, 0), null);
  quotas.observe(
    'a',
    rateLimitEvent({
      status: 'allowed',
      utilization: 1,
      rateLimitType: 'five_hour',
      resetsAt: 20,
      isUsingOverage: true,
    }),
    1,
  );
  assert.equal(quotas.blockedUntil('a', null, 1), null);
  quotas.observe(
    'a',
    rateLimitEvent({ status: 'rejected', rateLimitType: 'overage', overageResetsAt: 30 }),
    2,
  );
  assert.equal(quotas.blockedUntil('a', null, 2), 30_000);
});

test('the quota the CLI passes on in its stream becomes the windows of its own reading', () => {
  assert.deepEqual(observedQuota(weekly, observedQuota(daily, null, 0), 0), {
    windows: [
      { name: 'five_hour', utilization: 2, resetsAt: '2026-10-25T15:30:00.000Z' },
      { name: 'seven_day', utilization: 44, resetsAt: '2026-10-30T02:00:00.000Z' },
    ],
    measuredAt: new Date(0).toISOString(),
  });
});

test('an event for one window keeps the last reading of the others', () => {
  const first = observedQuota(weekly, observedQuota(daily, null, 0), 0);
  const next = observedQuota(
    rateLimitEvent({ status: 'allowed_warning', rateLimitType: 'seven_day', utilization: 0.81 }),
    first,
    1000,
  );
  assert.deepEqual(
    next?.windows.map(({ name, utilization }) => [name, utilization]),
    [
      ['five_hour', 2],
      ['seven_day', 81],
    ],
  );
  assert.equal(
    observedQuota(rateLimitEvent({ status: 'allowed', rateLimitType: 'overage' }), first),
    null,
  );
  assert.equal(observedQuota(rateLimitEvent({ status: 'allowed' }), null), null);
});

test('a public scoped window keeps its native name', () => {
  const event = rateLimitEvent({
    status: 'allowed',
    rateLimitType: 'seven_day_overage_included',
    utilization: 0.6,
    resetsAt: 1793325600,
  });
  assert.deepEqual(
    observedQuota(event, observedQuota(weekly, null, 0), 0)?.windows.map(({ name }) => name),
    ['seven_day', 'seven_day_overage_included'],
  );
});

test('readings are kept by login: another one neither sees nor overwrites them', () => {
  const quotas = new ObservedQuotas();
  quotas.observe('token', daily, 0);
  quotas.observe('token', weekly, 0);
  assert.equal(quotas.of('api key'), null);
  // A run left under an earlier login goes on reporting; the reading of the one signed in now stands.
  quotas.observe(
    'earlier',
    rateLimitEvent({
      status: 'allowed',
      rateLimitType: 'seven_day',
      utilization: 0.9,
      resetsAt: 1793325600,
    }),
    1,
  );
  assert.deepEqual(
    quotas.of('token')?.windows.map(({ name, utilization }) => [name, utilization]),
    [
      ['five_hour', 2],
      ['seven_day', 44],
    ],
  );
  assert.equal(quotas.of('earlier')?.windows[0]?.utilization, 90);
  // An event that says nothing of the windows leaves the reading as it was.
  quotas.observe('token', rateLimitEvent({ status: 'allowed', rateLimitType: 'overage' }), 2);
  assert.equal(quotas.of('token')?.measuredAt, new Date(0).toISOString());
});

test('a window drops out of the reading once its reset time has passed', () => {
  const observed = observedQuota(weekly, observedQuota(daily, null, 0), 0);
  const between = Date.parse('2026-10-27T00:00:00Z');
  assert.deepEqual(
    unexpired(observed, between)?.windows.map(({ name }) => name),
    ['seven_day'],
  );
  assert.equal(unexpired(observed, Date.parse('2026-10-30T02:00:00Z')), null);
  assert.equal(unexpired(null), null);
});

test('another login, an API key or a different account, is told apart from the one the reading came from', () => {
  const token = { apiProvider: 'firstParty', tokenSource: 'CLAUDE_CODE_OAUTH_TOKEN' } as const;
  assert.equal(loginOf(token), loginOf({ ...token }));
  assert.notEqual(
    loginOf(token),
    loginOf({ apiProvider: 'firstParty', apiKeySource: 'ANTHROPIC_API_KEY' }),
  );
  assert.notEqual(
    loginOf({ ...token, email: 'a@example.com' }),
    loginOf({ ...token, email: 'b@example.com' }),
  );
});

test('observations expire and changing an account clears both windows and rejection state', () => {
  const quotas = new Quotas();
  assert.equal(quotas.of('a', 0), null);
  quotas.observe('a', daily, 0);
  assert.equal(quotas.of('a', 0)?.windows[0].utilization, 2);
  assert.equal(quotas.of('b', 0), null);
  assert.equal(quotas.of('a', 1792942200000), null);
  quotas.observe('a', rateLimitEvent({ status: 'rejected' }), 0);
  assert.equal(quotas.blockedUntil('a', null, 0), Infinity);
  quotas.clear();
  assert.equal(quotas.of('a', 0), null);
  assert.equal(quotas.blockedUntil('a', null, 0), null);
  quotas.observe('b', daily, 0);
  assert.equal(quotas.of('a', 0), null);
  assert.equal(quotas.of('b', 0)?.windows[0].utilization, 2);
});
