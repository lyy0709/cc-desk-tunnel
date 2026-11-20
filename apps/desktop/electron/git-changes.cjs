const { execFile } = require('node:child_process');
const { constants } = require('node:fs');
const { lstat, open, readlink, stat } = require('node:fs/promises');
const path = require('node:path');
const { isUtf8 } = require('node:buffer');
const { structuredPatch, formatPatch, OMIT_HEADERS } = require('diff');
const { gitBranch } = require('./git-branch.cjs');

const previewBytes = 1024 * 1024;
const previewLines = 10000;
const untrackedCountLimit = 200;

// Viewing a repository never runs its external diff, text conversions or filesystem monitor.
function git(directory, args, maxBuffer = 8 * previewBytes, config = [], encoding = 'utf8') {
  const env = { ...process.env, LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0' };
  const count = Number(env.GIT_CONFIG_COUNT ?? 0);
  config.forEach(([key, value], index) => {
    env[`GIT_CONFIG_KEY_${count + index}`] = key;
    env[`GIT_CONFIG_VALUE_${count + index}`] = value;
  });
  env.GIT_CONFIG_COUNT = String(count + config.length);
  return new Promise((resolve, reject) => {
    const child = execFile(
      'git',
      [
        '--no-pager',
        '--no-optional-locks',
        '--literal-pathspecs',
        '-c',
        'core.fsmonitor=false',
        ...args,
      ],
      {
        cwd: directory,
        windowsHide: true,
        timeout: 15000,
        maxBuffer,
        env,
        encoding,
      },
      (error, stdout, stderr) => {
        if (!error) return resolve(stdout);
        if (error.code === 'ENOENT') {
          error.code = 'NO_GIT';
          error.message = '找不到 Git，请先在本机安装 Git 并加入 PATH。';
        } else if (/^fatal: not a git repository(?: |:)/i.test(stderr)) {
          error.code = 'NOT_REPOSITORY';
          error.message = '这个目录不在 Git 仓库中。';
        } else if (error.killed) error.message = '读取 Git 超时，请稍后刷新。';
        else error.message = `读取 Git 失败：${stderr.trim() || error.message}`;
        reject(error);
      },
    );
    child.stdin.end();
  });
}

// Git can execute clean/process filters even for status and diff. Disable those subprocesses only
// for this read; tell the reader that filtered files are compared as raw worktree contents.
async function filterOverrides(root) {
  let output;
  try {
    output = await git(root, [
      'config',
      '--null',
      '--get-regexp',
      '^filter\\..*\\.(clean|process)$',
    ]);
  } catch (error) {
    if (error.code === 1) return []; // No matching configuration.
    throw error;
  }
  const names = new Set(
    output.split('\0').flatMap((entry) => {
      const at = entry.indexOf('\n');
      return at >= 0 && entry.slice(at + 1).trim()
        ? [entry.slice(0, at).replace(/\.(clean|process)$/, '')]
        : [];
    }),
  );
  return [...names].flatMap((name) => [
    [`${name}.clean`, ''],
    [`${name}.process`, ''],
    [`${name}.required`, 'false'],
  ]);
}

function checkScope(scope) {
  if (!['uncommitted', 'unstaged', 'staged'].includes(scope)) throw new Error('未知的改动范围。');
}

async function repository(directory) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory))
    throw new Error('需要本机项目的绝对路径。');
  const found = await stat(directory).catch((error) => {
    if (error.code === 'ENOENT') throw new Error('本机项目目录已不存在。');
    throw error;
  });
  if (!found.isDirectory()) throw new Error('本机项目路径不是目录。');
  return (await git(directory, ['rev-parse', '--show-toplevel'])).replace(/\r?\n$/, '');
}

function entries(output, root) {
  const records = output.split('\0');
  const files = [];
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (!record) continue;
    const type = record[0];
    if (type === '?') {
      const name = record.slice(2);
      files.push({
        path: name,
        absolutePath: path.join(root, name),
        status: '?',
        kind: 'file',
        unstaged: true,
        staged: false,
      });
      continue;
    }
    const fields = record.split(' ');
    const offset = type === '1' ? 8 : type === '2' ? 9 : type === 'u' ? 10 : 0;
    if (!offset) continue;
    const name = fields.slice(offset).join(' ');
    const xy = fields[1];
    const conflict = type === 'u';
    const modes = fields.slice(3, conflict ? 7 : 6);
    files.push({
      path: name,
      absolutePath: path.join(root, name),
      ...(type === '2' ? { previousPath: records[++i] } : {}),
      status: xy,
      kind: conflict
        ? 'conflict'
        : fields[2][0] === 'S'
          ? 'submodule'
          : modes.includes('120000')
            ? 'symlink'
            : 'file',
      unstaged: conflict || xy[1] !== '.',
      staged: !conflict && xy[0] !== '.',
    });
  }
  return files;
}

const diffArgs = (scope) => [
  'diff',
  ...(scope === 'staged' ? ['--cached'] : []),
  '--no-ext-diff',
  '--no-textconv',
  '--ignore-submodules=none',
  '--find-renames',
];

function diffMetadata(output, root) {
  const records = output.split('\0');
  const tracked = new Map();
  const stats = new Map();
  for (let i = 0; i < records.length; i++) {
    const raw = /^:(\d{6}) (\d{6}) ([a-f0-9]+) [a-f0-9]+ ([A-Z])\d*$/.exec(records[i]);
    if (raw) {
      const [, oldMode, newMode, oldObject, status] = raw;
      const rename = status === 'R' || status === 'C';
      const previousPath = rename ? records[++i] : undefined;
      const name = records[++i];
      tracked.set(name, {
        path: name,
        absolutePath: path.join(root, name),
        previousPath,
        status,
        kind: [oldMode, newMode].includes('160000')
          ? 'submodule'
          : [oldMode, newMode].includes('120000')
            ? 'symlink'
            : 'file',
        oldObject,
        oldMode,
      });
      continue;
    }
    const match = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(records[i]);
    if (!match) continue;
    let name = match[3];
    if (!name) {
      i++; // A rename carries its old and new names as separate NUL-delimited records.
      name = records[++i];
    }
    stats.set(name, {
      added: match[1] === '-' ? null : Number(match[1]),
      removed: match[2] === '-' ? null : Number(match[2]),
    });
  }
  return { tracked, stats };
}

async function comparisonBase(root) {
  try {
    return (await git(root, ['rev-parse', '--verify', '--quiet', 'HEAD'])).trim();
  } catch (error) {
    if (error.code !== 1) throw error;
    // Use the repository's object format and leave the object store untouched.
    return (await git(root, ['hash-object', '-t', 'tree', '--stdin'])).trim();
  }
}

async function gitFileList(directory, scope) {
  checkScope(scope);
  const root = await repository(directory);
  const filters = await filterOverrides(root);
  const args = diffArgs(scope);
  if (scope === 'uncommitted') args.push(await comparisonBase(root));
  const [status, numbers, branch] = await Promise.all([
    git(
      root,
      ['status', '--porcelain=v2', '-z', '--untracked-files=all', '--ignore-submodules=none'],
      undefined,
      filters,
    ),
    git(
      root,
      [
        ...args,
        ...(scope === 'uncommitted' ? ['--raw', '--no-abbrev'] : []),
        '--numstat',
        '-z',
        '--',
      ],
      undefined,
      filters,
    ),
    gitBranch(root),
  ]);
  const all = entries(status, root);
  const { tracked, stats } = diffMetadata(numbers, root);
  const conflicts = new Map(
    all.filter((file) => file.kind === 'conflict').map((file) => [file.path, file]),
  );
  const untracked = new Map(
    all.filter((file) => file.status === '?').map((file) => [file.path, file]),
  );
  const scoped =
    scope === 'uncommitted'
      ? [
          ...[...tracked.values()].filter(
            (file) => !conflicts.has(file.path) && !untracked.has(file.path),
          ),
          ...conflicts.values(),
          ...untracked.values(),
        ]
      : all.filter((file) => file[scope]);
  return {
    root,
    branch,
    args,
    filters,
    tracked,
    counts: {
      unstaged: all.filter((file) => file.unstaged).length,
      staged: all.filter((file) => file.staged).length,
    },
    files: scoped.map(({ unstaged, staged, oldObject, oldMode, ...file }) => {
      const status =
        file.kind === 'conflict'
          ? 'U'
          : file.status === '?' || scope === 'uncommitted'
            ? file.status
            : file.status[scope === 'staged' ? 0 : 1];
      const number =
        status === '?' || ['conflict', 'submodule'].includes(file.kind)
          ? undefined
          : stats.get(file.path);
      return {
        ...file,
        status,
        ...(scope === 'staged' && unstaged ? { workingTreeChanged: true } : {}),
        added: number?.added ?? null,
        removed: number?.removed ?? null,
        kind: file.kind === 'file' && number?.added === null ? 'binary' : file.kind,
      };
    }),
  };
}

async function untrackedDiff(file, changes, context) {
  // A staged deletion can leave a new worktree file at the same path.
  const base = changes.tracked.get(file.path);
  if (base?.kind === 'submodule') return { kind: 'submodule', patch: '' };
  try {
    const found = await lstat(file.absolutePath);
    const symlink = found.isSymbolicLink();
    const status = !base ? '?' : symlink === (base.oldMode === '120000') ? 'M' : 'T';
    let bytes;
    if (symlink) bytes = await readlink(file.absolutePath, { encoding: 'buffer' });
    else {
      if (!found.isFile()) return { kind: 'unsupported', patch: '' };
      if (found.size > previewBytes) return { kind: 'too_large', patch: '' };
      const handle = await open(
        file.absolutePath,
        constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0),
      );
      try {
        const current = await handle.stat();
        if (!current.isFile() || current.ino !== found.ino || current.dev !== found.dev)
          throw new Error('读取时路径已变化，请刷新。');
        if (current.size > previewBytes) return { kind: 'too_large', patch: '' };
        const buffer = Buffer.allocUnsafe(current.size + 1);
        let size = 0;
        while (size < buffer.length) {
          const { bytesRead } = await handle.read(buffer, size, buffer.length - size);
          if (!bytesRead) break;
          size += bytesRead;
        }
        if (size !== current.size) throw new Error('读取时文件长度已变化，请刷新。');
        bytes = buffer.subarray(0, size);
      } finally {
        await handle.close();
      }
    }
    const before = base
      ? await git(changes.root, ['cat-file', 'blob', base.oldObject], previewBytes, [], 'buffer')
      : Buffer.alloc(0);
    if (
      base &&
      status === 'M' &&
      before.equals(bytes) &&
      (symlink || (base.oldMode === '100755') === Boolean(found.mode & 0o100))
    )
      return null;
    if ([before, bytes].some((value) => value.includes(0) || !isUtf8(value)))
      return { kind: 'binary', patch: '' };
    const diff = structuredPatch(
      file.path,
      file.path,
      before.toString('utf8'),
      bytes.toString('utf8'),
      undefined,
      undefined,
      { context, timeout: 80 },
    );
    const patch = diff?.hunks.length ? formatPatch(diff, OMIT_HEADERS) : '';
    if (!diff || Buffer.byteLength(patch) > previewBytes || patch.split('\n').length > previewLines)
      return { kind: 'too_large', patch: '' };
    let added = 0;
    let removed = 0;
    for (const hunk of diff.hunks)
      for (const line of hunk.lines) {
        if (line[0] === '+') added++;
        if (line[0] === '-') removed++;
      }
    return { kind: 'text', patch, added, removed, status, symlink };
  } catch (error) {
    if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return { kind: 'too_large', patch: '' };
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
    return { kind: 'unreadable', patch: '', message: error.message };
  }
}

async function gitChanges(directory, scope) {
  const changes = await gitFileList(directory, scope);
  const { root, branch, counts, filters } = changes;
  const files = [];
  let untracked = 0;
  for (const file of changes.files) {
    if (
      file.status !== '?' ||
      (untracked++ >= untrackedCountLimit && !changes.tracked.has(file.path))
    ) {
      files.push(file);
      continue;
    }
    const preview = await untrackedDiff(file, changes, 3);
    if (!preview) continue;
    const { kind, added = null, removed = null, status = file.status, symlink } = preview;
    files.push({
      ...file,
      added,
      removed,
      status,
      kind: kind === 'text' ? (symlink ? 'symlink' : 'file') : kind,
    });
  }
  return { root, branch, counts, ...(filters.length ? { rawContent: true } : {}), files };
}

async function gitDiff(directory, scope, name, moreContext) {
  const changes = await gitFileList(directory, scope);
  const file = changes.files.find((entry) => entry.path === name);
  const changed = () => new Error('这个文件的改动已变化，请刷新列表。');
  if (!file) throw changed();
  if (['binary', 'submodule', 'conflict'].includes(file.kind))
    return { kind: file.kind, patch: '' };
  const context = moreContext === true ? 20 : 3;
  if (file.status === '?') {
    const preview = await untrackedDiff(file, changes, context);
    if (!preview) throw changed();
    const { kind, patch, message } = preview;
    return { kind, patch, ...(message ? { message } : {}) };
  }
  let patch;
  try {
    patch = await git(
      changes.root,
      [
        ...changes.args,
        '--no-color',
        `--unified=${context}`,
        '--',
        ...new Set(
          [['R', 'C'].includes(file.status) && file.previousPath, file.path].filter(Boolean),
        ),
      ],
      previewBytes,
      changes.filters,
    );
  } catch (error) {
    if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return { kind: 'too_large', patch: '' };
    throw error;
  }
  if (Buffer.byteLength(patch) > previewBytes || patch.split('\n').length > previewLines)
    return { kind: 'too_large', patch: '' };
  return { kind: /^(?:Binary files |GIT binary patch)/m.test(patch) ? 'binary' : 'text', patch };
}

module.exports = { gitChanges, gitDiff, repository, previewBytes, previewLines };
