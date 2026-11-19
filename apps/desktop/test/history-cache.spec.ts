import { expect, test, _electron } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PROTOCOL_VERSION } from '@cc-desk-tunnel/protocol';
import { createProxyServer } from '../../server/src/server.ts';
import { connectionArgs } from './helpers.ts';

test('desktop resumes from SQLite and can page through the same records with the server offline', async () => {
  test.setTimeout(90_000);
  const directory = mkdtempSync(join(tmpdir(), 'ccdt-history-ui-'));
  const project = join(directory, 'project');
  mkdirSync(project);
  const token = 'history-ui-' + randomUUID();
  const server = createProxyServer({
    host: '127.0.0.1',
    token,
    dataDir: join(directory, 'server'),
  });
  let serviceOpen = false;
  let application: ElectronApplication | undefined;
  try {
    const url = (await server.listen(0)).replace('http:', 'ws:') + '/ws';
    serviceOpen = true;
    const launch = () =>
      _electron.launch({
        args: [
          resolve('apps/desktop'),
          '--smoke-test',
          ...connectionArgs(join(directory, 'profile')),
        ],
        env: Object.fromEntries(
          Object.entries(process.env).filter(
            (entry): entry is [string, string] =>
              entry[1] !== undefined && entry[0] !== 'ELECTRON_RUN_AS_NODE',
          ),
        ),
      });
    application = await launch();
    let page = await application.firstWindow();
    const device = await page.evaluate(() => window.desktop!.device());
    const session = server.store.create(randomUUID(), '缓存对话', project, device);
    const turn = (number: number, text: string) => {
      const run = randomUUID();
      server.store.append(session.id, run, {
        type: 'message.user',
        messageId: randomUUID(),
        scenario: 'chat',
        text: `缓存问题${number}`,
      });
      return server.store.append(session.id, run, {
        type: 'text.delta',
        messageId: randomUUID(),
        text,
      });
    };
    turn(0, 'history '.repeat(40_000));
    const last = turn(1, 'history '.repeat(40_000));
    await page.evaluate((path) => window.desktop!.saveShared('projects', [path]), project);
    const signIn = async (page: Page, first = false) => {
      const simulated = page.getByRole('button', { name: '本地模拟', exact: true });
      if (await simulated.isVisible()) await simulated.click();
      if (first) await page.getByLabel('服务地址').fill(url);
      else await expect(page.getByLabel('服务地址')).toHaveValue(url);
      await page.getByLabel('服务凭据').fill(token);
      await page.getByRole('button', { name: '连接', exact: true }).click();
      await expect(page.locator('.connection-status')).toContainText('已连接');
    };
    const older = async (page: Page) => {
      const first = page.getByText('缓存问题0', { exact: true });
      const more = page.getByRole('button', { name: '加载更早记录', exact: true });
      // The conversation may prefetch another page when its scroll anchor moves upward.
      await expect(first.or(more).first()).toBeVisible();
      if (!(await first.isVisible())) await more.click();
      await expect(first).toBeVisible();
    };
    await signIn(page, true);
    await page.locator('.session-select').filter({ hasText: '缓存对话' }).click();
    await expect(page.getByText('缓存问题1', { exact: true })).toBeVisible();
    await older(page);
    await expect
      .poll(() =>
        page.evaluate(
          async ({ url, protocol }) => {
            const stats = (await window.desktop!.historyCache({
              type: 'stats',
              url,
              protocol,
            })) as {
              events: number;
            } | null;
            return stats?.events;
          },
          { url, protocol: PROTOCOL_VERSION },
        ),
      )
      .toBe(4);
    await application.close();
    application = undefined;

    turn(2, '新增缓存回答');
    application = await launch();
    page = await application.firstWindow();
    const commands: { type: string; afterSequence?: number; afterCreatedAt?: string }[] = [];
    page.on('websocket', (socket) =>
      socket.on('framesent', (frame) => commands.push(JSON.parse(String(frame.payload)))),
    );
    await signIn(page);
    await page.locator('.session-select').filter({ hasText: '缓存对话' }).click();
    await expect(page.getByText('缓存问题2', { exact: true })).toBeVisible();
    expect(commands.find((command) => command.type === 'session.subscribe')).toMatchObject({
      afterSequence: last.sequence,
      afterCreatedAt: last.createdAt,
    });
    await older(page);
    expect(commands.filter((command) => command.type === 'session.history')).toHaveLength(0);
    await application.close();
    application = undefined;
    await server.close();
    serviceOpen = false;

    application = await launch();
    page = await application.firstWindow();
    await page.getByRole('button', { name: '离线查看缓存', exact: true }).click();
    await expect(page.locator('.connection-status')).toContainText('离线查看');
    await expect(page.getByText('缓存问题2', { exact: true })).toBeVisible();
    await expect(page.getByRole('textbox', { name: '消息', exact: true })).toBeDisabled();
    await older(page);
  } finally {
    await application?.close();
    if (serviceOpen) await server.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('Web IndexedDB keeps existing records and pages whole continuations after upgrade', async ({
  page,
}) => {
  await page.goto('/');
  const result = await page.evaluate(async (protocol) => {
    const url = new URL('/src/historyCache.ts', location.href).href;
    const { HistoryCache } = (await import(url)) as typeof import('../src/historyCache.ts');
    const dbName = crypto.randomUUID(),
      sessionId = crypto.randomUUID();
    const events = [
      ['a', { type: 'message.user', text: 'earlier' }],
      ['b', { type: 'message.user', text: 'original' }],
      ['s', { type: 'native.notice', text: 'status' }],
      ['c', { type: 'message.user', continued: true, text: 'continued' }],
      ['c', { type: 'text.delta', text: '中'.repeat(180000) }],
    ].map(([runId, payload], i) => ({ sessionId, sequence: i + 1, runId, payload }));
    await new Promise<void>((resolve, reject) => {
      const open = indexedDB.open(dbName, 1);
      open.onupgradeneeded = () => {
        const db = open.result;
        db.createObjectStore('about').put(`fixture/${protocol}`, 'history');
        db.createObjectStore('sessions', { keyPath: 'id' }).put({
          id: sessionId,
          ranges: [[0, 5]],
        });
        const records = db.createObjectStore('events', { keyPath: ['sessionId', 'sequence'] });
        for (const event of events)
          records.put({ sessionId, sequence: event.sequence, event, size: 1 });
      };
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        open.result.close();
        resolve();
      };
    });
    const disk = new HistoryCache(dbName);
    disk.use('fixture');
    const latest = await disk.latest(sessionId);
    const earlier = await disk.earlier(sessionId, 2);
    return [
      latest?.events.map((e) => e.sequence),
      earlier && 'events' in earlier && earlier.events.map((e) => e.sequence),
    ];
  }, PROTOCOL_VERSION);
  expect(result).toEqual([[2, 3, 4, 5], [1]]);
});
