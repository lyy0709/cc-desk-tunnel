import { buildProjectFiles } from './build-project-files.mjs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build as electronBuild, Platform, Arch } from 'electron-builder';
import { stageDesktop } from './package-desktop.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2);
if (args.some((arg) => arg !== '--dir')) throw new Error('Usage: npm run package:linux -- [--dir]');
if (process.platform !== 'linux' || process.arch !== 'x64')
  throw new Error('Build the Linux x64 package on Linux x64.');
const unpacked = args.includes('--dir');
const app = join(root, '.local/linux-package/app');
const output = join(root, 'artifacts/linux');
const program = join(output, 'linux-unpacked/cc-desk-tunnel');
await stageDesktop(root, app, {
  description: 'Linux client for a native remote Claude Code session',
});
const electron = JSON.parse(readFileSync(join(root, 'node_modules/electron/package.json'), 'utf8'));
const results = await electronBuild({
  targets: Platform.LINUX.createTarget(unpacked ? 'dir' : 'deb', Arch.x64),
  publish: 'never',
  config: {
    appId: 'io.github.ccdesktunnel.desktop',
    productName: 'CC Desk Tunnel',
    electronVersion: electron.version,
    electronDist: join(root, 'node_modules/electron/dist'),
    directories: { app, output },
    npmRebuild: false,
    asar: true,
    extraResources: [
      { from: join(app, 'licenses'), to: 'licenses' },
      { from: buildProjectFiles(join(app, '../helper')), to: 'project-files' },
    ],
    files: ['package.json', 'electron/**', 'dist/**', 'node_modules/**'],
    linux: {
      target: 'deb',
      executableName: 'cc-desk-tunnel',
      category: 'Development',
      icon: join(root, 'apps/desktop/electron/icon.png'),
      maintainer: 'CC Desk Tunnel contributors <cc-desk-tunnel@users.noreply.github.com>',
      artifactName: 'CC-Desk-Tunnel-${version}-linux-${arch}.${ext}',
    },
    deb: {
      depends: [
        'libgtk-3-0',
        'libnotify4',
        'libnss3',
        'libxss1',
        'libxtst6',
        'xdg-utils',
        'libatspi2.0-0',
        'libuuid1',
        'libsecret-1-0',
      ],
      // The interface is in Chinese, which a system set up in another language may have no font for.
      recommends: ['fonts-noto-cjk'],
    },
  },
});
// Started offline before it counts as built, where there is a screen to start it on. What is started is the
// unpacked program, whose sandbox the installed package sets up; scripts/smoke-posix-package.mjs can be run
// on the installed one as well.
if (process.env.DISPLAY || process.env.WAYLAND_DISPLAY)
  execFileSync(
    process.execPath,
    [join(root, 'scripts/smoke-posix-package.mjs'), program, '--no-sandbox'],
    { cwd: root, stdio: 'inherit', env: { ...process.env, NATIVE_TEST_CONFIG: '' } },
  );
else console.log('Not started: no display. Run it under xvfb-run to have it checked.');
for (const path of results.filter((path) => path.endsWith('.deb')))
  console.log(
    `${createHash('sha256').update(readFileSync(path)).digest('hex')}  ${basename(path)}`,
  );
console.log(`Linux package: ${results.join(', ') || program}`);
console.log(
  'No service token, OAuth data, local history, test fixtures or source repository included.',
);
