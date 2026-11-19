import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import cacheModule from '../electron/history-cache.cjs';
import { ProxyClient } from '../src/client.ts';
import { exportSession } from '../src/exportSession.ts';
import { DesktopHistoryCache } from '../src/historyCache.ts';

test('desktop cache tracks gaps and history replacement and never exports a gap as complete', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'ccdt-history-worker-'));
  const worker = new cacheModule.HistoryCache(directory);
  const oldWindow = globalThis.window;
  t.after(async () => {
    globalThis.window = oldWindow;
    await worker.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const device = { id: randomUUID(), name: '电脑' };
  const session = {
    id: randomUUID(),
    device,
    title: '缓存测试',
    lastSequence: 3,
    projectPath: directory,
    updatedAt: new Date().toISOString(),
    activeRun: { status: 'running' },
  };
  const event = (sequence) => ({
    sessionId: session.id,
    runId: randomUUID(),
    sequence,
    createdAt: session.updatedAt,
    payload: { type: 'message.user', text: `缓存问题${sequence}`, messageId: randomUUID() },
  });
  const port = (command) => worker.request(command);
  const url = 'wss://fixture.invalid/ws';
  const disk = new DesktopHistoryCache(url, port);
  const historyId = randomUUID();
  disk.use(historyId);
  disk.write(session, [event(1)], [0, 1]);
  disk.write(session, [event(3)], [2, 3]);
  assert.deepEqual(await disk.earlier(session.id, 3), { after: 1 });
  const older = await disk.earlier(session.id, 3, true);
  assert.deepEqual(
    older.events.map((event) => event.sequence),
    [1],
  );
  assert.equal(older.gap, true);

  const offline = new DesktopHistoryCache(url, port);
  assert.equal((await offline.list())[0].activeRun, null);
  const client = new ProxyClient();
  await client.openOffline(offline, device);
  await assert.rejects(exportSession(client, session), /还有记录未缓存在本机/);

  disk.write(session, [event(2)], [1, 2]);
  let saved;
  globalThis.window = {
    desktop: {
      saveFile(name, text) {
        saved = { name, text };
        return Promise.resolve(true);
      },
    },
  };
  assert.equal(await exportSession(client, session), true);
  assert.equal(saved.name, '缓存测试.md');
  assert.match(saved.text, /缓存问题1.*缓存问题2.*缓存问题3/s);
  assert.equal(
    await new DesktopHistoryCache('wss://other.invalid/ws', port).latest(session.id),
    null,
  );

  disk.retain([{ ...session, lastSequence: 4 }]);
  await assert.rejects(exportSession(client, session), /还有记录未缓存在本机/);
  disk.retain([{ ...session, lastSequence: undefined }]);
  await assert.rejects(exportSession(client, session), /还有记录未缓存在本机/);

  const replacement = new DesktopHistoryCache(url, port);
  replacement.use(randomUUID());
  assert.equal(await replacement.latest(session.id), null);
  disk.write(session, [event(4)], [3, 4]);
  assert.deepEqual(await replacement.list(), []);
});

test('a quota broadcast during a disk read leaves the subscription on the verified cursor', async () => {
  const client = new ProxyClient();
  const sessionId = randomUUID();
  const diskRead = Promise.withResolvers();
  client.update({ status: 'connected', sessions: [{ id: sessionId }] });
  client.disk = { ready: true, latest: () => diskRead.promise };
  const requests = [];
  client.request = async (command) => requests.push(command);
  client.select(sessionId);
  const event = {
    sessionId,
    runId: randomUUID(),
    createdAt: new Date().toISOString(),
    payload: { type: 'native.metrics' },
  };
  client.streamEvents.push({ ...event, sequence: 8 });
  client.flushStream();
  diskRead.resolve({ events: [{ ...event, sequence: 3 }], hasEarlier: false });
  await client.waitForHistory(sessionId);
  assert.deepEqual(requests, [
    { type: 'session.subscribe', sessionId, afterSequence: 3, afterCreatedAt: event.createdAt },
  ]);
});

test('SQLite pages a large continuation with its original question across state readings', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'ccdt-history-page-'));
  const worker = new cacheModule.HistoryCache(directory);
  t.after(async () => {
    await worker.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const disk = new DesktopHistoryCache('wss://fixture.invalid/ws', (cmd) => worker.request(cmd));
  disk.use(randomUUID());
  const session = { id: randomUUID(), lastSequence: 5 };
  const original = randomUUID(),
    continued = randomUUID();
  const payloads = [
    [randomUUID(), { type: 'message.user', text: 'earlier' }],
    [original, { type: 'message.user', text: 'original' }],
    [randomUUID(), { type: 'native.notice', text: 'status' }],
    [continued, { type: 'message.user', text: 'continued', continued: true }],
    [continued, { type: 'text.delta', text: '中'.repeat(180000) }],
  ];
  const events = payloads.map(([runId, payload], i) => ({
    sessionId: session.id,
    sequence: i + 1,
    runId,
    payload,
  }));
  disk.write(session, events, [0, 5]);
  const page = await disk.latest(session.id);
  assert.deepEqual(
    page.events.map((e) => e.sequence),
    [2, 3, 4, 5],
  );
  assert.deepEqual(
    (await disk.earlier(session.id, 2)).events.map((e) => e.sequence),
    [1],
  );
});
