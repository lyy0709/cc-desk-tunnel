const { execFile } = require('node:child_process');
const { lstat, readFile, readlink, stat } = require('node:fs/promises');
const path = require('node:path');
const { isUtf8 } = require('node:buffer');
const { gitBranch } = require('./git-branch.cjs');

const previewBytes = 1024 * 1024;
const previewLines = 10000;

// Viewing a repository never runs its external diff, text conversions or filesystem monitor.
function git(directory, args, maxBuffer = 8 * previewBytes, config = []) {
  const env = { ...process.env, LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0' };
  const count = Number(env.GIT_CONFIG_COUNT ?? 0);
  config.forEach(([key, value], index) => {
    env[`GIT_CONFIG_KEY_${count + index}`] = key;
    env[`GIT_CONFIG_VALUE_${count + index}`] = value;
  });
  env.GIT_CONFIG_COUNT = String(count + config.length);
  return new Promise((resolve, reject) => {
    execFile(
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
  if (scope !== 'unstaged' && scope !== 'staged') throw new Error('未知的改动范围。');
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

function statistics(output) {
  const records = output.split('\0');
  const result = new Map();
  for (let i = 0; i < records.length; i++) {
    const match = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(records[i]);
    if (!match) continue;
    let name = match[3];
    if (!name) {
      i++; // A rename carries its old and new names as separate NUL-delimited records.
      name = records[++i];
    }
    result.set(name, {
      added: match[1] === '-' ? null : Number(match[1]),
      removed: match[2] === '-' ? null : Number(match[2]),
    });
  }
  return result;
}

async function gitChanges(directory, scope) {
  checkScope(scope);
  const root = await repository(directory);
  const filters = await filterOverrides(root);
  const [status, numbers, branch] = await Promise.all([
    git(
      root,
      ['status', '--porcelain=v2', '-z', '--untracked-files=all', '--ignore-submodules=none'],
      undefined,
      filters,
    ),
    git(root, [...diffArgs(scope), '--numstat', '-z'], undefined, filters),
    gitBranch(root),
  ]);
  const all = entries(status, root);
  const stats = statistics(numbers);
  return {
    root,
    branch,
    ...(filters.length ? { rawContent: true } : {}),
    counts: {
      unstaged: all.filter((file) => file.unstaged).length,
      staged: all.filter((file) => file.staged).length,
    },
    files: await Promise.all(
      all
        .filter((file) => file[scope])
        .map(async ({ unstaged, staged, ...file }) => {
          const status =
            file.kind === 'conflict'
              ? 'U'
              : file.status === '?'
                ? '?'
                : file.status[scope === 'staged' ? 0 : 1];
          if (status === '?' && (await lstat(file.absolutePath)).isSymbolicLink())
            file.kind = 'symlink';
          const number = ['conflict', 'submodule'].includes(file.kind)
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
    ),
  };
}

async function gitDiff(directory, scope, name) {
  const changes = await gitChanges(directory, scope);
  const file = changes.files.find((entry) => entry.path === name);
  if (!file) throw new Error('这个文件的改动已变化，请刷新列表。');
  if (['binary', 'submodule', 'conflict'].includes(file.kind))
    return { kind: file.kind, patch: '' };
  let patch;
  if (file.status === '?') {
    const found = await lstat(file.absolutePath);
    let content;
    if (found.isSymbolicLink()) content = await readlink(file.absolutePath);
    else {
      if (!found.isFile()) throw new Error('这个路径不是可预览的文件。');
      if (found.size > previewBytes) return { kind: 'too_large', patch: '' };
      const bytes = await readFile(file.absolutePath);
      if (bytes.includes(0) || !isUtf8(bytes)) return { kind: 'binary', patch: '' };
      content = bytes.toString('utf8');
    }
    const lines = content ? content.replace(/\n$/, '').split('\n') : [];
    if (lines.length > previewLines || Buffer.byteLength(content) > previewBytes)
      return { kind: 'too_large', patch: '' };
    patch = lines.length
      ? `@@ -0,0 +1,${lines.length} @@\n${lines.map((line) => `+${line}`).join('\n')}\n${content.endsWith('\n') ? '' : '\\ No newline at end of file\n'}`
      : '';
  } else {
    try {
      patch = await git(
        changes.root,
        [
          ...diffArgs(scope),
          '--no-color',
          '--unified=3',
          '--',
          ...new Set(
            [['R', 'C'].includes(file.status) && file.previousPath, file.path].filter(Boolean),
          ),
        ],
        previewBytes,
        await filterOverrides(changes.root),
      );
    } catch (error) {
      if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER')
        return { kind: 'too_large', patch: '' };
      throw error;
    }
  }
  if (Buffer.byteLength(patch) > previewBytes || patch.split('\n').length > previewLines)
    return { kind: 'too_large', patch: '' };
  return { kind: /^(?:Binary files |GIT binary patch)/m.test(patch) ? 'binary' : 'text', patch };
}

module.exports = { gitChanges, gitDiff, repository, previewBytes, previewLines };
