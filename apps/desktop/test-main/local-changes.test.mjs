import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  chmod,
  mkdir,
  mkdtemp,
  writeFile,
  readFile,
  rm,
  symlink,
  realpath,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import changes from '../electron/local-changes.cjs';
const { ProjectChanges, TurnChanges } = changes;

async function fixture(t) {
  const temp = await realpath(await mkdtemp(join(tmpdir(), 'ccdt-review-')));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const root = join(temp, '项目');
  await mkdir(root);
  const storage = join(temp, 'baselines');
  return { root, storage, write: (file, value) => writeFile(join(root, file), value) };
}
test('project baseline survives restart, excludes ignored files and resets only the comparison', async (t) => {
  const { root, storage, write } = await fixture(t);
  await mkdir(join(root, 'sub'));
  await mkdir(join(root, 'node_modules'));
  await write('.gitignore', '*.log\n');
  await write('sub/.gitignore', '!keep.log\n');
  await write('old', 'gone\n');
  await write('changed', 'old\n');
  const project = new ProjectChanges(storage);
  await project.prepare(root);
  assert.deepEqual((await project.list(root, 'unstaged')).files, []);
  await rm(join(root, 'old'));
  await write('changed', 'new\n');
  await write('empty', '');
  await write('sub/no.log', 'hidden');
  await write('sub/keep.log', 'ok');
  await write('node_modules/code', 'skip');
  const restarted = new ProjectChanges(storage);
  const list = await restarted.list(root, 'unstaged');
  assert.deepEqual(
    list.files.map((f) => [f.path, f.status, f.added, f.removed]),
    [
      ['changed', 'M', 1, 1],
      ['empty', 'A', 0, 0],
      ['old', 'D', 0, 1],
      ['sub/keep.log', 'A', 1, 0],
    ],
  );
  assert.match(restarted.latest.diff('old').patch, /-gone/);
  assert.deepEqual((await restarted.list(root, 'unstaged', true)).files, []);
  assert.equal(await readFile(join(root, 'changed'), 'utf8'), 'new\n');
});

test('missing git falls back inside a repository; invalid directories still fail', async (t) => {
  const { root, storage, write } = await fixture(t);
  execFileSync('git', ['init', '--quiet'], { cwd: root });
  const review = new ProjectChanges(storage);
  assert.deepEqual((await review.list(root, 'unstaged')).counts, { staged: 0, unstaged: 0 });
  const path = process.env.PATH;
  try {
    process.env.PATH = root;
    await review.prepare(root);
    await write('file', 'new\n');
    const list = await review.list(root, 'unstaged');
    assert.deepEqual(
      list.files.map((file) => file.path),
      ['file'],
    );
    assert.equal(list.counts, undefined);
    await assert.rejects(review.list(join(root, 'gone'), 'unstaged'), /目录已不存在/);
  } finally {
    process.env.PATH = path;
  }
});

test(
  'live turn captures a script write before completion, reconciles reversions and freezes final patches',
  { timeout: 10000 },
  async (t) => {
    const { root, storage, write } = await fixture(t);
    await write('file', 'pre-existing\n');
    const seen = Promise.withResolvers();
    const turn = await TurnChanges.start(root, storage, (t) => {
      const file = t.comparison.changed.get('file');
      if (file?.added === 2) seen.resolve();
    });
    t.after(() => turn.finish());
    execFileSync(process.execPath, ['-e', "require('fs').appendFileSync('file','one\\ntwo\\n')"], {
      cwd: root,
    });
    await seen.promise;
    const other = await TurnChanges.start(root, storage, () => {});
    t.after(() => other.finish());
    await write('file', 'pre-existing\none\n');
    await turn.finish();
    await other.refresh();
    assert.equal(turn.comparison.result().files[0].added, 1);
    assert.equal(other.comparison.result().files[0].removed, 1);
    await write('file', 'pre-existing\none\ntwo\n');
    await other.finish();
    assert.deepEqual(other.comparison.result().files, []);
    assert.doesNotMatch(turn.comparison.diff('file').patch, /two/);
  },
);

test('unpreviewable files and inaccessible subtrees never become invented deletions', async (t) => {
  const { root, storage, write } = await fixture(t);
  const project = new ProjectChanges(storage);
  await mkdir(join(root, 'sub'));
  await write('sub/a', 'TARGET_CONTENT_ONLY\n');
  await project.prepare(root);
  await write('bin', Buffer.from([0, 1]));
  await write('large', 'a'.repeat(1048577));
  await write('lines', 'x\n'.repeat(10001));
  if (process.platform !== 'win32') {
    await symlink(join(root, 'sub', 'a'), join(root, 'link'));
    await chmod(join(root, 'sub'), 0);
  }
  try {
    const list = await project.list(root, 'unstaged');
    for (const name of ['large', 'lines', 'bin'])
      assert.equal(list.files.find((f) => f.path === name).added, null);
    assert.equal(project.latest.diff('bin').kind, 'binary');
    if (process.platform !== 'win32') {
      assert.doesNotMatch(project.latest.diff('link').patch, /TARGET_CONTENT_ONLY/);
      if (process.getuid() !== 0) assert.equal(project.latest.diff('sub').kind, 'unreadable');
      assert.ok(!list.files.some((f) => f.path === 'sub/a'));
    }
  } finally {
    if (process.platform !== 'win32') await chmod(join(root, 'sub'), 0o700);
  }
});
