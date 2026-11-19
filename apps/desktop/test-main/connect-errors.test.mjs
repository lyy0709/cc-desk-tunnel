import assert from 'node:assert/strict';
import { test } from 'node:test';
import { controlFailure } from '../electron/connect-errors.mjs';

const failure = (code, message = '') => Object.assign(new Error(message), { code });

test('a failed control connection says which step failed and what to check', () => {
  const target = 'cloud.example:8443';
  assert.match(controlFailure(failure('ENOTFOUND'), target), /无法解析.*cloud\.example。/);
  assert.match(controlFailure(failure('ECONNREFUSED'), target), /cloud\.example:8443 拒绝了连接/);
  assert.match(controlFailure(failure('ETIMEDOUT'), target), /超时[\s\S]*云安全组/);
  assert.match(controlFailure(new Error('Connection timed out'), target), /超时/);
  assert.match(controlFailure(failure('DEPTH_ZERO_SELF_SIGNED_CERT'), target), /SHA256 指纹/);
  assert.match(controlFailure(failure('ERR_TLS_CERT_ALTNAME_INVALID'), target), /主机名/);
  assert.match(controlFailure(failure('CERT_HAS_EXPIRED'), target), /已过期/);
  assert.match(controlFailure(failure('EPROTO'), target), /TLS/);
  assert.match(
    controlFailure(new Error('Unexpected server response: 502'), target),
    /502.*没有启动/,
  );
  assert.match(controlFailure(new Error('Unexpected server response: 404'), target), /WebSocket/);
  assert.match(controlFailure(new Error('Unexpected server response: 429'), target), /次数过多/);
  // The system proxy is named when the connection went through it, and blamed when it refused.
  const proxy = { host: '127.0.0.1', port: 7890 };
  assert.match(controlFailure(failure('ETIMEDOUT'), target, proxy), /系统代理 127\.0\.0\.1:7890/);
  assert.match(
    controlFailure(new Error('Proxy refused the connection: HTTP/1.1 403'), target, proxy),
    /系统代理 127\.0\.0\.1:7890拒绝转发/,
  );
  assert.match(
    controlFailure(failure('ESOMETHING'), target),
    /无法连接 cloud\.example:8443（ESOMETHING）/,
  );
});
