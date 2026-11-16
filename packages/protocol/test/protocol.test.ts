import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import {
  PROTOCOL_HISTORY,
  PROTOCOL_VERSION,
  messageText,
  authSchema,
  runWorking,
  commandSchema,
  eventSchema,
  serverMessageSchema,
  terminalControlSchema,
  tunnelCredentialsSchema,
} from '../src/index.ts';

test('scheduled provenance is a bounded optional marker and obsolete quota controls are rejected', () => {
  const command = {
    type: 'message.send',
    requestId: randomUUID(),
    sessionId: randomUUID(),
    text: '任务',
  };
  assert.equal(commandSchema.safeParse(command).success, true);
  for (const scheduled of ['scheduled', 'manual'])
    assert.equal(commandSchema.safeParse({ ...command, scheduled }).success, true);
  assert.equal(commandSchema.safeParse({ ...command, scheduled: 'peer' }).success, false);
  assert.equal(commandSchema.safeParse({ ...command, origin: { kind: 'human' } }).success, false);
  assert.equal(
    commandSchema.safeParse({ type: 'quota.watch', requestId: randomUUID(), active: true }).success,
    false,
  );
  assert.equal(
    commandSchema.safeParse({
      type: 'session.status',
      requestId: randomUUID(),
      sessionId: command.sessionId,
      quota: true,
    }).success,
    false,
  );
});

test('manual message priority is bounded and does not change scheduled provenance', () => {
  const message = {
    type: 'message.send',
    requestId: randomUUID(),
    sessionId: randomUUID(),
    text: '人工补充',
  };
  for (const priority of ['next', 'later', 'now']) {
    const parsed = commandSchema.parse({ ...message, priority });
    assert.ok(parsed.type === 'message.send' && parsed.priority === priority);
    assert.equal(
      commandSchema.safeParse({ ...message, priority, scheduled: 'manual' }).success,
      false,
    );
  }
  assert.equal(commandSchema.safeParse({ ...message, priority: 'urgent' }).success, false);
});

test('tunnel credentials accept spaces in usernames without allowing config delimiters', () => {
  const credentials = {
    type: 'tunnel.credentials',
    connectionId: randomUUID(),
    username: 'local user',
    privateKey: 'test-key',
    hostPublicKey: 'ssh-ed25519 AAAATEST',
    shells: ['pwsh'],
  };
  for (const username of ['local user', 'domain\\local user', 'user@example.com', 'user-name']) {
    assert.ok(tunnelCredentialsSchema.safeParse({ ...credentials, username }).success, username);
  }
  for (const username of [
    '',
    'user\nForwardAgent yes',
    'user\rname',
    'user\tname',
    'user"name',
    'user\0name',
    'user*',
  ]) {
    assert.equal(
      tunnelCredentialsSchema.safeParse({ ...credentials, username }).success,
      false,
      username,
    );
  }
});

test('setup tokens are bounded single-line credentials and never part of account state', () => {
  const message = {
    type: 'account.token',
    requestId: randomUUID(),
    token: ' setup-token-fixture ',
  };
  const command = commandSchema.parse(message);
  assert.equal(command.type, 'account.token');
  if (command.type === 'account.token') assert.equal(command.token, 'setup-token-fixture');
  for (const token of ['', 'one\ntwo', 'one two', 'x'.repeat(8193)])
    assert.equal(commandSchema.safeParse({ ...message, token }).success, false);
  const state = serverMessageSchema.parse({
    type: 'account.state',
    loggedIn: true,
    authMethod: 'oauth_token',
    login: null,
    token: message.token,
  });
  assert.equal('token' in state, false);
});

test('protocol validates UTF-8 text, IDs and bounded input', () => {
  const command = {
    type: 'message.send',
    requestId: randomUUID(),
    sessionId: randomUUID(),
    text: ' 检查 D:\\工作\\测试 ',
  };
  const parsed = commandSchema.parse(command);
  assert.equal(parsed.type, 'message.send');
  if (parsed.type === 'message.send') assert.equal(parsed.text, '检查 D:\\工作\\测试');
  assert.equal(commandSchema.safeParse({ ...command, text: ' ' }).success, false);
  assert.equal(commandSchema.safeParse({ ...command, text: 'a'.repeat(16001) }).success, false);
  assert.equal(commandSchema.safeParse({ ...command, sessionId: 'not-an-id' }).success, false);
  assert.equal(commandSchema.safeParse({ ...command, token: 'unexpected' }).success, false);
});

test('the protocol history ends with the current version', () => {
  assert.equal(Object.values(PROTOCOL_HISTORY).at(-1), PROTOCOL_VERSION);
});

test('file cards serialize to ordinary text and share the existing combined prompt limit', () => {
  const deviceId = randomUUID();
  const attachments = ['D:\\中文 空格\\a"b.ts', '/tmp/中文\\引号"换行\n.txt'].map((path) => ({
    path,
    name: '文件',
    deviceId,
    size: 12,
  }));
  const command = {
    type: 'message.send',
    requestId: randomUUID(),
    sessionId: randomUUID(),
    text: '',
    attachments,
  };
  assert.ok(commandSchema.safeParse(command).success);
  assert.deepEqual(
    messageText('', attachments)
      .split('\n')
      .map((line) => JSON.parse(line)),
    attachments.map((file) => file.path),
  );
  assert.equal(
    messageText('正文', attachments),
    `正文\n\n${attachments.map((file) => JSON.stringify(file.path)).join('\n')}`,
  );
  assert.equal(messageText('老消息\n'), '老消息\n');
  const inline = attachments.map((file, index) => ({ ...file, reference: index + 1 }));
  assert.equal(
    messageText('先看[文件 #2]，再改[文件 #1]。对照[文件 #2]', inline),
    `先看${JSON.stringify(inline[1].path)}，再改${JSON.stringify(inline[0].path)}。对照${JSON.stringify(inline[1].path)}`,
  );
  assert.equal(
    messageText('字面量[文件 #9]', inline),
    `字面量[文件 #9]\n\n${messageText('', attachments)}`,
  );
  assert.equal(
    commandSchema.safeParse({
      ...command,
      attachments: inline.map((file) => ({ ...file, reference: 1 })),
    }).success,
    false,
  );
  assert.equal(
    commandSchema.safeParse({ ...command, text: '[文件 #1]'.repeat(1000), attachments: inline })
      .success,
    false,
  );
  const references = messageText('', attachments).length;
  assert.ok(
    commandSchema.safeParse({ ...command, text: 'a'.repeat(16000 - references - 2) }).success,
  );
  assert.equal(
    commandSchema.safeParse({ ...command, text: 'a'.repeat(16001 - references - 2) }).success,
    false,
  );
  for (const file of [
    { ...attachments[0], deviceId: 'bad' },
    { ...attachments[0], path: '../other' },
    { ...attachments[0], size: -1 },
    { ...attachments[0], content: 'must not travel' },
  ])
    assert.equal(commandSchema.safeParse({ ...command, attachments: [file] }).success, false);
});

test('plan execution modes are bounded independently of the session mode', () => {
  const reply = {
    type: 'approval.reply',
    requestId: randomUUID(),
    sessionId: randomUUID(),
    runId: randomUUID(),
    approvalId: randomUUID(),
    allowed: true,
  };
  for (const executionMode of ['auto', 'default', 'acceptEdits'])
    assert.equal(commandSchema.safeParse({ ...reply, executionMode }).success, true);
  for (const executionMode of ['plan', 'bypassPermissions', 'dontAsk', 'unknown'])
    assert.equal(commandSchema.safeParse({ ...reply, executionMode }).success, false);
  assert.equal(commandSchema.safeParse(reply).success, true);
});
test('authentication version and event ordering are explicit', () => {
  const auth = {
    type: 'auth',
    protocolVersion: PROTOCOL_VERSION,
    token: 'x'.repeat(32),
    deviceName: '开发机',
  };
  assert.equal(authSchema.safeParse(auth).success, true);
  // Another version still authenticates, so that the service can answer with how to upgrade.
  assert.equal(authSchema.safeParse({ ...auth, protocolVersion: 9999 }).success, true);
  assert.equal(authSchema.safeParse({ ...auth, protocolVersion: 0 }).success, false);
  const event = {
    sessionId: randomUUID(),
    runId: randomUUID(),
    sequence: 1,
    createdAt: new Date().toISOString(),
    payload: { type: 'run.status', status: 'running', connectionId: randomUUID() },
  };
  assert.equal(eventSchema.safeParse(event).success, true);
  assert.equal(eventSchema.safeParse({ ...event, sequence: 0 }).success, false);
});

test('terminal control frames are explicitly scoped and bounded without request caches', () => {
  const frame = {
    type: 'terminal.input',
    sessionId: randomUUID(),
    terminalId: randomUUID(),
    data: '中文\r',
  };
  assert.equal(terminalControlSchema.safeParse(frame).success, true);
  assert.equal(
    terminalControlSchema.safeParse({ ...frame, data: 'x'.repeat(8193) }).success,
    false,
  );
  assert.equal(
    terminalControlSchema.safeParse({ ...frame, requestId: randomUUID() }).success,
    false,
  );
  assert.equal(
    terminalControlSchema.safeParse({
      type: 'terminal.ack',
      sessionId: frame.sessionId,
      terminalId: frame.terminalId,
      bytes: -1,
    }).success,
    false,
  );
  assert.equal(
    terminalControlSchema.safeParse({
      type: 'terminal.resize',
      sessionId: frame.sessionId,
      terminalId: frame.terminalId,
      cols: 0,
      rows: 30,
    }).success,
    false,
  );
});

test('a run waiting only for background tasks, its task list and the request to end one are valid', () => {
  const event = {
    sessionId: randomUUID(),
    runId: randomUUID(),
    sequence: 1,
    createdAt: new Date().toISOString(),
  };
  const status = { type: 'run.status', status: 'running', connectionId: randomUUID() };
  assert.ok(
    eventSchema.safeParse({ ...event, payload: { ...status, waiting: 'background' } }).success,
  );
  assert.ok(
    eventSchema.safeParse({
      ...event,
      payload: {
        type: 'native.tasks',
        tasks: [{ id: 'b1', kind: 'local_bash', description: '渲染' }],
      },
    }).success,
  );
  const stop = {
    type: 'run.task.stop',
    requestId: randomUUID(),
    sessionId: event.sessionId,
    runId: event.runId,
    taskId: 'b1',
  };
  assert.ok(commandSchema.safeParse(stop).success);
  assert.equal(commandSchema.safeParse({ ...stop, taskId: '' }).success, false);
  const background = {
    type: 'run.task.background',
    requestId: randomUUID(),
    sessionId: event.sessionId,
    runId: event.runId,
    toolId: 'call-1',
  };
  assert.ok(commandSchema.safeParse(background).success);
  assert.equal(commandSchema.safeParse({ ...background, toolId: '' }).success, false);
  assert.ok(
    eventSchema.safeParse({
      ...event,
      payload: { type: 'tool.task', toolId: 'call-1', taskId: 'b1' },
    }).success,
  );
});

test('a session report is asked for by session and answers with its figures', () => {
  const requestId = randomUUID();
  const sessionId = randomUUID();
  assert.ok(commandSchema.safeParse({ type: 'session.stats', requestId, sessionId }).success);
  assert.equal(commandSchema.safeParse({ type: 'session.stats', requestId }).success, false);
  const stats = {
    type: 'session.stats',
    requestId,
    sessionId,
    turns: 2,
    requests: 4,
    inputTokens: 40,
    outputTokens: 1000,
    cacheReadTokens: 4000,
    cacheCreationTokens: 200,
    modelMs: 11500,
    ttftMs: null,
    outputPerSecond: null,
    firstRecordAt: null,
  };
  assert.equal(serverMessageSchema.safeParse(stats).success, true);
  assert.equal(serverMessageSchema.safeParse({ ...stats, turns: -1 }).success, false);
  assert.equal(
    serverMessageSchema.safeParse({ ...stats, firstRecordAt: 'yesterday' }).success,
    false,
  );
});

test('a turn report names the message it answered, or none for a turn a background task started', () => {
  const stats = {
    type: 'turn.stats',
    requests: 3,
    inputTokens: 10,
    outputTokens: 200,
    cacheReadTokens: 1000,
    cacheCreationTokens: 50,
    modelMs: 5500,
    ttftMs: null,
    outputPerSecond: null,
    partial: false,
  };
  const event = (payload: object) => ({
    sessionId: randomUUID(),
    runId: randomUUID(),
    sequence: 1,
    createdAt: new Date().toISOString(),
    payload,
  });
  assert.equal(eventSchema.safeParse(event({ ...stats, messageId: randomUUID() })).success, true);
  assert.equal(eventSchema.safeParse(event(stats)).success, true);
  assert.equal(eventSchema.safeParse(event({ ...stats, requests: -1 })).success, false);
  assert.equal(eventSchema.safeParse(event({ ...stats, partial: undefined })).success, false);
});

test('a run is at work while a turn goes or waits on the user, or the CLI of a terminal works or waits', () => {
  const run = { id: randomUUID(), connectionId: randomUUID(), status: 'running' as const };
  assert.equal(runWorking(null), false);
  assert.equal(runWorking(run), true);
  assert.equal(runWorking({ ...run, status: 'awaiting_approval', waiting: 'question' }), true);
  assert.equal(runWorking({ ...run, waiting: 'background' }), false);
  assert.equal(runWorking({ ...run, surface: 'terminal', activity: 'working' }), true);
  assert.equal(runWorking({ ...run, surface: 'terminal', activity: 'waiting' }), true);
  assert.equal(runWorking({ ...run, surface: 'terminal', activity: 'idle' }), false);
  assert.equal(runWorking({ ...run, surface: 'terminal' }), false);
  const install = { type: 'service.update.install', requestId: randomUUID(), version: '0.3.15' };
  assert.equal(commandSchema.safeParse(install).success, true);
  assert.equal(commandSchema.safeParse({ ...install, force: true }).success, true);
  assert.equal(commandSchema.safeParse({ ...install, force: 'yes' }).success, false);
});
