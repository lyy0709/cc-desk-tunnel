import assert from 'node:assert/strict';
import { test } from 'node:test';
import { registerHooks } from 'node:module';
import { once } from 'node:events';
import { PassThrough } from 'node:stream';
import { execFileSync } from 'node:child_process';
// @ts-expect-error The terminal client is shipped as ESM.
import { Service } from '../../cli/src/connection.mjs';
// @ts-expect-error The terminal client is shipped as ESM.
import { relay } from '../../cli/src/terminal.mjs';
import {
  appendFileSync,
  realpathSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  truncateSync,
  symlinkSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID, X509Certificate } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket } from 'ws';
import { PROTOCOL_VERSION, type Session, type SessionEvent } from '@cc-desk-tunnel/protocol';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { crc32 } from 'node:zlib';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { defaultCertificate } from './fixtures/web-certificates.ts';
import { runClaude, rememberableCall } from '../src/claude.ts';
import { NativeInput } from '../src/native-input.ts';
import {
  OWN_FILE_TOOLS,
  ownDirectories,
  ownFile,
  ownFilesPrompt,
  projectBuiltinTools,
  projectPrompt,
} from '../src/project-tools.ts';
import { terminalSettings } from '../src/terminal-transcript.ts';
// @ts-expect-error The native bridge is a bundled ESM module.
import { openProxyBridge } from '../../desktop/electron/proxy-bridge.mjs';
// @ts-expect-error Packaging helper used to exercise the same binary users receive.
import { buildProjectFiles } from '../../../scripts/build-project-files.mjs';

test('built-in plan and memory file guards reject linked files and parents in chat and terminal', (t) => {
  const temp = mkdtempSync(join(tmpdir(), 'ccdt-own-files-'));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const directories = ownDirectories(join(temp, "it's config"), join(temp, 'project'));
  for (const directory of directories) mkdirSync(directory, { recursive: true });
  const outside = join(temp, 'outside');
  mkdirSync(outside);
  writeFileSync(join(outside, 'file.txt'), 'outside');
  symlinkSync(
    outside,
    join(directories[0], 'linked'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  symlinkSync(join(outside, 'file.txt'), join(directories[1], 'linked.txt'));
  const cases: [string, boolean][] = [
    [join(directories[0], 'new-plan.md'), true],
    [join(directories[1], 'nested', 'new.md'), true],
    [join(directories[0], 'linked', 'file.txt'), false],
    [join(directories[0], 'linked', 'new.txt'), false],
    [`${directories[0]}/linked/../outside/file.txt`, false],
    [join(directories[1], 'linked.txt'), false],
    [join(directories[0], '..', 'settings.json'), false],
    [outside, false],
  ];
  const overlay = ownDirectories(join(temp, 'runtime-home'), join(temp, 'project'));
  assert.equal(ownFile({ file_path: join(overlay[1], 'linked.txt') }, overlay, directories), false);
  assert.equal(ownFile({ file_path: join(overlay[1], 'new.md') }, overlay, directories), true);
  const settings = join(temp, 'settings.json');
  terminalSettings(settings, join(temp, 'hooks'), undefined, undefined, undefined, undefined, {
    node: process.execPath,
    script: resolve('apps/server/src/project-tools.ts'),
    directories,
  });
  const hook = JSON.parse(readFileSync(settings, 'utf8')).hooks.PreToolUse[0].hooks[0];
  assert.equal(hook.onFailure, 'block');
  for (const [file_path, expected] of cases) {
    assert.equal(ownFile({ file_path }, directories), expected, file_path);
    if (process.platform !== 'win32') {
      const result = JSON.parse(
        execFileSync('sh', ['-c', hook.command], {
          input: JSON.stringify({
            hook_event_name: 'PreToolUse',
            tool_name: 'Write',
            tool_input: { file_path },
          }),
          encoding: 'utf8',
        }),
      );
      assert.equal(result.hookSpecificOutput?.permissionDecision === 'deny', !expected, file_path);
    }
  }
  assert.equal(rememberableCall('mcp__project__command', {}), true);
  for (const context of [
    { suppressAlwaysAllowRule: true },
    { defaultToNo: true },
    { matchedAskRule: {} },
  ])
    assert.equal(rememberableCall('mcp__project__command', context), false);
  assert.equal(rememberableCall('mcp__project__edit', {}), false);
});

test(
  'a pinned desktop connection executes session-bound MCP operations and loses command authority on disconnect',
  {
    timeout: 60000,
    skip:
      process.platform === 'win32' &&
      'The server PTY runs on a POSIX host; Windows device paths are exercised by project-access.test.mjs.',
  },
  async (t) => {
    const temp = mkdtempSync(join(process.platform === 'win32' ? tmpdir() : '/tmp', 'ccdt-p-'));
    const project = join(temp, 'private-user-project');
    mkdirSync(project);
    writeFileSync(join(project, 'index.ts'), 'original\n');
    const originalConfig = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = join(temp, 'test-config');
    t.after(() => {
      if (originalConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = originalConfig;
    });
    const helper = buildProjectFiles(temp);
    const device = randomUUID(),
      token = randomUUID(),
      events: any[] = [];
    const driver = Symbol.for('ccdt-project-fixture');
    let mcp!: Client, finish!: () => void;
    let activeRun: Parameters<typeof runClaude>[1];
    const done = new Promise<void>((ok) => {
      finish = ok;
    });
    Reflect.set(globalThis, driver, async (_opts: unknown, run: any) => {
      activeRun = run;
      mcp = new Client({ name: 'fixture', version: '1' });
      await mcp.connect(
        new StdioClientTransport({
          command: process.execPath,
          args: [resolve('apps/server/src/project-mcp.ts'), run.projectTools.args[1]],
        }),
      );
      await done;
      await mcp.close();
      return 'completed';
    });
    const hooks = registerHooks({
      resolve(spec, ctx, next) {
        if (spec === './claude.ts' && ctx.parentURL?.includes('project-fixture'))
          return {
            url:
              'data:text/javascript,' +
              encodeURIComponent(`
      export const runClaude=(...args)=>globalThis[Symbol.for('ccdt-project-fixture')](...args);
      export * from ${JSON.stringify(new URL('../src/claude.ts', import.meta.url).href)};
    `),
            shortCircuit: true,
          };
        return next(spec, ctx);
      },
    });
    const { createProxyServer } = await import(
      new URL('../src/server.ts?project-fixture', import.meta.url).href
    );
    const fake = join(temp, 'fixture-cli.mjs');
    writeFileSync(
      fake,
      `#!${process.execPath}
import {Client} from ${JSON.stringify(import.meta.resolve('@modelcontextprotocol/sdk/client/index.js'))};
import {StdioClientTransport} from ${JSON.stringify(import.meta.resolve('@modelcontextprotocol/sdk/client/stdio.js'))};
import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
if (process.argv.slice(2).join(' ') === 'auth status --json') {
  if (process.env.CCDT_ACCOUNT_PROFILE !== 'personal') process.exit(2);
  console.log(JSON.stringify({loggedIn:true,authMethod:'claude.ai',email:'alice@example.test',orgId:'org-A'}));
  process.exit(0);
}
if (process.argv.slice(2).join(' ') === 'auth login') {
  if (process.env.CCDT_ACCOUNT_PROFILE !== 'personal' || process.env.CCDT_RUNTIME_SESSION) process.exit(2);
  console.log('FIXTURE-AUTH-URL');
  const {createInterface}=await import('node:readline');
  for await (const line of createInterface({input:process.stdin})) process.exit(line==='fixture-reply' ? 0 : 3);
}
const config=JSON.parse(process.argv[process.argv.indexOf('--mcp-config')+1]).mcpServers.project;
const client=new Client({name:'fixture-pty',version:'1'});await client.connect(new StdioClientTransport(config));
if (!(await client.listTools()).tools.some(tool=>tool.name==='command')) throw new Error('missing initial session grant');
const result=await client.callTool({name:'read',arguments:{path:'index.ts'}});
const session=process.argv[process.argv.includes('--resume') ? process.argv.indexOf('--resume')+1 : process.argv.indexOf('--session-id')+1];
const record={attributes:Object.entries({'event.name':'api_request','session.id':session,'user.email':'alice@example.test','organization.id':'org-A',model:'fixture'}).map(([key,stringValue])=>({key,value:{stringValue}}))};
const res=await fetch(process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({resourceLogs:[{scopeLogs:[{logRecords:[record]}]}]})});
if (!res.ok) throw new Error('fixture telemetry rejected');
const {statusLine,hooks}=JSON.parse(readFileSync(process.argv[process.argv.indexOf('--settings')+1],'utf8'));
const builtins=process.argv[process.argv.indexOf('--tools')+1].split(',');
for (const name of ['Read','Write','Edit']) if (!builtins.includes(name)) throw new Error('missing plan file tool');
const guard=hooks.PreToolUse.find(hook=>hook.matcher==='Read|Write|Edit').hooks[0];
const denied=JSON.parse(execFileSync('sh',['-c',guard.command],{input:JSON.stringify({hook_event_name:'PreToolUse',tool_name:'Write',tool_input:{file_path:'/outside/fixture.txt'}}),encoding:'utf8'}));
if(denied.hookSpecificOutput?.permissionDecision!=='deny') throw new Error('unguarded terminal files');
execFileSync('sh',['-c',statusLine.command],{input:JSON.stringify({rate_limits:{five_hour:{used_percentage:0},seven_day:{used_percentage:5,resets_at:Math.floor(Date.now()/1000)+86400}}})});
console.log('PTY-FIXTURE',result.content.map(block=>block.text).join(' '));await client.close();
`,
      { mode: 0o755 },
    );
    const server = createProxyServer({
      token,
      dataDir: join(temp, 'broker'),
      tls: { cert: Buffer.from(defaultCertificate.cert), key: Buffer.from(defaultCertificate.key) },
      claude: { executable: fake },
      // Room for the fixture's one run: what is sent to another session while it goes starts nothing.
      maxRuns: 1,
    });
    const url = (await server.listen(0)).replace('https', 'wss') + '/ws';
    const connect = async () => {
      const bridge = await openProxyBridge(
        { url, fingerprint: new X509Certificate(defaultCertificate.cert).fingerprint256 },
        {
          environment: { HOME: temp, ZDOTDIR: temp },
          projects: {
            helper,
            database: join(temp, 'bindings.sqlite'),
            chooseRoot: async (path: string) => path === realpathSync(project),
          },
        },
      );
      const socket = new WebSocket(bridge.url);
      socket.on('message', (raw) => events.push(JSON.parse(String(raw))));
      await once(socket, 'open');
      socket.send(
        JSON.stringify({
          type: 'auth',
          protocolVersion: PROTOCOL_VERSION,
          deviceName: 'test',
          token,
        }),
      );
      socket.send(JSON.stringify({ type: 'device', id: device }));
      return { bridge, socket };
    };
    let { bridge, socket } = await connect();
    t.after(async () => {
      finish();
      await bridge.close();
      socket.terminate();
      await server.close();
      hooks.deregister();
      Reflect.deleteProperty(globalThis, driver);
      rmSync(temp, { recursive: true, force: true });
    });
    async function request(fields: Record<string, unknown>, connection = socket, ok = true) {
      const requestId = randomUUID();
      connection.send(JSON.stringify({ ...fields, requestId }));
      for (let n = 0; n < 300; n++) {
        const result = events.find((e) => e.type === 'response' && e.requestId === requestId);
        if (result) {
          assert.equal(result.ok, ok, result.message);
          return result;
        }
        await delay(10);
      }
      throw new Error('missing response');
    }
    const { sessionId } = await request({
      type: 'session.create',
      projectPath: project,
      title: 'fixture',
    });
    assert.match(server.store.get(sessionId).session.projectPath, /^project:/);
    await request({ type: 'message.send', sessionId, text: 'fixture' });
    for (let n = 0; !mcp?.getServerVersion() && n < 300; n++) await delay(10);
    const call = async (name: string, args: Record<string, unknown>) => {
      const r = await mcp.callTool({ name, arguments: args });
      const content = r.content as { text: string }[];
      return {
        text: content.map((block) => block.text).join('\n'),
        metadata: content.length > 1 ? JSON.parse(content[0].text) : undefined,
        body: content
          .slice(1)
          .map((block) => block.text)
          .join('\n'),
        error: r.isError,
      };
    };
    // A session from before projects were bound goes on without being asked about, its history as it is, once its
    // project is bound on its computer. The one run this service has room for is going, so nothing more starts.
    const previous = { ...server.store.get(sessionId).session };
    delete previous.projectAccess;
    const legacy = async (projectPath: string) => {
      const id = randomUUID();
      server.store.database
        .prepare('INSERT INTO sessions VALUES(?,?,?)')
        .run(id, JSON.stringify({ ...previous, id, projectPath, activeRun: null }), randomUUID());
      const refused = await request(
        { type: 'message.send', sessionId: id, text: 'scheduled', scheduled: 'scheduled' },
        socket,
        false,
      );
      return { code: refused.code, session: server.store.get(id).session };
    };
    const taken = await legacy(previous.projectPath);
    assert.equal(taken.code, 'capacity');
    assert.equal(taken.session.projectAccess, 1);
    // One whose project was never bound, which the path it still names says, waits for its computer to bind it.
    const unbound = await legacy(project);
    assert.equal(unbound.code, 'project_binding');
    assert.equal(unbound.session.projectAccess, undefined);
    const before = await call('read', { path: 'index.ts' });
    assert.equal(before.body, 'original\n');
    assert.ok((await call('search', { path: '.', query: 'original' })).text.includes('index.ts:1'));
    writeFileSync(join(project, 'index.ts'), 'external original\n');
    const edit = {
      path: 'index.ts',
      old: 'original',
      new: 'edited',
      revision: before.metadata.revision,
    };
    assert.ok((await call('edit', edit)).error);
    edit.revision = (await call('read', { path: 'index.ts' })).metadata.revision;
    assert.ok(!(await call('edit', edit)).error);
    assert.equal(readFileSync(join(project, 'index.ts'), 'utf8'), 'external edited\n');
    assert.ok((await call('read', { path: '../bindings.sqlite' })).error);
    // Place a valid PNG metadata chunk before IEND to make a 1 MiB fixture with known original bytes.
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGMQMgn7DwAClAGcHVtGXwAAAABJRU5ErkJggg==',
      'base64',
    );
    const chunk = Buffer.alloc(1024 * 1024 - png.length, 65);
    chunk.writeUInt32BE(chunk.length - 12);
    chunk.write('tEXtNote\0', 4);
    chunk.writeUInt32BE(crc32(chunk.subarray(4, -4)), chunk.length - 4);
    const image = Buffer.concat([png.subarray(0, -12), chunk, png.subarray(-12)]);
    writeFileSync(join(project, 'sample.png'), image);
    writeFileSync(join(temp, 'attachment.PNG'), image);
    const attachment = await bridge.projects.attachment(sessionId, {
      path: join(temp, 'attachment.PNG'),
    });
    writeFileSync(join(temp, 'attachment.PNG'), 'replaced after approval');
    const execute = bridge.projects.call.bind(bridge.projects);
    const offsets: number[] = [];
    bridge.projects.call = async (message: { operation: { path: string; offset: number } }) => {
      offsets.push(message.operation.offset);
      const part = await execute(message);
      if (message.operation.path === 'changing.png' && message.operation.offset === 0)
        appendFileSync(join(project, 'changing.png'), 'x');
      return part;
    };
    for (const path of ['sample.png', attachment.path]) {
      offsets.length = 0;
      const result = await mcp.callTool({ name: 'read', arguments: { path } });
      const block = (result.content as { type: string; mimeType: string; data: string }[])[0];
      assert.equal(block.type, 'image');
      assert.equal(block.mimeType, 'image/png');
      assert.ok(Buffer.from(block.data, 'base64').equals(image));
      assert.deepEqual(
        offsets,
        Array.from({ length: 16 }, (_, i) => i * 65536),
      );
    }
    assert.ok((await call('read', { path: 'sample.png', offset: 12000 })).error);
    writeFileSync(join(project, 'changing.png'), image);
    const changedImage = await call('read', { path: 'changing.png' });
    assert.ok(changedImage.error);
    assert.match(changedImage.text, /图片已变更/);
    truncateSync(join(project, 'changing.png'), 20 * 1024 * 1024 + 1);
    const oversized = await call('read', { path: 'changing.png' });
    assert.ok(oversized.error);
    assert.match(oversized.text, /20 MiB/);
    writeFileSync(join(project, 'long.txt'), 'x'.repeat(32001));
    assert.equal((await call('read', { path: 'long.txt' })).metadata.next, 32000);
    const created = JSON.parse(
      (await call('create', { path: 'revisions.txt', new: 'first\n重复\n重复\n' })).text,
    );
    assert.equal((await call('read', { path: 'revisions.txt', line: 2 })).body, '重复\n重复\n');
    const edited = JSON.parse(
      (
        await call('edit', {
          path: 'revisions.txt',
          old: '重复',
          new: 'changed',
          all: true,
          revision: created.revision,
        })
      ).text,
    );
    assert.equal(
      (
        await call('edit', {
          path: 'revisions.txt',
          old: 'first',
          new: 'FIRST',
          revision: edited.revision,
        })
      ).error,
      false,
    );
    assert.equal((await call('read', { path: 'revisions.txt' })).body, 'FIRST\nchanged\nchanged\n');
    const normalCall = bridge.projects.call;
    try {
      for (const oversizedText of ['x'.repeat(120001), '中'.repeat(100000)]) {
        bridge.projects.call = async () => JSON.stringify({ text: oversizedText });
        const tooLarge = await call('read', { path: 'index.ts' });
        assert.equal(tooLarge.error, true);
        assert.match(tooLarge.text, /传输的上限/);
        assert.equal(socket.readyState, WebSocket.OPEN);
      }
    } finally {
      bridge.projects.call = normalCall;
    }
    assert.equal((await call('read', { path: 'index.ts' })).body, 'external edited\n');
    const input = JSON.stringify({ new: 'private-edit-marker' + '写'.repeat(22000) });
    const decision = activeRun!.approve(
      'tool-1',
      'approval',
      'mcp__project__edit',
      activeRun!.signal,
      { input, title: '编辑文件', description: '审批详情' },
    );
    const entry = server.store
      .get(sessionId)
      .events.findLast((e: any) => e.payload.type === 'approval.requested')!;
    assert.ok(entry.payload.type === 'approval.requested');
    const approval = { sessionId, runId: entry.runId, approvalId: entry.payload.approvalId };
    const inspect = { type: 'approval.inspect', ...approval, offset: 0 };
    const observer = await connect();
    try {
      assert.equal((await request(inspect, observer.socket, false)).code, 'approval_inactive');
    } finally {
      await observer.bridge.close();
      observer.socket.terminate();
    }
    const page = async (offset: number) => {
      const { requestId } = await request({ ...inspect, offset });
      return events.find((e) => e.type === 'approval.detail' && e.requestId === requestId);
    };
    const first = await page(0),
      second = await page(first.next);
    assert.equal(first.title, '编辑文件');
    assert.equal(first.description, '审批详情');
    assert.equal(first.input + second.input, input);
    assert.equal(second.next, undefined);
    assert.equal(
      (
        await request(
          { type: 'approval.reply', ...approval, allowed: true, remember: true },
          socket,
          false,
        )
      ).code,
      'invalid_approval_remember',
    );
    await request({ type: 'approval.reply', ...approval, allowed: false });
    assert.equal((await decision).allowed, false);
    assert.equal((await request(inspect, socket, false)).code, 'approval_inactive');
    assert.ok(!JSON.stringify(server.store.get(sessionId).events).includes('private-edit-marker'));
    const askCommand = (id: string) =>
      activeRun!.approve(id, 'approval', 'mcp__project__command', activeRun!.signal, {
        input: '{"command":"echo fixture"}',
        rememberable: true,
      });
    const answer = async (toolId: string, remember = false) => {
      const pending = server.store
        .get(sessionId)
        .events.findLast(
          (event: SessionEvent) =>
            event.payload.type === 'approval.requested' && event.payload.toolId === toolId,
        )!;
      assert.ok(pending?.payload.type === 'approval.requested');
      assert.equal(pending.payload.rememberable, true);
      await request({
        type: 'approval.reply',
        sessionId,
        runId: pending.runId,
        approvalId: pending.payload.approvalId,
        allowed: true,
        ...(remember && { remember: true }),
      });
    };
    const one = askCommand('command-1'),
      two = askCommand('command-2');
    await answer('command-1', true);
    assert.equal((await one).allowed, true);
    assert.equal((await two).allowed, true);
    const eventCount = server.store.get(sessionId).events.length;
    assert.equal((await askCommand('command-3')).allowed, true);
    assert.equal(server.store.get(sessionId).events.length, eventCount);
    const commandListed = async () =>
      (await mcp.listTools()).tools.some((tool) => tool.name === 'command');
    const changed = () =>
      new Promise<void>((resolve) =>
        mcp.setNotificationHandler(ToolListChangedNotificationSchema, () => resolve()),
      );
    assert.equal(await commandListed(), true);
    let update: Promise<void>;
    assert.match((await call('command', { command: 'echo fixture' })).text, /fixture/);
    update = changed();
    bridge.projects.commands(sessionId, false);
    await update;
    assert.equal(await commandListed(), false);
    update = changed();
    bridge.projects.commands(sessionId, true);
    await update;
    const reset = askCommand('command-reset');
    await answer('command-reset', true);
    assert.equal((await reset).allowed, true);
    const disconnected = changed();
    let writes = 0;
    bridge.projects.call = async (message: unknown) => {
      const result = await execute(message);
      writes++;
      const closed = once(socket, 'close');
      socket.terminate();
      await closed;
      await delay(20);
      return result;
    };
    const interrupted = await call('create', { path: 'once.txt', new: 'first' });
    assert.ok(interrupted.error);
    assert.equal(readFileSync(join(project, 'once.txt'), 'utf8'), 'first');
    assert.equal(writes, 1);
    await disconnected;
    const reconnected = changed();
    ({ bridge, socket } = await connect());
    await reconnected;
    for (let n = 0; !bridge.projects.sessions.has(sessionId) && n < 300; n++) await delay(10);
    assert.equal(await commandListed(), true);
    const afterDisconnect = askCommand('command-reconnected');
    await answer('command-reconnected');
    assert.equal((await afterDisconnect).allowed, true);
    assert.ok(!events.some((e) => e.type.startsWith('tunnel.')));
    finish();
    for (let n = 0; server.store.get(sessionId).session.activeRun && n < 300; n++) await delay(10);
    const terminal = new Service();
    terminal.bridge = await openProxyBridge(
      { url, fingerprint: new X509Certificate(defaultCertificate.cert).fingerprint256 },
      {
        projects: {
          helper,
          database: join(temp, 'bindings.sqlite'),
          chooseRoot: async () => false,
        },
      },
    );
    await terminal.open(token, device);
    await terminal.channel(3000);
    try {
      const output = new PassThrough();
      let printed = '';
      output.on('data', (b) => (printed += String(b)));
      const result = await relay(terminal, sessionId, {}, new PassThrough(), output);
      assert.equal(result.code, 0);
      assert.equal(server.store.get(sessionId).session.device?.name, `设备 ${device.slice(0, 8)}`);
      assert.match(printed, /PTY-FIXTURE.*external edited/);
      assert.ok(!printed.includes(project));
      // The quota the terminal's status line showed is the account's, as a chat run's would be.
      const summary = await terminal.request({ type: 'usage.summary' });
      assert.deepEqual(
        summary.windows.map((w: { utilization: number }) => w.utilization),
        [0, 5],
      );
      assert.equal(summary.windows[1].requests, 1);
      assert.equal(server.store.lastQuota(sessionId)?.windows[1]?.utilization, 5);
      const previous = server.store.list(true).map((session: Session) => session.id);
      const keys = new PassThrough(),
        screen = new PassThrough();
      let answered = false,
        display = '';
      screen.on('data', (chunk) => {
        display += String(chunk);
        if (!answered && display.includes('FIXTURE-AUTH-URL')) {
          answered = true;
          keys.write('fixture-reply\r');
        }
      });
      const auth = await relay(terminal, randomUUID(), { login: true }, keys, screen);
      assert.equal(auth.code, 0);
      assert.equal(answered, true);
      assert.deepEqual(
        server.store.list(true).map((session: Session) => session.id),
        previous,
      );
    } finally {
      await terminal.close();
    }
  },
);

test(
  'the official SDK sends queued project input only after an acknowledged stdin configuration',
  {
    skip: process.platform === 'win32',
    timeout: 20000,
  },
  async (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'ccdt-sdk-init-'));
    const original = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = join(directory, 'config');
    t.after(() => {
      if (original === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = original;
      rmSync(directory, { recursive: true, force: true });
    });
    const executable = join(directory, 'fixture-cli.mjs');
    writeFileSync(
      executable,
      `#!${process.execPath}
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
for await (const line of createInterface({input: process.stdin})) {
  const frame = JSON.parse(line);
  const say = message => console.log(JSON.stringify(message));
  const reply = response => say({type:'control_response',response:{request_id:frame.request_id,...response}});
  if (frame.request?.subtype === 'initialize') {
    appendFileSync(process.env.FIXTURE_TRACE,JSON.stringify({type:'initialize',argv:process.argv.slice(2),servers:frame.request.mcpServers,prompt:frame.request.appendSystemPrompt,hooks:frame.request.hooks})+'\\n');
    if (process.env.FIXTURE_ACK === 'error') reply({subtype:'error',error:'fixture initialize rejected'});
    else reply({subtype:'success',response:{commands:[],models:[],agents:[],account:{},hook_on_failure_supported:process.env.FIXTURE_ACK!=='hook-unsupported',
      ...(process.env.FIXTURE_ACK !== 'missing' && {mcp_servers_applied:process.env.FIXTURE_ACK === 'true'})}});
  } else if (frame.type === 'user') {
    appendFileSync(process.env.FIXTURE_TRACE,'{"type":"user"}\\n');
    say({type:'system',subtype:'init',session_id:frame.session_id,model:'fixture',claude_code_version:'fixture',mcp_servers:[{name:'project',status:'pending'}]});
    say({type:'system',subtype:'informational',session_id:frame.session_id,level:'warning',tag:'managed_mcp_arrived',content:'fixture policy'});
  } else if (frame.request?.subtype === 'mcp_status') {
    reply({subtype:'success',response:{mcpServers:[{name:'project',status:'connected',config:{unused:'private configuration'}}]}});
  }
}
`,
      { mode: 0o755 },
    );
    const projectTools = {
      type: 'stdio' as const,
      command: 'node',
      args: ['project-mcp.ts', join(directory, 'project.sock')],
    };
    for (const ack of ['true', 'false', 'missing', 'error', 'hook-unsupported']) {
      const sessionId = randomUUID(),
        receipt = join(directory, ack + '.jsonl');
      const stop = new AbortController();
      const controls: Parameters<typeof runClaude>[1]['controls'] = {};
      const statuses: string[] = [];
      const input = new NativeInput(sessionId, () => {});
      input.submit(randomUUID(), 'fixture input');
      const outcome = await runClaude(
        { executable, environment: { FIXTURE_ACK: ack, FIXTURE_TRACE: receipt } },
        {
          sessionId,
          nativeRoot: sessionId,
          projectTools,
          subagents: ack === 'true',
          permissionMode: 'default',
          input,
          resume: false,
          dataDir: directory,
          signal: AbortSignal.any([stop.signal, t.signal]),
          emit(event) {
            if (event.type === 'native.project_mcp') {
              statuses.push(event.status);
              if (event.status === 'policy') void controls.refreshProject!();
              if (event.status === 'connected') stop.abort();
            }
          },
          approve: async () => ({ allowed: false }),
          waiting() {},
          turnEnded() {},
          controls,
        },
      );
      assert.equal(outcome, ack === 'true' ? 'cancelled' : 'failed', ack);
      const frames = readFileSync(receipt, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      const { argv, servers, prompt } = frames[0];
      assert.equal(frames[0].hooks.PreToolUse[0].onFailure, 'block');
      assert.equal(frames.filter((f) => f.type === 'user').length, Number(ack === 'true'), ack);
      if (ack === 'true') assert.deepEqual(statuses, ['pending', 'policy', 'connected']);
      if (ack === 'false') assert.deepEqual(statuses, ['not_applied']);
      assert.deepEqual(servers, { project: projectTools });
      assert.equal(prompt, `${projectPrompt} ${ownFilesPrompt}`);
      assert.doesNotMatch(prompt, /\b(?:ssh|scp|sftp)\b/i);
      const tools = projectBuiltinTools({ subagents: ack === 'true' }, true);
      assert.ok(argv.includes(`--tools=${tools.join(',')}`));
      // File tools are guarded; host commands and unrestricted search remain unavailable.
      assert.equal(tools.includes('Agent'), ack === 'true');
      for (const name of ['Bash', 'Glob', 'Grep', 'NotebookEdit'])
        assert.ok(!tools.includes(name), name);
      for (const name of ['WebSearch', 'WebFetch', 'TodoWrite', ...OWN_FILE_TOOLS])
        assert.ok(tools.includes(name), name);
      assert.ok(argv.includes('--strict-mcp-config'));
      assert.ok(!argv.join(' ').includes('ssh device'));
      assert.ok(!argv.includes('--mcp-config'));
      assert.ok(!JSON.stringify(argv).includes(projectTools.args[1]));
    }
  },
);
