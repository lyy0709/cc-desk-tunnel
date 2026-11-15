import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ChevronDown, GitBranch, MoreHorizontal, RefreshCw, WrapText, X } from 'lucide-react';
import { IconButton, Menu, Modal } from './ui.tsx';
import type { MenuItem, MenuPosition } from './ui.tsx';

export type GitScope = 'unstaged' | 'staged';
export type GitFile = {
  path: string;
  absolutePath: string;
  previousPath?: string;
  status: string;
  kind: 'file' | 'binary' | 'symlink' | 'submodule' | 'conflict';
  added: number | null;
  removed: number | null;
};
export type GitChanges = {
  root: string;
  branch: string | null;
  counts: Record<GitScope, number>;
  files: GitFile[];
};
export type GitDiff = {
  kind: 'text' | 'binary' | 'submodule' | 'conflict' | 'too_large';
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
};
const unavailable: Record<Exclude<GitDiff['kind'], 'text'>, string> = {
  binary: '二进制或非 UTF-8 文件，无法预览文本差异。',
  submodule: '子模块发生改动，请在本机打开子模块查看。',
  conflict: '存在未解决的合并冲突，请在本机编辑器中查看。',
  too_large: '改动超过 1 MiB 或 10,000 行，请在本机编辑器中查看。',
};

function DiffContent({ diff, open }: { diff: GitDiff; open: (line?: number) => void }) {
  if (diff.kind !== 'text') return <p className="changes-note">{unavailable[diff.kind]}</p>;
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
            aria-label={after ? `在编辑器中打开第 ${after} 行` : '在编辑器中打开文件'}
            title={after ? `在编辑器中打开第 ${after} 行` : '在编辑器中打开文件'}
            onClick={() => open(after)}
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
  expanded,
  toggle,
}: {
  file: GitFile;
  directory: string;
  scope: GitScope;
  revision: number;
  expanded: boolean;
  toggle: () => void;
}) {
  const [diff, setDiff] = useState<GitDiff | null>(null);
  const [failure, setFailure] = useState('');
  const [loading, setLoading] = useState(false);
  const [menu, setMenu] = useState<(MenuPosition & { items: MenuItem[] }) | null>(null);
  useEffect(() => {
    if (!expanded) return;
    let current = true;
    setLoading(true);
    setFailure('');
    window
      .desktop!.gitDiff(directory, scope, file.path)
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
  }, [directory, scope, file.path, revision, expanded]);
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
          {file.status === 'D' && <p className="changes-note">文件已删除，无法在编辑器中打开。</p>}
          {loading && !diff && (
            <p className="changes-note" role="status">
              正在读取改动…
            </p>
          )}
          {failure && (
            <p className="changes-note error-text" role="alert">
              {failure}
            </p>
          )}
          {diff && (
            <DiffContent
              diff={diff}
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
}: {
  directory: string;
  scope: GitScope;
  changeScope: (scope: GitScope) => void;
  running: boolean;
}) {
  const [data, setData] = useState<GitChanges | null>(null);
  const [failure, setFailure] = useState('');
  const [loading, setLoading] = useState(false);
  const [revision, setRevision] = useState(0);
  const [expanded, setExpanded] = useState<Set<string> | null>(null);
  const [wrap, setWrap] = useState(true);
  const generation = useRef(0);
  const refresh = useCallback(async () => {
    const request = ++generation.current;
    setLoading(true);
    setFailure('');
    try {
      const result = await window.desktop!.gitChanges(directory, scope);
      if (request !== generation.current) return;
      setData(result);
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
  }, [directory, scope]);
  useEffect(() => {
    void refresh();
    const focus = () => {
      void refresh();
    };
    window.addEventListener('focus', focus);
    return () => {
      generation.current++;
      window.removeEventListener('focus', focus);
    };
  }, [refresh]);
  const wasRunning = useRef(running);
  useEffect(() => {
    if (wasRunning.current && !running) void refresh();
    wasRunning.current = running;
  }, [running, refresh]);
  return (
    <>
      <div className="changes-summary">
        <strong>{data?.root.split(/[\\/]/).at(-1) ?? '当前仓库改动'}</strong>
        {data?.branch && (
          <span>
            <GitBranch />
            {data.branch}
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
        <IconButton title="刷新改动" disabled={loading} onClick={() => void refresh()}>
          <RefreshCw className={loading ? 'spinning' : ''} />
        </IconButton>
      </div>
      <p className="changes-root" title={data?.root ?? directory}>
        {data?.root ?? directory}
      </p>
      <div className="changes-tabs" role="tablist" aria-label="改动范围">
        {(['unstaged', 'staged'] as const).map((value) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={scope === value}
            onClick={() => changeScope(value)}
          >
            {value === 'unstaged' ? '未暂存' : '已暂存'}
            {data && <small>{data.counts[value]}</small>}
          </button>
        ))}
      </div>
      <div
        className={`changes-files${wrap ? ' wrap' : ''}`}
        role="tabpanel"
        aria-label={scope === 'unstaged' ? '未暂存改动' : '已暂存改动'}
      >
        {failure && (
          <p className="changes-note error-text" role="alert">
            {failure}
            {data && ' 当前显示上次读取的内容。'}
          </p>
        )}
        {loading && !data && (
          <p className="changes-note" role="status">
            正在读取本机仓库…
          </p>
        )}
        {data && !data.files.length && (
          <p className="changes-note">
            {scope === 'unstaged' ? '没有未暂存的改动。' : '没有已暂存的改动。'}
          </p>
        )}
        {data?.files.map((file) => (
          <FileChange
            key={file.path}
            file={file}
            directory={directory}
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
      <p className="changes-footnote">当前仓库的未提交改动，包含你和 Claude 的修改。</p>
    </>
  );
}

export default function ChangesPanel({
  directory,
  workspace,
  running,
  close,
}: {
  directory: string;
  workspace: HTMLElement;
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
  const body = (
    <ChangesView
      key={scope}
      directory={directory}
      scope={scope}
      changeScope={setScope}
      running={running}
    />
  );
  return compact ? (
    <Modal title="当前仓库改动" onClose={close}>
      <div className="changes-dialog">{body}</div>
    </Modal>
  ) : (
    <aside className="changes-panel" aria-label="当前仓库改动">
      <header className="changes-heading">
        <strong>当前仓库改动</strong>
        <IconButton title="关闭改动面板" onClick={close}>
          <X />
        </IconButton>
      </header>
      {body}
    </aside>
  );
}
