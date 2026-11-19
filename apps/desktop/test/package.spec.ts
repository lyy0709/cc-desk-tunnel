import { test, expect, _electron } from '@playwright/test';
import { readFileSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { connectionArgs } from './helpers.ts';

test.use({ trace: 'off' });

test('packaged exe runs without development dependencies and operates on a project with its bundled helper and PowerShell', async () => {
  test.skip(
    !process.env.WINDOWS_PACKAGE_EXE || process.platform !== 'win32',
    'Explicit opt-in: built Windows package.',
  );
  test.setTimeout(90000);
  const executablePath = resolve(process.env.WINDOWS_PACKAGE_EXE!);
  const resources = join(dirname(executablePath), 'resources');
  const smokeRoot = resolve('.local/package-smoke');
  mkdirSync(smokeRoot, { recursive: true });
  const directory = mkdtempSync(join(smokeRoot, 'run-'));
  const project = join(directory, '项目 fixture');
  mkdirSync(join(project, '.git'), { recursive: true });
  writeFileSync(join(project, '.git/HEAD'), 'ref: refs/heads/package-smoke\n');
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined &&
        entry[0] !== 'ELECTRON_RUN_AS_NODE' &&
        !entry[0].startsWith('PROXY_') &&
        entry[0].toLowerCase() !== 'path',
    ),
  );
  env.PATH = `${process.env.SystemRoot}\\System32;${process.env.SystemRoot}`;
  const application = await _electron.launch({
    executablePath,
    args: ['--smoke-test', ...connectionArgs(join(directory, 'profile'))],
    cwd: directory,
    env,
  });
  const applicationProcess = application.process();
  const errors: string[] = [];
  try {
    const page = await application.firstWindow();
    page.on('pageerror', (error) => errors.push(error.message));
    await expect(page.getByRole('heading', { name: '连接代理服务', exact: true })).toBeVisible();
    await expect(page.getByLabel('服务证书指纹', { exact: true })).toBeVisible();
    expect(await application.evaluate(({ app }) => app.isPackaged)).toBe(true);
    expect(await page.evaluate((path) => window.desktop!.gitBranch(path), project)).toBe(
      'package-smoke',
    );
    await page.evaluate((path) => window.desktop!.prepareChanges(path), project);
    writeFileSync(join(project, 'example.txt'), 'first line\n');
    const changes = await page.evaluate(
      (path) => window.desktop!.projectChanges(path, 'unstaged'),
      project,
    );
    expect(changes.files.find((file) => file.path === 'example.txt')?.added).toBe(1);
    const patch = await page.evaluate(
      (root) => window.desktop!.projectDiff(root, 'example.txt'),
      changes.root,
    );
    expect(patch.patch).toContain('+first line');
    // Loaded only when an upgrade is fetched from the release page, so its absence would not show otherwise.
    expect(
      await application.evaluate(({ app }) => {
        const load = process.mainModule!.require;
        const file = load('node:path').join(app.getAppPath(), 'electron/release-download.mjs');
        return typeof load(file).downloadRelease;
      }),
    ).toBe('function');
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].show());
    // The connection started once more shows its window and goes: one window to a connection.
    await new Promise<void>((accept, reject) => {
      execFile(
        executablePath,
        ['--smoke-test', ...connectionArgs(join(directory, 'profile'))],
        { env, windowsHide: true, timeout: 10000 },
        (error) => (error ? reject(error) : accept()),
      );
    });
    expect(
      await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length),
    ).toBe(1);
    expect(existsSync(join(resources, 'vendor', 'openssh'))).toBe(false);
    for (const name of ['LICENSE', 'NOTICE'])
      expect(readFileSync(join(resources, 'licenses', name))).toEqual(readFileSync(name));
    const helper = join(resources, 'project-files.exe');
    const readFileTool = (input: object) =>
      JSON.parse(
        execFileSync(helper, [project], {
          input: JSON.stringify(input),
          encoding: 'utf8',
          windowsHide: true,
        }),
      );
    const identity = readFileTool({ op: 'bind' }).text;
    expect(typeof identity).toBe('string');
    expect(readFileTool({ op: 'read', identity, path: 'example.txt' }).text).toBe('first line\n');
    expect(
      execFileSync(
        join(resources, 'vendor', 'pwsh', 'pwsh.exe'),
        [
          '-NoProfile',
          '-NonInteractive',
          '-File',
          join(resources, 'app.asar.unpacked', 'electron', 'component-host.ps1'),
          '-OwnerProcessId',
          String(process.pid),
        ],
        {
          cwd: project,
          input: '[Console]::Write((Get-Content -Raw -LiteralPath example.txt))',
          encoding: 'utf8',
          windowsHide: true,
        },
      ),
    ).toBe('first line\n');
    if (process.env.NATIVE_TEST_CONFIG) {
      const connection = JSON.parse(readFileSync(resolve(process.env.NATIVE_TEST_CONFIG), 'utf8'));
      await page.getByLabel('服务地址', { exact: true }).fill(connection.url);
      await page.getByLabel('服务证书指纹', { exact: true }).fill(connection.fingerprint ?? '');
      await page.getByLabel('服务凭据', { exact: true }).fill(connection.token);
      await page.getByRole('button', { name: '连接', exact: true }).click();
      await expect(page.locator('.connection-status')).toContainText('已连接', { timeout: 45000 });
      await page.getByRole('button', { name: '设置与账号', exact: true }).click();
      await page.getByRole('menuitem', { name: /^账号/ }).click();
      await expect(page.locator('.account-identity')).toContainText(
        /GUI 模型服务(已登录|尚未登录)/,
        { timeout: 25000 },
      );
      await page.screenshot({ path: join(directory, 'packaged-account.png') });
      await application.close();
    } else {
      await page.screenshot({ path: join(directory, 'packaged-login.png') });
    }
    expect(errors).toEqual([]);
  } finally {
    if (applicationProcess.exitCode === null) await application.close();
  }
});
