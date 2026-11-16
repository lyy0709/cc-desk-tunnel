import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { posix, win32 } from 'node:path';
import { join } from 'node:path';
import { mkdtempSync, writeFileSync, rmSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';

const { editorUrl, runs, localPath, pictureOf, previewText } = createRequire(import.meta.url)(
  '../electron/file-links.cjs',
);

test('text preview is bounded, decodes BOMs, and never executes scripts or parses document containers', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ccdt-preview-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const marker = join(root, 'executed');
  const script = join(root, process.platform === 'win32' ? '中文 脚本.sh' : '中文 "脚本".sh');
  const source = `#!/bin/sh\nprintf unexpected > "${marker}"\n`;
  writeFileSync(script, source, { mode: 0o755 });
  assert.deepEqual(await previewText(script), { kind: 'text', text: source, truncated: false });
  assert.equal(existsSync(marker), false);
  for (const [name, bytes] of [
    ['utf8.txt', Buffer.from('\ufeff中文\n')],
    ['utf16le.txt', Buffer.from('\ufeff中文\n', 'utf16le')],
    ['utf16be.txt', Buffer.from('\ufeff中文\n', 'utf16le').swap16()],
  ]) {
    writeFileSync(join(root, name), bytes);
    assert.equal((await previewText(join(root, name))).text, '中文\n');
  }
  writeFileSync(join(root, 'large.txt'), '汉'.repeat(400000));
  const large = await previewText(join(root, 'large.txt'));
  assert.equal(large.truncated, true);
  assert.ok(Buffer.byteLength(large.text) <= 1024 * 1024);
  assert.ok(!large.text.includes('\ufffd'));
  writeFileSync(join(root, 'lines.txt'), 'line\n'.repeat(10000));
  assert.equal((await previewText(join(root, 'lines.txt'))).truncated, false);
  writeFileSync(join(root, 'lines.txt'), 'line\n'.repeat(10002));
  const lines = await previewText(join(root, 'lines.txt'));
  assert.equal(lines.truncated, true);
  assert.equal(lines.text.split('\n').length, 10000);
  for (const [name, bytes] of [
    ['binary', Buffer.from([1, 0, 255])],
    ['report.pdf', '%PDF-test'],
    ['report.docx', 'ZIP container'],
  ]) {
    writeFileSync(join(root, name), bytes);
    assert.deepEqual(await previewText(join(root, name)), { kind: 'unsupported' });
  }
  mkdirSync(join(root, 'directory'));
  await assert.rejects(previewText(join(root, 'directory')), /普通文件/);
  await assert.rejects(previewText(join(root, 'missing')), { code: 'ENOENT' });
  await assert.rejects(previewText('../outside'), /本机/);
  await assert.rejects(previewText('//server/share/file'), /本机/);
});

test('an editor opens a file at a line from its own address', () => {
  assert.equal(editorUrl('vscode', 'C:\\a b\\#1.ts', 12, 3), 'vscode://file/C:/a%20b/%231.ts:12:3');
  assert.equal(editorUrl('cursor', '/Users/me/a.ts'), 'cursor://file/Users/me/a.ts');
});

test('what would run is told from what the system says, and from the kinds it does not list', () => {
  const windows = { platform: 'win32', pathext: '.COM;.EXE;.BAT;.CMD;.PY' };
  assert.equal(runs('C:\\a\\setup.EXE', windows), true);
  // An interpreter installed on the computer adds its own type to PATHEXT.
  assert.equal(runs('C:\\a\\tool.py', windows), true);
  assert.equal(runs('C:\\a\\go.lnk', windows), true);
  assert.equal(runs('C:\\a\\x.ps1', windows), true);
  assert.equal(runs('C:\\a\\report.pdf', windows), false);
  assert.equal(runs('C:\\a\\Makefile', windows), false);
  // Without PATHEXT, Windows' own list stands in.
  assert.equal(runs('C:\\a\\x.vbs', { platform: 'win32' }), true);
  assert.equal(runs('C:\\a\\folder.exe', { ...windows, directory: true }), false);
  // Elsewhere, the permission to execute; on a Mac, an application is a folder.
  assert.equal(runs('/a/build', { platform: 'linux', mode: 0o100755 }), true);
  assert.equal(runs('/a/notes.md', { platform: 'linux', mode: 0o100644 }), false);
  assert.equal(runs('/a/x.desktop', { platform: 'linux', mode: 0o100644 }), true);
  assert.equal(runs('/a/Calc.app', { platform: 'darwin', directory: true }), true);
  assert.equal(runs('/a/run.command', { platform: 'darwin', mode: 0o100644 }), true);
});

test('only absolute paths on this computer are taken', () => {
  assert.equal(localPath('C:\\a\\b.txt', win32.isAbsolute), 'C:\\a\\b.txt');
  assert.equal(localPath('\\\\server\\share\\a', win32.isAbsolute), null);
  assert.equal(localPath('//server/share/a', posix.isAbsolute), null);
  assert.equal(localPath('a\\b.txt', win32.isAbsolute), null);
  assert.equal(localPath('/a/b\0c', posix.isAbsolute), null);
});

test('the picture address serves pictures and nothing else', () => {
  assert.deepEqual(pictureOf('local-image://file/C%3A%5Ca%20b%5Cx.PNG'), {
    file: 'C:\\a b\\x.PNG',
    type: 'image/png',
  });
  assert.equal(pictureOf('local-image://file/C%3A%5Ca%5Cx.txt'), null);
  // A path of macOS or Linux comes back as written, through the address the page makes of it.
  assert.deepEqual(pictureOf(`local-image://file/${encodeURIComponent('/Users/me/图 1.webp')}`), {
    file: '/Users/me/图 1.webp',
    type: 'image/webp',
  });
  assert.equal(pictureOf('local-image://other/C%3A%5Ca%5Cx.png'), null);
});
