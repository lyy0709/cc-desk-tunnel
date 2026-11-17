import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { PROTOCOL_VERSION } from '@cc-desk-tunnel/protocol';
import type {
  EventPayload,
  FileAttachment,
  MessagePriority,
  Session,
  SessionEvent,
} from '@cc-desk-tunnel/protocol';
import { conversationOutline } from '@cc-desk-tunnel/protocol/transcript';
import { screenshots } from './helpers.ts';

async function open(page: Page, followup: MessagePriority = 'next') {
  const now = new Date().toISOString();
  const connectionId = randomUUID();
  const session: Session = {
    id: randomUUID(),
    title: '后续消息',
    autoTitle: false,
    projectPath: 'D:\\项目\\后续消息',
    createdAt: now,
    updatedAt: now,
    permissionMode: 'auto',
    model: null,
    effort: null,
    activeRun: { id: randomUUID(), status: 'running', connectionId },
  };
  const other = { ...session, id: randomUUID(), title: '另一会话', activeRun: null };
  const sessions = [session, other];
  const histories = new Map<string, SessionEvent[]>(sessions.map((item) => [item.id, []]));
  const add = (target: Session, payload: EventPayload) => {
    const events = histories.get(target.id)!;
    const event = {
      sessionId: target.id,
      runId: target.activeRun?.id ?? session.activeRun?.id ?? randomUUID(),
      sequence: events.length + 1,
      createdAt: now,
      payload,
    };
    events.push(event);
    return event;
  };
  add(session, {
    type: 'message.user',
    messageId: randomUUID(),
    text: '正在处理原来的任务',
    scenario: 'chat',
  });
  add(session, { type: 'run.status', status: 'running', connectionId });
  const sent: {
    type: string;
    text: string;
    sessionId: string;
    priority?: MessagePriority;
    attachments?: FileAttachment[];
  }[] = [];
  let send = (_value: unknown) => {};
  let failNext = false,
    holdReply = false;
  await page.addInitScript((mode) => {
    if (!localStorage.getItem('proxy-prefs'))
      localStorage.setItem('proxy-prefs', JSON.stringify({ followup: mode }));
  }, followup);
  const finish = (target = session, status: 'completed' | 'cancelled' | 'failed' = 'completed') => {
    send({
      type: 'session.event',
      event: add(target, { type: 'run.status', status, connectionId }),
    });
    target.activeRun = null;
    target.lastRunStatus = status;
    send({ type: 'session.updated', session: target });
  };
  await page.routeWebSocket('ws://127.0.0.1:18924/ws', (route) => {
    send = (value) => route.send(JSON.stringify(value));
    route.onMessage((raw) => {
      const message = JSON.parse(String(raw));
      if (message.type === 'device') return;
      if (message.type === 'auth')
        return send({
          type: 'ready',
          protocolVersion: PROTOCOL_VERSION,
          version: '0.3.20',
          connectionId,
          adapter: 'claude-code',
          sessions,
        });
      const target = sessions.find((item) => item.id === message.sessionId) ?? session;
      const events = histories.get(target.id)!;
      if (message.type === 'session.subscribe')
        send({
          type: 'session.snapshot',
          requestId: message.requestId,
          session: target,
          mode: 'replace',
          firstSequence: events[0]?.sequence ?? 0,
          lastSequence: events.length,
          hasEarlier: false,
          events,
        });
      if (message.type === 'session.outline')
        send({
          type: 'session.outline',
          requestId: message.requestId,
          sessionId: target.id,
          fromSequence: 1,
          throughSequence: events.length,
          entries: conversationOutline(events),
        });
      if (message.type === 'message.send') {
        sent.push(message);
        if (failNext) {
          failNext = false;
          return send({
            type: 'response',
            requestId: message.requestId,
            ok: false,
            code: 'fixture_rejection',
            message: '测试拒绝，消息未发送',
          });
        }
        target.activeRun ??= { id: randomUUID(), status: 'running', connectionId };
        send({ type: 'session.updated', session: target });
        send({
          type: 'session.event',
          event: add(target, {
            type: 'message.user',
            messageId: message.requestId,
            text: message.text,
            attachments: message.attachments,
            scenario: 'chat',
            priority: message.priority,
          }),
        });
        if (holdReply) return;
      }
      if (message.type === 'run.cancel') finish(target, 'cancelled');
      send({ type: 'response', requestId: message.requestId, ok: true });
    });
  });
  const connect = async () => {
    await page.goto('/');
    await page.getByLabel('服务地址', { exact: true }).fill('ws://127.0.0.1:18924/ws');
    await page.getByLabel('服务凭据', { exact: true }).fill('test-only-followup-message-token');
    await page.getByRole('button', { name: '连接', exact: true }).click();
    await page.locator('.session-select').filter({ hasText: '后续消息' }).click();
  };
  await connect();
  return {
    sent,
    session,
    other,
    finish,
    connect,
    fail: () => {
      failNext = true;
    },
    hold: () => {
      holdReply = true;
    },
  };
}

const input = (page: Page) => page.getByRole('textbox', { name: '消息', exact: true });
async function submit(page: Page, text: string) {
  await input(page).fill(text);
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
}
async function general(page: Page) {
  await page.getByRole('button', { name: '设置与账号', exact: true }).click();
  await page.getByRole('menuitem', { name: '设置', exact: true }).click();
  await page
    .getByRole('navigation', { name: '设置分类' })
    .getByRole('button', { name: '常规', exact: true })
    .click();
}

test('defaults and per-message overrides select native priority without changing the other', async ({
  page,
}) => {
  const f = await open(page);
  await submit(page, '普通追加');
  await expect.poll(() => f.sent.map((item) => item.priority)).toEqual(['next']);
  await input(page).fill('临时排队');
  await page.getByRole('button', { name: '本条消息发送方式' }).click();
  await page.getByRole('menuitemradio', { name: '排队', exact: true }).click();
  await expect(page.getByRole('list', { name: '待发送消息' })).toContainText('临时排队');
  expect(f.sent).toHaveLength(1);
  await expect(page.locator('.message.user')).not.toContainText(['临时排队']);
  await input(page).fill('这条立即引导');
  await page.getByRole('button', { name: '本条消息发送方式' }).click();
  await page.getByRole('menuitemradio', { name: '立即引导', exact: true }).click();
  await expect.poll(() => f.sent.map((item) => item.priority)).toEqual(['next', 'now']);
  await general(page);
  const modes = page.getByRole('radiogroup', { name: '运行中发送消息' });
  await expect(modes.getByRole('radio', { name: '追加消息', exact: true })).toBeChecked();
  await modes.getByRole('radio', { name: '排队', exact: true }).click();
  await expect(page.getByText(/等当前轮完成后发送/)).toBeVisible();
  await page.screenshot({ path: join(screenshots, 'followup-settings-light.png') });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: join(screenshots, 'followup-settings-dark-narrow.png') });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.reload();
  await f.connect();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('proxy-prefs')!).followup)).toBe(
    'later',
  );
  await submit(page, '默认改为排队');
  await expect(page.getByRole('list', { name: '待发送消息' })).toContainText('默认改为排队');
  expect(f.sent).toHaveLength(2);
  await general(page);
  await modes.getByRole('radio', { name: '立即引导', exact: true }).click();
  await page
    .getByRole('navigation', { name: '页面' })
    .getByRole('button', { name: '会话', exact: true })
    .click();
  await submit(page, '默认立即引导');
  await expect.poll(() => f.sent.length).toBe(3);
  expect(f.sent[2]).toMatchObject({ text: '默认立即引导', priority: 'now' });
});

test('a failed or remotely cancelled run pauses its queue even while another session is selected', async ({
  page,
}) => {
  const f = await open(page, 'later');
  for (const status of ['failed', 'cancelled'] as const) {
    const before = f.sent.length;
    await submit(page, `留待确认 ${status}`);
    await page.locator('.session-select').filter({ hasText: '另一会话' }).click();
    f.finish(f.session, status);
    await page.locator('.session-select').filter({ hasText: '后续消息' }).click();
    const queue = page.getByRole('list', { name: '待发送消息' });
    await expect(queue).toContainText('已暂停');
    expect(f.sent).toHaveLength(before);
    await queue.getByRole('button', { name: '发送', exact: true }).click();
    await expect.poll(() => f.sent.length).toBe(before + 1);
  }
});

test('editing removes the old entry and a new send joins the tail even when the default is append', async ({
  page,
}) => {
  const f = await open(page, 'next');
  for (const text of ['第一条', '第二条']) {
    await input(page).fill(text);
    await page.getByRole('button', { name: '本条消息发送方式' }).click();
    await page.getByRole('menuitemradio', { name: '排队', exact: true }).click();
  }
  const saved = () =>
    page.evaluate(
      (id) => JSON.parse(localStorage.getItem('proxy-drafts') ?? '{}')[id],
      f.session.id,
    );
  await expect.poll(async () => (await saved())?.queued?.length).toBe(2);
  const previousId = (await saved()).queued[0].id;
  const queue = page.getByRole('list', { name: '待发送消息' });
  await queue
    .getByRole('listitem')
    .filter({ hasText: '第一条' })
    .getByRole('button', { name: '排队消息操作' })
    .click();
  await page.getByRole('menuitem', { name: '编辑消息', exact: true }).click();
  await expect(queue.locator('.queued-message-body p')).toHaveText(['第二条']);
  await expect(input(page)).toHaveValue('第一条');
  await input(page).fill('第一条修改后');
  await expect.poll(async () => (await saved())?.requeue).toBe(true);
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect(queue.locator('.queued-message-body p')).toHaveText(['第二条', '第一条修改后']);
  expect(f.sent).toHaveLength(0);
  await expect.poll(async () => (await saved())?.queued?.length).toBe(2);
  expect((await saved()).queued.map((item: { id: string }) => item.id)).not.toContain(previousId);
  await expect(page.getByRole('button', { name: '发送消息', exact: true })).toHaveAttribute(
    'title',
    /^追加消息/,
  );
  await submit(page, '普通的新消息');
  await expect.poll(() => f.sent.length).toBe(1);
  expect(f.sent[0]).toMatchObject({ text: '普通的新消息', priority: 'next' });
  f.finish();
  await expect.poll(() => f.sent.length).toBe(2);
  expect(f.sent[1]).toMatchObject({ text: '第二条', priority: 'later' });
  f.finish();
  await expect.poll(() => f.sent.length).toBe(3);
  expect(f.sent[2]).toMatchObject({ text: '第一条修改后', priority: 'later' });
});

test('editing withdraws an attachment-only message into the composer until the user sends again', async ({
  page,
}) => {
  const f = await open(page, 'later');
  const deviceId = await page.evaluate(() => localStorage.getItem('proxy-device')!);
  const file: FileAttachment = {
    name: '中文文件.txt',
    path: 'D:\\项目\\中文文件.txt',
    deviceId,
    reference: 1,
    size: 128,
  };
  await page.addInitScript(
    ({ sessionId, file }) =>
      localStorage.setItem(
        'proxy-drafts',
        JSON.stringify({ [sessionId]: { text: '', attachments: [file] } }),
      ),
    { sessionId: f.session.id, file },
  );
  await f.connect();
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  const queue = page.getByRole('list', { name: '待发送消息' });
  await expect(queue).toContainText('中文文件.txt');
  expect(f.sent).toHaveLength(0);
  await queue.getByRole('button', { name: '排队消息操作' }).click();
  await page.getByRole('menuitem', { name: '编辑消息', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(queue).toHaveCount(0);
  await expect(page.locator('form.composer .attachment-card')).toContainText('中文文件.txt');
  await expect(input(page)).toBeFocused();
  f.finish();
  await expect(page.getByRole('button', { name: '停止运行', exact: true })).toHaveCount(0);
  expect(f.sent).toHaveLength(0);
  await input(page).fill('请检查 [文件 #1]');
  await input(page).press('Enter');
  await expect.poll(() => f.sent.length).toBe(1);
  expect(f.sent[0]).toMatchObject({
    text: '请检查 [文件 #1]',
    attachments: [file],
  });
  expect(f.sent[0].priority).toBeUndefined();
});

test('queued messages edit without losing the draft, can be removed or steered, and drain once after the run', async ({
  page,
}) => {
  const f = await open(page, 'later');
  await submit(page, '先排第一条');
  await submit(page, '这一条稍后删');
  const queue = page.getByRole('list', { name: '待发送消息' });
  const row = queue.getByRole('listitem').filter({ hasText: '先排第一条' });
  await input(page).fill('正在写的另一份草稿');
  await row.getByRole('button', { name: '排队消息操作' }).click();
  await page.getByRole('menuitem', { name: '编辑消息', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(input(page)).toHaveValue('先排第一条');
  await expect(input(page)).toBeFocused();
  await expect(row).toHaveCount(0);
  await expect(queue).not.toContainText('正在写的另一份草稿');
  await expect(page.getByRole('button', { name: '恢复暂存草稿' })).toBeVisible();
  await input(page).fill('编辑后的第一条');
  await page.screenshot({ path: join(screenshots, 'followup-queue-editor.png') });
  await queue
    .getByRole('listitem')
    .filter({ hasText: '这一条稍后删' })
    .getByRole('button', { name: '移除排队消息' })
    .click();
  await expect(queue).toHaveCount(0);
  expect(f.sent).toHaveLength(0);
  await page.screenshot({ path: join(screenshots, 'followup-queue-light.png') });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('.sidebar-shade')).toBeHidden();
  await page.screenshot({ path: join(screenshots, 'followup-queue-dark-narrow.png') });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await input(page).press('Control+Enter');
  await expect
    .poll(() => f.sent.map((item) => [item.text, item.priority]))
    .toEqual([['编辑后的第一条', 'now']]);
  await expect(input(page)).toHaveValue('正在写的另一份草稿');
  await expect(input(page)).toBeFocused();
  await expect(page.getByRole('button', { name: '恢复暂存草稿' })).toHaveCount(0);
  await expect(queue).toHaveCount(0);
  await submit(page, '自然结束后发送');
  await submit(page, '再发队列下一条');
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.locator('.session-select').filter({ hasText: '另一会话' }).click();
  await expect(queue).toHaveCount(0);
  f.finish();
  await expect.poll(() => f.sent.length).toBe(2);
  expect(f.sent[1]).toMatchObject({
    sessionId: f.session.id,
    text: '自然结束后发送',
    priority: 'later',
  });
  f.finish();
  await expect.poll(() => f.sent.length).toBe(3);
  expect(f.sent[2]).toMatchObject({ text: '再发队列下一条', priority: 'later' });
  await page.locator('.session-select').filter({ hasText: '后续消息' }).click();
  await expect(queue).toHaveCount(0);
});

test('an unsent draft does not block an edited queue entry after it is sent again', async ({
  page,
}) => {
  const f = await open(page, 'later');
  await submit(page, '排队的 A');
  await input(page).fill('未发送的 D');
  const queue = page.getByRole('list', { name: '待发送消息' });
  await queue.getByRole('button', { name: '排队消息操作' }).click();
  await page.getByRole('menuitem', { name: '编辑消息', exact: true }).click();
  await submit(page, '编辑后的 A');
  await expect(input(page)).toHaveValue('未发送的 D');
  await expect(queue.locator('.queued-message-body p')).toHaveText(['编辑后的 A']);
  f.finish();
  await expect.poll(() => f.sent.map((message) => message.text)).toEqual(['编辑后的 A']);
  await expect(input(page)).toHaveValue('未发送的 D');
});

test('successive queue edits retain each unsent draft and can restore it after reloading', async ({
  page,
}) => {
  const f = await open(page, 'later');
  for (const text of ['排队 A', '排队 B']) await submit(page, text);
  await input(page).fill('原草稿 D');
  const queue = page.getByRole('list', { name: '待发送消息' });
  for (const text of ['排队 A', '排队 B']) {
    await queue
      .getByRole('listitem')
      .filter({ hasText: text })
      .getByRole('button', { name: '排队消息操作' })
      .click();
    await page.getByRole('menuitem', { name: '编辑消息', exact: true }).click();
    await expect(input(page)).toHaveValue(text);
  }
  await expect(queue).toHaveCount(0);
  await f.connect();
  await expect(input(page)).toHaveValue('排队 B');
  const restore = page.getByRole('button', { name: '恢复暂存草稿' });
  await expect(restore).toHaveText('暂存草稿 2');
  await restore.click();
  await page.getByRole('menuitem', { name: '1. 原草稿 D', exact: true }).click();
  await expect(input(page)).toHaveValue('原草稿 D');
  await restore.click();
  await page.getByRole('menuitem', { name: '1. 排队 A', exact: true }).click();
  await expect(input(page)).toHaveValue('排队 A');
  expect(f.sent).toHaveLength(0);
  await input(page).press('Control+Enter');
  await expect.poll(() => f.sent.length).toBe(1);
  await expect(input(page)).toHaveValue('原草稿 D');
  await restore.click();
  await expect(input(page)).toHaveValue('排队 B');
});

test('stacked messages reorder by drag or menu and any entry can steer without sending the others', async ({
  page,
}) => {
  const f = await open(page, 'later');
  for (const text of ['第一条任务', '第二条任务', '第三条任务']) await submit(page, text);
  const queue = page.getByRole('list', { name: '待发送消息' });
  const row = (text: string) => queue.getByRole('listitem').filter({ hasText: text });
  const order = () => queue.locator('.queued-message-body p').allTextContents();
  const bounds = (await queue.boundingBox())!;
  const composer = (await page.locator('form.composer').boundingBox())!;
  expect(bounds.x).toBeGreaterThan(composer.x);
  expect(bounds.y + bounds.height - composer.y).toBeCloseTo(16, 0);
  await page.screenshot({ path: join(screenshots, 'followup-stack-light.png') });
  await row('第一条任务').getByRole('button', { name: '排队消息操作' }).click();
  await expect(page.getByRole('menuitem', { name: '上移', exact: true })).toBeDisabled();
  await page.getByRole('menuitem', { name: '下移', exact: true }).click();
  await expect.poll(order).toEqual(['第二条任务', '第一条任务', '第三条任务']);
  await row('第三条任务').getByRole('button', { name: '排队消息操作' }).click();
  await expect(page.getByRole('menuitem', { name: '下移', exact: true })).toBeDisabled();
  await page.getByRole('menuitem', { name: '上移', exact: true }).click();
  await expect.poll(order).toEqual(['第二条任务', '第三条任务', '第一条任务']);
  await row('第一条任务')
    .getByRole('button', { name: '拖动排序排队消息' })
    .dragTo(row('第三条任务'));
  await expect.poll(order).toEqual(['第二条任务', '第一条任务', '第三条任务']);
  expect(f.sent).toHaveLength(0);
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('.sidebar-shade')).toBeHidden();
  await expect(queue.getByRole('button', { name: '引导', exact: true }).last()).toBeInViewport();
  await expect(input(page)).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: join(screenshots, 'followup-stack-dark-narrow.png') });
  await row('第一条任务').getByRole('button', { name: '引导', exact: true }).click();
  await expect
    .poll(() => f.sent.map((message) => [message.text, message.priority]))
    .toEqual([['第一条任务', 'now']]);
  await expect.poll(order).toEqual(['第二条任务', '第三条任务']);
  f.finish();
  await expect.poll(() => f.sent.length).toBe(2);
  expect(f.sent[1]).toMatchObject({ text: '第二条任务', priority: 'later' });
  f.finish();
  await expect.poll(() => f.sent.length).toBe(3);
  expect(f.sent[2]).toMatchObject({ text: '第三条任务', priority: 'later' });
  await expect(queue).toHaveCount(0);
});

test('failed or unconfirmed queued sends stay available and never replay after finishing or reloading', async ({
  page,
}) => {
  await page.clock.install();
  const f = await open(page, 'later');
  await submit(page, '保留失败的消息');
  const queue = page.getByRole('list', { name: '待发送消息' });
  f.fail();
  await queue.getByRole('button', { name: '引导', exact: true }).click();
  await expect(queue.getByRole('alert')).toHaveText('测试拒绝，消息未发送');
  f.hold();
  await queue.getByRole('button', { name: '引导', exact: true }).evaluate((el) => {
    (el as HTMLButtonElement).click();
    (el as HTMLButtonElement).click();
  });
  await expect.poll(() => f.sent.length).toBe(2);
  await page.clock.fastForward(11000);
  await expect(queue.getByRole('alert')).toContainText('请求超时');
  f.finish();
  await page.clock.fastForward(1000);
  expect(f.sent).toHaveLength(2);
  await page.reload();
  await f.connect();
  await expect(queue).toContainText('保留失败的消息');
  await expect(queue.getByRole('alert')).toContainText('请求超时');
  expect(f.sent).toHaveLength(2);
});

test('steering shortcuts respect composition, local commands keep queued content and stopping pauses it', async ({
  page,
}) => {
  const f = await open(page, 'later');
  await input(page).fill('键盘引导队首');
  await input(page).press('Enter');
  await expect(page.getByRole('list', { name: '待发送消息' })).toContainText('键盘引导队首');
  await input(page).press('Control+Enter');
  await expect.poll(() => f.sent.map((item) => item.priority)).toEqual(['now']);
  await input(page).fill('组合键引导草稿');
  await input(page).press('Control+x');
  await input(page).press('Control+s');
  await expect.poll(() => f.sent.length).toBe(2);
  expect(f.sent[1]).toMatchObject({ text: '组合键引导草稿', priority: 'now' });
  await input(page).fill('输入法中的文字');
  await input(page).dispatchEvent('keydown', {
    key: 'Enter',
    code: 'Enter',
    ctrlKey: true,
    isComposing: true,
  });
  expect(f.sent).toHaveLength(2);
  await expect(input(page)).toHaveValue('输入法中的文字');
  await submit(page, '停止后留在队列');
  await submit(page, '/status');
  expect(f.sent).toHaveLength(2);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '停止运行', exact: true }).click();
  const queue = page.getByRole('list', { name: '待发送消息' });
  await expect(queue).toContainText('已暂停');
  expect(f.sent).toHaveLength(2);
  await queue.getByRole('button', { name: '排队消息操作' }).click();
  await page.getByRole('menuitem', { name: '继续排队', exact: true }).click();
  await expect.poll(() => f.sent.length).toBe(3);
  expect(f.sent[2]).toMatchObject({ text: '停止后留在队列', priority: 'later' });
});
