const path = require('node:path');
const { constants, watch } = require('node:fs');
const fs = require('node:fs/promises');
const { createHash, randomUUID } = require('node:crypto');
const { isUtf8 } = require('node:buffer');
const { DatabaseSync } = require('node:sqlite');
const ignore = require('ignore');
const { structuredPatch, formatPatch, OMIT_HEADERS } = require('diff');
const { gitChanges, repository, previewBytes, previewLines } = require('./git-changes.cjs');

const within = (name, dir) => name === dir || name.startsWith(dir + '/');
const missing = (error) => error.code === 'ENOENT' || error.code === 'ENOTDIR';
const withoutGit = (error) => error.code === 'NO_GIT' || error.code === 'NOT_REPOSITORY';
const unreadable = (error) => ({ kind: 'unreadable', value: error.message });
const stampOf = (s) => [s.dev, s.ino, s.mode, s.size, s.mtimeNs, s.ctimeNs].join(':');

async function content(file, stat) {
  if (stat.isSymbolicLink()) return { kind: 'symlink', value: await fs.readlink(file) };
  if (!stat.isFile()) return { kind: 'unsupported', value: '' };
  const handle = await fs.open(
    file,
    constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0),
  );
  try {
    const opened = await handle.stat({ bigint: true });
    if (
      !opened.isFile() ||
      opened.ino !== stat.ino ||
      opened.dev !== stat.dev ||
      (await fs.realpath(file)) !== file
    )
      throw new Error('读取时路径已变化，请刷新。');
    // Also bounds a file that grows after stat. Only previewable text is stored verbatim.
    const parts = [];
    let length = 0;
    const identity = createHash('sha256');
    for await (const part of handle.createReadStream({ autoClose: false })) {
      identity.update(part);
      length += part.length;
      if (length <= previewBytes) parts.push(part);
    }
    let kind = 'too_large';
    if (length <= previewBytes) {
      const bytes = Buffer.concat(parts);
      if (isUtf8(bytes) && !bytes.includes(0)) {
        const value = bytes.toString('utf8');
        if (
          (value.match(/\n/g)?.length ?? 0) + Number(!!value && !value.endsWith('\n')) <=
          previewLines
        )
          return { kind: 'file', value };
      } else kind = 'binary';
    }
    return { kind, value: identity.digest('hex') };
  } finally {
    await handle.close();
  }
}

// Walk only branches containing a notified path. A full scan also reconciles missed notifications.
async function walk(root, excluded, paths, visit) {
  const covers = (name) => !paths || paths.some((p) => within(name, p));
  const rules = new Map();
  const blocked = new Set();
  function ignored(name, directory) {
    let prefix = '';
    let excludedByRule = false;
    for (const segment of name.split('/')) {
      const rule = rules.get(prefix);
      if (rule) {
        const match = rule.test(name.slice(prefix.length) + (directory ? '/' : ''));
        if (match.ignored || match.unignored) excludedByRule = match.ignored;
      }
      prefix += segment + '/';
    }
    return excludedByRule;
  }
  async function directory(rel) {
    const full = path.join(root, rel);
    let entries;
    try {
      if ((await fs.realpath(full)) !== full) throw new Error('扫描时目录已变化，请刷新。');
      entries = await fs.readdir(full, { withFileTypes: true });
      if (entries.some((entry) => entry.name === '.gitignore' && entry.isFile())) {
        const file = path.join(full, '.gitignore');
        const rule = await fs
          .lstat(file, { bigint: true })
          .then((stat) => stat.isFile() && content(file, stat))
          .catch((error) => {
            if (!missing(error)) throw error;
          });
        if (rule) {
          if (rule.kind !== 'file') throw new Error('无法读取 .gitignore 规则。');
          rules.set(
            rel ? rel + '/' : '',
            ignore({ ignorecase: process.platform === 'win32' }).add(rule.value),
          );
        }
      }
    } catch (error) {
      if (!rel) throw error;
      if (!missing(error)) {
        blocked.add(rel);
        await visit(rel, '', () => unreadable(error));
      }
      return;
    }
    for (const entry of entries) {
      const name = rel ? rel + '/' + entry.name : entry.name;
      if (!covers(name) && !paths.some((p) => within(p, name))) continue;
      const file = path.join(root, name);
      if (
        ['.git', 'node_modules'].includes(entry.name.toLowerCase()) ||
        file === excluded ||
        ignored(name, entry.isDirectory())
      ) {
        blocked.add(name);
        continue;
      }
      let stat;
      try {
        stat = await fs.lstat(file, { bigint: true });
      } catch (error) {
        if (missing(error)) continue;
        blocked.add(name);
        await visit(name, '', () => unreadable(error));
        continue;
      }
      if (stat.isDirectory()) await directory(name);
      else if (covers(name))
        await visit(name, stampOf(stat), async () => {
          try {
            return await content(file, stat);
          } catch (error) {
            return missing(error) ? null : unreadable(error);
          }
        });
    }
  }
  await directory('');
  return {
    covers,
    hidden(name) {
      const parts = name.split('/');
      for (let i = 1; i <= parts.length; i++) {
        const prefix = parts.slice(0, i).join('/');
        if (blocked.has(prefix) || ignored(prefix, i < parts.length)) return true;
      }
      return false;
    },
  };
}

function difference(name, before, after) {
  const failure = [after, before].find((file) => file?.kind === 'unreadable');
  const kind =
    failure?.kind ??
    [before?.kind, after?.kind].find((v) => ['unsupported', 'too_large', 'binary'].includes(v));
  const status =
    kind === 'unreadable'
      ? '!'
      : !before
        ? 'A'
        : !after
          ? 'D'
          : before.kind !== after.kind
            ? 'T'
            : 'M';
  if (kind !== 'unreadable' && before?.kind === after?.kind && before?.value === after?.value)
    return;
  let patch = '',
    added = null,
    removed = null,
    preview = kind;
  if (!preview) {
    const diff = structuredPatch(
      name,
      name,
      before?.value ?? '',
      after?.value ?? '',
      undefined,
      undefined,
      { context: 3, timeout: 80 },
    );
    if (diff) patch = formatPatch(diff, OMIT_HEADERS);
    if (
      !diff ||
      Buffer.byteLength(patch) > previewBytes ||
      patch.split('\n').length > previewLines
    ) {
      preview = 'too_large';
      patch = '';
    } else {
      preview = 'text';
      added = 0;
      removed = 0;
      for (const hunk of diff.hunks)
        for (const line of hunk.lines) {
          if (line[0] === '+') added++;
          if (line[0] === '-') removed++;
        }
    }
  }
  return {
    path: name,
    status,
    kind: after?.kind ?? before.kind,
    added,
    removed,
    diff: {
      kind: preview,
      patch,
      ...(failure ? { message: failure.value } : {}),
    },
  };
}

async function record(db, root, excluded) {
  db.exec(
    'BEGIN; CREATE TABLE files(path TEXT PRIMARY KEY, stamp TEXT, kind TEXT, value TEXT); CREATE TABLE origin(at TEXT)',
  );
  try {
    const put = db.prepare('INSERT INTO files VALUES(?,?,?,?)');
    await walk(root, excluded, null, async (name, stamp, read) => {
      const entry = await read();
      if (entry) put.run(name, entry.kind === 'unreadable' ? '' : stamp, entry.kind, entry.value);
    });
    db.prepare('INSERT INTO origin VALUES(?)').run(new Date().toISOString());
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

class Comparison {
  constructor(db, root, excluded) {
    this.root = root;
    this.excluded = excluded;
    this.db = db;
    this.at = db.prepare('SELECT at FROM origin').get().at;
    this.before = db.prepare('SELECT kind,value FROM files WHERE path=?');
    this.index = new Map(
      db
        .prepare('SELECT path,stamp FROM files')
        .all()
        .map((row) => [row.path, row.stamp]),
    );
    this.current = new Map(this.index);
    this.changed = new Map();
  }
  async scan(paths = null) {
    const seen = new Set();
    const current = new Map(this.current);
    const changed = new Map(this.changed);
    const { covers, hidden } = await walk(
      this.root,
      this.excluded,
      paths,
      async (name, stamp, read) => {
        const unchanged = stamp && current.get(name) === stamp;
        if (unchanged) {
          seen.add(name);
          return;
        }
        const after = await read();
        if (!after) return;
        seen.add(name);
        const item = difference(name, this.before.get(name), after);
        if (item) changed.set(name, item);
        else changed.delete(name);
        current.set(name, after.kind === 'unreadable' ? '' : stamp);
      },
    );
    for (const name of new Set([...this.index.keys(), ...current.keys(), ...changed.keys()])) {
      if (seen.has(name) || !covers(name)) continue;
      current.delete(name);
      if (hidden(name) || !this.index.has(name)) changed.delete(name);
      else if (changed.get(name)?.status !== 'D')
        changed.set(name, difference(name, this.before.get(name), null));
    }
    this.current = current;
    this.changed = changed;
  }
  result() {
    return {
      root: this.root,
      branch: null,
      baselineAt: this.at,
      files: [...this.changed.values()]
        .sort((a, b) => a.path.localeCompare(b.path))
        .map(({ diff, ...file }) => ({ ...file, absolutePath: path.join(this.root, file.path) })),
    };
  }
  diff(name) {
    const item = this.changed.get(name);
    if (!item) throw new Error('文件改动已变化，请刷新列表。');
    return item.diff;
  }
}

async function canonical(directory) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory))
    throw new Error('需要本机项目的绝对路径。');
  const root = await fs.realpath(directory).catch((error) => {
    if (missing(error)) throw new Error('本机项目目录已不存在。');
    throw error;
  });
  if (!(await fs.stat(root)).isDirectory()) throw new Error('本机项目路径不是目录。');
  return root;
}

class ProjectChanges {
  constructor(storage) {
    this.storage = storage;
    this.building = new Map();
    this.preparing = new Map();
    this.request = 0;
  }
  async baseline(root, reset = false) {
    if (!reset && this.building.has(root)) return this.building.get(root);
    const pending = this.saveBaseline(root, reset);
    this.building.set(root, pending);
    try {
      return await pending;
    } finally {
      if (this.building.get(root) === pending) this.building.delete(root);
    }
  }
  async saveBaseline(root, reset) {
    await fs.mkdir(this.storage, { recursive: true, mode: 0o700 });
    const key = process.platform === 'win32' ? root.toLowerCase() : root;
    const file = path.join(this.storage, createHash('sha256').update(key).digest('hex') + '.db');
    if (!reset) {
      try {
        await fs.access(file);
        return file;
      } catch (error) {
        if (!missing(error)) throw error;
      }
    }
    const temp = path.join(this.storage, randomUUID() + '.tmp');
    try {
      const db = new DatabaseSync(temp);
      try {
        await record(db, root, this.storage);
      } finally {
        db.close();
      }
      if (reset) await fs.rename(temp, file);
      else {
        // A second window opening the same folder keeps the first complete baseline.
        try {
          await fs.link(temp, file);
        } catch (error) {
          if (error.code !== 'EEXIST') throw error;
        }
      }
      return file;
    } finally {
      await fs.rm(temp, { force: true });
    }
  }
  prepare(directory) {
    if (this.preparing.has(directory)) return this.preparing.get(directory);
    const pending = repository(directory)
      .then(
        () => undefined,
        async (error) => {
          if (!withoutGit(error)) throw error;
          await this.baseline(await canonical(directory));
        },
      )
      .finally(() => this.preparing.delete(directory));
    this.preparing.set(directory, pending);
    return pending;
  }
  async list(directory, scope, reset = false) {
    const request = ++this.request;
    try {
      return await gitChanges(directory, scope);
    } catch (error) {
      if (!withoutGit(error)) throw error;
    }
    const root = await canonical(directory);
    const file = await this.baseline(root, reset);
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      const comparison = new Comparison(db, root, this.storage);
      await comparison.scan();
      if (request === this.request) this.latest = comparison;
      return comparison.result();
    } finally {
      db.close();
    }
  }
}

class TurnChanges {
  constructor(comparison, notify) {
    this.comparison = comparison;
    this.notify = notify;
    this.queue = Promise.resolve();
    this.pending = new Set();
    const root = comparison.root;
    const poll = () => {
      if (this.ended) return;
      this.watcher?.close();
      this.poll ??= setInterval(() => this.refresh(), 2000);
    };
    try {
      this.watcher = watch(root, { recursive: true }, (_event, filename) => {
        if (this.ended) return;
        const name = filename && filename.split(path.sep).join('/');
        if (name?.split('/').some((part) => ['.git', 'node_modules'].includes(part.toLowerCase())))
          return;
        if (!name || path.basename(name) === '.gitignore') this.full = true;
        else this.pending.add(name);
        this.timer ??= setTimeout(() => this.refresh(false), 150);
      });
      this.watcher.on('error', poll);
    } catch {
      poll();
    }
  }
  static async start(directory, excluded, notify) {
    const root = await canonical(directory);
    const db = new DatabaseSync('');
    try {
      await record(db, root, excluded);
      const turn = new TurnChanges(new Comparison(db, root, excluded), notify);
      turn.refresh(); // Catch changes between enumeration and installing the watcher.
      return turn;
    } catch (error) {
      db.close();
      throw error;
    }
  }
  refresh(full = true) {
    if (this.ended) return this.queue;
    this.full ||= full;
    clearTimeout(this.timer);
    this.timer = null;
    if (this.scheduled) return this.queue;
    this.scheduled = true;
    this.queue = this.queue.then(async () => {
      this.scheduled = false;
      const paths = this.full ? null : [...this.pending];
      this.full = false;
      this.pending.clear();
      try {
        await this.comparison.scan(paths);
        this.error = undefined;
      } catch (error) {
        this.error = error.message;
      }
      this.notify(this);
    });
    return this.queue;
  }
  finish() {
    if (!this.ended) {
      this.watcher?.close();
      clearInterval(this.poll);
      this.refresh();
      this.ended = true;
      this.queue = this.queue.finally(() => this.comparison.db.close());
    }
    return this.queue;
  }
}

module.exports = { ProjectChanges, TurnChanges };
