import { test, expect, _electron } from '@playwright/test';
import type { Page, WebSocketRoute } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PROTOCOL_VERSION } from '@cc-desk-tunnel/protocol';
import type { Session, SessionEvent, EventPayload } from '@cc-desk-tunnel/protocol';
import { login, screenshots } from './helpers.ts';

async function open(page: Page, { desktop = true, history = 0, foreign = false } = {}) {
  const device = { id: randomUUID(), name: '附件测试电脑', platform: 'darwin' as const };
  const elsewhere = { ...device, id: randomUUID(), name: '另一台电脑' };
  const now = new Date().toISOString();
  const connectionId = randomUUID();
  const session: Session = {
    id: randomUUID(),
    title: '附件会话',
    autoTitle: false,
    projectPath: '/fixtures/project',
    device,
    permissionMode: 'auto',
    model: null,
    effort: null,
    createdAt: now,
    updatedAt: now,
    activeRun: null,
  };
  const other = { ...session, id: randomUUID(), title: '另一会话' };
  const remote = { ...session, id: randomUUID(), title: '异地会话', device: elsewhere };
  const sessions = [session, other, remote];
  const events = new Map<string, SessionEvent[]>(sessions.map((session) => [session.id, []]));
  let sequence = 0;
  const event = (sessionId: string, runId: string, payload: EventPayload): SessionEvent => ({
    sessionId,
    runId,
    sequence: ++sequence,
    payload,
    createdAt: now,
  });
  for (let i = 0; i < history; i++) {
    const runId = randomUUID();
    events.get(session.id)!.push(
      event(session.id, runId, {
        type: 'message.user',
        messageId: randomUUID(),
        text: '',
        scenario: 'chat',
        attachments: [
          {
            path: `/fixtures/history-${i}.png`,
            name: `history-${i}.png`,
            size: 1024,
            deviceId: foreign ? elsewhere.id : device.id,
          },
        ],
      }),
      event(session.id, runId, {
        type: 'text.delta',
        messageId: randomUUID(),
        text: `第 ${i} 个文件的回复。`,
      }),
      event(session.id, runId, { type: 'run.status', status: 'completed', connectionId }),
    );
  }
  await page.addInitScript(
    ({ desktop, device }) => {
      localStorage.setItem('proxy-device', device.id);
      const state: any = window;
      state.fileCalls = [];
      state.pickedFiles = ['/fixtures/tcpfit.sh', '/fixtures/报告.docx'];
      state.failedImages = 0;
      window.addEventListener(
        'error',
        (event) => {
          if (
            event.target instanceof HTMLImageElement &&
            event.target.src.startsWith('local-image:')
          )
            state.failedImages++;
        },
        true,
      );
      if (!desktop) return;
      const empty = async () => {};
      const listener = () => () => {};
      state.desktop = {
        dev: true,
        platform: 'darwin',
        boot: { connection: '', shared: { connections: [], busy: [] } },
        onSharedChanged: listener,
        saveShared: empty,
        setBusy: empty,
        onNotifyClicked: listener,
        onUpdateProgress: listener,
        onProxyClosed: listener,
        notify: empty,
        version: async () => '0.3.18',
        loadLogin: async () => null,
        saveLogin: empty,
        disconnectProxy: empty,
        loadDrafts: async () => JSON.parse(localStorage.getItem('fixture-drafts') ?? '{}'),
        saveDrafts: async (drafts: unknown) =>
          localStorage.setItem('fixture-drafts', JSON.stringify(drafts)),
        workspaceRoots: async () => [],
        loadSchedules: async () => ({ path: '/fixtures/schedules.json', text: '[]' }),
        onSchedulesChanged: listener,
        device: async () => device,
        foldersExist: async (paths: string[]) => paths.map(() => true),
        gitBranch: async () => 'main',
        chooseFiles: async () =>
          state.holdChoose
            ? new Promise((resolve) => {
                state.finishChoose = resolve;
              })
            : state.pickedFiles,
        pathForFile: (file: File) =>
          file.name === 'clipboard.png' ? '' : `/fixtures/${file.name}`,
        saveImage: async (type: string, bytes: Uint8Array) => {
          state.fileCalls.push(['saveImage', type, bytes.length]);
          if (state.failSave) throw new Error('模拟图片保存失败');
          return '/fixtures/pasted.png';
        },
        inspectPath: async (path: string) => {
          state.fileCalls.push(['inspect', path]);
          return {
            kind: path.includes('missing') ? 'missing' : 'file',
            size: 1200,
            runs: path.endsWith('.sh'),
            editors: [{ scheme: 'vscode', name: 'VS Code' }],
            openWith: false,
          };
        },
        previewText: async (path: string) => {
          state.fileCalls.push(['preview', path]);
          if (path.endsWith('.docx') || path.endsWith('.pdf')) return { kind: 'unsupported' };
          return {
            kind: 'text',
            text: '#!/bin/sh\necho 本机预览\n<script>window.executed = true</script>',
            truncated: false,
          };
        },
        actOnPath: async (...args: unknown[]) => {
          state.fileCalls.push(['act', ...args]);
          return '';
        },
        copyText: async (text: string) => {
          state.copied = text;
        },
        saveFile: async (name: string, text: string) => {
          state.exported = { name, text };
          return true;
        },
      };
    },
    { desktop, device },
  );
  const requests: any[] = [];
  const fail = {
    configure: false,
    message: false,
    delivery: 'received' as 'received' | 'not_sent',
  };
  let socket: WebSocketRoute;
  const send = (value: unknown) => socket.send(JSON.stringify(value));
  await page.routeWebSocket('ws://127.0.0.1:18916/ws', (route) => {
    socket = route;
    route.onMessage((raw) => {
      const message = JSON.parse(String(raw));
      requests.push(message);
      if (message.type === 'device' || message.type === 'session.history.next') return;
      if (message.type === 'auth') {
        send({
          type: 'ready',
          protocolVersion: PROTOCOL_VERSION,
          version: '0.3.18',
          connectionId,
          adapter: 'claude-code',
          sessions,
        });
        send({
          type: 'devices',
          devices: [
            { ...device, ready: true },
            { ...elsewhere, ready: true },
          ],
        });
        return;
      }
      if (message.type === 'session.subscribe') {
        const session = sessions.find((session) => session.id === message.sessionId)!;
        const content = events.get(session.id)!;
        const snapshot = JSON.stringify([
          {
            type: 'session.snapshot',
            requestId: message.requestId,
            session,
            mode: 'replace',
            firstSequence: content.at(0)?.sequence ?? 0,
            lastSequence: content.at(-1)?.sequence ?? 0,
            hasEarlier: false,
            events: content,
          },
        ]);
        for (let at = 0; at < snapshot.length; at += 16384)
          send({
            type: 'session.history.part',
            requestId: message.requestId,
            sessionId: session.id,
            data: snapshot.slice(at, at + 16384),
            last: at + 16384 >= snapshot.length,
          });
      }
      if (
        (message.type === 'session.configure' && fail.configure) ||
        (message.type === 'message.send' && fail.message)
      ) {
        send({
          type: 'response',
          requestId: message.requestId,
          ok: false,
          code: 'fixture',
          message: '模拟请求失败',
        });
        return;
      }
      if (message.type === 'session.configure') {
        session.permissionMode = message.permissionMode;
        send({ type: 'session.updated', session });
      }
      if (message.type === 'message.send') {
        const runId = randomUUID();
        for (const payload of [
          {
            type: 'message.user',
            messageId: message.requestId,
            text: message.text,
            attachments: message.attachments,
            scenario: 'chat',
          },
          { type: 'message.delivery', messageId: message.requestId, status: fail.delivery },
          { type: 'text.delta', messageId: randomUUID(), text: '已收到文件引用。' },
          { type: 'run.status', status: 'completed', connectionId },
        ] as EventPayload[]) {
          const item = event(message.sessionId, runId, payload);
          events.get(message.sessionId)!.push(item);
          send({ type: 'session.event', event: item });
        }
      }
      if (message.type === 'session.fork') {
        const fork = { ...session, id: randomUUID(), title: '附件会话（分叉）' };
        sessions.push(fork);
        events.set(fork.id, []);
        send({ type: 'session.updated', session: fork });
        send({ type: 'response', requestId: message.requestId, ok: true, sessionId: fork.id });
        return;
      }
      if (message.requestId) send({ type: 'response', requestId: message.requestId, ok: true });
    });
  });
  const select = async (title: string) => {
    const expand = page.getByRole('button', { name: '展开会话列表', exact: true });
    if (await expand.isVisible()) await expand.click();
    if (title === remote.title) {
      const elsewhere = page.getByRole('button', { name: /其他设备/ });
      if (await elsewhere.count()) await elsewhere.click();
    }
    await page.locator('.session-select').filter({ hasText: title }).click();
  };
  const signIn = async () => {
    const local = page.getByRole('button', { name: '本地模拟', exact: true });
    if (await local.isVisible()) await local.click();
    await page.getByLabel('服务地址', { exact: true }).fill('ws://127.0.0.1:18916/ws');
    await page
      .getByLabel('服务凭据', { exact: true })
      .fill('test-only-attachments-token-long-enough');
    await page.getByRole('button', { name: '连接', exact: true }).click();
    await select(session.title);
    await expect(page.getByRole('textbox', { name: '消息', exact: true })).toBeVisible();
  };
  await page.goto('/');
  await signIn();
  return { session, other, remote, device, requests, fail, select, signIn };
}

const add = (page: Page) => page.getByRole('button', { name: '添加文件', exact: true }).click();

test('file cards insert references and preview locally without executing scripts', async ({
  page,
}) => {
  const f = await open(page);
  const body = page.getByRole('textbox', { name: '消息', exact: true });
  await body.fill('检查这两个文件');
  await add(page);
  const cards = page.locator('.composer .attachment-card');
  await expect(cards).toHaveCount(2);
  await expect(body).toHaveValue('检查这两个文件[文件 #1] [文件 #2]');
  await add(page);
  await expect(cards).toHaveCount(2);
  const calls = await page.evaluate(() => (window as any).fileCalls.length);
  await body.pressSequentially('，不要改动');
  expect(await page.evaluate(() => (window as any).fileCalls.length)).toBe(calls);
  const trigger = page.getByRole('button', { name: '预览 tcpfit.sh', exact: true });
  await trigger.click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.locator('pre')).toContainText('<script>window.executed = true</script>');
  expect(await page.evaluate(() => (window as any).executed)).toBeUndefined();
  await expect(dialog.getByRole('button', { name: '用默认应用打开', exact: true })).toHaveCount(0);
  await dialog.getByRole('button', { name: '在 VS Code 打开', exact: true }).click();
  expect(await page.evaluate(() => (window as any).fileCalls.at(-1))).toEqual([
    'act',
    'editor',
    '/fixtures/tcpfit.sh',
    { editor: 'vscode' },
  ]);
  await page.keyboard.press('Escape');
  await expect(trigger).toBeFocused();
  await page.getByRole('button', { name: '预览 报告.docx', exact: true }).click();
  await expect(dialog).toContainText('此格式或文本编码暂不支持预览');
  await dialog.getByRole('button', { name: '复制路径', exact: true }).click();
  expect(await page.evaluate(() => (window as any).copied)).toBe('/fixtures/报告.docx');
  await page.keyboard.press('Escape');
  await page.screenshot({ path: join(screenshots, 'attachments-light.png') });
  await page.getByRole('button', { name: '移除 tcpfit.sh', exact: true }).click();
  await expect(cards).toHaveCount(1);
  await body.fill('"/fixtures/manual.txt"');
  await expect(cards).toHaveCount(1);
  await page.evaluate(() => {
    (window as any).pickedFiles = ['/fixtures/missing.txt'];
  });
  await add(page);
  await expect(cards).toHaveCount(2);
  await expect(page.locator('.composer [role=alert]')).toContainText('本机找不到这个文件');
  await page.getByRole('button', { name: '预览 missing.txt', exact: true }).click();
  await expect(dialog).toContainText('本机找不到这个文件');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '移除 missing.txt', exact: true }).click();
  await expect(page.locator('.composer [role=alert]')).toHaveCount(0);
  expect(f.requests.filter((request) => request.type === 'message.send')).toHaveLength(0);
});

test('an inline attachment stays between sentences through reading, sending, copy and editing', async ({
  page,
}) => {
  const f = await open(page);
  const body = page.getByRole('textbox', { name: '消息', exact: true });
  await body.fill('先检查。再修改。');
  await body.evaluate((box: HTMLTextAreaElement) => box.setSelectionRange(3, 3));
  await page.evaluate(() => {
    (window as any).holdChoose = true;
  });
  await add(page);
  // The picker result arrives after an edit before the saved insertion point.
  await body.evaluate((box: HTMLTextAreaElement) => box.setSelectionRange(0, 0));
  await body.pressSequentially('请');
  await page.evaluate(() => (window as any).finishChoose(['/fixtures/tcpfit.sh']));
  await expect(body).toHaveValue('请先检查[文件 #1]。再修改。');
  expect(await body.evaluate((box: HTMLTextAreaElement) => box.selectionStart)).toBe(1);
  await page.getByRole('button', { name: '移除 tcpfit.sh', exact: true }).click();
  await expect(body).toHaveValue('请先检查。再修改。');
  await body.evaluate((box: HTMLTextAreaElement) => box.setSelectionRange(4, 4));
  await page.evaluate(() => {
    (window as any).holdChoose = false;
    (window as any).pickedFiles = ['/fixtures/tcpfit.sh'];
  });
  await add(page);
  await expect(body).toHaveValue('请先检查[文件 #1]。再修改。');
  expect(await body.evaluate((box: HTMLTextAreaElement) => box.selectionStart)).toBe(
    '请先检查[文件 #1]'.length,
  );
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  expect(f.requests.filter((request) => request.type === 'message.send').at(-1).text).toBe(
    '请先检查[文件 #1]。再修改。',
  );
  await page
    .locator('.message.user')
    .getByRole('button', { name: '复制消息', exact: true })
    .click();
  expect(await page.evaluate(() => (window as any).copied)).toBe(
    '请先检查"/fixtures/tcpfit.sh"。再修改。',
  );
  await page
    .locator('.message.user')
    .getByRole('button', { name: '编辑重发', exact: true })
    .click();
  await expect(body).toHaveValue('请先检查[文件 #1]。再修改。');
  await expect(page.locator('.composer .attachment-card')).toHaveCount(1);
});

test('pending selections stay in their originating draft and recover after a reload', async ({
  page,
}) => {
  const f = await open(page);
  await page.evaluate(() => {
    (window as any).holdChoose = true;
  });
  await add(page);
  await expect(page.getByText('正在添加文件…', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeDisabled();
  await f.select(f.other.title);
  await expect(page.locator('.composer .attachment-card')).toHaveCount(0);
  await page.evaluate(() => (window as any).finishChoose(['/fixtures/late.txt']));
  await expect(page.locator('.composer .attachment-card')).toHaveCount(0);
  await f.select(f.session.title);
  await expect(page.locator('.composer .attachment-card')).toContainText('late.txt');
  await expect(page.getByText('正在添加文件…', { exact: true })).toHaveCount(0);
  await page.waitForTimeout(400);
  await page.reload();
  await f.signIn();
  await expect(page.locator('.composer .attachment-card')).toContainText('late.txt');
  await page.evaluate(() => {
    (window as any).failSave = true;
  });
  await page.getByRole('textbox', { name: '消息', exact: true }).evaluate((box) => {
    const data = new DataTransfer();
    data.items.add(new File(['fixture'], 'clipboard.png', { type: 'image/png' }));
    box.dispatchEvent(
      new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }),
    );
  });
  await expect(page.locator('.composer [role=alert]')).toContainText('模拟图片保存失败');
  await expect(page.locator('.composer .attachment-card')).toHaveCount(1);
  await page.locator('.composer').evaluate((box) => {
    const data = new DataTransfer();
    data.items.add(new File(['text'], 'drop.txt', { type: 'text/plain' }));
    box.dispatchEvent(
      new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data }),
    );
  });
  await expect(page.locator('.composer .attachment-card')).toHaveCount(2);
});

test('plan, failed sends, history, copy, search and edit-fork retain attachment references', async ({
  page,
}) => {
  const f = await open(page);
  await page.evaluate(() => {
    (window as any).pickedFiles = ['/fixtures/tcpfit.sh'];
  });
  await add(page);
  const body = page.getByRole('textbox', { name: '消息', exact: true });
  await body.fill('/plan 检查文件');
  f.fail.configure = true;
  await body.press('Enter');
  await expect(page.locator('.error-banner')).toContainText('模拟请求失败');
  await expect(body).toHaveValue('/plan 检查文件');
  expect(f.requests.filter((request) => request.type === 'message.send')).toHaveLength(0);
  f.fail.configure = false;
  f.fail.message = true;
  await body.press('Enter');
  await expect(body).toHaveValue('检查文件');
  await expect(body).toBeEnabled();
  await expect(page.locator('.composer .attachment-card')).toHaveCount(1);
  const ordered = f.requests.filter((request) =>
    ['session.configure', 'message.send'].includes(request.type),
  );
  expect(ordered.slice(-2).map((request) => request.type)).toEqual([
    'session.configure',
    'message.send',
  ]);
  await body.fill('/plan');
  await body.press('Enter');
  await expect(body).toHaveValue('');
  await expect(page.locator('.composer .attachment-card')).toHaveCount(1);
  await body.fill('/status');
  await body.press('Enter');
  await expect(body).toHaveValue('');
  await expect(page.locator('.composer .attachment-card')).toHaveCount(1);
  await page.keyboard.press('Escape');
  f.fail.message = false;
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  const sent = f.requests.filter((request) => request.type === 'message.send').at(-1);
  expect(sent.text).toBe('');
  expect(sent.attachments).toEqual([
    {
      path: '/fixtures/tcpfit.sh',
      name: 'tcpfit.sh',
      size: 1200,
      deviceId: f.device.id,
      reference: 1,
    },
  ]);
  await expect(page.locator('.composer .attachment-card')).toHaveCount(0);
  await expect(page.locator('.message.user .attachment-card')).toHaveCount(1);
  await page
    .locator('.message.user')
    .getByRole('button', { name: '复制消息', exact: true })
    .click();
  expect(await page.evaluate(() => (window as any).copied)).toBe('"/fixtures/tcpfit.sh"');
  await page.getByRole('button', { name: '打开对话查找', exact: true }).click();
  await page.getByLabel('查找对话内容', { exact: true }).fill('tcpfit.sh');
  await expect(page.locator('.find-count')).toContainText('1 / 1');
  await page.getByLabel('查找对话内容', { exact: true }).press('Escape');
  await page.reload();
  await f.signIn();
  await expect(page.locator('.message.user .attachment-card')).toContainText('tcpfit.sh');
  await page
    .locator('.message.user')
    .getByRole('button', { name: '编辑重发', exact: true })
    .click();
  await expect(page.locator('.session-row.selected')).toContainText('分叉');
  await expect(page.locator('.composer .attachment-card')).toContainText('tcpfit.sh');
  await expect(body).toHaveValue('');
});

test('confirmed non-delivery restores files in place and another-device sessions cannot attach local files', async ({
  page,
}) => {
  const f = await open(page);
  f.fail.delivery = 'not_sent';
  await add(page);
  await page.getByRole('textbox', { name: '消息', exact: true }).fill('检查文件');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect(page.locator('.composer .attachment-card')).toHaveCount(0);
  await page
    .locator('.message.user')
    .getByRole('button', { name: '编辑重发', exact: true })
    .click();
  await expect(page.locator('.composer .attachment-card')).toHaveCount(2);
  await expect(page.getByRole('textbox', { name: '消息', exact: true })).toHaveValue('检查文件');
  expect(f.requests.some((request) => request.type === 'session.fork')).toBe(false);
  await f.select(f.remote.title);
  await expect(
    page.getByRole('button', { name: '只能向本机执行的会话添加文件', exact: true }),
  ).toBeDisabled();
});

for (const desktop of [true, false]) {
  test(`history from another device never reads local files · ${desktop ? 'desktop' : 'browser'}`, async ({
    page,
  }) => {
    await open(page, { desktop, history: 1, foreign: true });
    await expect(page.locator('.message.user .attachment-card')).toHaveCount(1);
    await expect(page.locator('.attachment-thumbnail img')).toHaveCount(0);
    await page.getByRole('button', { name: '预览 history-0.png', exact: true }).click();
    await expect(page.getByRole('dialog')).toContainText('请在文件所属的电脑上预览');
    expect(await page.evaluate(() => (window as any).fileCalls)).toEqual([]);
    await page.keyboard.press('Escape');
  });
}

test('1000 historical attachments do not inspect every file and previews remain lazy', async ({
  page,
}) => {
  await open(page, { history: 1000 });
  await expect(page.locator('.message.user .attachment-card')).toHaveCount(1000);
  expect(await page.evaluate(() => (window as any).fileCalls)).toEqual([]);
  await expect(page.locator('.attachment-thumbnail img:not([loading=lazy])')).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).failedImages)).toBeLessThan(100);
  await page.getByRole('button', { name: '预览 history-999.png', exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(() => [
        ...new Set(
          (window as any).fileCalls
            .filter((call: unknown[]) => call[0] === 'inspect')
            .map((call: unknown[]) => call[1]),
        ),
      ]),
    )
    .toEqual(['/fixtures/history-999.png']);
});

test('Electron previews actual local images and handles 50 mixed attachments without deleting files', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ccdt-attachments-'));
  const profile = mkdtempSync(resolve('.local/attachment-profile-'));
  const files = Array.from({ length: 50 }, (_, i) =>
    join(root, `文件 ${i}.${['svg', 'sh', 'txt', 'pdf'][i % 4]}`),
  );
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="#edf0f6"/><rect x="35" y="55" width="90" height="70" rx="8" fill="#658077"/><path d="M135 90h50" stroke="#6f7886" stroke-width="4"/><rect x="195" y="55" width="90" height="70" rx="8" fill="#c5ccd6"/></svg>';
  for (const file of files)
    writeFileSync(
      file,
      file.endsWith('.svg')
        ? svg
        : file.endsWith('.pdf')
          ? '%PDF-fixture'
          : '#!/bin/sh\necho 本机文件预览\n',
    );
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined && entry[0] !== 'ELECTRON_RUN_AS_NODE',
    ),
  );
  const application = await _electron.launch({
    args: [resolve('apps/desktop'), '--smoke-test', `--user-data-dir=${profile}`],
    env,
  });
  try {
    const page = await application.firstWindow();
    await expect(page.getByRole('button', { name: '本地模拟', exact: true })).toBeVisible();
    await login(page);
    await application.evaluate(
      ({ dialog }, { root, files }) => {
        dialog.showOpenDialog = (async (_window: unknown, options: { properties: string[] }) => ({
          canceled: false,
          filePaths: options.properties.includes('openDirectory') ? [root] : files,
        })) as typeof dialog.showOpenDialog;
      },
      { root, files },
    );
    await page.getByRole('button', { name: '添加项目', exact: true }).click();
    await page.getByRole('button', { name: `新建会话 · ${root}`, exact: true }).click();
    const started = Date.now();
    await add(page);
    await expect(page.getByText('正在添加文件…', { exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: /展开附件/ }).click();
    await expect(page.locator('.composer .attachment-card')).toHaveCount(50);
    const addMs = Date.now() - started;
    const image = page.locator('.composer .attachment-thumbnail img').first();
    await expect
      .poll(() => image.evaluate((image: HTMLImageElement) => image.naturalWidth))
      .toBe(320);
    await page.getByRole('button', { name: '预览 文件 0.svg', exact: true }).click();
    await expect
      .poll(() =>
        page
          .getByRole('dialog')
          .locator('img')
          .evaluate((image: HTMLImageElement) => image.naturalWidth),
      )
      .toBe(320);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('button', { name: '预览 文件 0.svg', exact: true })).toBeFocused();
    await page.getByRole('button', { name: '预览 文件 1.sh', exact: true }).click();
    await expect(page.getByRole('dialog').locator('pre')).toContainText('echo 本机文件预览');
    await page.keyboard.press('Escape');
    const typed = Date.now();
    await page
      .getByRole('textbox', { name: '消息', exact: true })
      .pressSequentially('abcdefghijklmnopqrstuvwxyz0123456789');
    const perKeyMs = (Date.now() - typed) / 36;
    await page.screenshot({ path: join(screenshots, 'attachments-electron-light.png') });
    await page.evaluate(() => {
      document.documentElement.dataset.theme = 'dark';
    });
    await application.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].setSize(440, 760);
    });
    await expect(page.locator('.shell')).toHaveClass(/side-closed/);
    await expect(page.locator('.sidebar')).toBeHidden();
    await expect(page.getByRole('textbox', { name: '消息', exact: true })).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({ path: join(screenshots, 'attachments-electron-dark-narrow.png') });
    await page.getByRole('textbox', { name: '消息', exact: true }).fill('长正文\n'.repeat(400));
    const sendButton = (await page
      .getByRole('button', { name: '发送消息', exact: true })
      .boundingBox())!;
    expect(sendButton.y + sendButton.height).toBeLessThanOrEqual(
      await page.evaluate(() => innerHeight),
    );
    await expect(page.getByRole('textbox', { name: '消息', exact: true })).toBeInViewport();
    const removed = Date.now();
    for (let i = 0; i < 50; i++) await page.locator('.composer .attachment-remove').first().click();
    await expect(page.locator('.composer .attachment-card')).toHaveCount(0);
    const removeMs = Date.now() - removed;
    expect(readdirSync(root)).toHaveLength(50);
    // A real File/IPC/image-protocol round trip, without changing the computer's clipboard.
    await page.getByRole('textbox', { name: '消息', exact: true }).evaluate((box) => {
      const bytes = Uint8Array.from(
        atob(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
        ),
        (character) => character.charCodeAt(0),
      );
      const clipboard = new DataTransfer();
      clipboard.items.add(new File([bytes], 'clipboard.png', { type: 'image/png' }));
      box.dispatchEvent(
        new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: clipboard }),
      );
    });
    await expect(page.locator('.composer .attachment-card')).toHaveCount(1);
    await expect
      .poll(() =>
        page
          .locator('.composer .attachment-thumbnail img')
          .evaluate((image: HTMLImageElement) => image.naturalWidth),
      )
      .toBe(1);
    await expect
      .poll(async () =>
        page.evaluate(async () => {
          const drafts = (await window.desktop!.loadDrafts()) as Record<
            string,
            { attachments: { path: string }[] }
          >;
          return Object.values(drafts).flatMap((draft) => draft.attachments).length;
        }),
      )
      .toBe(1);
    const pasted = await page.evaluate(async () => {
      const drafts = (await window.desktop!.loadDrafts()) as Record<
        string,
        { attachments: { path: string }[] }
      >;
      return Object.values(drafts).flatMap((draft) => draft.attachments)[0].path;
    });
    expect(existsSync(pasted)).toBe(true);
    await page.locator('.composer .attachment-remove').click();
    expect(existsSync(pasted)).toBe(true);
    console.log(JSON.stringify({ files: 50, addMs, perKeyMs, removeMs }));
    expect(addMs).toBeLessThan(5000);
    expect(perKeyMs).toBeLessThan(100);
  } finally {
    await application.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(profile, { recursive: true, force: true });
  }
});
