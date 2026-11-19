import { existsSync } from 'node:fs';
import desktop from '../../desktop/package.json' with { type: 'json' };
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Windows commands run with the packaged PowerShell, or the one available in development.
const here = fileURLToPath(new URL('.', import.meta.url));
const packaged = existsSync(join(here, 'vendor'));
const vendor = packaged
  ? join(here, 'vendor')
  : fileURLToPath(new URL('../../desktop/vendor/', import.meta.url));

export const components = (env = process.env) => ({
  powershell:
    env.CCDT_POWERSHELL ??
    (existsSync(join(vendor, 'pwsh', 'pwsh.exe')) ? join(vendor, 'pwsh', 'pwsh.exe') : 'pwsh.exe'),
});

// The release ccdt belongs to, which is the one of the service it speaks to: the package writes it in.
export const version = typeof __CCDT_VERSION__ === 'string' ? __CCDT_VERSION__ : desktop.version;

// ccdt runs from a package (scripts/package-cli.mjs), which it can replace with another release's, rather than from
// the source tree.
export const bundled = typeof __CCDT_VERSION__ === 'string';

// The name of the ccdt package of a release for a system, as the release page has it; undefined for a system there
// is none for.
const SYSTEMS = {
  'win32-x64': 'windows-x64',
  'darwin-arm64': 'mac-arm64',
  'darwin-x64': 'mac-x64',
  'linux-x64': 'linux-x64',
  'linux-arm64': 'linux-arm64',
};
export const packageName = (release, system = `${process.platform}-${process.arch}`) => {
  const name = SYSTEMS[system];
  return name && `ccdt-${release}-${name}.${name.startsWith('windows') ? 'zip' : 'tar.gz'}`;
};

export const releases = `${desktop.repository}/releases`;
export const releasePage = (release) => `${releases}/tag/v${release}`;
