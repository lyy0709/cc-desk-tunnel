import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { completeOnboarding, parseAccountStatus, removeSetupToken } from '../src/native-account.ts';
import { NativeLogin } from '../src/native-login.ts';
import type { TerminalSpawner } from '../src/native-terminal.ts';
import { migratePersonalSettings, personalConfig } from '../src/native-settings.ts';
import { ignoredProviderSettings, providerEnvironment } from '../src/runtime-environment.ts';

test('only a consistent upstream auth-status result becomes account state', () => {
  assert.equal(parseAccountStatus('{"loggedIn":false,"authMethod":"none"}', 1).loggedIn, false);
  const signedIn = parseAccountStatus(
    '{"loggedIn":true,"email":"owner@example.test","orgName":"fixture"}',
    0,
  );
  assert.equal(signedIn.email, 'owner@example.test');
  assert.equal(signedIn.organization, 'fixture');
  for (const [output, code] of [
    ['{}', 0],
    ['{"loggedIn":false}', 2],
    ['{"loggedIn":true}', 1],
    ['', 1],
  ] as const)
    assert.throws(() => parseAccountStatus(output, code));
});
test('only explicit provider credentials reach the application runtime', () => {
  assert.deepEqual(
    providerEnvironment(undefined, {
      ANTHROPIC_API_KEY: 'fixture',
      PROXY_TOKEN: 'private',
      CLAUDE_CODE_OAUTH_TOKEN: 'private',
      CLAUDE_CONFIG_DIR: '/personal',
      ANTHROPIC_AUTH_TOKEN: 'private',
    }),
    { ANTHROPIC_API_KEY: 'fixture' },
  );
});
test('the provider settings the runtime leaves out are named, without their values', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'ccdt-provider-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'provider.json');
  writeFileSync(
    path,
    JSON.stringify({
      env: {
        ANTHROPIC_API_KEY: 'fixture',
        AWS_REGION: 'us-east-1',
        ANTHROPIC_BASE_URL: 'https://gateway.example.test',
        ANTHROPIC_AUTH_TOKEN: 'private',
        HTTPS_PROXY: 'http://proxy.example.test:3128',
        'not a name': 'x',
      },
    }),
  );
  assert.deepEqual(ignoredProviderSettings(path), [
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
    'HTTPS_PROXY',
  ]);
  writeFileSync(path, '{}');
  assert.deepEqual(ignoredProviderSettings(path), []);
  assert.deepEqual(ignoredProviderSettings(join(directory, 'missing.json')), []);
});

// A terminal for NativeLogin that the test writes into and ends.
function fakeTerminal() {
  const terminal = {
    args: [] as string[],
    env: {} as Record<string, string>,
    written: [] as string[],
    data: (_text: string) => {},
    end: (_event: { exitCode: number }) => {},
  };
  const spawn: TerminalSpawner = (_file, args, options) => {
    terminal.args = args;
    terminal.env = (options as { env: Record<string, string> }).env;
    return {
      pid: 1,
      onData: (listener) => {
        terminal.data = listener;
        return { dispose() {} };
      },
      onExit: (listener) => {
        terminal.end = listener;
        return { dispose() {} };
      },
      write: (text) => terminal.written.push(text.toString()),
      resize() {},
      pause() {},
      resume() {},
      kill() {
        terminal.end({ exitCode: 1 });
      },
    };
  };
  return { terminal, spawn };
}

test('sign-in runs the official command, passes the code on as typed and reports what it says', async () => {
  const { terminal, spawn } = fakeTerminal();
  const results: boolean[] = [];
  const notices: string[] = [];
  const login = new NativeLogin(
    'claude',
    (succeeded) => results.push(succeeded),
    (text) => notices.push(text),
    { spawn },
  );
  assert.deepEqual(terminal.args, ['auth', 'login']);
  // The command is one about the sign-in, which every launch on the service shares.
  assert.equal(terminal.env.CCDT_ACCOUNT_PROFILE, 'personal');
  terminal.data(
    'Opening browser to sign in…\r\nIf the browser didn’t open, visit: \x1b]8;;https://claude.ai/oauth/authorize?code=true&state=fixture\x07https://claude.ai/oauth/authorize?code=true&state=fixture\x1b]8;;\x07\r\n',
  );
  assert.equal(await login.url, 'https://claude.ai/oauth/authorize?code=true&state=fixture');
  // A code the page did not give: the command says so and waits for another.
  login.submit('wrong#code');
  terminal.data('Paste code here if prompted > wrong#code\r\nInvalid code. Please try again.\r\n');
  await delay(450);
  assert.deepEqual(notices, ['Invalid code. Please try again.']);
  login.submit('fixture#state');
  assert.deepEqual(terminal.written, ['wrong#code\r', 'fixture#state\r']);
  terminal.data('Login successful.\r\n');
  terminal.end({ exitCode: 0 });
  assert.deepEqual(results, [true]);

  // A failure keeps the CLI's own words and leaves the code out of them.
  const failing = fakeTerminal();
  const failed = new NativeLogin(
    'claude',
    (succeeded) => results.push(succeeded),
    () => {},
    {
      spawn: failing.spawn,
    },
  );
  failing.terminal.data('https://claude.ai/oauth/authorize?fixture=1\r\n');
  await failed.url;
  failed.submit('secret#code');
  failing.terminal.data('OAuth error: Request failed for secret#code\r\nPress Enter to retry.\r\n');
  failing.terminal.end({ exitCode: 1 });
  assert.deepEqual(results, [true, false]);
  assert.equal(failed.error, 'OAuth error: Request failed for [授权码已省略]');

  // Cancelled, it does not count as signed in whatever the command says last.
  const cancelling = fakeTerminal();
  const cancelled = new NativeLogin(
    'claude',
    (succeeded) => results.push(succeeded),
    () => {},
    {
      spawn: cancelling.spawn,
    },
  );
  cancelling.terminal.data('https://claude.ai/oauth/authorize?fixture=2\r\n');
  await cancelled.url;
  cancelled.cancel();
  assert.deepEqual(results, [true, false, false]);
  assert.equal(cancelled.error, undefined);

  // A command that ends before it shows a link says why.
  const refused = fakeTerminal();
  const early = new NativeLogin(
    'claude',
    () => {},
    () => {},
    { spawn: refused.spawn },
  );
  const rejected = assert.rejects(early.url, /allowedProviders policy/);
  refused.terminal.data("This machine's allowedProviders policy does not permit claude.ai.\r\n");
  refused.terminal.end({ exitCode: 1 });
  await rejected;
});

test('signing out leaves no setup token behind and keeps every other setting', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'ccdt-account-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'settings.json');
  removeSetupToken(path);
  assert.equal(existsSync(path), false, 'nothing is written where there is nothing to remove');
  writeFileSync(
    path,
    JSON.stringify({
      env: { KEEP: 'yes', CLAUDE_CODE_OAUTH_TOKEN: 'test-only-token' },
      language: 'chinese',
    }),
  );
  removeSetupToken(path);
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), {
    env: { KEEP: 'yes' },
    language: 'chinese',
  });
  writeFileSync(path, JSON.stringify({ env: { CLAUDE_CODE_OAUTH_TOKEN: 'test-only-token' } }));
  removeSetupToken(path);
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), {});
});

test('a signed-in Claude Code skips its first-run wizard, in the personal home the service names', (t) => {
  const home = mkdtempSync(join(tmpdir(), 'ccdt-home-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const config = personalConfig({ CCDT_PERSONAL_HOME: home, CLAUDE_CONFIG_DIR: '/transcripts' });
  assert.deepEqual(config, {
    directory: join(home, '.claude'),
    state: join(home, '.claude.json'),
  });
  // Outside the image it is the CLI this process would start.
  assert.equal(
    personalConfig({ CLAUDE_CONFIG_DIR: '/elsewhere' }).state,
    join('/elsewhere', '.claude.json'),
  );
  mkdirSync(config.directory);
  writeFileSync(config.state, JSON.stringify({ theme: 'dark', hasCompletedOnboarding: false }));
  // Only invoked by the success callback of the official login command. No token file is needed.
  assert.equal(completeOnboarding(config), true);
  assert.deepEqual(JSON.parse(readFileSync(config.state, 'utf8')), {
    theme: 'dark',
    hasCompletedOnboarding: true,
  });
  assert.equal(completeOnboarding(config), false);
});

test('old desktop preferences migrate once without importing credentials or replacing personal instructions', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ccdt-import-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const previous = join(dir, 'old'),
    personal = join(dir, 'personal');
  mkdirSync(previous);
  mkdirSync(personal);
  writeFileSync(
    join(previous, 'settings.json'),
    JSON.stringify({
      language: 'chinese',
      env: { ENABLE_TOOL_SEARCH: 'true', ANTHROPIC_API_KEY: 'dummy' },
    }),
  );
  writeFileSync(join(previous, 'CLAUDE.md'), 'old');
  writeFileSync(join(personal, 'CLAUDE.md'), 'keep');
  migratePersonalSettings(previous, personal);
  assert.deepEqual(JSON.parse(readFileSync(join(personal, 'settings.json'), 'utf8')), {
    language: 'chinese',
    env: { ENABLE_TOOL_SEARCH: 'true' },
  });
  assert.equal(readFileSync(join(personal, 'CLAUDE.md'), 'utf8'), 'keep');
  rmSync(join(personal, 'settings.json'));
  migratePersonalSettings(previous, personal);
  assert.ok(!existsSync(join(personal, 'settings.json')));
});
