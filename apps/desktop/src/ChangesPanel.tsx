import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { diffWordsWithSpace, parsePatch, type Change } from 'diff';
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Folder,
  FolderTree,
  Maximize2,
  Minimize2,
  GitBranch,
  MoreHorizontal,
  RefreshCw,
  WrapText,
  X,
} from 'lucide-react';
import { IconButton, Menu, Modal } from './ui.tsx';
import type { MenuItem, MenuPosition } from './ui.tsx';
import type { TurnReview } from './turnChanges.ts';

export type GitScope = 'uncommitted' | 'unstaged' | 'staged';
export type ChangedFile = {
  path: string;
  absolutePath: string;
  previousPath?: string;
  workingTreeChanged?: boolean;
  status: string;
  kind:
    | 'file'
    | 'binary'
    | 'symlink'
    | 'submodule'
    | 'conflict'
    | 'too_large'
    | 'unreadable'
    | 'unsupported';
  added: number | null;
  removed: number | null;
};
export type Changes = {
  root: string;
  branch: string | null;
  rawContent?: boolean;
  counts?: Record<'unstaged' | 'staged', number>;
  baselineAt?: string;
  notice?: string;
  finished?: boolean;
  files: ChangedFile[];
};
export type FileDiff = {
  kind: 'text' | 'binary' | 'submodule' | 'conflict' | 'too_large' | 'unreadable' | 'unsupported';
  message?: string;
  patch: string;
};

const statusNames: Record<string, string> = {
  A: '新增',
  M: '修改',
  D: '删除',
  R: '重命名',
  C: '复制',
  U: '冲突',
  '?': '未跟踪',
  T: '类型变化',
  '!': '无法读取',
};
const unavailable: Record<Exclude<FileDiff['kind'], 'text'>, string> = {
  binary: '二进制或非 UTF-8 文件，无法预览文本差异。',
  submodule: '子模块发生改动，请在本机打开子模块查看。',
  conflict: '存在未解决的合并冲突，请在本机编辑器中查看。',
  too_large: '文件或差异超过预览限制，请在本机编辑器中查看。',
  unreadable: '文件无法读取。',
  unsupported: '此文件类型无法预览。',
};

type DiffLayout = 'auto' | 'unified' | 'split';
type DiffLine = {
  kind: 'added' | 'removed' | 'context';
  text: string;
  before?: number;
  after?: number;
  noNewline?: boolean;
  words?: Change[];
};

function parseDiff(patch: string) {
  const sections = parsePatch(patch);
  const changes = sections.reduce(
    (total, section) =>
      total +
      section.hunks.reduce(
        (sum, hunk) => sum + hunk.lines.filter((line) => line[0] === '+' || line[0] === '-').length,
        0,
      ),
    0,
  );
  const wordDiffDeadline = Date.now() + 32;
  return sections.map(({ oldMode, newMode, hunks }) => {
    let nextOld = 1;
    let nextNew = 1;
    return {
      modeChanged: oldMode && newMode && oldMode !== newMode ? `${oldMode} → ${newMode}` : null,
      hunks: hunks.map((hunk) => {
        let oldLine = hunk.oldStart;
        let newLine = hunk.newStart;
        const skipped = Math.max(0, Math.min(oldLine - nextOld, newLine - nextNew));
        const lines: DiffLine[] = [];
        const pairs: [DiffLine | undefined, DiffLine | undefined][] = [];
        let removed: DiffLine[] = [];
        let added: DiffLine[] = [];
        // Keep unchanged lines aligned and pair replacements within each change block.
        function flush() {
          for (let i = 0; i < Math.max(removed.length, added.length); i++) {
            const before = removed[i];
            const after = added[i];
            const timeout = wordDiffDeadline - Date.now();
            if (
              before &&
              after &&
              changes <= 2000 &&
              timeout > 0 &&
              Math.max(before.text.length, after.text.length) <= 1000
            ) {
              const words = diffWordsWithSpace(before.text, after.text, { timeout });
              if (words?.some((part) => !part.added && !part.removed && part.value.trim())) {
                before.words = words.filter((part) => !part.added);
                after.words = words.filter((part) => !part.removed);
              }
            }
            pairs.push([before, after]);
          }
          removed = [];
          added = [];
        }
        for (const raw of hunk.lines) {
          if (raw.startsWith('\\')) {
            const previous = lines.at(-1);
            if (previous) previous.noNewline = true;
            continue;
          }
          const kind = raw[0] === '+' ? 'added' : raw[0] === '-' ? 'removed' : 'context';
          const line: DiffLine = {
            kind,
            text: raw.slice(1),
            before: kind === 'added' ? undefined : oldLine++,
            after: kind === 'removed' ? undefined : newLine++,
          };
          lines.push(line);
          if (kind === 'removed') removed.push(line);
          else if (kind === 'added') added.push(line);
          else {
            flush();
            pairs.push([line, line]);
          }
        }
        flush();
        nextOld = oldLine;
        nextNew = newLine;
        return { hunk, lines, pairs, skipped };
      }),
    };
  });
}

function DiffContent({
  diff,
  split,
  wrap,
  open,
  locateLines,
}: {
  diff: FileDiff;
  split: boolean;
  wrap: boolean;
  open?: (line?: number) => void;
  locateLines: boolean;
}) {
  const sections = useMemo(() => {
    try {
      return diff.kind === 'text' ? parseDiff(diff.patch) : [];
    } catch {
      return null;
    }
  }, [diff.kind, diff.patch]);
  if (diff.kind !== 'text')
    return <p className="changes-note">{diff.message ?? unavailable[diff.kind]}</p>;
  if (!sections)
    return (
      <p className="changes-note error-text" role="alert">
        补丁格式有误，无法预览。
      </p>
    );
  if (!sections.some((section) => section.hunks.length || section.modeChanged))
    return <p className="changes-note">没有文本差异。</p>;

  function renderLine(line: DiffLine | undefined, side?: 'old' | 'new', key?: number) {
    if (!line) return <div className="diff-line diff-empty" aria-hidden="true" key={key} />;
    const { kind, text, before, after, noNewline, words } = line;
    const jump = locateLines ? after : undefined;
    const label = jump ? `在编辑器中打开第 ${jump} 行` : '在编辑器中打开文件';
    return (
      <div className={`diff-line ${kind}`} key={key}>
        {side !== 'new' && <span className="diff-number">{before}</span>}
        {side !== 'old' &&
          (after && open ? (
            <button
              className="diff-number"
              type="button"
              title={label}
              aria-label={label}
              onClick={() => open(jump)}
            >
              {after}
            </button>
          ) : (
            <span className="diff-number">{after}</span>
          ))}
        <span className="diff-sign" aria-hidden="true">
          {kind === 'added' ? '+' : kind === 'removed' ? '−' : ''}
        </span>
        <code>
          {words?.map(({ value, added, removed }, index) =>
            added || removed ? <mark key={index}>{value}</mark> : value,
          ) ?? text}
          {noNewline && (
            <span className="diff-eol" title="文件末尾无换行" aria-label="文件末尾无换行">
              ↵
            </span>
          )}
        </code>
      </div>
    );
  }

  const renderSections = (side?: 'old' | 'new') =>
    sections.map(({ hunks, modeChanged }, section) => (
      <div className="diff-section" key={section}>
        {modeChanged && <div className="diff-hunk">文件权限 {modeChanged}</div>}
        {hunks.map(({ hunk, lines, pairs, skipped }, index) => (
          <div className="diff-section" key={index}>
            <div className="diff-hunk">
              <span>
                原 {hunk.oldLines ? hunk.oldStart : '—'} · 新 {hunk.newLines ? hunk.newStart : '—'}
              </span>
              {skipped > 0 && <span>折叠 {skipped} 行上下文</span>}
            </div>
            {split
              ? pairs.map(([before, after], i) =>
                  side ? (
                    renderLine(side === 'old' ? before : after, side, i)
                  ) : (
                    <div className="diff-pair" key={i}>
                      {renderLine(before, 'old')}
                      {renderLine(after, 'new')}
                    </div>
                  ),
                )
              : lines.map((line, i) => renderLine(line, undefined, i))}
          </div>
        ))}
      </div>
    ));

  if (split && !wrap)
    return (
      <div className="diff-panes">
        {(['old', 'new'] as const).map((side) => {
          const title = side === 'old' ? '修改前' : '修改后';
          return (
            <div
              className="diff-scroll"
              role="region"
              aria-label={title + '代码'}
              tabIndex={0}
              key={side}
            >
              <div className="diff-lines diff-pane">
                <div className="diff-sides">
                  <span>{title}</span>
                </div>
                {renderSections(side)}
              </div>
            </div>
          );
        })}
      </div>
    );

  return (
    <div
      className="diff-scroll"
      tabIndex={wrap ? undefined : 0}
      aria-label={wrap ? undefined : '代码差异'}
    >
      <div className={`diff-lines ${split ? 'split' : 'unified'}${wrap ? ' wrap' : ''}`}>
        {split && (
          <div className="diff-sides">
            <span>修改前</span>
            <span>修改后</span>
          </div>
        )}
        {renderSections()}
      </div>
    </div>
  );
}

function FileChange({
  file,
  directory,
  scope,
  revision,
  turnId,
  local,
  expanded,
  toggle,
  split,
  wrap,
}: {
  file: ChangedFile;
  directory: string;
  scope: GitScope;
  revision: number;
  turnId?: string;
  local: boolean;
  expanded: boolean;
  toggle: () => void;
  split: boolean;
  wrap: boolean;
}) {
  const [diff, setDiff] = useState<FileDiff | null>(null);
  const [failure, setFailure] = useState('');
  const [loading, setLoading] = useState(true);
  const [moreContext, setMoreContext] = useState(false);
  const [menu, setMenu] = useState<(MenuPosition & { items: MenuItem[] }) | null>(null);
  useEffect(() => {
    if (!expanded) return;
    let current = true;
    setLoading(true);
    setFailure('');
    const api = window.desktop!;
    const request = turnId
      ? api.turnDiff(turnId, file.path)
      : local
        ? api.projectDiff(directory, file.path)
        : api.gitDiff(directory, scope, file.path, moreContext);
    request
      .then(
        (value) => {
          if (!current) return;
          if (moreContext && value.kind === 'too_large') setFailure('额外上下文超出预览限制。');
          else setDiff(value);
        },
        (error: Error) => {
          if (current) setFailure(error.message);
        },
      )
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => {
      current = false;
    };
  }, [directory, scope, file.path, revision, local, turnId, moreContext, expanded]);
  async function open(line?: number) {
    try {
      const info = await window.desktop!.inspectPath(file.absolutePath);
      if (info.kind === 'missing') {
        setFailure('文件已删除，本机无法打开。');
        return;
      }
      const editor = info.editors[0];
      const result = await window.desktop!.actOnPath(
        editor ? 'editor' : 'reveal',
        file.absolutePath,
        { line, editor: editor?.scheme },
      );
      if (result) setFailure(result);
    } catch (error) {
      setFailure(error instanceof Error ? error.message : '没能打开文件。');
    }
  }
  async function editors(position: MenuPosition) {
    try {
      const info = await window.desktop!.inspectPath(file.absolutePath);
      setMenu({
        ...position,
        items: [
          ...(info.kind === 'missing' ? [] : [{ label: '在本机打开文件', run: () => void open() }]),
          ...info.editors.map((editor) => ({
            label: `在 ${editor.name} 中打开`,
            run: () => {
              void window
                .desktop!.actOnPath('editor', file.absolutePath, { editor: editor.scheme })
                .then(
                  (message) => message && setFailure(message),
                  (error: Error) => setFailure(error.message),
                );
            },
          })),
          {
            label: '复制路径',
            run: () => {
              void window
                .desktop!.copyText(file.absolutePath)
                .catch((error: Error) => setFailure(error.message));
            },
          },
        ],
      });
    } catch (error) {
      setFailure(error instanceof Error ? error.message : '无法读取编辑器列表。');
    }
  }
  const slash = file.path.lastIndexOf('/');
  const canExpandContext =
    !local &&
    !turnId &&
    (moreContext ||
      (['M', 'R', 'C'].includes(file.status) &&
        file.kind === 'file' &&
        diff?.kind === 'text' &&
        /^@@ /m.test(diff.patch)));
  return (
    <section className="change-file" aria-label={file.path} data-path={file.path}>
      <header>
        <button
          type="button"
          className="change-path"
          title={file.previousPath ? `${file.previousPath} → ${file.path}` : file.absolutePath}
          aria-expanded={expanded}
          aria-label={`${expanded ? '收起' : '展开'} ${file.path}`}
          onClick={toggle}
        >
          <ChevronDown aria-hidden="true" />
          <strong>{file.path.slice(slash + 1)}</strong>
          {slash !== -1 && <small>{file.path.slice(0, slash)}</small>}
        </button>
        <span className="change-kind">{statusNames[file.status] ?? file.status}</span>
        {file.added !== null && file.removed !== null && (
          <span className="tool-diff">
            <ins>+{file.added}</ins>
            <del>−{file.removed}</del>
          </span>
        )}
        {expanded && canExpandContext && (
          <button
            type="button"
            className="change-context"
            disabled={loading}
            aria-pressed={moreContext}
            title="切换每处改动前后最多 20 行的上下文"
            onClick={() => setMoreContext(!moreContext)}
          >
            更多上下文
          </button>
        )}
        <IconButton
          title={`文件操作 ${file.path}`}
          onClick={(event) => {
            const box = event.currentTarget.getBoundingClientRect();
            void editors({ x: box.right, y: box.bottom });
          }}
        >
          <MoreHorizontal />
        </IconButton>
      </header>
      {expanded && (
        <div aria-busy={loading}>
          {file.previousPath && <p className="changes-note">原路径 {file.previousPath}</p>}
          {file.kind === 'symlink' && <p className="changes-note">符号链接 · 显示链接目标路径</p>}
          {file.workingTreeChanged && (
            <p className="changes-note">存在未暂存修改，点击行号仅打开文件。</p>
          )}
          {failure && (
            <p className="changes-note error-text" role="alert">
              {failure}
              {diff && ' 当前显示上次读取的内容。'}
            </p>
          )}
          {loading && !diff && (
            <p className="changes-note" role="status">
              正在读取改动…
            </p>
          )}
          {diff && (
            <DiffContent
              diff={diff}
              split={split}
              wrap={wrap}
              locateLines={!file.workingTreeChanged}
              open={file.status === 'D' ? undefined : (line) => void open(line)}
            />
          )}
        </div>
      )}
      {menu && <Menu label="文件操作" {...menu} onClose={() => setMenu(null)} />}
    </section>
  );
}

function ChangesView({
  directory,
  scope,
  changeScope,
  running,
  turn,
}: {
  directory: string;
  scope: GitScope;
  changeScope: (scope: GitScope) => void;
  running: boolean;
  turn?: TurnReview;
}) {
  const [loaded, setLoaded] = useState<{ scope: GitScope; changes: Changes } | null>(null);
  const data = loaded?.scope === scope ? loaded.changes : null;
  const counts = loaded?.changes.counts;
  const root = loaded?.changes.root ?? directory;
  const [failure, setFailure] = useState('');
  const [loading, setLoading] = useState(false);
  const [revision, setRevision] = useState(0);
  const [selectedPath, selectPath] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string> | null>(null);
  const [showIndex, setShowIndex] = useState(false);
  const [jump, setJump] = useState<string | null>(null);
  const [layout, setLayout] = useState<DiffLayout>('auto');
  const [wrap, setWrap] = useState(true);
  const [wide, setWide] = useState(false);
  const scroll = useRef<HTMLDivElement>(null);
  const generation = useRef(0);
  useLayoutEffect(() => {
    const node = scroll.current!;
    const observer = new ResizeObserver(() => setWide(node.clientWidth >= 620));
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  useLayoutEffect(() => {
    if (scroll.current) scroll.current.scrollTop = 0;
  }, [scope]);
  useLayoutEffect(() => {
    if (jump === null) return;
    const pane = scroll.current!;
    const section = pane.querySelector<HTMLElement>(`[data-path="${CSS.escape(jump)}"]`);
    if (section) {
      section.querySelector<HTMLButtonElement>('.change-path')?.focus({ preventScroll: true });
      pane.scrollTop += section.getBoundingClientRect().top - pane.getBoundingClientRect().top;
    }
    setJump(null);
  }, [jump]);
  const refresh = useCallback(
    async (reset = false) => {
      const request = ++generation.current;
      setLoading(true);
      setFailure('');
      try {
        const result = turn
          ? await window.desktop!.turnFiles(turn.id)
          : await window.desktop!.projectChanges(directory, scope, reset);
        if (request !== generation.current) return;
        setLoaded({ scope, changes: result });
        selectPath((previous) =>
          result.files.some((file) => file.path === previous)
            ? previous
            : (result.files[0]?.path ?? null),
        );
        setExpanded((previous) => {
          if (!result.files.length) return null;
          if (!previous) return new Set([result.files[0].path]);
          return new Set(
            result.files.filter((file) => previous.has(file.path)).map((file) => file.path),
          );
        });
        setRevision((value) => value + 1);
      } catch (error) {
        if (request === generation.current)
          setFailure(error instanceof Error ? error.message : '读取改动失败。');
      } finally {
        if (request === generation.current) setLoading(false);
      }
    },
    [directory, scope, turn?.id],
  );
  const scan = useCallback(() => {
    if (!turn) void refresh();
    else if (!data?.finished)
      void window
        .desktop!.refreshTurnChanges(turn.id)
        .catch((error: Error) => setFailure(error.message));
  }, [refresh, turn?.id, data?.finished]);
  useEffect(() => {
    void refresh();
    const onChange =
      turn &&
      window.desktop!.onTurnChanges((id) => {
        if (id === turn.id) void refresh();
      });
    return () => {
      onChange?.();
      generation.current++;
    };
  }, [refresh, turn?.id]);
  useEffect(() => {
    window.addEventListener('focus', scan);
    return () => window.removeEventListener('focus', scan);
  }, [scan]);
  const wasRunning = useRef(running);
  useEffect(() => {
    if (!turn && wasRunning.current && !running) void refresh();
    wasRunning.current = running;
  }, [running, refresh]);
  const local = !!data?.baselineAt;
  const files = data?.files ?? [];
  const selectedIndex = files.findIndex((file) => file.path === selectedPath);
  // Keep the number of mounted sections bounded on repositories with many changed paths.
  const singleFile = files.length > 100;
  const visibleFiles = singleFile ? files.slice(selectedIndex, selectedIndex + 1) : files;
  const groups = useMemo(() => {
    const directories = new Map<string, ChangedFile[]>();
    if (showIndex)
      for (const file of files) {
        const slash = file.path.lastIndexOf('/');
        const dir = slash < 0 ? '' : file.path.slice(0, slash);
        const group = directories.get(dir);
        if (group) group.push(file);
        else directories.set(dir, [file]);
      }
    return [...directories].sort(([first], [second]) => first.localeCompare(second));
  }, [files, showIndex]);
  function visit(path: string) {
    selectPath(path);
    setExpanded((current) => new Set(current).add(path));
    setJump(path);
  }
  const totals = files.reduce(
    (sum, file) => ({
      added: sum.added + (file.added ?? 0),
      removed: sum.removed + (file.removed ?? 0),
      uncounted: sum.uncounted + Number(file.added === null),
    }),
    { added: 0, removed: 0, uncounted: 0 },
  );
  return (
    <>
      <div className="changes-summary">
        {(counts || data) && (
          <div className="changes-comparison">
            {counts ? (
              <select
                aria-label="改动范围"
                value={scope}
                onChange={(event) => {
                  selectPath(null);
                  setExpanded(null);
                  changeScope(event.target.value as GitScope);
                }}
              >
                <option value="uncommitted">未提交</option>
                <option value="unstaged">未暂存 ({counts.unstaged})</option>
                <option value="staged">已暂存 ({counts.staged})</option>
              </select>
            ) : (
              <span>{turn ? '本轮' : '项目累计'}</span>
            )}
            {data && (
              <span className="tool-diff" aria-label="增删行数">
                <ins>+{totals.added}</ins>
                <del>−{totals.removed}</del>
              </span>
            )}
          </div>
        )}
        <button
          type="button"
          className="changes-index-toggle"
          aria-label="改动文件列表"
          aria-expanded={showIndex && files.length > 0}
          disabled={!files.length}
          onClick={() => setShowIndex(!showIndex)}
        >
          <FolderTree aria-hidden="true" />
          {files.length} 个文件
        </button>
        <span className="toolbar-space" />
        <select
          className="changes-layout"
          aria-label="对比视图"
          value={layout}
          onChange={(event) => setLayout(event.target.value as DiffLayout)}
        >
          <option value="auto">自动布局</option>
          <option value="unified">行内对比</option>
          <option value="split">并排对比</option>
        </select>
        <button
          type="button"
          className={`icon-button${wrap ? ' active' : ''}`}
          aria-label="长行换行"
          aria-pressed={wrap}
          onClick={() => setWrap(!wrap)}
        >
          <WrapText />
        </button>
        {!data?.finished && (
          <IconButton title="刷新改动" disabled={loading} onClick={scan}>
            <RefreshCw className={loading ? 'spinning' : ''} />
          </IconButton>
        )}
      </div>
      {local && (
        <div className="changes-origin">
          <span>
            {turn && '本轮运行期间的项目目录变化 · '}
            {turn?.joined ? '从接入时开始统计 ' : '起点 '}
            {new Date(data.baselineAt!).toLocaleString('zh-CN', { hour12: false })}
          </span>
          {!turn && (
            <button
              type="button"
              className="button secondary"
              disabled={loading}
              onClick={() => {
                if (window.confirm('将当前文件状态设为新的比较起点？')) void refresh(true);
              }}
            >
              重设起点
            </button>
          )}
        </div>
      )}
      {singleFile && (
        <div className="changes-page">
          <span>
            逐文件审阅 · {selectedIndex + 1} / {files.length}
          </span>
          <IconButton
            title="上一个文件"
            disabled={selectedIndex <= 0}
            onClick={() => visit(files[selectedIndex - 1].path)}
          >
            <ChevronLeft />
          </IconButton>
          <IconButton
            title="下一个文件"
            disabled={selectedIndex >= files.length - 1}
            onClick={() => visit(files[selectedIndex + 1].path)}
          >
            <ChevronRight />
          </IconButton>
        </div>
      )}
      <div className="changes-body">
        {showIndex && files.length > 0 && (
          <nav className="changes-index" aria-label="改动文件目录">
            {groups.map(([dir, items]) => (
              <div key={dir} className={dir ? 'change-directory' : undefined}>
                {dir && (
                  <strong title={dir}>
                    <Folder aria-hidden="true" /> <span>{dir}</span>
                  </strong>
                )}
                {items.map((item) => (
                  <button
                    key={item.path}
                    type="button"
                    title={item.path}
                    aria-label={`定位 ${item.path}`}
                    aria-current={selectedPath === item.path ? 'location' : undefined}
                    onClick={() => visit(item.path)}
                  >
                    <span>{item.path.slice(dir ? dir.length + 1 : 0)}</span>
                    <small aria-label={statusNames[item.status]}>{item.status}</small>
                  </button>
                ))}
              </div>
            ))}
          </nav>
        )}
        <div
          ref={scroll}
          className="changes-files"
          role="region"
          aria-label="改动文件"
          onFocusCapture={(event) => {
            const section = event.target.closest<HTMLElement>('.change-file');
            if (section?.dataset.path) selectPath(section.dataset.path);
          }}
        >
          {data?.rawContent && (
            <p className="changes-note">按原始内容比较，未运行 Git 内容过滤器。</p>
          )}
          {(failure || data?.notice) && (
            <p className="changes-note error-text" role="alert">
              {failure || data?.notice}
              {data && ' 当前显示上次读取的内容。'}
            </p>
          )}
          {loading && !data && (
            <p className="changes-note" role="status">
              正在读取项目改动…
            </p>
          )}
          {data && !data.notice && !files.length && (
            <p className="changes-note">
              {local
                ? '与起点相比没有改动。'
                : scope === 'unstaged'
                  ? '没有未暂存的改动。'
                  : scope === 'staged'
                    ? '没有已暂存的改动。'
                    : '没有未提交的改动。'}
            </p>
          )}
          {visibleFiles.map((file) => (
            <FileChange
              key={`${scope}:${file.path}`}
              file={file}
              directory={local ? root : directory}
              turnId={turn?.id}
              local={local}
              scope={scope}
              revision={revision}
              expanded={expanded?.has(file.path) ?? false}
              toggle={() => {
                selectPath(file.path);
                setExpanded((previous) => {
                  const next = new Set(previous);
                  if (next.has(file.path)) next.delete(file.path);
                  else next.add(file.path);
                  return next;
                });
              }}
              split={
                layout === 'split' || (layout === 'auto' && wide && !!file.added && !!file.removed)
              }
              wrap={wrap}
            />
          ))}
        </div>
      </div>
      <footer className="changes-location">
        {loaded?.changes.branch && (
          <span className="changes-branch" title={loaded.changes.branch}>
            <GitBranch />
            <span>{loaded.changes.branch}</span>
          </span>
        )}
        <span className="changes-root" title={root}>
          {root}
        </span>
        {!!totals.uncounted && <span>{totals.uncounted} 个文件未计行数</span>}
      </footer>
    </>
  );
}

export default function ChangesPanel({
  directory,
  workspace,
  turn,
  running,
  close,
}: {
  directory: string;
  workspace: HTMLElement;
  turn?: TurnReview;
  running: boolean;
  close: () => void;
}) {
  const [scope, setScope] = useState<GitScope>('uncommitted');
  const [enlarged, setEnlarged] = useState(false);
  const [compact, setCompact] = useState(() => workspace.clientWidth < 900);
  useLayoutEffect(() => {
    const observer = new ResizeObserver(() => setCompact(workspace.clientWidth < 900));
    observer.observe(workspace);
    return () => observer.disconnect();
  }, [workspace]);
  useEffect(() => {
    if (compact) return;
    const escape = (event: KeyboardEvent) => {
      if (
        event.key === 'Escape' &&
        !event.defaultPrevented &&
        !document.querySelector('dialog[open]')
      )
        close();
    };
    window.addEventListener('keydown', escape);
    return () => window.removeEventListener('keydown', escape);
  }, [compact, close]);
  useEffect(
    () => () => {
      if (turn) void window.desktop!.releaseTurnChanges(turn.id);
    },
    [turn?.id],
  );
  const title = turn ? '本轮更改' : '项目改动';
  const body = (
    <ChangesView
      key={turn?.id}
      turn={turn}
      directory={directory}
      scope={scope}
      changeScope={setScope}
      running={running}
    />
  );
  return compact ? (
    <Modal title={title} onClose={close}>
      <div className="changes-dialog">{body}</div>
    </Modal>
  ) : (
    <aside className={`changes-panel${enlarged ? ' enlarged' : ''}`} aria-label={title}>
      <header className="changes-heading">
        <strong>{title}</strong>
        <span className="toolbar-space" />
        <IconButton
          title={enlarged ? '恢复面板宽度' : '加宽改动面板'}
          onClick={() => setEnlarged(!enlarged)}
        >
          {enlarged ? <Minimize2 /> : <Maximize2 />}
        </IconButton>
        <IconButton title="关闭改动面板" onClick={close}>
          <X />
        </IconButton>
      </header>
      {body}
    </aside>
  );
}
