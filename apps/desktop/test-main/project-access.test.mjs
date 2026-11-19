import { test } from 'node:test';
import assert from 'node:assert/strict';
import { realpath, writeFile, mkdtemp, mkdir, symlink, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { ProjectAccess } from '../electron/project-access.mjs';
import { buildProjectFiles } from '../../../scripts/build-project-files.mjs';

test('native project bindings enforce file and command authority across sessions, links, and revocation', async (t) => {
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
    confirmFile: async (file) => file === (await realpath(join(temp, 'attachment.txt'))),
  });
  t.after(() => access.close());
  const project = await access.bind(root);
  const a = randomUUID(),
    b = randomUUID();
  access.session({ id: a, projectPath: project });
  access.session({ id: b, projectPath: project });
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
    Buffer.from(
      JSON.parse(await call(a, { op: 'read', path: card.path, offset: 0 })).base64,
      'base64',
    ).toString(),
    'chosen',
  );
  access.commands(a, true);
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
