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

  const replacement = new DesktopHistoryCache(url, port);
  replacement.use(randomUUID());
  assert.equal(await replacement.latest(session.id), null);
  disk.write(session, [event(4)], [3, 4]);
  assert.deepEqual(await replacement.list(), []);
});
