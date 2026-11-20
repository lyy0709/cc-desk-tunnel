import assert from 'node:assert/strict';
import { test } from 'node:test';
import { registerHooks } from 'node:module';
import { once } from 'node:events';
import { PassThrough } from 'node:stream';
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
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID, X509Certificate } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket } from 'ws';
import { PROTOCOL_VERSION, type Session } from '@cc-desk-tunnel/protocol';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { crc32 } from 'node:zlib';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { defaultCertificate } from './fixtures/web-certificates.ts';
import { runClaude } from '../src/claude.ts';
import { NativeInput } from '../src/native-input.ts';
import { projectBuiltinTools, projectPrompt } from '../src/project-tools.ts';
// @ts-expect-error The native bridge is a bundled ESM module.
import { openProxyBridge } from '../../desktop/electron/proxy-bridge.mjs';
// @ts-expect-error Packaging helper used to exercise the same binary users receive.
import { buildProjectFiles } from '../../../scripts/build-project-files.mjs';

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
const {statusLine}=JSON.parse(readFileSync(process.argv[process.argv.indexOf('--settings')+1],'utf8'));
execFileSync('sh',['-c',statusLine.command],{input:JSON.stringify({rate_limits:{five_hour:{used_percentage:0},seven_day:{used_percentage:5,resets_at:Math.floor(Date.now()/1000)+86400}}})});
console.log('PTY-FIXTURE',result.content[0].text);await client.close();
`,
      { mode: 0o755 },
    );
    const server = createProxyServer({
      token,
      dataDir: join(temp, 'broker'),
      tls: { cert: Buffer.from(defaultCertificate.cert), key: Buffer.from(defaultCertificate.key) },
      claude: { executable: fake },
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
            confirmFile: async (file: string) =>
              file === realpathSync(join(temp, 'attachment.PNG')),
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
      return { text: content[0].text, error: r.isError };
    };
    // A legacy session with native context must be explicitly accepted before a background run can reuse it.
    const previous = { ...server.store.get(sessionId).session };
    delete previous.projectAccess;
    const legacyId = randomUUID();
    server.store.database
      .prepare('INSERT INTO sessions VALUES(?,?,?)')
      .run(legacyId, JSON.stringify({ ...previous, id: legacyId, activeRun: null }), randomUUID());
    const rid = randomUUID();
    socket.send(
      JSON.stringify({
        type: 'message.send',
        requestId: rid,
        sessionId: legacyId,
        text: 'scheduled',
        scheduled: 'scheduled',
      }),
    );
    for (let n = 0; !events.find((e) => e.requestId === rid) && n < 100; n++) await delay(10);
    assert.equal(events.find((e) => e.requestId === rid)?.code, 'history_consent');
    await request({ type: 'session.acceptHistory', sessionId: legacyId });
    assert.equal(server.store.get(legacyId).session.projectAccess, 1);
    const before = JSON.parse((await call('read', { path: 'index.ts' })).text);
    assert.equal(before.text, 'original\n');
    assert.ok((await call('search', { path: '.', query: 'original' })).text.includes('index.ts:1'));
    writeFileSync(join(project, 'index.ts'), 'external original\n');
    const edit = { path: 'index.ts', old: 'original', new: 'edited', revision: before.revision };
    assert.ok((await call('edit', edit)).error);
    edit.revision = JSON.parse((await call('read', { path: 'index.ts' })).text).revision;
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
    writeFileSync(join(project, 'long.txt'), 'x'.repeat(12001));
    assert.equal(JSON.parse((await call('read', { path: 'long.txt' })).text).next, 12000);
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
    await request({ type: 'approval.reply', ...approval, allowed: false });
    assert.equal((await decision).allowed, false);
    assert.equal((await request(inspect, socket, false)).code, 'approval_inactive');
    assert.ok(!JSON.stringify(server.store.get(sessionId).events).includes('private-edit-marker'));
    const commandListed = async () =>
      (await mcp.listTools()).tools.some((tool) => tool.name === 'command');
    const changed = () =>
      new Promise<void>((resolve) =>
        mcp.setNotificationHandler(ToolListChangedNotificationSchema, () => resolve()),
      );
    assert.equal(await commandListed(), false);
    let update = changed();
    bridge.projects.commands(sessionId, true);
    await update;
    assert.equal(await commandListed(), true);
    assert.match((await call('command', { command: 'echo fixture' })).text, /fixture/);
    update = changed();
    bridge.projects.commands(sessionId, false);
    await update;
    assert.equal(await commandListed(), false);
    update = changed();
    bridge.projects.commands(sessionId, true);
    await update;
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
    ({ bridge, socket } = await connect());
    for (let n = 0; !bridge.projects.sessions.has(sessionId) && n < 300; n++) await delay(10);
    assert.equal(await commandListed(), false);
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
          confirmFile: async () => false,
        },
      },
    );
    await terminal.open(token, device);
    await terminal.channel(3000);
    try {
      terminal.bridge.projects.commands(sessionId, true);
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
    appendFileSync(process.env.FIXTURE_TRACE,JSON.stringify({type:'initialize',argv:process.argv.slice(2),servers:frame.request.mcpServers,prompt:frame.request.appendSystemPrompt})+'\\n');
    if (process.env.FIXTURE_ACK === 'error') reply({subtype:'error',error:'fixture initialize rejected'});
    else reply({subtype:'success',response:{commands:[],models:[],agents:[],account:{},
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
    for (const ack of ['true', 'false', 'missing', 'error']) {
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
      assert.equal(frames.filter((f) => f.type === 'user').length, Number(ack === 'true'), ack);
      if (ack === 'true') assert.deepEqual(statuses, ['pending', 'policy', 'connected']);
      if (ack === 'false') assert.deepEqual(statuses, ['not_applied']);
      assert.deepEqual(servers, { project: projectTools });
      assert.equal(prompt, projectPrompt);
      assert.doesNotMatch(prompt, /\b(?:ssh|scp|sftp)\b/i);
      const tools = projectBuiltinTools({ subagents: ack === 'true' });
      assert.ok(argv.includes(`--tools=${tools.join(',')}`));
      // Subagents come only with the service's setting. Nothing that works on this host's files or runs its
      // commands is among the tools either way.
      assert.equal(tools.includes('Agent'), ack === 'true');
      for (const name of ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'NotebookEdit'])
        assert.ok(!tools.includes(name), name);
      for (const name of ['WebSearch', 'WebFetch', 'TodoWrite'])
        assert.ok(tools.includes(name), name);
      assert.ok(argv.includes('--strict-mcp-config'));
      assert.ok(!argv.join(' ').includes('ssh device'));
      assert.ok(!argv.includes('--mcp-config'));
      assert.ok(!JSON.stringify(argv).includes(projectTools.args[1]));
    }
  },
);
