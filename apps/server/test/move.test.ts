import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore } from '../src/store.ts';

const device = { id: randomUUID(), name: '台式机' };
function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'cc-desk-tunnel-move-'));
  let store = new SessionStore(directory);
  t.after(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    store,
    session: store.create(randomUUID(), '会话', 'D:\\项目 甲', device),
    // The library as a service that starts on it finds it.
    reopen() {
      store.close();
      return (store = new SessionStore(directory));
    },
  };
}
test('moving a session persists its project and device and rejects a move during approval', (t) => {
  const made = fixture(t);
  const laptop = { id: randomUUID(), name: '笔记本' };
  const project = 'project:' + randomUUID();
  const { id } = made.session;
  made.store.move(id, project, laptop);
  const store = made.reopen();
  assert.equal(store.get(id).session.projectPath, project);
  assert.deepEqual(store.get(id).session.device, laptop);
  store.append(id, randomUUID(), {
    type: 'run.status',
    status: 'awaiting_approval',
    connectionId: randomUUID(),
    waiting: 'question',
  });
  assert.throws(() => store.move(id, made.session.projectPath, device), /结束当前运行/);
});

test('a session from before computers were told apart becomes that of the first to use it, unannounced', (t) => {
  const made = fixture(t);
  const { session } = made;
  made.store.database
    .prepare(
      "UPDATE sessions SET metadata = json_set(json_remove(metadata, '$.device'), '$.prompt', json(?))",
    )
    .run(JSON.stringify({ projectPath: '/old/private/path', shells: ['pwsh'] }));
  const store = made.reopen();
  assert.equal(store.get(session.id).session.device, undefined);
  assert.deepEqual(store.claim(session.id, device).device, device);
  assert.ok(!('prompt' in store.get(session.id).session));
  // It is claimed once: the next computer has to take it over.
  const laptop = { id: randomUUID(), name: '笔记本' };
  assert.deepEqual(store.claim(session.id, laptop).device, device);
  assert.deepEqual(
    store.named({ ...device, name: '新名字' }).map(({ id }) => id),
    [session.id],
  );
  assert.equal(store.get(session.id).session.device?.name, '新名字');
});

test('MCP command routing uses only shells available on the device', (t) => {
  const { store } = fixture(t);
  store.equip(device.id, ['pwsh', 'bash']);
  store.prefer(device.id, 'bash');
  assert.equal(store.execution(device.id, 'win32').shell, 'bash');
  store.equip(device.id, ['pwsh']);
  assert.equal(store.execution(device.id, 'win32').shell, undefined);
  assert.deepEqual(store.execution(undefined, 'darwin').shells, ['zsh']);
});
