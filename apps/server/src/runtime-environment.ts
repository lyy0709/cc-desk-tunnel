import { readFileSync } from 'node:fs';

// What crosses into a CLI launch, kept apart from the account code so that the relay, started for every launch, loads
// nothing more than this.

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

const providerSetting =
  /^(ANTHROPIC_API_KEY$|CLAUDE_CODE_USE_(BEDROCK|VERTEX|FOUNDRY)$|AWS_|GOOGLE_|CLOUD_ML_REGION$|ANTHROPIC_(VERTEX|FOUNDRY)_|AZURE_)/;
// The deployment owns this file. It may name an API key or a cloud provider for the service's Claude Code, which chat
// runs and terminals then both use; left empty, Claude Code uses its own sign-in. Nothing else in it is taken.
export function providerEnvironment(
  path?: string,
  inherited = process.env,
): Record<string, string> {
  const values = { ...inherited, ...(path ? JSON.parse(readFileSync(path, 'utf8')).env : {}) };
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(values))
    if (typeof value === 'string' && providerSetting.test(name)) env[name] = value;
  return env;
}

// The names in the deployment's provider file that the runtime does not take. A setting that stops applying without
// a word, as after an upgrade from a release that passed all of them on, reads as a broken sign-in; the account page
// names them instead. Only names are returned, never a value.
export function ignoredProviderSettings(path: string): string[] {
  try {
    const env: unknown = JSON.parse(readFileSync(path, 'utf8')).env;
    if (!env || typeof env !== 'object') return [];
    return Object.keys(env)
      .filter((name) => /^\w{1,64}$/.test(name) && !providerSetting.test(name))
      .sort();
  } catch {
    return [];
  }
}

// Every launch of the official CLI on this service is the same Claude Code, with one home and one sign-in. A command
// about that sign-in, which belongs to no session, says so with this marker (see runtime-relay.mjs).
export const ACCOUNT_LAUNCH = { CCDT_ACCOUNT_PROFILE: 'personal' };
