import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { _electron } from '@playwright/test';

// Launch the packaged app offline and read a fixture with its shipped project-files helper.
const mac = process.platform === 'darwin';
if (process.platform === 'win32' || !process.argv[2] || mac !== process.argv[2].endsWith('.app'))
  throw new Error('Usage: node scripts/smoke-posix-package.mjs <application> [arguments]');
const executable = mac
  ? join(resolve(process.argv[2]), 'Contents/MacOS/CC Desk Tunnel')
  : resolve(process.argv[2]);
const archive = join(dirname(executable), mac ? '../Resources/app.asar' : 'resources/app.asar');
for (const name of ['LICENSE', 'NOTICE'])
  assert.deepEqual(readFileSync(join(dirname(archive), 'licenses', name)), readFileSync(name));
// The shell each system gives its users: the script host has to work with both.
const shell = mac ? '/bin/zsh' : '/bin/bash';
const root = resolve('.local/package-smoke');
mkdirSync(root, { recursive: true });
const directory = mkdtempSync(join(root, 'run-'));
const env = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) => key !== 'ELECTRON_RUN_AS_NODE' && !key.startsWith('PROXY_'),
  ),
);
env.PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
const args = [
  ...process.argv.slice(3),
  '--smoke-test',
  `--user-data-dir=${join(directory, 'profile')}`,
];
const application = await _electron.launch({
  executablePath: executable,
  args,
  cwd: directory,
  env,
  timeout: 30_000,
});
const launcherProcess = application.process();
try {
  const errors = [];
  const page = await application.firstWindow();
  page.on('pageerror', (error) => errors.push(error.message));
  await page.getByRole('heading', { name: '连接代理服务', exact: true }).waitFor();
  assert.equal(await application.evaluate(({ app }) => app.isPackaged), true);
  assert.equal(await page.evaluate(() => window.desktop.platform), process.platform);
  // Exercise the installed preload, SQLite baseline and bundled diff libraries with Git absent.
  const project = join(directory, 'project');
  mkdirSync(project);
  const oldPath = await application.evaluate(() => {
    const old = process.env.PATH;
    process.env.PATH = '';
    return old;
  });
  try {
    await page.evaluate((path) => window.desktop.prepareChanges(path), project);
    writeFileSync(join(project, 'example.txt'), 'first line\n');
    const changes = await page.evaluate(
      (path) => window.desktop.projectChanges(path, 'unstaged'),
      project,
    );
    assert.equal(changes.files[0].added, 1);
    const patch = await page.evaluate(
      (root) => window.desktop.projectDiff(root, 'example.txt'),
      changes.root,
    );
    assert.match(patch.patch, /\+first line/);
    const turn = 'package-smoke-turn';
    await page.evaluate(([id, path]) => window.desktop.startTurnChanges(id, path), [turn, project]);
    await page.evaluate((id) => window.desktop.turnFiles(id), turn);
    writeFileSync(join(project, 'example.txt'), 'first line\nturn line\n');
    // The next turn may be requested while the previous turn's final scan is in flight.
    const next = 'package-smoke-next';
    await page.evaluate(
      ([id, next, path]) =>
        Promise.all([
          window.desktop.finishTurnChanges(id),
          window.desktop.startTurnChanges(next, path),
        ]),
      [turn, next, project],
    );
    writeFileSync(join(project, 'example.txt'), 'first line\nturn line\nnext line\n');
    const result = await page.evaluate((id) => window.desktop.turnFiles(id), turn);
    assert.equal(result.finished, true);
    const finalPatch = await page.evaluate(
      (id) => window.desktop.turnDiff(id, 'example.txt'),
      turn,
    );
    assert.match(finalPatch.patch, /\+turn line/);
    assert.doesNotMatch(finalPatch.patch, /next line/);
    await page.evaluate(
      ([id, next]) =>
        Promise.all([
          window.desktop.releaseTurnChanges(id),
          window.desktop.finishTurnChanges(next),
        ]),
      [turn, next],
    );
  } finally {
    await application.evaluate((_, path) => {
      process.env.PATH = path;
    }, oldPath);
  }
  execFileSync(
    executable,
    [
      '--input-type=module',
      '-e',
      String.raw`
    import assert from 'node:assert/strict';
    import { execFile } from 'node:child_process';
    import { randomUUID } from 'node:crypto';
    import { writeFile } from 'node:fs/promises';
    import { createRequire } from 'node:module';
    import { join } from 'node:path';
    import { pathToFileURL } from 'node:url';
    const root = process.env.CC_PACKAGE_ROOT;
    const directory = process.cwd();
    const require = createRequire(pathToFileURL(join(directory, 'package.json')));
    const { HistoryCache } = require(join(root, 'electron/history-cache.cjs'));
    const cache = new HistoryCache(join(directory, 'history-cache'));
    try {
      const address = { url: 'wss://fixture.invalid/ws', protocol: 1, history: randomUUID() + '/1' };
      await cache.request({ type: 'use', ...address });
      const stats = await cache.request({ type: 'stats', ...address });
      assert.ok(stats.bytes > 0);
      assert.equal(stats.events, 0);
    } finally { await cache.close(); }
    const bridge = await import(pathToFileURL(join(root, 'electron/proxy-bridge.mjs')));
    assert.equal(typeof bridge.openProxyBridge, 'function');
    const helper=join(root,'..','project-files');
    const files = (request) => new Promise((ok,fail)=>{
      const child=execFile(helper,[directory],(err,stdout)=>err?fail(err):ok(JSON.parse(stdout)));
      child.stdin.end(JSON.stringify(request));
    });
    const { text: identity } = await files({op:'bind'});
    assert.ok(identity);
    const created = await files({op:'create', identity, path:'smoke.txt', new:'packaged helper'});
    assert.ifError(created.error);
    assert.equal((await files({op:'read',identity,path:'smoke.txt'})).text,'packaged helper');

  `,
    ],
    {
      cwd: directory,
      timeout: 30_000,
      stdio: 'inherit',
      env: {
        ...env,
        ELECTRON_RUN_AS_NODE: '1',
        CC_PACKAGE_ROOT: archive,
        CC_PACKAGE_SHELL: shell,
      },
    },
  );
  assert.deepEqual(errors, []);
  // A picture of the window as the system draws it, for whoever reviews a build without a Mac at hand.
  if (process.env.SMOKE_SCREENSHOT) {
    await application.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      window.show();
      window.moveTop();
      window.focus();
    });
    // A window shown for the first time takes a moment to be drawn, longer without a graphics card.
    await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => done())));
    await delay(4000);
    mkdirSync(dirname(resolve(process.env.SMOKE_SCREENSHOT)), { recursive: true });
    try {
      // The whole screen: the window's buttons are the system's on macOS and Chromium's own on Linux, and
      // neither is part of the page.
      if (mac) execFileSync('screencapture', ['-x', resolve(process.env.SMOKE_SCREENSHOT)]);
      else execFileSync('import', ['-window', 'root', resolve(process.env.SMOKE_SCREENSHOT)]);
    } catch (error) {
      console.log(`No screenshot: ${error.message}`);
    }
    // And the page alone, as the program itself renders it, should the screen have shown nothing.
    await page.screenshot({
      path: resolve(process.env.SMOKE_SCREENSHOT).replace(/\.png$/, '-page.png'),
    });
  }
  // A connection is a process of its own: the sign-in window starts the packaged program once more under the
  // connection's profile and goes once that runs, and a command line asks that one to go.
  const profile = join(directory, 'profile');
  const id = 'smoke000';
  const instance = join(profile, 'connections', id, 'instance.json');
  mkdirSync(join(profile, 'connections', id), { recursive: true });
  mkdirSync(join(profile, 'shared'), { recursive: true });
  writeFileSync(
    join(profile, 'shared', 'connections.json'),
    JSON.stringify([{ id, name: '另一个' }]),
  );
  const until = async (open) => {
    for (let waited = 0; existsSync(instance) !== open; waited += 500) {
      assert.ok(waited < 30_000, `The second connection is ${open ? 'not open' : 'still open'}.`);
      await delay(500);
    }
  };
  // The sign-in window goes as the connection's window runs, and with it the page.
  await page.evaluate((connection) => window.desktop.openLegacy(connection), id).catch(() => {});
  let servicePid;
  try {
    await until(true);
    servicePid = JSON.parse(readFileSync(instance, 'utf8')).pid;
    if (mac) {
      // Launch Services used to retain the exited launcher as a second Dock application
      // for the lifetime of its child. Check both PIDs while the service window is alive.
      const registered = (pid, entries) => new RegExp(`^\\s*pid = ${pid}\\b`, 'm').test(entries);
      for (let waited = 0; ; waited += 250) {
        const entries = execFileSync('/usr/bin/lsappinfo', ['list'], { encoding: 'utf8' });
        if (registered(servicePid, entries) && !registered(launcherProcess.pid, entries)) break;
        assert.ok(waited < 10_000, 'Launch Services must keep only the service window registered');
        await delay(250);
      }
    }
  } finally {
    execFileSync(executable, [...args, `--connection=${id}`, '--quit-connection'], {
      cwd: directory,
      env,
      timeout: 30_000,
    });
    await until(false);
    // Electron can still flush the profile after removing instance.json on quit.
    if (servicePid) {
      for (let waited = 0; ; waited += 100) {
        try {
          process.kill(servicePid, 0);
        } catch (error) {
          if (error.code === 'ESRCH') break;
          throw error;
        }
        assert.ok(waited < 10_000, 'The service window did not exit.');
        await delay(100);
      }
    }
  }
  console.log(
    'PASS: the packaged client starts offline, its packaged helper reads a project file and a connection opens in a process of its own.',
  );
} finally {
  // The sign-in window may have gone already.
  if (launcherProcess.exitCode === null) await application.close().catch(() => {});
  rmSync(directory, { recursive: true, force: true });
}
