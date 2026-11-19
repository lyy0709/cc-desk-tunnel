import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';

test(
  'Windows reclaims a running local command when its owner exits',
  { skip: process.platform !== 'win32', timeout: 30000 },
  async (t) => {
    const owner = spawn(process.execPath, ['-e', 'setInterval(() => {}, 60000)'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    const host = spawn(
      'pwsh.exe',
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-File',
        fileURLToPath(new URL('../electron/component-host.ps1', import.meta.url)),
        '-OwnerProcessId',
        String(owner.pid),
      ],
      { windowsHide: true },
    );
    const done = once(host, 'close', { signal: t.signal });
    t.after(() => {
      if (owner.exitCode === null && !owner.signalCode) owner.kill();
      if (host.exitCode === null && !host.signalCode) host.kill();
    });
    let stderr = '';
    host.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    const output = createInterface({ input: host.stdout });
    const firstLine = once(output, 'line', { signal: t.signal });
    host.stdin.end('[Console]::WriteLine($PID); [Console]::Out.Flush(); Start-Sleep -Seconds 60');
    const pid = await Promise.race([
      firstLine.then(([line]) => Number(line)),
      done.then(() => {
        throw new Error(stderr || 'Command host exited before launching the command');
      }),
    ]);
    assert.ok(Number.isInteger(pid) && pid > 0);
    owner.kill();
    assert.equal((await done)[0], 0, stderr);
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  },
);
