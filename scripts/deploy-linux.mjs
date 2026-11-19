import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { Client } from 'ssh2';
import { packageServer } from './package-server.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const config = JSON.parse(readFileSync(resolve(process.argv[2] ?? '.local/deploy.json'), 'utf8'));
if (!config.host || !config.username || !/^SHA256:[A-Za-z0-9+/]+$/.test(config.fingerprint))
  throw new Error('Host, username and pinned SHA256 fingerprint required.');
const client = new Client();
await new Promise((resolve, reject) => {
  client.once('ready', resolve).once('error', reject);
  client.connect({
    host: config.host,
    port: config.port ?? 22,
    username: config.username,
    password: config.password,
    privateKey: config.privateKeyPath ? readFileSync(config.privateKeyPath) : undefined,
    readyTimeout: 15000,
    hostVerifier(key) {
      return (
        config.fingerprint ===
        'SHA256:' + createHash('sha256').update(key).digest('base64').replace(/=+$/, '')
      );
    },
  });
});
function exec(command, input) {
  return new Promise((resolve, reject) =>
    client.exec(command, (error, stream) => {
      if (error) return reject(error);
      let stdout = '',
        stderr = '';
      stream.on('data', (data) => (stdout += data.toString('utf8')));
      stream.stderr.on('data', (data) => (stderr += data.toString('utf8')));
      stream.on('error', reject);
      stream.on('close', (code) =>
        code
          ? reject(new Error(`Remote command failed (${code}): ${stderr.slice(-3000)}`))
          : resolve(stdout),
      );
      if (input !== undefined) stream.end(input);
    }),
  );
}
const quote = (text) => "'" + text.replaceAll("'", "'\\''") + "'";
try {
  const home = (await exec('printf %s "$HOME"')).trim();
  const base = `${home}/.local/share/cc-desk-tunnel`;
  const app = base + '/app',
    data = base + '/data',
    manage = 'bash ' + quote(app + '/deploy/manage.sh');
  const port = config.servicePort ?? 8787;
  if (!Number.isInteger(port) || port < 1024 || port > 65535)
    throw new Error('Invalid service port');
  await exec('docker compose version >/dev/null');
  if ((await exec('test -f ' + quote(base + '/service.env') + ' && echo legacy || true')).trim())
    throw new Error(
      '检测到旧的裸机开发部署。请先备份旧服务与原生历史，使用单独的 Compose 部署目录；旧进程和数据未改动。',
    );
  const local = join(root, '.local');
  mkdirSync(local, { recursive: true });
  const archive = join(local, 'service.tar.gz');
  packageServer(root, archive);
  await exec('umask 077; mkdir -p ' + quote(app));
  const sftp = await new Promise((ok, fail) =>
    client.sftp((err, ch) => (err ? fail(err) : ok(ch))),
  );
  const remoteArchive = base + '/service.tar.gz';
  await new Promise((ok, fail) =>
    sftp.fastPut(archive, remoteArchive, { mode: 0o600 }, (err) => (err ? fail(err) : ok())),
  );
  await exec('tar -xzf ' + quote(remoteArchive) + ' -C ' + quote(app));
  const initialized = (
    await exec('test -f ' + quote(app + '/.local/docker.env') + ' && echo yes || true')
  ).trim();
  if (!initialized) {
    const args = ['init', '--data', data, '--host', config.host, '--control-port', String(port)];
    if (config.token) args.push('--token', config.token);
    await exec(manage + ' ' + args.map(quote).join(' '));
  }
  const provider = data + '/config/provider.json';
  if (config.provider)
    await exec('umask 077; cat > ' + quote(provider), JSON.stringify({ env: config.provider }));
  else if (config.settingsPath)
    await exec('cp -- ' + quote(config.settingsPath) + ' ' + quote(provider));
  const settings = {
    CLAUDE_MODEL: config.model,
    CLAUDE_CONTEXT_RETENTION_DAYS: config.contextRetentionDays,
  };
  const lines = Object.entries(settings)
    .filter(([, v]) => v != null)
    .map(([k, v]) => {
      if (!/^[a-zA-Z0-9_.:/-]+$/.test(String(v)))
        throw new Error('Invalid model or retention setting');
      return k + '=' + v;
    });
  if (lines.length)
    await exec('cat >> ' + quote(data + '/config/service.env'), '\n' + lines.join('\n') + '\n');
  await exec(manage + ' build');
  await exec(manage + ' up');
  const token = (
    await exec('. ' + quote(data + '/config/service.env') + '; printf %s "$PROXY_TOKEN"')
  ).trim();
  const fingerprint = (
    await exec(
      'openssl x509 -in ' + quote(data + '/tls/control.crt') + ' -noout -fingerprint -sha256',
    )
  )
    .trim()
    .split('=')
    .at(-1);
  writeFileSync(
    join(local, 'native-connection.json'),
    JSON.stringify({ url: `wss://${config.host}:${port}/ws`, fingerprint, token }, null, 2),
    { mode: 0o600 },
  );
  console.log(
    'Compose deployment is healthy. Connection details are in .local/native-connection.json.',
  );
  sftp.end();
} finally {
  client.end();
}
