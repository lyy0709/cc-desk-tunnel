import {
  readFileSync,
  renameSync,
  writeFileSync,
  mkdirSync,
  lstatSync,
  mkdtempSync,
  linkSync,
  copyFileSync,
  rmSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { nativeSettingsSchema } from '@cc-desk-tunnel/protocol';
import type { NativeSettings } from '@cc-desk-tunnel/protocol';

// The Claude Code that every chat run and terminal of this service starts: its configuration directory and the file
// of its own state, which holds the sign-in's account and first-run marks. In the image the service's own
// CLAUDE_CONFIG_DIR is its transcript store, so the deployment names the personal home (CCDT_PERSONAL_HOME), whose CLI
// runs without CLAUDE_CONFIG_DIR. Elsewhere it is the CLI this process would start itself.
export function personalConfig(env = process.env) {
  if (env.CCDT_PERSONAL_HOME)
    return {
      directory: join(env.CCDT_PERSONAL_HOME, '.claude'),
      state: join(env.CCDT_PERSONAL_HOME, '.claude.json'),
    };
  return {
    directory: env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'),
    state: join(env.CLAUDE_CONFIG_DIR ?? homedir(), '.claude.json'),
  };
}

// The official CLI's user settings file. The proxy edits only the keys in the protocol schema and keeps every
// other key as it found it; a new CLI process reads the file when it starts, so changes apply from the next run.
export function settingsPath(configDirectory = personalConfig().directory) {
  return join(configDirectory, 'settings.json');
}

// Settings the CLI takes as environment variables, which the file holds under `env` as text.
const variables: Partial<Record<keyof NativeSettings, string>> = {
  toolSearch: 'ENABLE_TOOL_SEARCH',
};
// Settings the file holds under `permissions`.
const permissionKeys = new Set<keyof NativeSettings>([
  'denyInsteadOfPrompting',
  'blockWritesOutsideWorkingDirectories',
]);
const section = (file: Record<string, unknown>, name: string) =>
  file[name] && typeof file[name] === 'object' && !Array.isArray(file[name])
    ? (file[name] as Record<string, unknown>)
    : {};
const environment = (file: Record<string, unknown>) => section(file, 'env');

export function readSettingsFile(path = settingsPath()): Record<string, unknown> {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
  const value = JSON.parse(text);
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Settings file is not an object');
  return value;
}

export function writeSettingsFile(file: Record<string, unknown>, path = settingsPath()) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(`${path}.proxy`, JSON.stringify(file, null, 2) + '\n', { mode: 0o600 });
  renameSync(`${path}.proxy`, path);
}

export function readNativeSettings(path = settingsPath()): NativeSettings {
  const file = readSettingsFile(path);
  // A value the schema does not accept was written by hand; it is shown as unset and left alone until changed here.
  return Object.fromEntries(
    Object.entries(nativeSettingsSchema.shape).map(([key, schema]) => {
      const variable = variables[key as keyof NativeSettings];
      if (variable) {
        const text = environment(file)[variable];
        return [key, text === 'true' ? true : text === 'false' ? false : null];
      }
      const value = permissionKeys.has(key as keyof NativeSettings)
        ? section(file, 'permissions')[key]
        : file[key];
      const parsed = schema.safeParse(value ?? null);
      return [key, parsed.success ? parsed.data : null];
    }),
  ) as NativeSettings;
}

export function updateNativeSettings(values: Partial<NativeSettings>, path = settingsPath()) {
  const file = readSettingsFile(path);
  for (const [key, value] of Object.entries(values)) {
    const variable = variables[key as keyof NativeSettings];
    if (variable) {
      if (value === undefined) continue;
      const env = { ...environment(file) };
      if (value === null) delete env[variable];
      else env[variable] = String(value);
      if (Object.keys(env).length) file.env = env;
      else delete file.env;
      continue;
    }
    if (permissionKeys.has(key as keyof NativeSettings)) {
      if (value === undefined) continue;
      const permissions = { ...section(file, 'permissions') };
      if (value === null) delete permissions[key];
      else permissions[key] = value;
      if (Object.keys(permissions).length) file.permissions = permissions;
      else delete file.permissions;
      continue;
    }
    if (value === null) delete file[key];
    else if (value !== undefined) file[key] = value;
  }
  writeSettingsFile(file, path);
  return readNativeSettings(path);
}

// 0.4.0 stored GUI preferences separately. Import only settings managed by CCDT, never credentials,
// environment overrides or hooks. A hard link installs each complete file only if its destination is still free.
export function migratePersonalSettings(previous: string, personal: string) {
  const marker = join(previous, '.personal-settings-migrated');
  if (
    previous === personal ||
    !lstatSync(previous, { throwIfNoEntry: false })?.isDirectory() ||
    lstatSync(marker, { throwIfNoEntry: false })
  )
    return;
  mkdirSync(personal, { recursive: true, mode: 0o700 });
  const staged = mkdtempSync(join(personal, '.ccdt-settings-'));
  try {
    for (const name of ['settings.json', 'CLAUDE.md']) {
      const source = join(previous, name),
        target = join(personal, name),
        temp = join(staged, name);
      if (!lstatSync(source, { throwIfNoEntry: false })?.isFile()) continue;
      if (lstatSync(target, { throwIfNoEntry: false })) {
        console.warn(`保留个人目录中的 ${name}；此前的桌面文件保存在 ${source}。`);
        continue;
      }
      if (name === 'settings.json') {
        const values = Object.fromEntries(
          Object.entries(readNativeSettings(source)).filter(([, v]) => v != null),
        );
        if (!Object.keys(values).length) continue;
        updateNativeSettings(values, temp);
      } else copyFileSync(source, temp);
      try {
        linkSync(temp, target);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      }
    }
    writeFileSync(marker, '', { mode: 0o600 });
  } finally {
    rmSync(staged, { recursive: true, force: true });
  }
}
