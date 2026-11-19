import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export function buildProjectFiles(output, arch = process.arch) {
  const binary = join(output, process.platform === 'win32' ? 'project-files.exe' : 'project-files');
  mkdirSync(output, { recursive: true });
  execFileSync('go', ['build', '-trimpath', '-o', binary, '.'], {
    cwd: fileURLToPath(new URL('../packages/project-files/', import.meta.url)),
    stdio: 'inherit',
    env: { ...process.env, CGO_ENABLED: '0', GOARCH: arch === 'x64' ? 'amd64' : arch },
  });
  return binary;
}
if (process.argv[1] === fileURLToPath(import.meta.url))
  buildProjectFiles(fileURLToPath(new URL('../.local/', import.meta.url)));
