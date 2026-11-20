import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdtemp, mkdir, symlink, readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { ProjectAccess } from '../electron/project-access.mjs';
import { buildProjectFiles } from '../../../scripts/build-project-files.mjs';

test('a bound project gives its sessions files and commands, each its own attachments, and nothing outside it', async (t) => {
  const temp = await mkdtemp(join(tmpdir(), 'ccdt-files-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const root = join(temp, 'project');
  await mkdir(root);
  const access = new ProjectAccess({
    service: 'fixture',
    environment: { HOME: temp, ZDOTDIR: temp },
    database: join(temp, 'local.sqlite'),
    helper: buildProjectFiles(temp),
    chooseRoot: async () => false,
  });
  t.after(() => access.close());
  const project = await access.bind(root);
  const a = randomUUID(),
    b = randomUUID(),
    elsewhere = randomUUID();
  const granted = [];
  access.onCommandsChanged = (id, to, enabled) => granted.push([id, to, enabled]);
  access.session({ id: a, projectPath: project });
  access.session({ id: b, projectPath: project });
  // Seen again, a session is granted nothing anew; one whose project is not bound here is granted nothing at all.
  access.session({ id: a, projectPath: project });
  access.session({ id: elsewhere, projectPath: 'project:' + randomUUID() });
  assert.deepEqual(granted, [
    [a, project, true],
    [b, project, true],
  ]);
  assert.equal(access.grants.has(elsewhere), false);
  const call = (sessionId, operation) =>
    access.call({ sessionId, project, operation, requestId: randomUUID() });
  await assert.rejects(access.reference(temp));
  await symlink(temp, join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(call(a, { op: 'create', path: 'escape/escaped', new: 'x' }));
  await call(a, { op: 'create', path: 'work.txt', new: 'kept' });
  assert.equal(await readFile(join(root, 'work.txt'), 'utf8'), 'kept');
  await assert.rejects(call(a, { op: 'create', path: 'work.txt', new: 'replacement' }));
  await writeFile(join(temp, 'attachment.txt'), 'chosen');
  const card = await access.attachment(a, { path: join(temp, 'attachment.txt') });
  assert.match(card.path, /^attachment:/);
  await assert.rejects(call(b, { op: 'read', path: card.path, offset: 0 }));
  assert.equal(
    JSON.parse(await call(a, { op: 'read', path: card.path, offset: 0 })).text,
    'chosen',
  );
  const chinese = 'x' + '中🙂'.repeat(4001) + '\n第二行\n';
  await writeFile(join(temp, '中文.txt'), chinese);
  const textFile = await access.attachment(a, { path: join(temp, '中文.txt') });
  let offset = 0,
    whole = '';
  do {
    const part = JSON.parse(await call(a, { op: 'read', path: textFile.path, offset }));
    whole += part.text;
    if (part.next !== undefined) assert.ok(part.next > offset);
    offset = part.next;
  } while (offset !== undefined);
  assert.equal(whole, chinese);
  assert.equal(
    JSON.parse(await call(a, { op: 'read', path: textFile.path, line: 2, offset: 1 })).text,
    '第二行\n',
  );
  assert.ok(
    JSON.parse(await call(a, { op: 'read', path: textFile.path, offset: 2 })).text.startsWith(
      '中🙂',
    ),
  );
  await writeFile(join(temp, 'binary.txt'), Buffer.from([255, 254]));
  const binary = await access.attachment(a, { path: join(temp, 'binary.txt') });
  await assert.rejects(call(a, { op: 'read', path: binary.path, offset: 0 }), /UTF-8/);
  // Command output uses UTF-16 positions; an emoji that straddles the page stays intact.
  const outputId = randomUUID(),
    output = 'x'.repeat(9999) + '🙂done';
  access.outputs.set(a, new Map([[outputId, { output, code: 0, signal: null, truncated: false }]]));
  const first = JSON.parse(access.output(a, outputId, 0));
  const second = JSON.parse(access.output(a, outputId, first.next));
  assert.equal(first.output + second.output, output);
  assert.equal(first.next, 9999);
  // Taken back for one session, the grant is still the other's.
  access.commands(b, false);
  await assert.rejects(call(b, { op: 'command', command: 'echo denied' }));
  const command =
    process.platform === 'win32'
      ? 'Start-Sleep -Seconds 2; Set-Content late x'
      : 'sleep 2; echo x > late';
  const running = call(a, { op: 'command', command });
  await delay(300);
  access.commands(a, false);
  await assert.rejects(running);
  await delay(2000);
  await assert.rejects(readFile(join(root, 'late')), { code: 'ENOENT' });
});

test('a command stopped at its limit says so, and commands run side by side keep their own output', async (t) => {
  const temp = await mkdtemp(join(tmpdir(), 'ccdt-commands-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const root = join(temp, 'project');
  await mkdir(root);
  const access = new ProjectAccess({
    service: 'fixture',
    environment: { HOME: temp, ZDOTDIR: temp },
    database: join(temp, 'local.sqlite'),
    helper: buildProjectFiles(temp),
    chooseRoot: async () => false,
    commandLimitMs: 1500,
  });
  t.after(() => access.close());
  const project = await access.bind(root);
  const session = randomUUID();
  access.session({ id: session, projectPath: project });
  const run = async (command) => {
    const requestId = randomUUID();
    const text = await access.call({
      sessionId: session,
      project,
      requestId,
      operation: { op: 'command', command },
    });
    return { requestId, result: JSON.parse(text) };
  };
  const windows = process.platform === 'win32';
  const [first, second, slow] = await Promise.all([
    run(windows ? 'Write-Output first' : 'echo first'),
    run(windows ? 'Write-Output second' : 'echo second'),
    run(windows ? 'Start-Sleep -Seconds 20' : 'sleep 20'),
  ]);
  assert.equal(first.result.timedOut, undefined);
  assert.equal(slow.result.timedOut, true);
  // Each is still read by its own ID after the others have finished.
  for (const [held, word] of [
    [first, 'first'],
    [second, 'second'],
  ]) {
    const page = JSON.parse(
      await access.call({
        sessionId: session,
        project,
        requestId: randomUUID(),
        operation: { op: 'output', id: held.requestId, offset: 0 },
      }),
    );
    assert.match(page.output, new RegExp(word));
  }
});

test('a path chosen again keeps its project, and its sessions go on in the directory that is there now', async (t) => {
  const temp = await mkdtemp(join(tmpdir(), 'ccdt-rebind-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const root = join(temp, 'project');
  await mkdir(root);
  const access = new ProjectAccess({
    service: 'fixture',
    environment: { HOME: temp, ZDOTDIR: temp },
    database: join(temp, 'local.sqlite'),
    helper: buildProjectFiles(temp),
    chooseRoot: async () => false,
  });
  t.after(() => access.close());
  const project = await access.bind(root);
  const session = randomUUID();
  access.session({ id: session, projectPath: project });
  const list = () =>
    access.call({
      sessionId: session,
      project,
      requestId: randomUUID(),
      operation: { op: 'list', path: '.', offset: 0 },
    });
  await list();
  // The directory first chosen stays where it can be told from the one now at its path.
  await rename(root, join(temp, 'earlier'));
  await mkdir(root);
  await writeFile(join(root, 'now.txt'), 'x');
  await assert.rejects(list());
  // What ran in the directory that was there is told to stop, and the grant is given again for the one chosen now.
  const told = [];
  access.onCommandsChanged = (_id, _project, enabled) => told.push(enabled);
  assert.equal(await access.bind(root), project);
  assert.deepEqual(told, [false, true]);
  assert.equal(access.grants.get(session), project);
  assert.match(JSON.parse(await list()).text, /now\.txt/);
});
