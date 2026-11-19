import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAccountStatus, providerEnvironment } from '../src/native-account.ts';

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
