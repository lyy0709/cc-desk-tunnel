import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  rmSync,
  renameSync,
  symlinkSync,
  realpathSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';

const { gitChanges, gitDiff } = createRequire(import.meta.url)('../electron/git-changes.cjs');
function repository(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ccdt-changes-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-b', 'main');
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@example.invalid');
  const write = (name, content) => writeFileSync(join(root, name), content);
  const commit = () => {
    git('add', '.');
    git('commit', '-m', 'fixture');
  };
  return { root, git, write, commit };
}

test('staged and unstaged changes use different bases, including a first commit', async (t) => {
  const { root, git, write } = repository(t);
  write('code.txt', 'first\n');
  git('add', '.');
  write('code.txt', 'second\n');
  write('new.txt', 'new\n');
  const index = readFileSync(join(root, '.git/index'));
  const staged = await gitChanges(root, 'staged');
  assert.deepEqual(staged.counts, { staged: 1, unstaged: 2 });
  assert.equal(staged.files[0].status, 'A');
  assert.equal(staged.files[0].workingTreeChanged, true);
  assert.match((await gitDiff(root, 'staged', 'code.txt')).patch, /\+first/);
  assert.match((await gitDiff(root, 'unstaged', 'code.txt')).patch, /-first\n\+second/);
  assert.match((await gitDiff(root, 'unstaged', 'new.txt')).patch, /\+new/);
  assert.deepEqual(readFileSync(join(root, '.git/index')), index);
  assert.equal(readFileSync(join(root, 'code.txt'), 'utf8'), 'second\n');
});

test('repository-wide discovery handles renames, deletions and literal special paths', async (t) => {
  const { root, git, write, commit } = repository(t);
  mkdirSync(join(root, 'sub'));
  write('old.txt', 'original\n');
  write('delete.txt', 'remove\n');
  const name = process.platform === 'win32' ? '中文 空格[文件].txt' : '中文 空格\t换行\n[文件].txt';
  write(name, 'before\n');
  commit();
  renameSync(join(root, 'old.txt'), join(root, 'renamed.txt'));
  git('add', '-A');
  rmSync(join(root, 'delete.txt'));
  write(name, 'after\n');
  const staged = await gitChanges(join(root, 'sub'), 'staged');
  assert.equal(staged.root, root);
  assert.equal(staged.files[0].status, 'R');
  assert.equal(staged.files[0].previousPath, 'old.txt');
  assert.match((await gitDiff(root, 'staged', 'renamed.txt')).patch, /rename from old.txt/);
  const unstaged = await gitChanges(root, 'unstaged');
  assert.equal(unstaged.files.find((file) => file.path === 'delete.txt').status, 'D');
  assert.match((await gitDiff(root, 'unstaged', name)).patch, /-before\n\+after/);
  await assert.rejects(gitDiff(root, 'unstaged', '../outside'), /已变化/);
  await assert.rejects(gitChanges(root, 'other'), /未知/);
});

test('binary and large files do not return a full text preview; symlinks never read their target', async (t) => {
  const { root, write, commit } = repository(t);
  write('binary', Buffer.from([0, 1, 2]));
  commit();
  write('binary', Buffer.from([0, 3, 4]));
  write('large', 'x'.repeat(1024 * 1024 + 1));
  write('lines', 'x\n'.repeat(10001));
  assert.equal((await gitDiff(root, 'unstaged', 'binary')).kind, 'binary');
  for (const name of ['large', 'lines'])
    assert.deepEqual(await gitDiff(root, 'unstaged', name), { kind: 'too_large', patch: '' });
  if (process.platform !== 'win32') {
    const outside = mkdtempSync(join(tmpdir(), 'ccdt-link-'));
    t.after(() => rmSync(outside, { recursive: true, force: true }));
    writeFileSync(join(outside, 'secret'), 'DO NOT READ CONTENT');
    symlinkSync(join(outside, 'secret'), join(root, 'link'));
    const diff = await gitDiff(root, 'unstaged', 'link');
    assert.match(diff.patch, /secret/);
    assert.doesNotMatch(diff.patch, /DO NOT READ/);
  }
});

test('conflicts and submodules are reported without misleading zero counts or text previews', async (t) => {
  const { root, git, write, commit } = repository(t);
  write('conflict', 'base\n');
  commit();
  const head = git('rev-parse', 'HEAD').trim();
  git('update-index', '--add', '--cacheinfo', `160000,${head},module`);
  const staged = await gitChanges(root, 'staged');
  assert.equal(staged.files.find((file) => file.path === 'module').kind, 'submodule');
  assert.equal((await gitDiff(root, 'staged', 'module')).kind, 'submodule');
  git('reset', '--hard', 'HEAD');
  git('checkout', '-b', 'side');
  write('conflict', 'side\n');
  commit();
  git('checkout', 'main');
  write('conflict', 'main\n');
  commit();
  assert.throws(() => git('merge', 'side'));
  assert.equal((await gitChanges(root, 'unstaged')).files[0].kind, 'conflict');
  assert.equal((await gitDiff(root, 'unstaged', 'conflict')).kind, 'conflict');
});

test('linked worktrees work, and inspection does not invoke external diff, textconv or fsmonitor', async (t) => {
  const { root, git, write, commit } = repository(t);
  write('file.txt', 'old\n');
  commit();
  const tree = join(root, 'linked');
  git('worktree', 'add', '-b', 'linked', tree);
  writeFileSync(join(tree, 'file.txt'), 'new\n');
  assert.equal((await gitChanges(tree, 'unstaged')).branch, 'linked');
  const helper = join(root, 'helper.cjs');
  const marker = join(root, 'called');
  writeFileSync(helper, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'called');`);
  const command = `"${process.execPath}" "${helper}"`;
  git('config', 'diff.external', command);
  git('config', 'diff.custom.textconv', command);
  git('config', 'core.fsmonitor', command);
  writeFileSync(join(tree, '.gitattributes'), '*.txt diff=custom\n');
  assert.match((await gitDiff(tree, 'unstaged', 'file.txt')).patch, /\+new/);
  assert.equal(existsSync(marker), false);
});

test('missing directories and non-repositories are distinct errors', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ccdt-no-repo-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  await assert.rejects(gitChanges(join(root, 'missing'), 'unstaged'), /目录已不存在/);
  await assert.rejects(gitChanges(root, 'unstaged'), /不在 Git 仓库/);
});

test('status and diff never execute clean/process filters and disclose raw-content comparison', async (t) => {
  const { root, git, write, commit } = repository(t);
  write('file.txt', 'before\n');
  commit();
  const marker = join(root, 'filter-called');
  const helper = join(root, 'filter.cjs');
  writeFileSync(
    helper,
    `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(marker)},'called');process.stdin.pipe(process.stdout);`,
  );
  // A subsection may contain '='; the override must preserve the entire key.
  const command = `"${process.execPath}" "${helper}"`;
  git('config', 'filter.probe=local.clean', command);
  git('config', 'filter.probe=local.required', 'true');
  write('.gitattributes', '*.txt filter=probe=local\n');
  write('file.txt', 'after\n');
  assert.equal((await gitChanges(root, 'unstaged')).rawContent, true);
  assert.match((await gitDiff(root, 'unstaged', 'file.txt')).patch, /\+after/);
  assert.equal(existsSync(marker), false);
  git('config', 'filter.probe=local.process', command);
  assert.equal((await gitChanges(root, 'unstaged')).rawContent, true);
  assert.match((await gitDiff(root, 'unstaged', 'file.txt')).patch, /\+after/);
  assert.equal(existsSync(marker), false);
});

test('a missing Git installation is reported without attempting to install anything', async (t) => {
  const { root } = repository(t);
  const original = process.env.PATH;
  try {
    process.env.PATH = root;
    await assert.rejects(gitChanges(root, 'unstaged'), /找不到 Git/);
  } finally {
    process.env.PATH = original;
  }
});
