import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AccountState } from '@cc-desk-tunnel/protocol';
import {
  personalConfig,
  readSettingsFile,
  settingsPath,
  writeSettingsFile,
} from './native-settings.ts';
import { ACCOUNT_LAUNCH } from './runtime-environment.ts';

const official = (executable: string, args: string[]) =>
  promisify(execFile)(executable, args, {
    env: { ...process.env, ...ACCOUNT_LAUNCH },
    timeout: 20_000,
  });

export async function accountStatus(executable: string) {
  let stdout: string;
  let code = 0;
  try {
    ({ stdout } = await official(executable, ['auth', 'status', '--json']));
  } catch (error) {
    // Upstream returns 1 and a JSON result when signed out. A transport error is not an account state.
    const failure = error as { code?: number; stdout?: string };
    if (failure.code !== 1 || !failure.stdout) throw new Error('无法读取官方 CLI 的认证状态。');
    stdout = failure.stdout;
    code = failure.code;
  }
  const state = parseAccountStatus(stdout, code);
  const scope =
    state.loggedIn && state.authMethod === 'claude.ai'
      ? subscriptionScope(state.email, JSON.parse(stdout).orgId)
      : null;
  return { state, scope };
}

// Compatible with the account-scoped readings written by 0.4.0.
export function subscriptionScope(email: unknown, org: unknown) {
  if (typeof email !== 'string' || !email.trim() || typeof org !== 'string' || !org.trim())
    return null;
  return (
    'terminal:' +
    createHash('sha256')
      .update(JSON.stringify([email.trim().toLowerCase(), org.trim()]))
      .digest('hex')
  );
}

export function parseAccountStatus(
  stdout: string,
  code: number,
): Omit<AccountState, 'login' | 'notice'> {
  const status = JSON.parse(stdout);
  if (typeof status?.loggedIn !== 'boolean' || code !== (status.loggedIn ? 0 : 1))
    throw new Error('官方 CLI 未返回有效的认证状态。');
  return {
    loggedIn: status.loggedIn,
    authMethod: typeof status.authMethod === 'string' ? status.authMethod : undefined,
    email: typeof status.email === 'string' ? status.email : undefined,
    organization: typeof status.orgName === 'string' ? status.orgName : undefined,
    subscriptionType:
      typeof status.subscriptionType === 'string' ? status.subscriptionType : undefined,
    loginExpiresAt:
      typeof status.loginExpiresAt === 'string' &&
      Number.isFinite(Date.parse(status.loginExpiresAt))
        ? status.loginExpiresAt
        : undefined,
  };
}

// Official logout clears the sign-in the CLI stored. A setup token an earlier release kept in the user settings would
// keep the CLI signed in, so it goes too; nothing else in the file changes.
export async function accountLogout(executable: string, settings = settingsPath()) {
  try {
    await official(executable, ['auth', 'logout']);
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    throw new Error(
      failure.stderr?.trim() ||
        failure.stdout?.trim() ||
        `claude auth logout 退出码：${failure.code ?? '未知'}`,
    );
  }
  removeSetupToken(settings);
}

export function removeSetupToken(path = settingsPath()) {
  const file = readSettingsFile(path);
  const env = file.env;
  if (!env || typeof env !== 'object' || !Object.hasOwn(env, 'CLAUDE_CODE_OAUTH_TOKEN')) return;
  const { CLAUDE_CODE_OAUTH_TOKEN: _token, ...rest } = env as Record<string, unknown>;
  if (Object.keys(rest).length) file.env = rest;
  else delete file.env;
  writeSettingsFile(file, path);
}

// The CLI marks its first-run wizard done only when the user confirms the wizard's last screen. An account signed in
// with `claude auth login` never reaches that screen, and every terminal would start with the wizard, asking for a
// theme and a sign-in again. Called with no CLI running, as it writes the CLI's own state file.
export function completeOnboarding(config = personalConfig()) {
  try {
    const state = JSON.parse(readFileSync(config.state, 'utf8'));
    if (state.hasCompletedOnboarding === true) return false;
    writeFileSync(
      `${config.state}.onboarding`,
      JSON.stringify({ ...state, hasCompletedOnboarding: true }, null, 2),
      { mode: 0o600 },
    );
    renameSync(`${config.state}.onboarding`, config.state);
    return true;
  } catch {
    return false;
  }
}
