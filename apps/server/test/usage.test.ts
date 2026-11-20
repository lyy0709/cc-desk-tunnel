import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { UsageLog, createUsageReceiver, telemetryEnvironment } from '../src/usage.ts';
import { terminalEnvironment } from '../src/native-terminal.ts';

import { subscriptionScope } from '../src/native-account.ts';
const owner = subscriptionScope('user@example.invalid', 'org-A')!;
const hour = 3600_000;
const base = Date.parse('2026-10-06T00:00:00.000Z');
const recordedRange = {
  from: new Date(base - 48 * hour).toISOString(),
  to: new Date(base + 48 * hour).toISOString(),
};
function record(at: number, values: Record<string, string | number>, name = 'api_request') {
  return {
    timeUnixNano: `${at}000000`,
    body: { stringValue: `claude_code.${name}` },
    attributes: Object.entries({
      'event.name': name,
      'event.timestamp': new Date(at).toISOString(),
      'user.email': 'user@example.invalid',
      'organization.id': 'org-A',
      ...values,
    }).map(([key, value]) => ({
      key,
      value:
        typeof value === 'string'
          ? { stringValue: value }
          : Number.isInteger(value)
            ? { intValue: value }
            : { doubleValue: value },
    })),
  };
}
const request = (at: number, id: string, extra: Record<string, string | number> = {}) =>
  record(at, {
    'session.id': '4f0c9d0e-1111-4222-8333-444455556666',
    model: 'claude-opus-5-5',
    input_tokens: 10,
    output_tokens: 200,
    cache_read_tokens: 1000,
    cache_creation_tokens: 50,
    cost_usd: 0.5,
    duration_ms: 3000,
    ttft_ms: 1000,
    request_id: id,
    query_source: 'sdk',
    ...extra,
  });
const batch = (...logRecords: unknown[]) => ({ resourceLogs: [{ scopeLogs: [{ logRecords }] }] });

test('collector keeps model requests only, once each, without account identity', () => {
  const database = new DatabaseSync(':memory:');
  const log = new UsageLog(database);
  assert.equal(
    log.ingest(
      batch(
        record(base, { prompt: '<REDACTED>' }, 'user_prompt'),
        request(base, 'req_1'),
        request(base + 1, 'req_2'),
      ),
    ),
    2,
  );
  assert.equal(log.ingest(batch(request(base, 'req_1'))), 0);
  assert.equal(log.ingest({ unexpected: true }), 0);
  const columns = (
    database.prepare('PRAGMA table_info(api_requests)').all() as { name: string }[]
  ).map((column) => column.name);
  assert.ok(!columns.some((name) => /email|user|account|prompt(?!_id$)/.test(name)));
  const page = log.query({ limit: 1, range: recordedRange }, () => '标题');
  assert.equal(page.rows.length, 1);
  assert.equal(page.hasMore, true);
  assert.deepEqual(
    { ...page.rows[0], id: 0 },
    {
      id: 0,
      at: new Date(base + 1).toISOString(),
      sessionId: '4f0c9d0e-1111-4222-8333-444455556666',
      sessionTitle: '标题',
      model: 'claude-opus-5-5',
      inputTokens: 10,
      outputTokens: 200,
      cacheReadTokens: 1000,
      cacheCreationTokens: 50,
      costUsd: 0.5,
      durationMs: 3000,
      ttftMs: 1000,
      source: 'sdk',
    },
  );
  assert.equal(page.totals.requests, 2);
  assert.equal(page.totals.costUsd, 1);
  assert.equal(page.totals.outputPerSecond, 100);
  assert.equal(
    log.query({ limit: 1, beforeId: page.rows[0].id, range: recordedRange }, () => null).hasMore,
    false,
  );
});

test('filters, sparse UTC slices, and retention limits', () => {
  const log = new UsageLog(new DatabaseSync(':memory:'), 35, 3);
  log.ingest(
    batch(
      request(base - 30 * hour, 'a', { model: 'claude-haiku-4-5' }),
      request(base - 2 * hour, 'b'),
      request(base + hour, 'c', { model: 'claude-haiku-4-5', ttft_ms: 5000, duration_ms: 4000 }),
      request(base + 2 * hour, 'd'),
    ),
  );
  const range = {
    from: new Date(base - 3 * hour).toISOString(),
    to: new Date(base + 3 * hour).toISOString(),
  };
  const page = log.query({ range, limit: 100 }, () => null);
  assert.deepEqual(
    page.series.map((item) => [item.at, item.requests]),
    [
      ['2026-10-05T22:00:00.000Z', 1],
      ['2026-10-06T01:00:00.000Z', 1],
      ['2026-10-06T02:00:00.000Z', 1],
    ],
  );
  assert.deepEqual(page.models, ['claude-haiku-4-5', 'claude-opus-5-5']);
  const haiku = log.query({ range, limit: 100, model: 'claude-haiku-4-5' }, () => null);
  assert.equal(haiku.totals.requests, 1);
  assert.equal(haiku.totals.outputPerSecond, null);
  assert.deepEqual(haiku.models, page.models);
  // The breakdown by model covers the range whatever the filter; each bucket splits its tokens by kind.
  assert.deepEqual(page.byModel.map((item) => [item.model, item.requests]).sort(), [
    ['claude-haiku-4-5', 1],
    ['claude-opus-5-5', 2],
  ]);
  assert.deepEqual(haiku.byModel, page.byModel);
  const [day] = page.series;
  assert.equal(
    day.inputTokens + day.outputTokens + day.cacheReadTokens + day.cacheCreationTokens,
    day.tokens,
  );
  assert.ok(day.cacheReadTokens > 0);
  // Pages are counted from the newest record.
  const first = log.query({ range, limit: 2 }, () => null);
  const second = log.query({ range, limit: 2, offset: 2 }, () => null);
  assert.equal(first.hasMore, true);
  assert.equal(second.hasMore, false);
  assert.deepEqual(
    [...first.rows, ...second.rows].map((row) => row.id),
    page.rows.map((row) => row.id),
  );
  assert.equal(second.totals.requests, 3);
  log.prune(base + 3 * hour);
  assert.equal(log.query({ limit: 100, range: recordedRange }, () => null).totals.requests, 3);
  log.prune(base + 40 * 24 * hour);
  assert.equal(log.query({ limit: 100, range: recordedRange }, () => null).totals.requests, 0);
});

test('the proxy clock sets the range and keeps the same UTC bounds across a DST change and pagination', (t) => {
  const originalZone = process.env.TZ;
  process.env.TZ = 'America/New_York';
  t.after(() => {
    if (originalZone === undefined) delete process.env.TZ;
    else process.env.TZ = originalZone;
  });
  const log = new UsageLog(new DatabaseSync(':memory:'));
  const now = Date.parse('2026-11-01T12:00:00Z');
  const query = (range: Parameters<UsageLog['query']>[0]['range'], clock = now) =>
    log.query({ range, limit: 50 }, () => null, clock);
  log.ingest(
    batch(
      request(Date.parse('2026-11-01T03:59:59Z'), 'previous'),
      request(Date.parse('2026-11-01T04:00:00Z'), 'midnight'),
      request(now, 'after-snapshot'),
    ),
  );
  const today = query('today');
  assert.equal(today.timeZone, 'America/New_York');
  assert.equal(today.from, '2026-11-01T04:00:00.000Z');
  assert.equal(today.to, '2026-11-01T12:00:00.000Z');
  assert.equal(today.totals.requests, 1);
  assert.deepEqual(query({ from: today.from, to: today.to }, now + hour), today);
  assert.equal(query({ from: today.from }, now + hour).totals.requests, 2);
  for (const [preset, days] of [
    ['24h', 1],
    ['7d', 7],
    ['30d', 30],
  ] as const)
    assert.equal(Date.parse(query(preset).from), now - days * 24 * hour);
  assert.deepEqual(query({ serverFrom: '2026-11-01T00:00', serverTo: '2026-11-01T07:00' }), today);
  assert.throws(
    () => query({ serverFrom: '2026-03-08T02:30', serverTo: '2026-03-08T05:00' }),
    /不存在/,
  );
  assert.throws(
    () => query({ serverFrom: '2026-11-01T07:00', serverTo: '2026-11-01T00:00' }),
    /结束时间/,
  );
});

test('period statistics follow the official windows, including early resets and expiry', () => {
  const log = new UsageLog(new DatabaseSync(':memory:'));
  const limits = (fiveHour: [number, number], week: [number, number]) => ({
    windows: [
      {
        name: 'five_hour',
        utilization: fiveHour[0],
        resetsAt: new Date(fiveHour[1]).toISOString(),
      },
      { name: 'seven_day', utilization: week[0], resetsAt: new Date(week[1]).toISOString() },
    ],
  });
  const weekEnd = base + 5 * 24 * hour;
  log.ingest(batch(request(base - 3 * 24 * hour, 'old'), request(base + hour, 'w1')));
  log.observe(limits([20, base + 5 * hour], [30, weekEnd]), base + hour + 1, owner);
  const count = (now: number) =>
    Object.fromEntries(
      log.summary(now, owner).windows.map((window) => [window.name, window.requests]),
    );
  // First observation: the period start is derived from the reported reset time.
  assert.deepEqual(count(base + hour + 2), { five_hour: 1, seven_day: 1 });
  assert.equal(
    log.summary(base + hour + 2, owner).windows[1].startedAt,
    new Date(weekEnd - 7 * 24 * hour).toISOString(),
  );

  // Sub-second jitter in the reported reset time is not a new period.
  log.ingest(batch(request(base + 2 * hour, 'w2')));
  log.observe(limits([40, base + 5 * hour + 900], [31, weekEnd - 700]), base + 2 * hour + 1, owner);
  assert.deepEqual(count(base + 2 * hour + 2), { five_hour: 2, seven_day: 2 });

  // Past the reset time and before any new report, the old period's requests no longer count.
  assert.deepEqual(count(base + 6 * hour), { five_hour: 0, seven_day: 2 });
  assert.equal(log.summary(base + 6 * hour, owner).windows[0].utilization, null);

  // A new five-hour window starts with the first request after expiry.
  log.ingest(batch(request(base + 7 * hour, 'w3')));
  log.observe(limits([5, base + 12 * hour], [32, weekEnd]), base + 7 * hour + 1, owner);
  assert.deepEqual(count(base + 7 * hour + 2), { five_hour: 1, seven_day: 3 });

  // A reset granted early clears the weekly utilization while its reset time stays; statistics restart too.
  log.ingest(batch(request(base + 8 * hour, 'w4')));
  log.observe(limits([10, base + 12 * hour], [0, weekEnd]), base + 8 * hour + 1, owner);
  assert.deepEqual(count(base + 8 * hour + 2), { five_hour: 2, seven_day: 1 });
});

test('a period survives jitter and repeated readings, and a cut-short one is restored', () => {
  const database = new DatabaseSync(':memory:');
  const log = new UsageLog(database);
  const weekEnd = base + 3 * 24 * hour;
  const weekStart = new Date(weekEnd - 7 * 24 * hour).toISOString();
  const reading = (utilization: number, at: number, resetsAt: number | null = weekEnd) => ({
    measuredAt: new Date(at).toISOString(),
    windows: [
      {
        name: 'seven_day',
        utilization,
        resetsAt: resetsAt === null ? null : new Date(resetsAt).toISOString(),
      },
    ],
  });
  const started = () => log.summary(base + 3 * hour, owner).windows[0].startedAt;
  log.ingest(batch(request(base, 'j1')));
  log.observe(reading(45, base + hour), Date.now(), owner);
  // Two readings a few milliseconds apart, the later one a point lower.
  log.observe(reading(44, base + hour + 36), Date.now(), owner);
  assert.equal(started(), weekStart);
  // Another session's long turn emits the reading it took earlier once more.
  log.observe(reading(47, base + 2 * hour), Date.now(), owner);
  log.observe(reading(30, base + hour + 10), base + 2 * hour + 5, owner);
  assert.equal(started(), weekStart);
  assert.equal(log.summary(base + 3 * hour, owner).windows[0].utilization, 47);
  assert.equal(log.summary(base + 3 * hour, owner).windows[0].requests, 1);
  // A reset granted early leaves the reset time alone, and something has been used again by the next reading.
  log.observe(reading(3, base + 2 * hour + 100), Date.now(), owner);
  assert.equal(started(), new Date(base + 2 * hour).toISOString());
  assert.equal(log.summary(base + 3 * hour, owner).windows[0].requests, 0);

  // An expired window is reported empty and without a reset time; its next period is told by the new one.
  const five = (utilization: number, at: number, resetsAt: number | null) => ({
    measuredAt: new Date(at).toISOString(),
    windows: [
      {
        name: 'five_hour',
        utilization,
        resetsAt: resetsAt === null ? null : new Date(resetsAt).toISOString(),
      },
    ],
  });
  const fiveStart = () =>
    log.summary(base + 9 * hour, owner).windows.find((window) => window.name === 'five_hour')!
      .startedAt;
  log.observe(five(2, base + hour, base + 5 * hour), Date.now(), owner);
  log.observe(five(0, base + 6 * hour, null), Date.now(), owner);
  log.observe(five(1, base + 7 * hour, base + 11.5 * hour), Date.now(), owner);
  assert.equal(fiveStart(), new Date(base + 6.5 * hour).toISOString());

  // A database written before the fix: the start is put back once, and the records stay.
  const old = new DatabaseSync(':memory:');
  new UsageLog(old).ingest(batch(request(Date.now() - hour, 'kept')));
  const resetsAt = Date.now() + 2 * 24 * hour;
  old.exec("DELETE FROM migrations WHERE name = 'usage-window-start'");
  old
    .prepare(
      'INSERT INTO scoped_usage_windows(scope,name,started_at,resets_at,utilization,observed_at) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .run(owner, 'seven_day', Date.now() - 60_000, resetsAt, 51, Date.now() - 1000);
  const records = old.prepare('SELECT * FROM api_requests ORDER BY id').all();
  const restored = new UsageLog(old).summary(Date.now(), owner).windows[0];
  assert.equal(restored.startedAt, new Date(resetsAt - 7 * 24 * hour).toISOString());
  assert.equal(restored.requests, 1);
  assert.deepEqual(old.prepare('SELECT * FROM api_requests ORDER BY id').all(), records);
  // Recovery is once only; a later explicitly observed reset must survive a restart.
  old.prepare('UPDATE scoped_usage_windows SET started_at = ?').run(Date.now() - 500);
  new UsageLog(old);
  assert.ok(
    Number(old.prepare('SELECT started_at FROM scoped_usage_windows').get()!.started_at) >
      Date.now() - 5000,
  );
});

test('period recovery preserves an early reset recorded in the original quota events', () => {
  const db = new DatabaseSync(':memory:');
  const log = new UsageLog(db);
  const now = Date.now();
  const end = now + 2 * 24 * hour;
  log.ingest(batch(request(now - 4 * hour, 'before-reset'), request(now - hour, 'after-reset')));
  db.exec(
    "DELETE FROM migrations WHERE name = 'usage-window-start'; CREATE TABLE events (data TEXT NOT NULL)",
  );
  db.prepare(
    'INSERT INTO scoped_usage_windows(scope,name,started_at,resets_at,utilization,observed_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(owner, 'seven_day', now - 60000, end, 20, now);
  const insert = db.prepare('INSERT INTO events VALUES (?)');
  for (const [at, utilization] of [
    [now - 3 * hour, 60],
    [now - 2 * hour, 2],
    [now - hour, 20],
  ]) {
    insert.run(
      JSON.stringify({
        createdAt: new Date(at).toISOString(),
        payload: {
          type: 'native.metrics',
          rateLimits: {
            available: true,
            measuredAt: new Date(at).toISOString(),
            windows: [{ name: 'seven_day', resetsAt: new Date(end).toISOString(), utilization }],
          },
        },
      }),
    );
  }
  const records = db.prepare('SELECT * FROM api_requests ORDER BY id').all();
  const events = db.prepare('SELECT * FROM events').all();
  const recovered = new UsageLog(db).summary(Date.now(), owner).windows[0];
  assert.equal(recovered.requests, 1);
  assert.equal(recovered.startedAt, new Date(now - 3 * hour).toISOString());
  assert.deepEqual(db.prepare('SELECT * FROM api_requests ORDER BY id').all(), records);
  assert.deepEqual(db.prepare('SELECT * FROM events').all(), events);
});

test('legacy calls remain in history but unidentified 0.3 windows cannot overwrite the signed-in account', () => {
  const db = new DatabaseSync(':memory:');
  const now = Date.now();
  // A 0.3 database: its own table of periods, calls that do not say which surface made them, no new table yet.
  db.exec(`CREATE TABLE api_requests (
      id INTEGER PRIMARY KEY, at INTEGER NOT NULL, session_id TEXT, model TEXT NOT NULL,
      input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL,
      cache_read_tokens INTEGER NOT NULL, cache_creation_tokens INTEGER NOT NULL,
      cost_usd REAL NOT NULL, duration_ms INTEGER NOT NULL, ttft_ms INTEGER, source TEXT, request_id TEXT UNIQUE,
      prompt_id TEXT);
    CREATE TABLE usage_windows(name TEXT PRIMARY KEY,started_at INTEGER NOT NULL,resets_at INTEGER,utilization REAL,observed_at INTEGER NOT NULL);
    CREATE TABLE migrations (name TEXT PRIMARY KEY);
    INSERT INTO migrations VALUES ('usage-window-start');
    CREATE TABLE events(data TEXT);`);
  db.prepare("INSERT INTO usage_windows VALUES ('five_hour', ?, ?, 40, ?)").run(
    now - 2 * hour,
    now + 3 * hour,
    now - 60_000,
  );
  db.prepare(
    `INSERT INTO api_requests(at,model,input_tokens,output_tokens,cache_read_tokens,cache_creation_tokens,cost_usd,
      duration_ms,request_id) VALUES (?,'fixture',1,0,0,0,0.1,1,'legacy')`,
  ).run(now - hour);
  const payload = {
    type: 'native.metrics',
    context: { usedTokens: 42 },
    usage: { costUsd: 1 },
    rateLimits: { available: true, windows: [] },
  };
  db.prepare('INSERT INTO events VALUES (?)').run(JSON.stringify({ payload }));
  const events = db.prepare('SELECT data FROM events').all();
  const log = new UsageLog(db);
  assert.deepEqual(log.summary(now, owner).windows, []);
  // The account's readings in the sessions stay as they were, and so does 0.3's table, for a downgrade.
  assert.deepEqual(db.prepare('SELECT data FROM events').all(), events);
  assert.ok(db.prepare("SELECT 1 FROM usage_windows WHERE name = 'five_hour'").get());
  // A reading here is newer than 0.3's: starting again takes over nothing older.
  const resetsAt = new Date(now + 3 * hour).toISOString();
  log.observe({ windows: [{ name: 'five_hour', utilization: 45, resetsAt }] }, now, owner);
  assert.equal(new UsageLog(db).summary(now, owner).windows[0].utilization, 45);
  // 0.3 started again on this data reads later; back on this release, its reading is taken over.
  db.prepare(
    "UPDATE usage_windows SET utilization = 60, observed_at = ? WHERE name = 'five_hour'",
  ).run(now + 1000);
  const again = new UsageLog(db);
  assert.equal(again.summary(now + 2000, owner).windows[0].utilization, 45);
  const range = {
    from: new Date(now - 2 * hour).toISOString(),
    to: new Date(now + hour).toISOString(),
  };
  assert.equal(again.query({ range, limit: 10 }, () => null).totals.requests, 1);
});

test('loopback receiver counts the calls of chat runs and terminals alike towards the account periods', async () => {
  const log = new UsageLog(new DatabaseSync(':memory:'));
  const receiver = createUsageReceiver(log, () => owner);
  const endpoint = await receiver.listen();
  try {
    assert.match(endpoint, /^http:\/\/127\.0\.0\.1:\d+\/v1\/logs$/);
    assert.equal(telemetryEnvironment(endpoint).OTEL_EXPORTER_OTLP_LOGS_ENDPOINT, endpoint);
    const post = (body: string, path = '') =>
      fetch(endpoint + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
    assert.equal(
      (await post(JSON.stringify(batch(request(base, 'http', { input_tokens: '12' }))))).status,
      200,
    );
    assert.equal((await post('not json')).status, 400);
    assert.equal((await post('{}', '/other')).status, 404);
    const page = log.query({ limit: 10, range: recordedRange }, () => null);
    assert.equal(page.rows.length, 1);
    assert.equal(page.rows[0].inputTokens, 12);
    const terminal = terminalEnvironment(
      { executable: 'fixture', environment: telemetryEnvironment(endpoint) },
      {},
    );
    const response = await fetch(terminal.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT, {
      method: 'POST',
      body: JSON.stringify(batch(request(base, 'terminal', { 'organization.id': 'org-A' }))),
    });
    assert.equal(response.status, 200);
    // The log keeps which surface made each call, and nothing of the account.
    assert.deepEqual(
      log.database
        .prepare('SELECT profile FROM api_requests ORDER BY id')
        .all()
        .map((row) => row.profile),
      ['sdk', 'terminal'],
    );
    const resetsAt = new Date(base + hour).toISOString();
    log.observe({ windows: [{ name: 'five_hour', utilization: 3, resetsAt }] }, base, owner);
    assert.deepEqual(
      log.summary(base, owner).windows.map((w) => [w.utilization, w.requests]),
      [[3, 2]],
    );
    assert.equal(log.query({ limit: 10, range: recordedRange }, () => null).totals.requests, 2);
    // A terminal's status line reports the same account's window, and a later reading of it is the one shown.
    log.observe(
      {
        windows: [{ name: 'five_hour', utilization: 9, resetsAt }],
        measuredAt: new Date(base + 1000).toISOString(),
      },
      base + 1000,
      owner,
    );
    assert.deepEqual(
      log.summary(base + 2000, owner).windows.map((w) => [w.utilization, w.requests]),
      [[9, 2]],
    );
  } finally {
    await receiver.close();
  }
});

test('subscription periods join desktop and terminal calls only for the signed-in organization', () => {
  const log = new UsageLog(new DatabaseSync(':memory:'));
  const other = subscriptionScope('user@example.invalid', 'org-B')!;
  log.ingest(batch(request(base, 'a')));
  log.ingest(batch(request(base, 'b', { 'organization.id': 'org-B' })), 'terminal');
  log.ingest(batch(request(base, 'unknown', { 'organization.id': '' })));
  log.ingest(batch(request(base, 'api-key')), 'sdk', null);
  log.observe({ windows: [{ name: 'five_hour', utilization: 73, resetsAt: null }] }, base, owner);
  assert.deepEqual(log.summary(base, null).windows, []);
  assert.deepEqual(log.summary(base, other).windows, []);
  assert.equal(log.summary(base, owner).windows[0].requests, 1);
  assert.equal(
    log.query({ range: recordedRange, limit: 10, accountPeriod: true }, () => null, base, other)
      .totals.requests,
    1,
  );
  assert.equal(log.query({ range: recordedRange, limit: 10 }, () => null, base).totals.requests, 4);
});
test('a turn is summed over its time window with the figures the call log shows', () => {
  const log = new UsageLog(new DatabaseSync(':memory:'));
  const session = '4f0c9d0e-1111-4222-8333-444455556666';
  log.ingest(
    batch(
      request(base - 1000, 'before'),
      request(base, 'a'),
      request(base + 5000, 'b', { output_tokens: 400, ttft_ms: 500, duration_ms: 2500 }),
      // Streamed time is what is left after the first token: 2000 ms and 2000 ms for 600 tokens.
      request(base + 9000, 'elsewhere', { 'session.id': 'ffffffff-1111-4222-8333-444455556666' }),
      request(base + 20000, 'after'),
    ),
  );
  assert.deepEqual(
    log.turnStats(session, { promptIds: [], startedAt: base, endedAt: base + 10000 }),
    {
      requests: 2,
      inputTokens: 20,
      outputTokens: 600,
      cacheReadTokens: 2000,
      cacheCreationTokens: 100,
      modelMs: 5500,
      mainRequests: 2,
      ttftMs: 750,
      outputPerSecond: 150,
    },
  );
  assert.deepEqual(
    log.turnStats(session, { promptIds: [], startedAt: base + 30000, endedAt: base + 40000 }),
    {
      requests: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      modelMs: 0,
      mainRequests: 0,
      ttftMs: null,
      outputPerSecond: null,
    },
  );
});

test('a session is summed over all its requests, turns being its distinct prompts', () => {
  const log = new UsageLog(new DatabaseSync(':memory:'));
  const session = '4f0c9d0e-1111-4222-8333-444455556666';
  assert.deepEqual(log.sessionStats(session), {
    turns: 0,
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    modelMs: 0,
    ttftMs: null,
    outputPerSecond: null,
    firstRecordAt: null,
  });
  log.ingest(
    batch(
      request(base, 'a1', { 'prompt.id': 'p1' }),
      request(base + 1000, 'a2', {
        'prompt.id': 'p1',
        output_tokens: 400,
        ttft_ms: 500,
        duration_ms: 2500,
      }),
      request(base + 2000, 'b1', { 'prompt.id': 'p2' }),
      request(base + 3000, 'unnamed'),
      request(base + 4000, 'elsewhere', {
        'session.id': 'ffffffff-1111-4222-8333-444455556666',
        'prompt.id': 'p3',
      }),
    ),
  );
  // Streamed time is what is left after the first token: 2000, 2000 and 2000 ms for 800 and 200 tokens.
  assert.deepEqual(log.sessionStats(session), {
    turns: 2,
    requests: 4,
    inputTokens: 40,
    outputTokens: 1000,
    cacheReadTokens: 4000,
    cacheCreationTokens: 200,
    modelMs: 11500,
    ttftMs: 875,
    outputPerSecond: 1000 / ((2000 * 4) / 1000),
    firstRecordAt: new Date(base).toISOString(),
  });
});

test('a turn is summed over the requests of its prompts, whatever the time, and of its window', () => {
  const log = new UsageLog(new DatabaseSync(':memory:'));
  const session = '4f0c9d0e-1111-4222-8333-444455556666';
  log.ingest(
    batch(
      request(base, 'main', { 'prompt.id': 'p1' }),
      // A subagent's request arrives with the prompt it ran for, even long after the turn's window.
      request(base + 60000, 'subagent', {
        'prompt.id': 'p1',
        output_tokens: 100,
        query_source: 'agent:builtin:general-purpose',
      }),
      request(base + 1000, 'next', { 'prompt.id': 'p2' }),
      request(base + 2000, 'unnamed'),
    ),
  );
  const turn = (promptIds: string[]) => ({ promptIds, startedAt: base, endedAt: base + 500 });
  assert.equal(log.turnStats(session, turn(['p1'])).requests, 2);
  assert.equal(log.turnStats(session, turn(['p1'])).outputTokens, 300);
  // Only the main loop's requests count towards the requests the turn is waiting for.
  assert.equal(log.turnStats(session, turn(['p1'])).mainRequests, 1);
  assert.equal(log.turnStats(session, turn(['p1', 'p2'])).requests, 3);
  // Without prompts, the window alone: the first request, not the subagent's a minute later.
  assert.equal(log.turnStats(session, turn([])).requests, 1);
  // A request in the window counts once, whether or not its prompt is named too.
  assert.equal(
    log.turnStats(session, { promptIds: ['p1'], startedAt: base, endedAt: base + 1500 }).requests,
    3,
  );
});

test('a question is summed over the prompts of every turn it took, late subagent requests included', () => {
  const log = new UsageLog(new DatabaseSync(':memory:'));
  const session = '4f0c9d0e-1111-4222-8333-444455556666';
  const subagent = { query_source: 'agent:builtin:general-purpose', output_tokens: 100 };
  log.ingest(
    batch(
      // The user's prompt: a main request, then a background subagent's while the first turn is still running.
      request(base, 'a', { 'prompt.id': 'p1' }),
      request(base + 1000, 'b', { 'prompt.id': 'p1', ...subagent }),
      // The subagent hands back, which starts a turn with a prompt of its own.
      request(base + 5000, 'c', { 'prompt.id': 'p2' }),
      // Subagent requests made after that turn ended carry the latest prompt's id, not the first one's.
      request(base + 6000, 'd', { 'prompt.id': 'p2', ...subagent }),
      request(base + 9000, 'e', { 'prompt.id': 'p3' }),
      request(base + 9500, 'f', { 'prompt.id': 'p3', ...subagent }),
      // Subagent requests under a prompt the CLI never told us of still fall in the question's window.
      request(base + 7000, 'h', { 'prompt.id': 'unseen', ...subagent }),
      // Another question's request, and one nobody named, both after the question.
      request(base + 20000, 'g', { 'prompt.id': 'p4' }),
      request(base + 30000, 'i'),
    ),
  );
  const turn = (promptIds: string[]) => ({ promptIds, startedAt: base, endedAt: base + 10000 });
  // The first prompt alone, over the first turn's window, misses the subagent requests made later.
  assert.equal(
    log.turnStats(session, { promptIds: ['p1'], startedAt: base, endedAt: base + 2000 }).requests,
    2,
  );
  const whole = log.turnStats(session, turn(['p1', 'p2', 'p3']));
  assert.equal(whole.requests, 7);
  assert.equal(whole.mainRequests, 3);
  assert.equal(whole.outputTokens, 3 * 200 + 4 * 100);
  // The same prompt named twice is counted once.
  assert.equal(log.turnStats(session, turn(['p1', 'p2', 'p3', 'p3'])).requests, 7);
});
