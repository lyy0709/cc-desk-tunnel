import { test, expect } from '@playwright/test';
import type { Page, WebSocketRoute } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { PROTOCOL_VERSION } from '@cc-desk-tunnel/protocol';
import type { Session, EventPayload } from '@cc-desk-tunnel/protocol';
import { screenshots } from './helpers.ts';

async function open(
  page: Page,
  options: {
    desktop?: boolean;
    running?: boolean;
    reconnect?: boolean;
    startOnSend?: boolean;
  } = {},
) {
  const desktop = options.desktop !== false;
  const device = { id: randomUUID(), name: '本机 Mac', platform: 'darwin' as const };
  const connectionId = randomUUID();
  const runId = randomUUID();
  const now = new Date().toISOString();
  const session: Session = {
    id: randomUUID(),
    title: '本机变更',
    autoTitle: false,
    projectPath: '/fixtures/项目',
    device,
    permissionMode: 'auto',
    model: null,
    effort: null,
    createdAt: now,
    updatedAt: now,
    activeRun: options.running ? { id: runId, status: 'running', connectionId } : null,
  };
  const other: Session = {
    ...session,
    id: randomUUID(),
    title: '另一个项目',
    projectPath: '/fixtures/另一个项目',
    activeRun: null,
  };
  const remote: Session = {
    ...session,
    id: randomUUID(),
    title: '另一台电脑',
    device: { ...device, id: randomUUID(), name: '远程电脑' },
    activeRun: null,
  };
  await page.addInitScript(
    ({ desktop, device }) => {
      localStorage.setItem('proxy-device', device.id);
      localStorage.setItem(
        'proxy-prefs',
        JSON.stringify({ quotaReads: false, view: { mode: 'expanded' } }),
      );
      if (!desktop) return;
      const calls: unknown[][] = [];
      (window as any).localCalls = calls;
      const empty = async () => {};
      const listener = () => () => {};
      const file = (directory: string, name: string, status = 'M') => ({
        path: name,
        absolutePath: `${directory}/${name}`,
        status,
        kind: 'file',
        added: 2,
        removed: 1,
      });
      const listeners = new Set<(id: string, summary: unknown) => void>();
      const counts = new Map<string, number>();
      const finished = new Set<string>();
      (window as any).changeLines = (lines: number) => {
        const id = (window as any).latestTurn;
        counts.set(id, lines);
        for (const listener of listeners)
          listener(id, { added: lines, removed: 0, count: lines ? 1 : 0 });
      };
      (window as any).desktop = {
        startTurnChanges: async (id: string) => {
          (window as any).latestTurn = id;
          counts.set(id, 0);
          if ((window as any).holdTurn)
            await new Promise<void>((resolve) => {
              (window as any).readyTurn = resolve;
            });
        },
        finishTurnChanges: async (id: string) => {
          finished.add(id);
          for (const listener of listeners) listener(id, {});
        },
        refreshTurnChanges: empty,
        releaseTurnChanges: empty,
        onTurnChanges: (fn: (id: string, summary: unknown) => void) => {
          listeners.add(fn);
          return () => listeners.delete(fn);
        },
        turnFiles: async (id: string) => ({
          root: '/fixtures/项目',
          branch: null,
          baselineAt: '2026-11-17T00:00:00Z',
          finished: finished.has(id),
          files: counts.get(id)
            ? [{ ...file('/fixtures/项目', 'live.ts'), added: counts.get(id), removed: 0 }]
            : [],
        }),
        turnDiff: async (id: string) => ({
          kind: 'text',
          patch: '@@ -0,0 +1,1 @@\n+turn-lines-' + counts.get(id) + '\n',
        }),
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
        version: async () => '0.3.16',
        loadLogin: async () => null,
        loginOwner: async () => null,
        saveLogin: empty,
        disconnectProxy: empty,
        loadDrafts: async () => ({}),
        saveDrafts: empty,
        connectProxy: async () => ({ url: 'ws://127.0.0.1:18913/ws' }),
        workspaceRoots: async () => [],
        loadSchedules: async () => ({ path: '/fixtures/schedules.json', text: '[]' }),
        onSchedulesChanged: listener,
        device: async () => device,
        foldersExist: async (paths: string[]) => paths.map(() => true),
        gitBranch: async (directory: string) => {
          calls.push(['branch', directory]);
          return 'main';
        },
        projectChanges: async (directory: string, scope: string, reset?: boolean) => {
          calls.push(['changes', directory, scope]);
          if ((window as any).listError) throw new Error('读取 Git 失败：fixture');
          if ((window as any).snapshotProject) {
            if (reset) (window as any).snapshotReset = true;
            return {
              root: directory,
              branch: null,
              baselineAt: '2026-11-17T00:00:00Z',
              files: (window as any).snapshotReset ? [] : [file(directory, 'local.txt')],
            };
          }
          return {
            root: directory,
            branch: 'main',
            counts: { unstaged: 3, staged: 1 },
            files:
              scope === 'staged'
                ? [{ ...file(directory, 'staged.ts', 'A'), workingTreeChanged: true }]
                : [
                    file(directory, 'src/中文 文件.ts'),
                    file(directory, 'removed.ts', 'D'),
                    { ...file(directory, 'image.png'), kind: 'binary', added: null, removed: null },
                  ],
          };
        },
        projectDiff: async () => ({ kind: 'text', patch: '@@ -1,1 +1,1 @@\n-before\n+after\n' }),
        gitDiff: async (directory: string, scope: string, name: string) => {
          calls.push(['diff', directory, scope, name]);
          if ((window as any).holdDiff)
            return new Promise((resolve) => {
              (window as any).finishDiff = resolve;
            });
          if (name === 'image.png') return { kind: 'binary', patch: '' };
          return {
            kind: 'text',
            patch: `@@ -1,2 +1,2 @@\n-old\n+LOCAL_ONLY_${directory}\n context\n${Array.from({ length: 55 }, (_, i) => `+line ${i} ${'value '.repeat(16)}`).join('\n')}\n`,
          };
        },
        inspectPath: async () => ({
          kind: 'file',
          runs: false,
          editors: [{ scheme: 'vscode', name: 'VS Code' }],
        }),
        actOnPath: async (...args: unknown[]) => {
          calls.push(['open', ...args]);
          return '';
        },
        copyText: async (text: string) => {
          calls.push(['copy', text]);
        },
      };
    },
    { desktop, device },
  );
  const events = [
    {
      type: 'native.capabilities',
      account: {},
      models: [],
      commands: ['plan', 'status', 'changes', 'review'],
    },
    {
      type: 'native.session',
      nativeSessionId: session.id,
      model: 'fixture',
      version: 'fixture',
      permissionMode: 'acceptEdits',
      requestedPermissionMode: 'auto',
    },
    {
      type: 'text.delta',
      messageId: randomUUID(),
      text: Array.from(
        { length: 50 },
        (_, i) => `第 ${i + 1} 段：检查本机项目的实现和验证结果。`,
      ).join('\n\n'),
    },
  ].map((payload, index) => ({
    sessionId: session.id,
    runId: randomUUID(),
    sequence: index + 1,
    createdAt: now,
    payload,
  }));
  const requests: any[] = [];
  const fail = { configure: false, message: false };
  let socket: WebSocketRoute;
  let outage = false;
  let sequence = events.length;
  const send = (value: unknown) => socket.send(JSON.stringify(value));
  const snapshot = (selected: Session, requestId: string) =>
    send({
      type: 'session.snapshot',
      requestId,
      session: selected,
      mode: 'replace',
      firstSequence: selected === session ? 1 : 0,
      lastSequence: selected === session ? events.length : 0,
      hasEarlier: false,
      events: selected === session ? events : [],
    });
  await page.routeWebSocket('ws://127.0.0.1:18913/ws', (route) => {
    socket = route;
    route.onMessage((raw) => {
      const message = JSON.parse(String(raw));
      requests.push(message);
      if (message.type === 'device') return;
      if (message.type === 'auth') {
        if (outage) return;
        send({
          type: 'ready',
          protocolVersion: PROTOCOL_VERSION,
          version: '0.3.16',
          connectionId,
          adapter: 'claude-code',
          sessions: [session, other, remote],
        });
        send({ type: 'devices', devices: [{ ...device, ready: true }] });
        return;
      }
      if (message.type === 'session.subscribe')
        snapshot(
          [session, other, remote].find((item) => item.id === message.sessionId)!,
          message.requestId,
        );
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
      if (message.type === 'message.send' && options.startOnSend && !session.activeRun) {
        session.activeRun = { id: runId, connectionId, status: 'running' };
        send({ type: 'session.updated', session });
      }
      if (message.requestId) send({ type: 'response', requestId: message.requestId, ok: true });
    });
  });
  await page.goto('/');
  if (desktop && !options.reconnect)
    await page.getByRole('button', { name: '本地模拟', exact: true }).click();
  await page.getByLabel('服务地址', { exact: true }).fill('ws://127.0.0.1:18913/ws');
  await page
    .getByLabel('服务凭据', { exact: true })
    .fill('test-only-local-review-token-with-enough-length');
  await page.getByRole('button', { name: '连接', exact: true }).click();
  const select = async (title: string) => {
    const expand = page.getByRole('button', { name: '展开会话列表', exact: true });
    if (await expand.isVisible()) await expand.click();
    if (title === remote.title) {
      const elsewhere = page.getByRole('button', { name: /其他设备/ });
      if (await elsewhere.count()) await elsewhere.click();
    }
    await page
      .locator('.session-row')
      .filter({ hasText: title })
      .locator('.session-select')
      .click();
  };
  await select(session.title);
  await expect(page.getByRole('textbox', { name: '消息' })).toBeVisible();
  return {
    session,
    other,
    remote,
    fail,
    requests,
    select,
    send,
    disconnect: () => {
      outage = true;
      socket.close();
    },
    event: (payload: EventPayload) =>
      send({
        type: 'session.event',
        event: { sessionId: session.id, runId, sequence: ++sequence, createdAt: now, payload },
      }),
  };
}

const box = (page: Page) => page.getByRole('textbox', { name: '消息' });

test('local changes are readable, stay local, preserve conversation scroll, and open the editor', async ({
  page,
}) => {
  const fixture = await open(page);
  await expect(page.locator('.conversation')).toContainText('第 50 段');
  await page.locator('.conversation').press('Home');
  await expect.poll(() => page.locator('.conversation').evaluate((node) => node.scrollTop)).toBe(0);
  const before = await page.locator('.conversation').evaluate((node) => node.scrollTop);
  const count = fixture.requests.length;
  await page.getByRole('button', { name: '查看改动', exact: true }).click();
  const panel = page.getByRole('complementary', { name: '项目改动' });
  await expect(panel).toContainText('LOCAL_ONLY_/fixtures/项目');
  const scope = panel.getByRole('combobox', { name: '改动范围' });
  await expect(scope).toHaveValue('unstaged');
  const summary = panel.locator('.changes-comparison');
  await expect(summary.locator('ins')).toHaveText('+4');
  await expect(summary.locator('del')).toHaveText('−2');
  await panel.getByRole('button', { name: '在编辑器中打开第 1 行', exact: true }).first().click();
  await expect
    .poll(() =>
      page.evaluate(() => (window as any).localCalls.filter((call: any[]) => call[0] === 'open')),
    )
    .toEqual([
      ['open', 'editor', '/fixtures/项目/src/中文 文件.ts', { line: 1, editor: 'vscode' }],
    ]);
  await panel.getByRole('button', { name: '展开 image.png', exact: true }).click();
  await expect(panel).toContainText('二进制或非 UTF-8');
  await panel.getByRole('button', { name: '刷新改动', exact: true }).click();
  await expect(panel.getByRole('button', { name: '收起 image.png', exact: true })).toBeVisible();
  await expect
    .poll(() => page.locator('.conversation').evaluate((node) => node.scrollTop))
    .toBe(before);
  expect(fixture.requests.length).toBe(count);
  expect(JSON.stringify(fixture.requests)).not.toContain('LOCAL_ONLY');
  await panel.locator('.changes-files').evaluate((node) => {
    node.scrollTop = 0;
  });
  await page.screenshot({ path: resolve(screenshots, 'changes-light.png') });
  await page.evaluate(() => (document.documentElement.dataset.theme = 'dark'));
  await page.screenshot({ path: resolve(screenshots, 'changes-dark.png') });
  await scope.selectOption('staged');
  await expect(panel).toContainText('staged.ts');
  await expect(summary.locator('ins')).toHaveText('+2');
  await expect(summary.locator('del')).toHaveText('−1');
  await expect(panel).toContainText('存在未暂存修改，点击行号仅打开文件');
  await panel.locator('.diff-line.added button').first().click();
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as any).localCalls.filter((call: any[]) => call[0] === 'open').at(-1),
      ),
    )
    .toEqual(['open', 'editor', '/fixtures/项目/staged.ts', { editor: 'vscode' }]);
  await page.keyboard.press('Escape');
  await expect(panel).toHaveCount(0);
  await expect(page.locator('.changes-trigger')).toBeFocused();
});

test('narrow review uses the existing dialog and long lines stay inside it', async ({ page }) => {
  await open(page);
  await page.setViewportSize({ width: 620, height: 850 });
  await page.getByRole('button', { name: '查看改动', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '项目改动' });
  await expect(dialog).toContainText('LOCAL_ONLY');
  expect(await dialog.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: resolve(screenshots, 'changes-narrow.png') });
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('.changes-trigger')).toBeFocused();
});

test('late diffs cannot cross project or scope boundaries and read failures are visible', async ({
  page,
}) => {
  const fixture = await open(page);
  await page.evaluate(() => {
    (window as any).holdDiff = true;
  });
  await page.getByRole('button', { name: '查看改动', exact: true }).click();
  await expect.poll(() => page.evaluate(() => !!(window as any).finishDiff)).toBe(true);
  await page.getByRole('combobox', { name: '改动范围' }).selectOption('staged');
  await page.evaluate(() => {
    (window as any).holdDiff = false;
    (window as any).finishDiff({ kind: 'text', patch: '+OLD_SCOPE' });
  });
  await fixture.select(fixture.other.title);
  await expect(page.getByRole('complementary', { name: '项目改动' })).toHaveCount(0);
  await page.getByRole('button', { name: '查看改动', exact: true }).click();
  await expect(page.getByRole('complementary', { name: '项目改动' })).toContainText(
    'LOCAL_ONLY_/fixtures/另一个项目',
  );
  await expect(page.locator('body')).not.toContainText('OLD_SCOPE');
  await page.evaluate(() => {
    (window as any).listError = true;
  });
  await page.getByRole('button', { name: '刷新改动', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('读取 Git 失败');
});

test('plan config precedes sending; repeated plan does not exit, and local status never sends a prompt', async ({
  page,
}) => {
  const fixture = await open(page);
  await box(page).fill('/plan 调研修改');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect(box(page)).toHaveValue('');
  expect(
    fixture.requests
      .filter((item) => ['session.configure', 'message.send'].includes(item.type))
      .map((item) => [item.type, item.permissionMode ?? item.text]),
  ).toEqual([
    ['session.configure', 'plan'],
    ['message.send', '调研修改'],
  ]);
  await box(page).fill('/plan');
  await box(page).press('Enter');
  await expect(box(page)).toHaveValue('');
  expect(fixture.requests.filter((item) => item.type === 'session.configure')).toHaveLength(1);
  await box(page).fill('/status');
  await box(page).press('Enter');
  await expect(page.getByRole('dialog', { name: '会话状态' })).toContainText('计划模式');
  expect(fixture.requests.filter((item) => item.type === 'message.send')).toHaveLength(1);
  await page.keyboard.press('Escape');
  await box(page).fill('/changes 参数');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('不接受参数');
  await expect(box(page)).toHaveValue('/changes 参数');
  await box(page).fill('/planner');
  await box(page).press('Enter');
  await expect
    .poll(() => fixture.requests.filter((item) => item.type === 'message.send').at(-1)?.text)
    .toBe('/planner');
});

test('plan failures keep the right draft and never send or retry implicitly', async ({ page }) => {
  const fixture = await open(page);
  fixture.fail.configure = true;
  await box(page).fill('/plan 保留正文');
  await box(page).press('Enter');
  await expect(page.getByRole('alert')).toContainText('模拟请求失败');
  await expect(box(page)).toHaveValue('/plan 保留正文');
  expect(fixture.requests.filter((item) => item.type === 'message.send')).toHaveLength(0);
  fixture.fail.configure = false;
  fixture.fail.message = true;
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect(box(page)).toHaveValue('保留正文');
  await expect(page.getByRole('button', { name: '审批模式', exact: true })).toContainText(
    '计划模式',
  );
  expect(fixture.requests.filter((item) => item.type === 'message.send')).toHaveLength(1);
});

test('current native mode wins, old runs do not leak, and disconnects show last-known state', async ({
  page,
}) => {
  const fixture = await open(page, { running: true, reconnect: true });
  const mode = page.getByRole('button', { name: '审批模式', exact: true });
  await expect(mode).toContainText('启动中');
  await box(page).fill('/plan 调研');
  await box(page).press('Enter');
  await expect(page.getByRole('alert')).toContainText('请先结束当前运行');
  expect(fixture.requests.some((item) => item.type === 'session.configure')).toBe(false);
  fixture.event({
    type: 'native.session',
    nativeSessionId: fixture.session.id,
    model: 'fixture',
    version: 'fixture',
    requestedPermissionMode: 'plan',
    permissionMode: 'default',
  });
  await expect(mode).toContainText('手动审批');
  fixture.event({ type: 'native.permission', permissionMode: 'acceptEdits' });
  await expect(mode).toContainText('接受编辑');
  await page.getByRole('button', { name: '查看会话状态', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '会话状态' })).toContainText(
    '请求模式：计划模式；原生模式：接受编辑',
  );
  await page.screenshot({ path: resolve(screenshots, 'session-status.png') });
  fixture.event({
    type: 'native.session',
    nativeSessionId: fixture.session.id,
    model: 'fixture',
    version: 'fixture',
    requestedPermissionMode: 'plan',
    permissionMode: 'auto',
  });
  await expect(mode).toContainText('自动审批');
  fixture.send({ type: 'devices', devices: [] });
  await expect(page.getByRole('dialog', { name: '会话状态' })).toContainText('执行通道未就绪');
  fixture.disconnect();
  await expect(page.getByRole('dialog', { name: '会话状态' })).toContainText('最后已知');
  await expect(page.locator('body')).not.toContainText('任务仍在服务端继续');
});

test('another device with the same directory never reads local Git, and browser commands omit changes', async ({
  page,
}) => {
  const fixture = await open(page);
  await expect(page.locator('.composer-context')).toContainText('main');
  const before = await page.evaluate(() => (window as any).localCalls.length);
  await fixture.select(fixture.remote.title);
  await expect(page.locator('.session-row.selected')).toContainText(fixture.remote.title);
  await expect(page.locator('.changes-trigger')).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).localCalls.length)).toBe(before);
});

test('browser local commands keep native review and do not send while composing text', async ({
  page,
}) => {
  const fixture = await open(page, { desktop: false });
  await box(page).fill('/');
  const menu = page.getByRole('listbox', { name: '会话命令' });
  await expect(menu.getByRole('option', { name: /进入计划模式/ })).toHaveCount(1);
  await expect(menu.getByRole('option', { name: /查看改动/ })).toHaveCount(0);
  await expect(menu.getByRole('option', { name: /\/review/ })).toHaveCount(1);
  await box(page).fill('/plan 输入法正文');
  await box(page).dispatchEvent('keydown', { key: 'Enter', isComposing: true });
  expect(fixture.requests.some((message) => message.type === 'session.configure')).toBe(false);
  await box(page).fill('/pl');
  await menu.getByRole('option', { name: /进入计划模式/ }).click();
  await expect(box(page)).toHaveValue('');
  expect(fixture.requests.filter((message) => message.type === 'session.configure')).toHaveLength(
    1,
  );
  expect(fixture.requests.some((message) => message.type === 'message.send')).toBe(false);
});

test('turn pill follows net lines while an open panel keeps its completed turn', async ({
  page,
}) => {
  const fixture = await open(page, { running: true });
  const pill = page.locator('.turn-changes-pill');
  await expect(pill).toHaveCount(0);
  const before = await page.locator('.composer-context').boundingBox();
  await page.evaluate(() => (window as any).changeLines(3));
  await expect(pill).toContainText('+3');
  await expect(pill).toHaveCSS('position', 'absolute');
  const after = await page.locator('.composer-context').boundingBox();
  expect(after).toEqual(before);
  const bounds = (await pill.boundingBox())!;
  expect(bounds.y + bounds.height).toBeLessThan(after!.y);
  expect(after!.y + after!.height).toBeLessThan((await page.locator('.composer').boundingBox())!.y);
  await pill.click();
  const panel = page.getByRole('complementary', { name: '本轮更改' });
  await expect(panel).toContainText('从接入时开始统计');
  await expect(panel).toContainText('+turn-lines-3');
  await expect(panel.locator('.changes-comparison ins')).toHaveText('+3');
  await page.screenshot({ path: resolve(screenshots, 'changes-current-turn.png') });
  await page.evaluate(() => (window as any).changeLines(0));
  await expect(pill).toHaveCount(0);
  await page.evaluate(() => (window as any).changeLines(1));
  await expect(pill).toContainText('+1');
  fixture.send({ type: 'session.updated', session: { ...fixture.session, activeRun: null } });
  await expect(pill).toHaveCount(0);
  await expect(panel.getByRole('button', { name: '刷新改动' })).toHaveCount(0);
  await panel.getByRole('button', { name: '展开 live.ts' }).click();
  await expect(panel).toContainText('+turn-lines-1');
  const previous = await page.evaluate(() => (window as any).latestTurn);
  fixture.send({
    type: 'session.updated',
    session: { ...fixture.session, activeRun: { ...fixture.session.activeRun, id: randomUUID() } },
  });
  await expect.poll(() => page.evaluate(() => (window as any).latestTurn)).not.toBe(previous);
  await page.evaluate(() => (window as any).changeLines(2));
  await expect(pill).toContainText('+2');
  await expect(panel).toContainText('+turn-lines-1');
  await pill.click();
  await expect(panel).toContainText('+turn-lines-2');
});

test('the first message waits for its local baseline before going to the service', async ({
  page,
}) => {
  const fixture = await open(page, { startOnSend: true });
  await page.evaluate(() => ((window as any).holdTurn = true));
  await box(page).fill('修改本机文件');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect.poll(() => page.evaluate(() => !!(window as any).readyTurn)).toBe(true);
  expect(fixture.requests.some((request) => request.type === 'message.send')).toBe(false);
  await page.evaluate(() => (window as any).readyTurn());
  await expect
    .poll(() => fixture.requests.filter((request) => request.type === 'message.send').length)
    .toBe(1);
  await page.evaluate(() => (window as any).changeLines(1));
  await page.locator('.turn-changes-pill').click();
  const panel = page.getByRole('complementary', { name: '本轮更改' });
  await expect(panel).toContainText('+turn-lines-1');
  await expect(panel).not.toContainText('从接入时开始统计');
});

test('a snapshot project can reset its baseline from the project panel', async ({ page }) => {
  await open(page);
  await page.evaluate(() => ((window as any).snapshotProject = true));
  await page.getByRole('button', { name: '查看改动', exact: true }).click();
  const panel = page.getByRole('complementary', { name: '项目改动' });
  await expect(panel).toContainText('项目累计');
  await expect(panel).toContainText('+after');
  await expect(panel.getByRole('combobox', { name: '改动范围' })).toHaveCount(0);
  page.once('dialog', (dialog) => dialog.accept());
  await panel.getByRole('button', { name: '重设起点' }).click();
  await expect(panel).toContainText('与起点相比没有改动');
});
