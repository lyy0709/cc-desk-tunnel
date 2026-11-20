import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { PROTOCOL_VERSION } from '@cc-desk-tunnel/protocol';
import type { SessionTools } from '@cc-desk-tunnel/protocol';

test('subagents for device sessions are off until switched on in the settings, and saved at once', async ({
  page,
}) => {
  const values: SessionTools = { subagents: false };
  const updates: unknown[] = [];
  await page.routeWebSocket('ws://127.0.0.1:18893/ws', (route) => {
    const send = (value: unknown) => route.send(JSON.stringify(value));
    route.onMessage((raw) => {
      const message = JSON.parse(String(raw));
      if (message.type === 'device') return;
      if (message.type === 'auth') {
        send({
          type: 'ready',
          protocolVersion: PROTOCOL_VERSION,
          version: '0.0.1',
          connectionId: randomUUID(),
          adapter: 'claude-code',
          sessions: [],
        });
        return;
      }
      if (message.type === 'tools.update') {
        updates.push(message.values);
        Object.assign(values, message.values);
      }
      if (message.type.startsWith('tools.'))
        send({ type: 'tools.state', requestId: message.requestId, values });
      send({ type: 'response', requestId: message.requestId, ok: true });
    });
  });
  await page.goto('/');
  await page.getByLabel('服务地址', { exact: true }).fill('ws://127.0.0.1:18893/ws');
  await page
    .getByLabel('服务凭据', { exact: true })
    .fill('test-only-session-tools-token-with-length');
  await page.getByRole('button', { name: '连接', exact: true }).click();
  await page.getByRole('button', { name: '设置与账号', exact: true }).click();
  await page.getByRole('menuitem', { name: '设置', exact: true }).click();
  // The service's own, for every device connected to it.
  const sections = page.getByRole('navigation', { name: '设置分类' });
  await sections.getByRole('button', { name: '项目工具', exact: true }).click();
  const panel = page.getByRole('region', { name: '项目工具' });
  await expect(panel).toContainText('保存在服务端');
  const subagents = panel.getByRole('switch', { name: '启用子代理', exact: true });
  await expect(subagents).not.toBeChecked();
  await subagents.click();
  await expect(subagents).toBeChecked();
  await expect.poll(() => updates).toEqual([{ subagents: true }]);
  await subagents.click();
  await expect(subagents).not.toBeChecked();
  await expect.poll(() => updates).toEqual([{ subagents: true }, { subagents: false }]);
});
