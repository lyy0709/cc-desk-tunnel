import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { PROTOCOL_VERSION } from '@cc-desk-tunnel/protocol';
import type { Session } from '@cc-desk-tunnel/protocol';
import { screenshots } from './helpers.ts';

test('quota display watches per preference, refreshes on request and expires while idle', async ({
  page,
}) => {
  const now = new Date().toISOString();
  const session: Session = {
    id: randomUUID(),
    title: '额度',
    autoTitle: false,
    projectPath: 'D:\\工作\\额度',
    permissionMode: 'default',
    model: null,
    effort: null,
    createdAt: now,
    updatedAt: now,
    activeRun: null,
  };
  const requests: { type: string; quota?: boolean; active?: boolean }[] = [];
  let publish: (value: unknown) => void = () => {};
  await page.clock.install({ time: new Date(now) });
  await page.addInitScript(() =>
    localStorage.setItem('proxy-prefs', JSON.stringify({ quotaReads: true, quota: true })),
  );

  await page.routeWebSocket('ws://127.0.0.1:18899/ws', (route) => {
    const send = (value: unknown) => route.send(JSON.stringify(value));
    publish = send;
    route.onMessage((raw) => {
      const message = JSON.parse(String(raw));
      if (message.type === 'device') return;
      if (message.type === 'auth')
        return send({
          type: 'ready',
          protocolVersion: PROTOCOL_VERSION,
          version: '0.0.1',
          connectionId: randomUUID(),
          adapter: 'claude-code',
          sessions: [session],
        });
      requests.push(message);
      send({ type: 'response', requestId: message.requestId, ok: true });
    });
  });
  await page.goto('/');
  await page.getByLabel('服务地址', { exact: true }).fill('ws://127.0.0.1:18899/ws');
  await page
    .getByLabel('服务凭据', { exact: true })
    .fill('test-only-quota-token-with-enough-length');
  await page.getByRole('button', { name: '连接', exact: true }).click();
  await page.getByRole('button', { name: '设置与账号', exact: true }).click();
  await page.getByRole('menuitem', { name: '设置', exact: true }).click();
  const sections = page.getByRole('navigation', { name: '设置分类' });
  await sections.getByRole('button', { name: '账号与额度', exact: true }).click();
  const watch = page.getByRole('switch', { name: '运行中每分钟读取一次额度', exact: true });
  await expect(watch).toBeChecked();
  expect(requests.some((message) => message.type === 'quota.watch' && message.active)).toBe(true);
  await expect(page.getByText('尚无额度数据', { exact: true })).toBeVisible();
  publish({
    type: 'session.event',
    event: {
      sessionId: session.id,
      runId: randomUUID(),
      sequence: 1,
      createdAt: now,
      payload: {
        type: 'native.metrics',
        context: null,
        usage: null,
        rateLimits: {
          available: true,
          measuredAt: now,
          windows: [
            {
              name: 'five_hour',
              utilization: 37,
              resetsAt: new Date(Date.parse(now) + 120000).toISOString(),
            },
          ],
        },
      },
    },
  });
  await expect(page.getByText('37% 已用 · 63% 剩余')).toBeVisible();
  await expect(page.locator('.account-updated')).toContainText('更新于');
  await page.screenshot({ path: join(screenshots, 'quota-observed-light.png') });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: join(screenshots, 'quota-observed-dark-narrow.png') });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const count = requests.length;
  await page.clock.fastForward('02:01');
  await expect(page.getByText('尚无额度数据', { exact: true })).toBeVisible();
  await page.screenshot({ path: join(screenshots, 'quota-expired-dark-narrow.png') });
  expect(requests.slice(count).filter((message) => message.type !== 'usage.summary')).toEqual([]);
  await watch.click();
  await expect(watch).not.toBeChecked();
  await expect
    .poll(() => requests.filter((message) => message.type === 'quota.watch').at(-1)?.active)
    .toBe(false);
  const beforeRefresh = requests.filter((message) => message.type === 'session.status').length;
  await page.getByRole('button', { name: '刷新账号信息', exact: true }).click();
  await expect
    .poll(() => requests.filter((message) => message.type === 'session.status').length)
    .toBe(beforeRefresh + 1);
  expect(requests.filter((message) => message.type === 'session.status').at(-1)?.quota).toBe(true);
  expect(requests.some((message) => message.type === 'message.send')).toBe(false);
});
