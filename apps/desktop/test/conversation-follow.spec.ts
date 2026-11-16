import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { PROTOCOL_VERSION } from '@cc-desk-tunnel/protocol';
import type { Session } from '@cc-desk-tunnel/protocol';
import { join } from 'node:path';
import { screenshots } from './helpers.ts';

// Trace snapshots walk the entire DOM and distort the frame/input timings measured in this file.
test.use({ trace: 'off' });

// A long session whose replies differ in height: lists, code and tables, so that what the page guesses for a
// reply not yet drawn is off, and the view must keep to its end while the real heights come in.
const turns = 60;

function reply(n: number) {
  const lines = Array.from(
    { length: (n % 7) + 2 },
    (_, i) => `- 第${n}轮的第${i + 1}点，说明写得长一些，好让它在窗口里换行。`,
  );
  const code = Array.from({ length: (n % 5) * 3 }, (_, i) => `echo ${n}-${i}`).join('\n');
  return [
    `第${n}轮的回答。`,
    ...lines,
    code ? '```sh\n' + code + '\n```' : '',
    `| 列 | 值 |\n| --- | --- |\n| ${n} | ${n * 2} |`,
  ].join('\n\n');
}

// Opens the session; what is returned starts a reply streaming into it, fast, and stops it when called.
async function open(page: Page, { count = turns, earlier = 0, historyFailure = '' } = {}) {
  const now = new Date().toISOString();
  const connectionId = randomUUID();
  let stream = (): (() => void) => () => {};
  const session: Session = {
    id: randomUUID(),
    title: '长对话',
    autoTitle: false,
    projectPath: 'D:\\工作\\长对话',
    permissionMode: 'auto',
    model: null,
    effort: null,
    createdAt: now,
    updatedAt: now,
    activeRun: null,
  };
  const other = { ...session, id: randomUUID(), title: '另一段会话' };
  const requests: string[] = [];
  await page.routeWebSocket('ws://127.0.0.1:18894/ws', (route) => {
    const send = (value: unknown) => route.send(JSON.stringify(value));
    let sequence = 0;
    const start = Date.now() - 3_600_000;
    const events: unknown[] = [];
    for (let n = 0; n < count; n++) {
      const runId = randomUUID();
      const event = (payload: unknown) => ({
        sessionId: session.id,
        runId,
        sequence: ++sequence,
        createdAt: new Date(start + sequence * 1000).toISOString(),
        payload,
      });
      events.push(
        event({
          type: 'message.user',
          messageId: randomUUID(),
          text: `第${n}问`,
          scenario: 'chat',
        }),
        event({
          type: 'tool.requested',
          toolId: `t${n}`,
          name: 'Bash',
          input: JSON.stringify({ command: 'ls', description: `看一看${n}` }),
          target: 'Windows',
        }),
        event({
          type: 'tool.result',
          toolId: `t${n}`,
          status: 'completed',
          output: 'a',
          exitCode: 0,
        }),
        event({ type: 'text.delta', messageId: randomUUID(), text: reply(n) }),
        event({ type: 'run.status', status: 'completed', connectionId }),
      );
    }
    stream = () => {
      const messageId = randomUUID();
      const runId = randomUUID();
      const emit = (payload: unknown) =>
        send({
          type: 'session.event',
          event: {
            sessionId: session.id,
            runId,
            sequence: ++sequence,
            createdAt: new Date().toISOString(),
            payload,
          },
        });
      send({
        type: 'session.updated',
        session: { ...session, activeRun: { id: runId, status: 'running', connectionId } },
      });
      emit({ type: 'message.user', messageId: randomUUID(), text: '继续输出', scenario: 'chat' });
      emit({ type: 'run.status', status: 'running', connectionId });
      let n = 0;
      const timer = setInterval(() => {
        emit({
          type: 'text.delta',
          messageId,
          text: `\n\n流式输出第${++n}段，写得长一些，好让它在窗口里换行，页面跟着变高。`,
        });
      }, 20);
      return () => {
        clearInterval(timer);
        emit({ type: 'run.status', status: 'completed', connectionId });
        send({ type: 'session.updated', session });
      };
    };
    route.onMessage((raw) => {
      const message = JSON.parse(String(raw));
      requests.push(message.type);
      if (message.type === 'device' || message.type === 'session.history.next') return;
      if (message.type === 'auth') {
        send({
          type: 'ready',
          protocolVersion: PROTOCOL_VERSION,
          version: '0.0.1',
          connectionId,
          adapter: 'claude-code',
          sessions: [session, other],
        });
        return;
      }
      if (message.type === 'session.history' && historyFailure) {
        send({
          type: 'response',
          requestId: message.requestId,
          ok: false,
          message: historyFailure,
        });
        return;
      }
      if (message.type === 'session.subscribe' || message.type === 'session.history') {
        const previous = message.type === 'session.history';
        const empty = message.sessionId === other.id;
        const snapshot = JSON.stringify([
          {
            type: 'session.snapshot',
            requestId: message.requestId,
            session: empty ? other : session,
            mode: previous ? 'prepend' : 'replace',
            firstSequence: empty ? 0 : previous ? 1 : earlier * 5 + 1,
            lastSequence: empty ? 0 : count * 5,
            hasEarlier: !empty && !previous && (!!historyFailure || earlier > 0),
            events: empty
              ? []
              : previous
                ? events.slice(0, earlier * 5)
                : events.slice(earlier * 5),
          },
        ]);
        for (let offset = 0; offset < snapshot.length; offset += 16384) {
          send({
            type: 'session.history.part',
            requestId: message.requestId,
            sessionId: message.sessionId,
            data: snapshot.slice(offset, offset + 16384),
            last: offset + 16384 >= snapshot.length,
          });
        }
      }
      send({ type: 'response', requestId: message.requestId, ok: true });
    });
  });
  await page.goto('/');
  await page.getByLabel('服务地址', { exact: true }).fill('ws://127.0.0.1:18894/ws');
  await page
    .getByLabel('服务凭据', { exact: true })
    .fill('test-only-view-token-with-enough-length');
  await page.getByRole('button', { name: '连接', exact: true }).click();
  const expand = page.getByRole('button', { name: '展开会话列表', exact: true });
  if (await expand.isVisible()) await expand.click();
  await page
    .locator('.session-row')
    .filter({ hasText: session.title })
    .locator('.session-select')
    .click();
  await expect(page.getByText(`第${count - 1}轮的回答。`)).toBeVisible();
  // Wait for Markdown rather than its temporary plain-text fallback before measuring layout or clicking folds.
  await expect(page.locator('.message.assistant').last().locator('table')).toBeVisible();
  return Object.assign(() => stream(), { requests });
}

// How far the view is from the end of the conversation, once it has stopped moving.
async function fromEnd(page: Page) {
  const conversation = page.locator('.conversation');
  let last = -1;
  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(100);
    const now = await conversation.evaluate((box) => box.scrollTop);
    if (now === last) break;
    last = now;
  }
  return conversation.evaluate((box) => box.scrollHeight - box.scrollTop - box.clientHeight);
}

test('a long conversation opens at its end', async ({ page }) => {
  await open(page);
  expect(await fromEnd(page)).toBeLessThan(2);
});

test('approaching the top preloads history and preserves the actual failure reason', async ({
  page,
}) => {
  const reason = '历史传输连续 30 秒没有收到接收确认，请重试。';
  await open(page, { historyFailure: reason });
  await page.locator('.conversation').evaluate((box) => {
    box.scrollTop = 200;
  });
  await expect(page.getByText(reason, { exact: true })).toHaveCount(1);
  await expect(page.getByRole('button', { name: '加载更早记录', exact: true })).toBeEnabled();
});

test('coming back from the settings, the conversation is at its end again', async ({ page }) => {
  await open(page);
  await page.getByRole('button', { name: '设置与账号', exact: true }).click();
  await page.getByRole('button', { name: '会话', exact: true }).click();
  await expect(page.getByText(`第${turns - 1}轮的回答。`)).toBeVisible();
  expect(await fromEnd(page)).toBeLessThan(2);
});

test('a resized window keeps to the end, and one read further up stays where it is', async ({
  page,
}) => {
  await open(page);
  await page.setViewportSize({ width: 1000, height: 700 });
  expect(await fromEnd(page)).toBeLessThan(2);
  const conversation = page.locator('.conversation');
  await conversation.hover();
  await page.mouse.wheel(0, -1500);
  const before = await fromEnd(page);
  expect(before).toBeGreaterThan(500);
  await page.setViewportSize({ width: 1100, height: 760 });
  expect(await fromEnd(page)).toBeGreaterThan(300);
});

test('opening the steps of the last turn does not pull them out of sight', async ({ page }) => {
  await open(page);
  expect(await fromEnd(page)).toBeLessThan(2);
  const summary = page.locator('.turn-process > summary').last();
  await summary.click();
  await expect(page.locator('.turn-process').last()).toHaveAttribute('open', '');
  await fromEnd(page);
  await expect(summary).toBeInViewport();
});

test('while output streams in fast, a reader scrolling up a little is not pulled back to the end', async ({
  page,
}) => {
  const stream = await open(page);
  const conversation = page.locator('.conversation');
  const back = page.getByRole('button', { name: '回到底部', exact: true });
  expect(await fromEnd(page)).toBeLessThan(2);
  await expect(back).toHaveCount(0);
  const stop = stream();
  await page.waitForTimeout(300);
  // One notch at a time, slower than the output comes in.
  await conversation.hover();
  for (let i = 0; i < 3; i++) {
    await page.mouse.wheel(0, -60);
    await page.waitForTimeout(150);
  }
  await page.waitForTimeout(800);
  const read = await conversation.evaluate((box) => box.scrollTop);
  await page.waitForTimeout(500);
  expect(await conversation.evaluate((box) => box.scrollTop)).toBe(read);
  await expect(back).toBeVisible();
  // The button brings the view down, and it follows the output from there.
  await back.click();
  await expect(back).toHaveCount(0);
  await page.waitForTimeout(500);
  stop();
  expect(await fromEnd(page)).toBeLessThan(2);
  // Scrolling all the way down by hand follows again as well. Each turn of the wheel goes past where the end is as
  // it is taken: a fixed step would never get there on a machine slow enough that the page grows faster than it.
  const again = stream();
  await page.mouse.wheel(0, -400);
  await expect(back).toBeVisible();
  for (let i = 0; i < 20 && (await back.count()); i++) {
    const gap = await conversation.evaluate(
      (box) => box.scrollHeight - box.scrollTop - box.clientHeight,
    );
    await page.mouse.wheel(0, gap + 400);
    await page.waitForTimeout(100);
  }
  await expect(back).toHaveCount(0);
  await page.waitForTimeout(500);
  again();
  expect(await fromEnd(page)).toBeLessThan(2);
});

test('turn navigation previews without scrolling, jumps by pointer or keyboard and stays put during output', async ({
  page,
}) => {
  const stream = await open(page);
  await fromEnd(page);
  const track = page.getByRole('slider', { name: '对话轮次（上下键预览，回车跳转）' });
  const box = await track.boundingBox();
  const position = { x: 14, y: 8 + (17 / (turns - 1)) * (box!.height - 16) };
  const scroller = page.locator('.conversation');
  const before = await scroller.evaluate((element) => element.scrollTop);
  const sent = stream.requests.length;
  await track.hover({ position });
  const preview = page.getByRole('tooltip');
  await expect(preview).toContainText('第17问');
  await expect(preview).toContainText('第17轮的回答。');
  expect(await scroller.evaluate((element) => element.scrollTop)).toBe(before);
  expect(stream.requests.length).toBe(sent);
  await page.screenshot({ path: join(screenshots, 'conversation-navigation-light.png') });
  await track.click({ position });
  await expect(page.getByText('第17问', { exact: true })).toBeInViewport();
  await expect(track).toHaveAttribute('aria-valuenow', '18');
  await expect(preview).toHaveCount(0);
  const stop = stream();
  try {
    await fromEnd(page);
    const reading = await scroller.evaluate((element) => element.scrollTop);
    await page.waitForTimeout(400);
    expect(await scroller.evaluate((element) => element.scrollTop)).toBe(reading);
    await track.focus();
    await track.press('ArrowUp');
    await expect(preview).toContainText('第16问');
    await track.press('Enter');
    await expect(page.getByText('第16问', { exact: true })).toBeInViewport();
    await track.press('Home');
    await expect(preview).toContainText('第0问');
    await track.press('Escape');
    await expect(preview).toHaveCount(0);
    await track.press('Home');
    await track.press('Enter');
    await expect(page.getByText('第0问', { exact: true })).toBeInViewport();
  } finally {
    stop();
  }
});

test('navigation keeps the reading anchor when older turns arrive and clears on a session switch', async ({
  page,
}) => {
  await open(page, { count: 80, earlier: 30 });
  const track = page.getByRole('slider');
  await expect(track).toHaveAttribute('aria-valuemax', '50');
  await track.focus();
  await track.press('Home');
  for (let n = 0; n < 10; n++) await track.press('ArrowDown');
  await track.press('Enter');
  const reading = page.getByText('第40问', { exact: true });
  await expect(reading).toBeInViewport();
  await fromEnd(page);
  const top = (await reading.boundingBox())!.y;
  await page.getByRole('button', { name: '导航：加载更早记录', exact: true }).click();
  await expect(track).toHaveAttribute('aria-valuemax', '80');
  await expect(reading).toBeInViewport();
  expect(Math.abs((await reading.boundingBox())!.y - top)).toBeLessThan(3);
  await expect(page.getByRole('button', { name: '导航：加载更早记录', exact: true })).toHaveCount(
    0,
  );
  await track.focus();
  await track.press('ArrowUp');
  await expect(page.getByRole('tooltip')).toBeVisible();
  await page.locator('.session-select').filter({ hasText: '另一段会话' }).click();
  await expect(track).toHaveCount(0);
  await expect(page.getByRole('tooltip')).toHaveCount(0);
});

test('navigation fits a narrow dark window and reduced motion still reaches the chosen turn', async ({
  page,
}) => {
  await page.addInitScript(() =>
    localStorage.setItem('proxy-prefs', JSON.stringify({ theme: 'dark' })),
  );
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await open(page);
  await page.setViewportSize({ width: 390, height: 844 });
  const collapse = page.getByRole('button', { name: '收起会话列表', exact: true });
  if (await collapse.isVisible()) await collapse.click();
  const track = page.getByRole('slider');
  await track.focus();
  await track.press('Home');
  for (let n = 0; n < 20; n++) await track.press('ArrowDown');
  const preview = page.getByRole('tooltip');
  await expect(preview).toContainText('第20问');
  const bounds = await preview.boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
  expect(bounds!.y).toBeGreaterThanOrEqual(0);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(844);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: join(screenshots, 'conversation-navigation-dark-narrow.png') });
  await page.setViewportSize({ width: 390, height: 1044 });
  await expect
    .poll(async () => {
      const tip = (await preview.boundingBox())!;
      const rail = (await track.boundingBox())!;
      return Math.abs(
        tip.y + tip.height / 2 - (rail.y + 8 + (20 / (turns - 1)) * (rail.height - 16)),
      );
    })
    .toBeLessThan(2);
  await track.press('Enter');
  await expect(page.getByText('第20问', { exact: true })).toBeInViewport();
});

test.describe('navigation performance', () => {
  test('1000 mixed turns keep navigation, scrolling and typing responsive during streaming', async ({
    page,
  }, info) => {
    const started = Date.now();
    const stream = await open(page, { count: 1000 });
    const openMs = Date.now() - started;
    await fromEnd(page);
    const track = page.getByRole('slider');
    await expect(track).toHaveAttribute('aria-valuemax', '1000');
    expect(await track.locator('i').count()).toBeLessThan(70);
    await track.focus();
    await track.press('Home');
    await track.press('Enter');
    const stop = stream();
    try {
      const metrics = await page.evaluate(async () => {
        const box = document.querySelector<HTMLElement>('.conversation')!;
        const track = document.querySelector<HTMLElement>('.conversation-nav-track')!;
        const bounds = track.getBoundingClientRect();
        const frames: number[] = [];
        const longTasks: number[] = [];
        const observer = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) longTasks.push(entry.duration);
        });
        observer.observe({ type: 'longtask' });
        let previous = await new Promise<number>(requestAnimationFrame);
        box.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: 700 }));
        for (let n = 0; n < 180; n++) {
          box.scrollTop += 700;
          track.dispatchEvent(
            new PointerEvent('pointermove', {
              bubbles: true,
              pointerType: 'mouse',
              clientX: bounds.x + 14,
              clientY: bounds.y + 8 + ((n % 60) / 59) * (bounds.height - 16),
            }),
          );
          const now = await new Promise<number>(requestAnimationFrame);
          frames.push(now - previous);
          previous = now;
        }
        observer.disconnect();
        frames.sort((a, b) => a - b);
        return {
          p95FrameMs: frames[Math.floor(frames.length * 0.95)],
          maxFrameMs: frames.at(-1)!,
          slowFrames: frames.filter((ms) => ms > 50).length,
          longTasks,
        };
      });
      const jumpAt = Date.now();
      await track.press('End');
      await track.press('ArrowUp');
      await track.press('ArrowUp');
      await track.press('Enter');
      await expect(page.getByText('第998问', { exact: true })).toBeInViewport();
      const jumpMs = Date.now() - jumpAt;
      const message = page.getByRole('textbox', { name: '消息', exact: true });
      const typed = Date.now();
      await message.pressSequentially('abcdefghijklmnopqrstuvwxyz0123456789');
      const perKeyMs = (Date.now() - typed) / 36;
      const results = { turns: 1000, openMs, jumpMs, perKeyMs, ...metrics };
      console.log(JSON.stringify(results));
      await info.attach('conversation-navigation-performance', {
        body: JSON.stringify(results, null, 2),
        contentType: 'application/json',
      });
      expect(openMs).toBeLessThan(8000);
      expect(jumpMs).toBeLessThan(1000);
      expect(perKeyMs).toBeLessThan(100);
      expect(metrics.p95FrameMs).toBeLessThan(50);
      expect(metrics.slowFrames).toBeLessThan(9);
      expect(metrics.maxFrameMs).toBeLessThan(250);
    } finally {
      stop();
    }
  });
});
