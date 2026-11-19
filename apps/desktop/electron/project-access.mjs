import { execFile, spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { resolvePosixShell, captureShellEnvironment } from './shell-environment.mjs';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { open, realpath, lstat } from 'node:fs/promises';
import { dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { findGitBash } from './git-bash.mjs';
import { ProcessSupervisor } from './process-supervisor.mjs';
const imagePath = /\.(png|jpe?g|gif|webp)$/i;

function files(executable, root, input, signal) {
  return new Promise((accept, reject) => {
    const child = execFile(
      executable,
      [root],
      { signal, timeout: 30000, maxBuffer: 128 * 1024, windowsHide: true },
      (err, stdout) => {
        if (err) return reject(new Error('本机文件工具未完成，请检查安装或重新选择项目。'));
        try {
          const result = JSON.parse(stdout);
          if (result.error) throw new Error(result.error);
          accept(result);
        } catch (error) {
          reject(error);
        }
      },
    );
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(input));
  });
}

// Only native UI choices (or the CLI working directory) can create bindings.
export class ProjectAccess {
  constructor({
    database,
    service,
    helper,
    chooseRoot,
    confirmFile,
    powershell,
    scriptDirectory,
    environment,
  }) {
    mkdirSync(dirname(database), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(database);
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS projects(service TEXT, path TEXT, id TEXT, identity TEXT, PRIMARY KEY(service,path), UNIQUE(service,id))',
    );
    Object.assign(this, {
      service,
      helper,
      chooseRoot,
      confirmFile,
      powershell,
      scriptDirectory,
      environment,
    });
    this.sessions = new Map();
    this.grants = new Map();
    this.attachments = new Map();
    this.calls = new Map();
    this.outputs = new Map();
    this.closed = false;
  }
  async bind(folder) {
    const path = await realpath(folder);
    const { text: identity } = await files(this.helper, path, { op: 'bind' });
    this.db
      .prepare(
        'INSERT INTO projects VALUES(?,?,?,?) ON CONFLICT(service,path) DO UPDATE SET id=excluded.id, identity=excluded.identity WHERE projects.identity<>excluded.identity',
      )
      .run(this.service, path, 'project:' + randomUUID(), identity);
    return this.byPath(path).id;
  }
  byPath(path) {
    return this.db
      .prepare('SELECT * FROM projects WHERE service=? AND path=?')
      .get(this.service, path);
  }
  byId(id) {
    return this.db.prepare('SELECT * FROM projects WHERE service=? AND id=?').get(this.service, id);
  }
  async reference(path) {
    const folder = await realpath(path);
    const row = this.byPath(folder);
    if (row) return row.id;
    if (await this.chooseRoot(folder)) return this.bind(folder);
    throw new Error('请在本机选择项目目录。');
  }
  session(session) {
    const old = this.sessions.get(session.id);
    if (old && old !== session.projectPath) this.revoke(session.id);
    this.sessions.set(session.id, session.projectPath);
    return { ...session, projectPath: this.byId(session.projectPath)?.path ?? session.projectPath };
  }
  revokeCommands(id) {
    const project = this.grants.get(id);
    this.grants.delete(id);
    this.outputs.delete(id);
    for (const call of this.calls.values())
      if (call.sessionId === id && call.command) call.controller.abort();
    if (project) this.onCommandsChanged?.(id, project, false);
  }
  revoke(id) {
    this.revokeCommands(id);
    for (const call of this.calls.values()) if (call.sessionId === id) call.controller.abort();
    for (const [ref, file] of this.attachments)
      if (file.sessionId === id) this.attachments.delete(ref);
  }
  commands(id, enabled) {
    const project = this.sessions.get(id);
    if (!this.byId(project ?? '')) throw new Error('请先在这台电脑上绑定项目。');
    if (!enabled) return this.revokeCommands(id);
    if (this.grants.get(id) === project) return;
    this.grants.set(id, project);
    this.onCommandsChanged?.(id, project, true);
  }
  async attachment(sessionId, file) {
    const root = this.byId(this.sessions.get(sessionId) ?? '');
    if (!root) throw new Error('请先绑定项目。');
    const full = await realpath(file.path);
    const rel = relative(root.path, full);
    if (rel && !isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep))
      return { ...file, path: 'project:/' + rel.split(sep).join('/') };
    const selected = await lstat(full, { bigint: true });
    if (!selected.isFile()) throw new Error('只接受普通附件。');
    if (!(await this.confirmFile(full))) throw new Error('未授权项目外附件。');
    const handle = await open(
      full,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
    );
    try {
      const opened = await handle.stat({ bigint: true });
      if (
        opened.dev !== selected.dev ||
        opened.ino !== selected.ino ||
        (await realpath(full)) !== full
      )
        throw new Error('附件已变更，请重新选择。');
      const info = await handle.stat();
      if (!info.isFile() || info.size > 20 * 1024 * 1024)
        throw new Error('只支持 20 MiB 以内的普通附件。');
      const bytes = Buffer.alloc(info.size);
      let at = 0;
      while (at < bytes.length) {
        const { bytesRead } = await handle.read(bytes, at, bytes.length - at, at);
        if (!bytesRead) break;
        at += bytesRead;
      }
      const ref = 'attachment:' + randomUUID();
      this.attachments.set(ref, {
        sessionId,
        bytes: bytes.subarray(0, at),
        ext: extname(full).toLowerCase(),
      });
      return { ...file, path: ref };
    } finally {
      await handle.close();
    }
  }
  async call(message) {
    const { sessionId, project, operation, requestId } = message;
    if (this.closed || this.sessions.get(sessionId) !== project)
      throw new Error('会话的项目绑定已失效。');
    const root = this.byId(project);
    if (!root) throw new Error('请在本机重新绑定此项目。');
    const controller = new AbortController();
    this.calls.set(requestId, { sessionId, controller, command: operation.op === 'command' });
    try {
      if (operation.op === 'command') {
        if (this.grants.get(sessionId) !== project)
          throw new Error('请在项目所在电脑为本次会话开启命令权限。');
        if (
          (await files(this.helper, root.path, { op: 'bind' }, controller.signal)).text !==
          root.identity
        )
          throw new Error('项目目录已变更。');
        if (controller.signal.aborted || this.grants.get(sessionId) !== project)
          throw new Error('命令授权已撤销。');
        const result = await runCommand(
          root.path,
          operation.command,
          this.powershell,
          this.scriptDirectory,
          operation.shell,
          this.environment,
          controller.signal,
        );
        if (controller.signal.aborted) throw new Error('命令已中断，结果未知。');
        this.outputs.set(sessionId, { id: requestId, ...result });
        return this.output(sessionId, requestId, 0);
      }
      if (operation.op === 'output') return this.output(sessionId, operation.id, operation.offset);
      if (operation.path.startsWith('attachment:')) {
        const file = this.attachments.get(operation.path);
        if (operation.op !== 'read' || file?.sessionId !== sessionId)
          throw new Error('附件引用无效。');
        const image = imagePath.test(file.ext);
        const end = Math.min(file.bytes.length, operation.offset + (image ? 64 * 1024 : 12000));
        return JSON.stringify({
          base64: file.bytes.subarray(operation.offset, end).toString('base64'),
          ext: file.ext,
          next: end < file.bytes.length ? end : undefined,
        });
      }
      const image = operation.op === 'read' && imagePath.test(operation.path);
      const result = await files(
        this.helper,
        root.path,
        { ...operation, op: image ? 'image' : operation.op, identity: root.identity },
        controller.signal,
      );
      if (image)
        return JSON.stringify({
          base64: result.text,
          next: result.next,
          revision: result.revision,
          ext: extname(operation.path).toLowerCase(),
        });
      return JSON.stringify(result);
    } finally {
      this.calls.delete(requestId);
    }
  }
  output(session, id, offset) {
    const held = this.outputs.get(session);
    if (!held || held.id !== id) throw new Error('此命令的输出已释放。');
    const end = Math.min(offset + 10000, held.output.length);
    return JSON.stringify({
      id,
      output: held.output.slice(offset, end),
      next: end < held.output.length ? end : undefined,
      code: held.code,
      signal: held.signal,
      truncated: held.truncated,
    });
  }
  close() {
    this.closed = true;
    for (const { controller } of this.calls.values()) controller.abort();
    this.outputs.clear();
    this.grants.clear();
    this.attachments.clear();
    this.db.close();
  }
}

async function runCommand(cwd, script, powershell, scriptDirectory, shell, environment, signal) {
  const windows = process.platform === 'win32';
  const supervisor = new ProcessSupervisor();
  const binary = windows ? (powershell ?? 'pwsh.exe') : await resolvePosixShell({ signal });
  const host = scriptDirectory
    ? resolve(scriptDirectory, 'component-host.ps1')
    : fileURLToPath(new URL('./component-host.ps1', import.meta.url));
  const args = windows
    ? [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-File',
        host,
        '-OwnerProcessId',
        String(process.pid),
      ]
    : ['-c', script];
  if (windows && shell === 'bash') {
    const bash = await findGitBash();
    if (!bash) throw new Error('本机没有 Git Bash。');
    args.push('-Bash', bash);
  }
  signal.throwIfAborted();
  const env = windows
    ? process.env
    : await captureShellEnvironment(binary, supervisor, {
        cwd,
        signal,
        env: { ...process.env, ...environment },
      });
  signal.throwIfAborted();
  const options = {
    cwd,
    env: { ...env, ...environment },
    windowsHide: true,
    stdio: [windows ? 'pipe' : 'ignore', 'pipe', 'pipe'],
  };
  const child = windows ? spawn(binary, args, options) : supervisor.spawn(binary, args, options);
  if (windows) {
    child.stdin.on('error', () => {});
    child.stdin.end(script);
  }
  const stop = () => {
    if (windows) child.kill();
    else void supervisor.close();
  };
  const timer = setTimeout(stop, 120000);
  signal.addEventListener('abort', stop, { once: true });
  try {
    return await new Promise((ok, fail) => {
      const chunks = [];
      let length = 0,
        truncated = false;
      const collect = (chunk) => {
        const space = 1024 * 1024 - length;
        if (chunk.length > space) truncated = true;
        if (space > 0) {
          const piece = chunk.subarray(0, space);
          chunks.push(piece);
          length += piece.length;
        }
      };
      child.stdout.on('data', collect);
      child.stderr.on('data', collect);
      child.once('error', () => fail(new Error('本机命令进程无法启动。')));
      child.once('close', (code, reason) =>
        ok({ output: Buffer.concat(chunks).toString(), code, signal: reason, truncated }),
      );
    });
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', stop);
    if (!windows) await supervisor.close();
  }
}
