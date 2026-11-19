import { randomInt } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:net';
import {
  chmodSync,
  chownSync,
  closeSync,
  constants,
  fchownSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  readlinkSync,
  symlinkSync,
  rmSync,
} from 'node:fs';
import { createInterface } from 'node:readline';
import { join, resolve, relative, isAbsolute, dirname, basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { providerEnvironment, runtimeEnvironment } from './native-account.ts';

const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;

function directory(path: string, uid: number, mode: number) {
  try {
    mkdirSync(path, { mode });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const fd = openSync(path, constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    fchownSync(fd, uid, 1000);
  } finally {
    closeSync(fd);
  }
}

function sessionHome(session: string | undefined, interactive: boolean, cwd?: string) {
  if (cwd && (!session || !uuid.test(session))) throw new Error('Invalid runtime session');
  const shared = process.env.CLAUDE_CONFIG_DIR!;
  const appHome = process.env.HOME!;
  const home = interactive
    ? '/data/home'
    : session
      ? join(appHome, 'sessions', session, 'sdk')
      : join(appHome, 'account-status');
  directory(shared, 1000, 0o700);
  if (!interactive && session)
    for (const parent of [dirname(dirname(home)), dirname(home)]) {
      directory(parent, 0, 0o751);
      chmodSync(parent, 0o751);
    }
  const config = join(home, '.claude');
  directory(home, 1000, 0o700);
  directory(config, 1000, 0o700);
  const names = interactive ? [] : ['settings.json', 'CLAUDE.md'];
  let history: string | undefined;
  if (cwd) {
    const projects = join(shared, 'projects');
    directory(projects, 1000, 0o700);
    // The broker assigns an ASCII UUID cwd. Its native transcript directory encodes slashes as dashes.
    const projectName = cwd.replaceAll('/', '-');
    history = join(projects, projectName);
    directory(history, 1000, 0o700);
    const localProjects = join(config, 'projects');
    if (!interactive) {
      if (lstatSync(localProjects, { throwIfNoEntry: false })?.isSymbolicLink()) {
        if (readlinkSync(localProjects) !== projects) throw new Error('Unexpected history link');
        rmSync(localProjects);
      }
      directory(localProjects, 1000, 0o700);
    } else {
      // Compose overlays only this directory. Never install links into a user's original history.
      const overlay = lstatSync(localProjects);
      if (
        !overlay.isDirectory() ||
        overlay.uid !== 0 ||
        (overlay.mode & 0o022) !== 0 ||
        overlay.dev === lstatSync(config).dev
      )
        throw new Error('Missing private terminal history mount');
    }
    names.push(join('projects', projectName));
  }
  for (const name of names) {
    const source = join(shared, name),
      link = join(config, name);
    try {
      symlinkSync(source, link);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST' || readlinkSync(link) !== source)
        throw err;
    }
  }
  return {
    HOME: home,
    ...(!interactive && { CLAUDE_CONFIG_DIR: config }),
    CCDT_SHARED_CONFIG: shared,
    ...(history && { CCDT_HISTORY: history }),
  };
}
// Runs inside the isolated volume and PID namespace. No executable or credential path is accepted on the wire.
export function serveRuntime(path: string, executable: string, root: string, provider: string) {
  // The supervisor owns both directories. Only the broker group can create or list project sockets.
  // A CLI’s primary group is unique to this launch and can connect only to its assigned socket.
  execFileSync('/usr/local/bin/ccdt-guard', ['--check'], { stdio: 'inherit' });
  const sockets = resolve(root, '../project-sockets');
  process.setgroups!([]);
  for (const [dir, mode] of [
    [dirname(path), 0o710],
    [sockets, 0o771],
  ] as const) {
    mkdirSync(dir, { recursive: true });
    chownSync(dir, 0, 1000);
    chmodSync(dir, mode);
  }
  const activeGroups = new Set<number>();
  let nextGid = randomInt(12000, 60000);
  rmSync(path, { force: true });
  const server = createServer((socket) => {
    let kill = () => {},
      pause = () => {},
      resume = () => {},
      write = (data: Buffer) => {},
      eof = () => {},
      resize = (cols: number, rows: number) => {};
    let started = false;
    let group: number | undefined;
    const output = (data: Buffer, err = false) => {
      if (!socket.write(JSON.stringify({ data: data.toString('base64'), err }) + '\n')) pause();
    };
    const exit = (code: number | null) => socket.end(JSON.stringify({ exit: code ?? 1 }) + '\n');
    socket.on('drain', () => resume());
    socket.on('error', () => socket.destroy());
    socket.on('close', () => {
      kill();
      if (group !== undefined) activeGroups.delete(group);
    });
    void (async () => {
      for await (const line of createInterface({ input: socket })) {
        if (line.length > 2 ** 20) throw new Error();
        const frame = JSON.parse(line);
        if (!started) {
          if (
            !Array.isArray(frame.args) ||
            !frame.args.every((a: unknown) => typeof a === 'string') ||
            !isAbsolute(frame.cwd)
          )
            throw new Error();
          if (typeof frame.tty !== 'boolean') throw new Error('Invalid terminal mode');
          const account = frame.profile !== undefined;
          if (account) {
            if (
              !['sdk', 'terminal'].includes(frame.profile) ||
              frame.session ||
              frame.projectSocket ||
              (frame.tty && frame.profile !== 'terminal') ||
              JSON.stringify(frame.args) !==
                JSON.stringify(frame.tty ? ['auth', 'login'] : ['auth', 'status', '--json'])
            )
              throw new Error('Invalid account status request');
          } else {
            const rel = relative(root, frame.cwd);
            if (
              !uuid.test(rel) ||
              join(root, rel) !== frame.cwd ||
              realpathSync(frame.cwd) !== frame.cwd
            )
              throw new Error('Invalid project directory');
          }
          let terminal: string | undefined;
          if (frame.tty && !account) {
            const index = frame.args.indexOf('--settings');
            const settings = index < 0 ? undefined : frame.args[index + 1];
            if (typeof settings !== 'string') throw new Error('Missing terminal settings');
            terminal = dirname(settings);
            if (
              !uuid.test(basename(terminal)) ||
              settings !== join(root, '..', 'terminals', basename(terminal), 'settings.json') ||
              realpathSync(settings) !== settings ||
              realpathSync(join(terminal, 'events')) !== join(terminal, 'events')
            )
              throw new Error('Invalid terminal settings');
          }
          if (activeGroups.size >= 48000) throw new Error('Runtime process capacity exceeded');
          while (activeGroups.has(nextGid)) nextGid = 12000 + ((nextGid - 11999) % 48000);
          group = nextGid;
          activeGroups.add(group);
          nextGid = 12000 + ((nextGid - 11999) % 48000);
          const identity = { uid: 1000, gid: group };
          if (frame.projectSocket) {
            const name = basename(frame.projectSocket);
            if (dirname(frame.projectSocket) !== sockets || !/^[0-9a-f-]{36}\.sock$/.test(name))
              throw new Error();
            const entry = lstatSync(frame.projectSocket);
            if (!entry.isSocket() || entry.uid !== 1000) throw new Error();
            chownSync(frame.projectSocket, 0, identity.gid);
            chmodSync(frame.projectSocket, 0o660);
          }
          started = true;
          const interactive = frame.tty || frame.profile === 'terminal';
          const home = sessionHome(frame.session, interactive, account ? undefined : frame.cwd);
          const env: Record<string, string> = {
            ...home,
            PATH: process.env.PATH!,
            LANG: 'C.UTF-8',
            DISABLE_AUTOUPDATER: '1',
            ...(!interactive && providerEnvironment(provider, {})),
            ...(terminal && { CCDT_TERMINAL: terminal }),
            ...runtimeEnvironment(frame.env ?? {}),
          };
          if (frame.tty) {
            const { spawn: pty } = await import('node-pty');
            if (socket.destroyed) return;
            const proc = pty('/usr/local/bin/ccdt-guard', [executable, ...frame.args], {
              ...identity,
              cwd: account ? home.HOME : frame.cwd,
              env,
              cols: frame.cols || 80,
              rows: frame.rows || 24,
              name: 'xterm-256color',
            });
            write = (b) => proc.write(b);
            resize = (c, r) => proc.resize(c, r);
            pause = () => proc.pause();
            resume = () => proc.resume();
            kill = () => {
              try {
                proc.kill('SIGKILL');
              } catch {}
            };
            proc.onData((s) => output(Buffer.from(s)));
            proc.onExit((e) => {
              kill = () => {};
              exit(e.exitCode);
            });
          } else {
            const proc = spawn('/usr/local/bin/ccdt-guard', [executable, ...frame.args], {
              ...identity,
              cwd: account ? home.HOME : frame.cwd,
              env,
              stdio: 'pipe',
              detached: true,
            });
            kill = () => {
              if (proc.pid)
                try {
                  process.kill(-proc.pid, 'SIGKILL');
                } catch {}
            };
            pause = () => {
              proc.stdout.pause();
              proc.stderr.pause();
            };
            resume = () => {
              proc.stdout.resume();
              proc.stderr.resume();
            };
            write = (b) => {
              if (!proc.stdin.write(b)) {
                socket.pause();
                proc.stdin.once('drain', () => socket.resume());
              }
            };
            eof = () => proc.stdin.end();
            proc.stdin.on('error', () => {});
            proc.stdout.on('data', (b) => output(b));
            proc.stderr.on('data', (b) => output(b, true));
            proc.on('error', () => exit(1));
            proc.on('close', (code) => {
              kill();
              kill = () => {};
              exit(code);
            });
          }
        } else if (typeof frame.input === 'string') write(Buffer.from(frame.input, 'base64'));
        else if (frame.eof) eof();
        else if (Number.isInteger(frame.cols) && Number.isInteger(frame.rows))
          resize(frame.cols, frame.rows);
      }
    })().catch(() => socket.destroy());
  });
  server.listen(path, () => {
    chownSync(path, 0, 1000);
    chmodSync(path, 0o660);
  });
  return server;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url)
  serveRuntime(
    '/data/cc-runner/launch.sock',
    '/opt/runtime/cli/bin/claude',
    '/data/state/native',
    '/data/provider.json',
  );
