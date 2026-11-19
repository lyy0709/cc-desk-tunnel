import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AccountState } from '@cc-desk-tunnel/protocol';

// Only these launch settings cross the broker/runner socket. Both ends apply the same list.
export function runtimeEnvironment(values: Record<string, unknown>) {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(values))
    if (
      typeof value === 'string' &&
      /^(?:OTEL_.+|CLAUDE_AGENT_SDK_.+|CLAUDE_CODE_(?:ENTRYPOINT|ENABLE_TELEMETRY|HOST_SCHEDULED_RUN|SDK_READS_SESSION_STATE|SDK_READS_STARTUP_MARKS|ENABLE_SDK_FILE_CHECKPOINTING|DISABLE_DEFERRED_TOOL_RESUME)|ENABLE_CLAUDEAI_MCP_SERVERS)$/.test(
        name,
      )
    )
      env[name] = value;
  return env;
}

// The deployment owns this file. Import only settings for a separately billed provider.
export function providerEnvironment(
  path?: string,
  inherited = process.env,
): Record<string, string> {
  const values = { ...inherited, ...(path ? JSON.parse(readFileSync(path, 'utf8')).env : {}) };
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(values))
    if (
      typeof value === 'string' &&
      /^(ANTHROPIC_API_KEY$|CLAUDE_CODE_USE_(BEDROCK|VERTEX|FOUNDRY)$|AWS_|GOOGLE_|CLOUD_ML_REGION$|ANTHROPIC_(VERTEX|FOUNDRY)_|AZURE_)/.test(
        name,
      )
    )
      env[name] = value;
  return env;
}

export async function accountStatus(executable: string, profile: 'sdk' | 'terminal') {
  let stdout: string;
  let code = 0;
  try {
    ({ stdout } = await promisify(execFile)(executable, ['auth', 'status', '--json'], {
      env: { ...process.env, CCDT_ACCOUNT_PROFILE: profile },
      timeout: 20_000,
    }));
  } catch (error) {
    // Upstream returns 1 and a JSON result when signed out. A transport error is not an account state.
    const failure = error as { code?: number; stdout?: string };
    if (failure.code !== 1 || !failure.stdout) throw new Error('无法读取官方 CLI 的认证状态。');
    stdout = failure.stdout;
    code = failure.code;
  }
  const account = parseAccountStatus(stdout, code);
  const scope =
    profile === 'terminal' && account.loggedIn && account.authMethod === 'claude.ai'
      ? subscriptionScope(account.email, JSON.parse(stdout).orgId)
      : null;
  return { account, scope };
}

// A private database key for an account and organization. Neither email nor organization ID is stored in call logs.
export function subscriptionScope(email: unknown, org: unknown): string | null {
  if (typeof email !== 'string' || !email.trim() || typeof org !== 'string' || !org.trim())
    return null;
  return (
    'terminal:' +
    createHash('sha256')
      .update(JSON.stringify([email.trim().toLowerCase(), org.trim()]))
      .digest('hex')
  );
}

export function parseAccountStatus(stdout: string, code: number): AccountState {
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
