#!/usr/bin/env node
// The Agent SDK and PTY each launch this transport in the broker. Only the runner starts Claude.
import { createConnection } from 'node:net';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { runtimeEnvironment } from './native-account.ts';

const socket = createConnection(process.env.CCDT_RUNTIME_SOCKET ?? '/data/cc-runner/launch.sock');
const send = (frame) => socket.write(JSON.stringify(frame) + '\n');
let code = 1;
try {
  await once(socket, 'connect');
  const tty = !!process.stdin.isTTY;
  send({
    profile: process.env.CCDT_ACCOUNT_PROFILE,
    session: process.env.CCDT_RUNTIME_SESSION,
    projectSocket: process.env.CCDT_PROJECT_SOCKET,
    args: process.argv.slice(2),
    cwd: process.cwd(),
    env: runtimeEnvironment(process.env),
    tty,
    cols: process.stdout.columns,
    rows: process.stdout.rows,
  });
  if (tty) process.stdin.setRawMode(true);
  process.stdout.on('resize', () =>
    send({ cols: process.stdout.columns, rows: process.stdout.rows }),
  );
  socket.on('drain', () => process.stdin.resume());
  process.stdin.on('data', (chunk) => {
    if (!send({ input: chunk.toString('base64') })) process.stdin.pause();
  });
  process.stdin.on('end', () => send({ eof: true }));
  for await (const line of createInterface({ input: socket })) {
    const frame = JSON.parse(line);
    if (frame.exit !== undefined) {
      code = frame.exit;
      break;
    }
    const stream = frame.err ? process.stderr : process.stdout;
    if (!stream.write(Buffer.from(frame.data, 'base64'))) await once(stream, 'drain');
  }
} catch {
  process.stderr.write('CC 运行容器连接失败。\n');
} finally {
  socket.destroy();
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  process.stdin.pause();
  process.exitCode = code;
}
