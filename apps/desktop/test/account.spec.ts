import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { PROTOCOL_VERSION, commandSchema } from '@cc-desk-tunnel/protocol';
import { join } from 'node:path';
import { UsageLog } from '../../server/src/usage.ts';
import { screenshots } from './helpers.ts';

test('ordinary login shows the official link, takes back the code and shows the one account', async ({
  page,
}) => {
  const codes: string[] = [];
  let waiting = false;
  let signedIn = false;
  await page.routeWebSocket('ws://127.0.0.1:18921/ws', (route) => {
    const reply = (value: unknown) => route.send(JSON.stringify(value));
    const state = () =>
      reply({
        type: 'account.state',
        ...(signedIn
          ? {
              loggedIn: true,
              authMethod: 'claude.ai',
              email: 'operator@example.test',
              subscriptionType: 'max',
            }
          : { loggedIn: false, authMethod: 'none' }),
        login: waiting ? { url: 'https://claude.ai/oauth/authorize?fixture=1' } : null,
      });
    route.onMessage((raw) => {
      const message = JSON.parse(String(raw));
      if (message.type === 'device') return;
      if (message.type === 'auth') {
        reply({
          type: 'ready',
          protocolVersion: PROTOCOL_VERSION,
          version: '0.4.0',
          connectionId: randomUUID(),
          adapter: 'claude-code',
          sessions: [],
        });
        return;
      }
      if (message.type === 'account.status') state();
      if (message.type === 'account.login') {
        waiting = true;
        state();
      }
      if (message.type === 'account.code') {
        codes.push(message.code);
        if (message.code === 'fixture#state') {
          waiting = false;
          signedIn = true;
        }
        state();
      }
      if (message.type === 'usage.summary')
        reply({
          type: 'usage.summary',
          requestId: message.requestId,
          retentionDays: 35,
          firstRecordAt: null,
          windows: [],
        });
      expect(message.type).not.toBe('server.session.create');
      reply({ type: 'response', requestId: message.requestId, ok: true });
    });
  });
  await page.goto('/');
  await page.getByLabel('服务地址', { exact: true }).fill('ws://127.0.0.1:18921/ws');
  await page.getByLabel('服务凭据', { exact: true }).fill('test-only-account-connection-token');
  await page.getByRole('button', { name: '连接', exact: true }).click();
  await page.getByRole('button', { name: '设置与账号', exact: true }).click();
  await page.getByRole('menuitem', { name: '设置', exact: true }).click();
  await page
    .getByRole('navigation', { name: '设置分类' })
    .getByRole('button', { name: '账号与额度', exact: true })
    .click();
  await expect(page.getByText(/图形客户端与 ccdt 共用这一个登录/)).toBeVisible();
  await expect(page.getByRole('heading', { name: '尚未登录' })).toBeVisible();
  // One sign-in and one quota: no token entry, no second quota to choose.
  await expect(page.getByRole('button', { name: /setup token/i })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '模型服务', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '普通登录', exact: true }).click();
  const form = page.getByRole('form', { name: '登录 Claude 账号' });
  await expect(form.getByRole('button', { name: '打开授权页' })).toBeVisible();
  await expect(form.getByRole('button', { name: '复制链接' })).toBeVisible();
  await page.screenshot({ path: join(screenshots, 'account-login.png') });
  await form.getByLabel('授权码').fill(' fixture#state ');
  await form.getByRole('button', { name: '完成登录' }).click();
  await expect(page.getByRole('heading', { name: 'operator@example.test' })).toBeVisible();
  await expect(page.getByText('浏览器授权', { exact: true })).toBeVisible();
  await expect(form).toHaveCount(0);
  expect(codes).toEqual(['fixture#state']);
  await page.screenshot({ path: join(screenshots, 'account-signed-in.png') });
});

for (const timezoneId of ['America/New_York', 'Asia/Kathmandu']) {
  test.describe(`usage in ${timezoneId}`, () => {
    test.use({ timezoneId });
    test('refreshes and pages by proxy time and groups UTC records on the viewer', async ({
      page,
    }) => {
      const original = process.env.TZ;
      const db = new DatabaseSync(':memory:');
      try {
        process.env.TZ = 'Asia/Tokyo';
        const log = new UsageLog(db);
        let now = Date.parse('2026-11-01T07:30:00Z');
        const add = db.prepare(`INSERT INTO api_requests(at,model,input_tokens,output_tokens,
          cache_read_tokens,cache_creation_tokens,cost_usd,duration_ms) VALUES(?,'fixture',1,0,0,0,0,1)`);
        for (const [at, count] of [
          ['03:45', 1],
          ['04:00', 1],
          ['05:15', 28],
          ['06:15', 24],
        ] as const)
          for (let i = 0; i < count; i++) add.run(Date.parse(`2026-11-01T${at}:00Z`));
        const seen: object[] = [];
        await page.clock.setFixedTime(new Date('2031-06-21T03:00:00Z'));
        await page.routeWebSocket('ws://127.0.0.1:18922/ws', (route) => {
          const reply = (value: object) => route.send(JSON.stringify(value));
          route.onMessage((raw) => {
            const { requestId, ...msg } = JSON.parse(String(raw));
            if (msg.type === 'device') return;
            if (msg.type === 'auth')
              return reply({
                type: 'ready',
                protocolVersion: PROTOCOL_VERSION,
                version: '0.4.0',
                connectionId: randomUUID(),
                adapter: 'claude-code',
                sessions: [],
              });
            if (msg.type === 'usage.summary')
              reply({ type: 'usage.summary', requestId, ...log.summary(now, null) });
            if (msg.type === 'usage.query') {
              seen.push(msg);
              const cmd = commandSchema.parse({ requestId, ...msg });
              if (cmd.type === 'usage.query')
                reply({ type: 'usage.page', requestId, ...log.query(cmd, () => null, now) });
            }
            reply({ type: 'response', requestId, ok: true });
          });
        });
        await page.goto('/');
        await page.getByLabel('服务地址', { exact: true }).fill('ws://127.0.0.1:18922/ws');
        await page
          .getByLabel('服务凭据', { exact: true })
          .fill('fixture-usage-time-connection-token');
        const button = (name: string) => page.getByRole('button', { name, exact: true });
        await button('连接').click();
        await button('设置与账号').click();
        await page.getByRole('menuitem', { name: '设置', exact: true }).click();
        await page
          .getByRole('navigation', { name: '设置分类' })
          .getByRole('button', { name: '账号与额度' })
          .click();
        await button('调用日志').click();
        await expect(page.getByText(/代理时区 Asia\/Tokyo/)).toBeVisible();
        const request = { type: 'usage.query', limit: 50, offset: 0 };
        // The development renderer mounts effects twice. Check every frame that reached the proxy.
        expect(seen.length).toBeGreaterThan(0);
        for (const frame of seen) expect(frame).toEqual({ ...request, range: 'today' });
        const ny = timezoneId === 'America/New_York';
        await expect(
          page.locator('.usage-log tbody tr').first().locator('td').first(),
        ).toContainText(ny ? '01:15:00' : '12:00:00');
        const bars = page.locator('figure.usage-chart .usage-bars > div');
        await bars.nth(-3).hover();
        await expect(page.getByRole('tooltip')).toContainText('28 次请求');
        await expect(page.getByRole('tooltip')).toContainText(ny ? 'GMT-4' : 'GMT+5:45');
        await bars.nth(-2).hover();
        await expect(page.getByRole('tooltip')).toContainText('24 次请求');
        await expect(page.getByRole('tooltip')).toContainText(ny ? 'GMT-5' : 'GMT+5:45');
        now += 60_000;
        await button('下一页').click();
        await expect(page.locator('.usage-log tbody tr')).toHaveCount(4);
        const frozen = { from: '2026-10-31T15:00:00.000Z', to: '2026-11-01T07:30:00.000Z' };
        expect(seen.at(-1)).toEqual({ ...request, offset: 50, range: frozen });
        await button('刷新调用日志').click();
        await expect(page.locator('.usage-log tbody tr')).toHaveCount(50);
        expect(seen.at(-1)).toEqual({ ...request, range: 'today' });
        await button('7 天').click();
        await expect(page.getByText('每日等价费用', { exact: true })).toBeVisible();
        await bars.last().hover();
        await expect(page.getByRole('tooltip')).toContainText(`${ny ? 53 : 54} 次请求`);
        expect(seen.at(-1)).toEqual({ ...request, range: '7d' });
        await button('自定义').click();
        await expect(page.getByLabel('结束时间')).toHaveValue('2026-11-01T16:31');
        await page.getByLabel('开始时间').fill('2026-11-01T12:00');
        await page.getByLabel('模型', { exact: true }).selectOption('fixture');
        await expect
          .poll(() => seen.at(-1))
          .toEqual({
            ...request,
            model: 'fixture',
            range: { serverFrom: '2026-11-01T12:00', serverTo: '2026-11-01T16:31' },
          });
        for (const msg of seen) {
          expect(msg).not.toHaveProperty('offsetMinutes');
          expect(msg).not.toHaveProperty('timeZone');
        }
      } finally {
        db.close();
        if (original === undefined) delete process.env.TZ;
        else process.env.TZ = original;
      }
    });
  });
}
