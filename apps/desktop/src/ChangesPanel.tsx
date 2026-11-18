import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ChevronDown, GitBranch, MoreHorizontal, RefreshCw, WrapText, X } from 'lucide-react';
import { IconButton, Menu, Modal } from './ui.tsx';
import type { MenuItem, MenuPosition } from './ui.tsx';
import type { TurnReview } from './turnChanges.ts';

export type GitScope = 'unstaged' | 'staged';
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
  counts?: Record<GitScope, number>;
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

function DiffContent({
  diff,
  open,
  locateLines,
}: {
  diff: FileDiff;
  open: (line?: number) => void;
  locateLines: boolean;
}) {
  if (diff.kind !== 'text')
    return <p className="changes-note">{diff.message ?? unavailable[diff.kind]}</p>;
  if (!diff.patch) return <p className="changes-note">没有文本差异。</p>;
  let oldLine = 0;
  let newLine = 0;
  let hunk = false;
  const rows = diff.patch
    .replace(/\n$/, '')
    .split('\n')
    .map((text, index) => {
      const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
      if (header) {
        oldLine = Number(header[1]);
        newLine = Number(header[2]);
        hunk = true;
        return (
          <div className="diff-hunk" key={index}>
            {text}
          </div>
        );
      }
      const kind =
        hunk && text[0] === '+'
          ? 'added'
          : hunk && text[0] === '-'
            ? 'removed'
            : hunk && text[0] === ' '
              ? 'context'
              : 'meta';
      const before = kind === 'removed' || kind === 'context' ? oldLine++ : undefined;
      const after = kind === 'added' || kind === 'context' ? newLine++ : undefined;
      return (
        <div className={`diff-line ${kind}`} key={index}>
          <span className="diff-number">{before}</span>
          <button
            type="button"
            className="diff-number"
            disabled={kind === 'meta'}
            aria-label={
              after && locateLines ? `在编辑器中打开第 ${after} 行` : '在编辑器中打开文件'
            }
            title={after && locateLines ? `在编辑器中打开第 ${after} 行` : '在编辑器中打开文件'}
            onClick={() => open(locateLines ? after : undefined)}
          >
            {after ?? (before ? '−' : '')}
          </button>
          <code>{text || ' '}</code>
        </div>
      );
    });
  return <div className="diff-lines">{rows}</div>;
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
}: {
  file: ChangedFile;
  directory: string;
  scope: GitScope;
  revision: number;
  turnId?: string;
  local: boolean;
  expanded: boolean;
  toggle: () => void;
}) {
  const [diff, setDiff] = useState<FileDiff | null>(null);
  const [failure, setFailure] = useState('');
  const [loading, setLoading] = useState(false);
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
        : api.gitDiff(directory, scope, file.path);
    request
      .then(
        (value) => {
          if (current) setDiff(value);
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
  }, [directory, scope, file.path, revision, expanded, local, turnId]);
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
  return (
    <section className="change-file" aria-label={file.path}>
      <header>
        <button
          type="button"
          className="change-expand"
          aria-label={`${expanded ? '收起' : '展开'} ${file.path}`}
          aria-expanded={expanded}
          onClick={toggle}
        >
          <ChevronDown />
        </button>
        <button
          type="button"
          className="change-path"
          title={file.previousPath ? `${file.previousPath} → ${file.path}` : file.absolutePath}
          disabled={file.status === 'D'}
          onClick={() => void open()}
        >
          {file.path}
        </button>
        <span className="change-kind">{statusNames[file.status] ?? file.status}</span>
        {file.added !== null && file.removed !== null && (
          <span className="tool-diff">
            <ins>+{file.added}</ins>
            <del>−{file.removed}</del>
          </span>
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
          {file.previousPath && <p className="changes-note">原路径：{file.previousPath}</p>}
          {file.kind === 'symlink' && <p className="changes-note">符号链接 · 仅展示链接本身</p>}
          {file.workingTreeChanged && (
            <p className="changes-note">存在未暂存修改，点击行号仅打开文件。</p>
          )}
          {file.status === 'D' && <p className="changes-note">文件已删除，无法在编辑器中打开。</p>}
          {loading && !diff && (
            <p className="changes-note" role="status">
              正在读取改动…
            </p>
          )}
          {failure && (
            <p className="changes-note error-text" role="alert">
              {failure}
              {diff && ' 当前显示上次读取的内容。'}
            </p>
          )}
          {diff && (
            <DiffContent
              diff={diff}
              locateLines={!file.workingTreeChanged}
              open={(line) => {
                if (file.status !== 'D') void open(line);
              }}
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
  const [expanded, setExpanded] = useState<Set<string> | null>(null);
  const [wrap, setWrap] = useState(true);
  const generation = useRef(0);
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
        setExpanded(
          (previous) =>
            new Set(
              previous === null
                ? result.files.slice(0, 1).map((file) => file.path)
                : result.files.filter((file) => previous.has(file.path)).map((file) => file.path),
            ),
        );
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
  const totals = data?.files.reduce(
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
                  setExpanded(null);
                  changeScope(event.target.value as GitScope);
                }}
              >
                <option value="unstaged">未暂存 ({counts.unstaged})</option>
                <option value="staged">已暂存 ({counts.staged})</option>
              </select>
            ) : (
              <span>{turn ? '本轮' : '项目累计'}</span>
            )}
            {totals && (
              <span className="tool-diff" aria-label="增删行数">
                <ins>+{totals.added}</ins>
                <del>−{totals.removed}</del>
              </span>
            )}
          </div>
        )}
        {loaded?.changes.branch && (
          <span className="changes-branch" title={loaded.changes.branch}>
            <GitBranch />
            <span>{loaded.changes.branch}</span>
          </span>
        )}
        <span className="toolbar-space" />
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
      <p className="changes-root" title={root}>
        {root}
      </p>
      {(local || !!totals?.uncounted) && (
        <div className="changes-origin">
          {local && (
            <span>
              {turn && '本轮运行期间的项目目录变化 · '}
              {turn?.joined ? '从接入时开始统计 ' : '起点 '}
              {new Date(data.baselineAt!).toLocaleString('zh-CN', { hour12: false })}
            </span>
          )}
          {local && !turn && (
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
          {!!totals?.uncounted && <span>{totals.uncounted} 个文件未计行数</span>}
        </div>
      )}
      <div className={`changes-files${wrap ? ' wrap' : ''}`} role="region" aria-label="改动文件">
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
        {data && !data.notice && !data.files.length && (
          <p className="changes-note">
            {local
              ? '与起点相比没有改动。'
              : scope === 'unstaged'
                ? '没有未暂存的改动。'
                : '没有已暂存的改动。'}
          </p>
        )}
        {data?.files.map((file) => (
          <FileChange
            key={file.path}
            file={file}
            directory={local ? data.root : directory}
            turnId={turn?.id}
            local={local}
            scope={scope}
            revision={revision}
            expanded={expanded?.has(file.path) ?? false}
            toggle={() =>
              setExpanded((current) => {
                const next = new Set(current);
                next.has(file.path) ? next.delete(file.path) : next.add(file.path);
                return next;
              })
            }
          />
        ))}
      </div>
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
  const [scope, setScope] = useState<GitScope>('unstaged');
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
    <aside className="changes-panel" aria-label={title}>
      <header className="changes-heading">
        <strong>{title}</strong>
        <IconButton title="关闭改动面板" onClick={close}>
          <X />
        </IconButton>
      </header>
      {body}
    </aside>
  );
}
