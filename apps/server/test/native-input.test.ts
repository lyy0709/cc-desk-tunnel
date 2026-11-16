import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { registerHooks } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import type { SDKMessage, SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import type { EventPayload } from '@cc-desk-tunnel/protocol';
import { messageText } from '@cc-desk-tunnel/protocol';
import { NativeInput } from '../src/native-input.ts';

test(
  'native runs declare only scheduled tasks, while user additions and compact keep their original inputs',
  { skip: process.platform === 'win32' },
  async (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'ccdt-native-input-'));
    const original = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = directory;
    const captured: {
      env: Record<string, string>;
      messages: {
        origin: unknown;
        priority?: string;
        message: { content: string };
        isSynthetic?: boolean;
        client_composed?: boolean;
      }[];
    }[] = [];
    (globalThis as any).__ccdtInputFixture = captured;
    const stub = `
    export async function getSessionInfo() { return undefined; }
    export function query({prompt, options}) {
      if (globalThis.__ccdtNativeDriver) return globalThis.__ccdtNativeDriver({prompt, options});
      const captured = {env: options.env, messages: []};
      globalThis.__ccdtInputFixture.push(captured);
      const stream = (async function* () {
        const first = (await prompt.next()).value;
        captured.messages.push(first);
        const second = (await prompt.next()).value;
        captured.messages.push(second);
        yield {type:'result', subtype:'success', is_error:false, result:'fixture',
          user_message_uuids:[first.uuid, second.uuid], queued_turn_count:0,
          modelUsage:{}, usage:{}, total_cost_usd:0};
      })();
      return Object.assign(stream, {
        initializationResult: async () => ({commands:[], models:[], account:{}}),
        getContextUsage: async () => null,
        close() {},
      });
    }
  `;
    const hooks = registerHooks({
      resolve(specifier, context, next) {
        return specifier === '@anthropic-ai/claude-agent-sdk'
          ? { url: 'data:text/javascript,' + encodeURIComponent(stub), shortCircuit: true }
          : next(specifier, context);
      },
    });
    t.after(() => {
      hooks.deregister();
      delete (globalThis as any).__ccdtInputFixture;
      delete (globalThis as any).__ccdtNativeDriver;
      if (original === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = original;
      rmSync(directory, { recursive: true, force: true });
    });
    const { runClaude } = await import('../src/claude.ts');
    for (const [scheduled, priority] of [
      [undefined, undefined],
      [undefined, 'next'],
      [undefined, 'later'],
      [undefined, 'now'],
      ['scheduled', undefined],
      ['manual', undefined],
    ] as const) {
      const { input, sessionId } = fixture();
      input.submit(randomUUID(), scheduled ? '任务提示词' : '/compact', scheduled);
      input.submit(randomUUID(), '用户追加', undefined, priority);
      const outcome = await runClaude(
        { executable: '/does-not-exist/claude' },
        {
          sessionId,
          nativeRoot: sessionId,
          projectPath: '/fixture',
          execution: { platform: 'linux', shells: ['bash'], shell: 'bash' },
          permissionMode: 'auto',
          input,
          scheduled,
          dataDir: directory,
          resume: false,
          signal: new AbortController().signal,
          emit() {},
          approve: async () => ({ allowed: false }),
          waiting() {},
          turnEnded() {},
          controls: {},
        },
      );
      assert.equal(outcome, 'completed');
      const current = captured.at(-1)!;
      assert.equal(current.env.CLAUDE_CODE_HOST_SCHEDULED_RUN, scheduled ? '1' : undefined);
      assert.deepEqual(
        current.messages[0].origin,
        scheduled
          ? { kind: 'task-notification', subkind: 'scheduled-trigger', fireReason: scheduled }
          : { kind: 'human' },
      );
      assert.equal(current.messages[0].message.content, scheduled ? '任务提示词' : '/compact');
      assert.deepEqual(current.messages[1].origin, { kind: 'human' });
      assert.equal(current.messages[1].priority, priority);
      assert.equal(
        current.messages[0].priority,
        undefined,
        'compact and scheduled inputs keep their original delivery',
      );
      assert.equal(current.messages[0].isSynthetic, undefined);
      assert.equal(current.messages[0].client_composed, undefined);
    }
    for (const lateReply of [false, true])
      await t.test(
        lateReply
          ? 'a late native receipt cancels the idle timeout'
          : 'a hook-dropped message ends as unconfirmed after an idle timeout',
        async (t) => {
          t.mock.timers.enable({ apis: ['setTimeout'] });
          const { input, sessionId, events } = fixture();
          const first = randomUUID(),
            second = randomUUID();
          input.submit(first, 'first');
          input.submit(second, 'followup', undefined, 'next');
          const driver = controlledQuery();
          const running = runClaude(
            { executable: '/does-not-exist/claude' },
            {
              sessionId,
              nativeRoot: sessionId,
              projectPath: '/fixture',
              execution: { platform: 'linux', shells: ['bash'], shell: 'bash' },
              permissionMode: 'auto',
              input,
              dataDir: directory,
              resume: false,
              signal: new AbortController().signal,
              emit: (event) => events.push(event),
              approve: async () => ({ allowed: false }),
              waiting() {},
              turnEnded() {},
              controls: {},
            },
          );
          await setImmediate();
          await driver.prompt.next();
          driver.push({
            ...result([first]),
            modelUsage: {},
            usage: {},
            total_cost_usd: 0,
          } as SDKResultMessage);
          await setImmediate();
          t.mock.timers.tick(60_000);
          assert.equal(driver.closed, false, 'an input not yet pulled by the SDK cannot time out');
          await driver.prompt.next();
          t.mock.timers.tick(29_999);
          assert.equal(driver.closed, false);
          if (lateReply) {
            driver.push({
              type: 'assistant',
              parent_tool_use_id: null,
              user_message_uuid: second,
              message: { content: [{ type: 'text', text: 'working' }] },
            } as SDKMessage);
            await setImmediate();
            t.mock.timers.tick(60_000);
            assert.equal(
              driver.closed,
              false,
              'accepted work is not subject to the receipt deadline',
            );
            driver.push({
              ...result([second]),
              modelUsage: {},
              usage: {},
              total_cost_usd: 0,
            } as SDKResultMessage);
            await setImmediate();
            driver.close();
          } else {
            driver.push({
              type: 'stream_event',
              parent_tool_use_id: null,
              event: { type: 'ping' },
            } as unknown as SDKMessage);
            await setImmediate();
            t.mock.timers.tick(1);
          }
          assert.equal(await running, lateReply ? 'completed' : 'failed');
          assert.equal(input.onDrain, undefined);
          assert.ok(
            events.some(
              (event) =>
                event.type === 'message.delivery' &&
                event.messageId === second &&
                event.status === (lateReply ? 'received' : 'unconfirmed'),
            ),
          );
          assert.equal(
            events.some((event) => event.type === 'run.error'),
            !lateReply,
          );
        },
      );
    await t.test(
      'a queued native turn survives an earlier error without a receipt deadline',
      async (t) => {
        t.mock.timers.enable({ apis: ['setTimeout'] });
        const { input, sessionId } = fixture();
        const first = randomUUID(),
          second = randomUUID();
        input.submit(first, 'first');
        input.submit(second, 'followup', undefined, 'now');
        const driver = controlledQuery();
        const running = runClaude(
          { executable: '/does-not-exist/claude' },
          {
            sessionId,
            nativeRoot: sessionId,
            projectPath: '/fixture',
            execution: { platform: 'linux', shells: ['bash'], shell: 'bash' },
            permissionMode: 'auto',
            input,
            dataDir: directory,
            resume: false,
            signal: new AbortController().signal,
            emit() {},
            approve: async () => ({ allowed: false }),
            waiting() {},
            turnEnded() {},
            controls: {},
          },
        );
        await setImmediate();
        await driver.prompt.next();
        await driver.prompt.next();
        driver.push({
          ...result([first], 1),
          is_error: true,
          terminal_reason: 'api_error',
          modelUsage: {},
          usage: {},
          total_cost_usd: 0,
        } as SDKResultMessage);
        await setImmediate();
        t.mock.timers.tick(60_000);
        assert.equal(driver.closed, false);
        input.assertWritable();
        driver.push({
          ...result([second]),
          modelUsage: {},
          usage: {},
          total_cost_usd: 0,
        } as SDKResultMessage);
        await setImmediate();
        driver.close();
        assert.equal(await running, 'completed');
      },
    );
    await t.test(
      'a cancelled permission never returns a late allow or changes plan mode',
      async () => {
        const { input, sessionId, events } = fixture();
        const id = randomUUID();
        input.submit(id, 'plan');
        const driver = controlledQuery();
        const permission = new AbortController();
        let receivedSignal: AbortSignal | undefined;
        let answer!: (value: { allowed: boolean; executionMode: 'auto' }) => void;
        const running = runClaude(
          { executable: '/does-not-exist/claude' },
          {
            sessionId,
            nativeRoot: sessionId,
            projectPath: '/fixture',
            execution: { platform: 'linux', shells: ['bash'], shell: 'bash' },
            permissionMode: 'plan',
            input,
            dataDir: directory,
            resume: false,
            signal: new AbortController().signal,
            emit: (event) => events.push(event),
            approve: (_tool, _waiting, _name, signal) => {
              receivedSignal = signal;
              return new Promise((resolve) => {
                answer = resolve;
              });
            },
            waiting() {},
            turnEnded() {},
            controls: {},
          },
        );
        await setImmediate();
        await driver.prompt.next();
        const pending = driver.options.canUseTool(
          'ExitPlanMode',
          { plan: 'fixture' },
          { toolUseID: 'plan', signal: permission.signal },
        );
        permission.abort();
        assert.equal(receivedSignal?.aborted, true);
        answer({ allowed: true, executionMode: 'auto' });
        const denied = await pending;
        assert.equal(denied.behavior, 'deny');
        assert.equal('updatedPermissions' in denied, false);
        driver.push({
          type: 'user',
          message: {
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'plan',
                is_error: false,
                content: 'handled by another client',
              },
            ],
          },
        } as SDKMessage);
        driver.push({
          ...result([id]),
          modelUsage: {},
          usage: {},
          total_cost_usd: 0,
        } as SDKResultMessage);
        await setImmediate();
        driver.close();
        assert.equal(await running, 'completed');
        assert.deepEqual(
          events.filter((event) => event.type === 'tool.result').map((event) => event.status),
          ['completed'],
        );
      },
    );
  },
);

function controlledQuery() {
  const messages: SDKMessage[] = [];
  let wake: (() => void) | undefined;
  const driver = {
    prompt: null as any,
    options: null as any,
    closed: false,
    push(message: SDKMessage) {
      messages.push(message);
      wake?.();
    },
    close() {
      driver.closed = true;
      wake?.();
    },
  };
  (globalThis as any).__ccdtNativeDriver = ({ prompt, options }: any) => {
    driver.prompt = prompt;
    driver.options = options;
    const stream = (async function* () {
      while (!driver.closed) {
        const message = messages.shift();
        if (message) yield message;
        else
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
      }
    })();
    return Object.assign(stream, {
      initializationResult: async () => ({ commands: [], models: [], account: {} }),
      getContextUsage: async () => null,
      close: driver.close,
    });
  };
  return driver;
}

function fixture() {
  const events: EventPayload[] = [];
  const sessionId = randomUUID();
  const input = new NativeInput(sessionId, (event) => events.push(event));
  return { events, sessionId, input };
}
function result(ids: string[], queued = 0) {
  return {
    type: 'result',
    subtype: 'success',
    is_error: false,
    user_message_uuid: ids[0],
    user_message_uuids: ids,
    queued_turn_count: queued,
  } as SDKResultMessage;
}

test('attachment presentation metadata never becomes a custom native message field', async () => {
  const { input } = fixture();
  const attachments = [
    { name: '脚本.sh', path: '/tmp/中文 "脚本".sh', deviceId: randomUUID(), reference: 1 },
  ];
  input.submit(randomUUID(), messageText('先检查[文件 #1]，再修改。', attachments));
  const stream = input.stream();
  const native = (await stream.next()).value!;
  assert.deepEqual(native.message, {
    role: 'user',
    content: '先检查"/tmp/中文 \\"脚本\\".sh"，再修改。',
  });
  assert.equal('attachments' in native, false);
  input.close();
  await stream.next();
});

test('streaming additions use the same native session and human message UUIDs', async () => {
  const { input, sessionId, events } = fixture();
  const stream = input.stream();
  const first = randomUUID(),
    second = randomUUID();
  input.submit(first, 'first');
  assert.deepEqual((await stream.next()).value, {
    type: 'user',
    uuid: first,
    parent_tool_use_id: null,
    session_id: sessionId,
    message: { role: 'user', content: 'first' },
    origin: { kind: 'human' },
  });
  const waiting = stream.next();
  input.submit(second, 'second');
  assert.equal((await waiting).value?.uuid, second);
  assert.deepEqual(
    events.filter((event) => event.type === 'message.delivery').map((event) => event.status),
    ['submitted', 'queued', 'submitted', 'queued'],
  );
  input.close();
  assert.equal((await stream.next()).done, true);
});

test('native merged receipts complete multiple sends without inventing additional turns', async () => {
  const { input, events } = fixture();
  const ids = [randomUUID(), randomUUID()];
  const stream = input.stream();
  for (const id of ids) {
    input.submit(id, id);
    await stream.next();
  }
  input.observe({
    type: 'stream_event',
    parent_tool_use_id: null,
    user_message_uuid: ids[0],
  } as SDKMessage);
  input.observe({
    type: 'assistant',
    parent_tool_use_id: null,
    user_message_uuid: ids[0],
  } as SDKMessage);
  const done = result(ids);
  input.observe(done);
  assert.equal(input.endTurn(done), true);
  assert.throws(() => input.submit(randomUUID(), 'too late'), { code: 'run_finishing' });
  assert.deepEqual(
    events.flatMap((event) =>
      event.type === 'message.delivery' && event.status === 'received' ? [event.messageId] : [],
    ),
    ids,
  );
  input.close();
  assert.ok(
    !events.some((event) => event.type === 'message.delivery' && event.status === 'unconfirmed'),
  );
  await stream.next();
});

test('first result cannot discard a submitted input even if its native write is still pending', async () => {
  const { input } = fixture();
  const ids = [randomUUID(), randomUUID()];
  const stream = input.stream();
  input.submit(ids[0], 'first');
  await stream.next();
  input.submit(ids[1], 'second');
  const first = result([ids[0]]);
  input.observe(first);
  assert.equal(input.endTurn(first), false);
  assert.equal((await stream.next()).value?.uuid, ids[1]);
  const second = result([ids[1]]);
  input.observe(second);
  assert.equal(input.endTurn(second), true);
  input.close();
  await stream.next();
});

test('an interrupted turn keeps a pending human steer in the same input stream', async () => {
  for (const terminal_reason of ['aborted_streaming', 'aborted_tools'] as const) {
    const { input, events } = fixture();
    const stream = input.stream();
    const first = randomUUID(),
      steer = randomUUID();
    input.submit(first, 'first');
    await stream.next();
    input.submit(steer, 'change direction', undefined, 'now');
    const native = (await stream.next()).value!;
    assert.equal(native.priority, 'now');
    assert.deepEqual(native.origin, { kind: 'human' });
    const interrupted = { ...result([first], 1), terminal_reason };
    input.observe(interrupted);
    assert.equal(input.endTurn(interrupted), false);
    input.assertWritable();
    assert.ok(
      !events.some(
        (event) =>
          event.type === 'message.delivery' &&
          event.messageId === steer &&
          event.status === 'received',
      ),
    );
    const finished = result([steer]);
    input.observe(finished);
    assert.equal(input.endTurn(finished), true);
    input.close();
    await stream.next();
  }
});

test('cancel and disconnect distinguish never sent from unconfirmed and do not replay inputs', async () => {
  const { input, events } = fixture();
  const ids = [randomUUID(), randomUUID()];
  const stream = input.stream();
  input.submit(ids[0], 'delivered');
  await stream.next();
  input.submit(ids[1], 'not delivered');
  input.close();
  input.close();
  assert.equal((await stream.next()).done, true);
  assert.deepEqual(events.filter((event) => event.type === 'message.delivery').slice(-2), [
    { type: 'message.delivery', messageId: ids[0], status: 'unconfirmed' },
    { type: 'message.delivery', messageId: ids[1], status: 'not_sent' },
  ]);
  assert.throws(() => input.assertWritable(), { code: 'run_finishing' });
});

test('transport waiters close, bounded backlog rejects, and unrelated or subagent echoes cannot confirm a send', async () => {
  const { input, events } = fixture();
  const stream = input.stream();
  const ids = Array.from({ length: 32 }, () => randomUUID());
  for (const id of ids) input.submit(id, 'test');
  assert.throws(() => input.submit(randomUUID(), 'overflow'), { code: 'input_busy' });
  input.observe({
    type: 'assistant',
    parent_tool_use_id: 'nested',
    user_message_uuid: ids[0],
  } as SDKMessage);
  input.observe({
    type: 'assistant',
    parent_tool_use_id: null,
    user_message_uuid: randomUUID(),
  } as SDKMessage);
  assert.ok(
    !events.some((event) => event.type === 'message.delivery' && event.status === 'received'),
  );
  input.close();
  assert.equal((await stream.next()).done, true);
  const empty = fixture().input;
  const pending = empty.stream().next();
  empty.close();
  assert.equal((await pending).done, true);
});

test('fatal and older native results seal the input while reporting uncertain deliveries', async () => {
  for (const done of [
    { type: 'result', is_error: true, startup_failure_reason: 'config_file_invalid' },
    { type: 'result', is_error: false, queued_turn_count: 0 },
  ] as SDKResultMessage[]) {
    const { input, events } = fixture();
    const id = randomUUID();
    const stream = input.stream();
    input.submit(id, 'test');
    await stream.next();
    assert.equal(input.endTurn(done), true);
    assert.throws(() => input.assertWritable(), { code: 'run_finishing' });
    input.close();
    assert.ok(
      events.some((event) => event.type === 'message.delivery' && event.status === 'unconfirmed'),
    );
    await stream.next();
  }
});

test('a turn error keeps confirmed native backlog alive until its own result', async () => {
  const { input } = fixture();
  const stream = input.stream();
  const first = randomUUID(),
    second = randomUUID();
  input.submit(first, 'first');
  await stream.next();
  input.submit(second, 'second', undefined, 'now');
  await stream.next();
  const error = {
    ...result([first], 1),
    is_error: true,
    terminal_reason: 'api_error',
  } as SDKResultMessage;
  input.observe(error);
  assert.equal(input.endTurn(error), false);
  input.assertWritable();
  const completed = result([second]);
  input.observe(completed);
  assert.equal(input.endTurn(completed), true);
  input.close();
  await stream.next();
});

test('a turn that leaves background tasks running keeps the input open for the turn they start', () => {
  const { input } = fixture();
  assert.equal(input.endTurn(result([]), true), false);
  input.assertWritable();
  assert.equal(input.endTurn({ ...result([]), is_error: true } as SDKResultMessage, true), true);
  assert.throws(() => input.assertWritable());
  const idle = fixture().input;
  assert.equal(idle.endTurn(result([])), true);
});
