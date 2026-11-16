import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import {
  ArrowUp,
  Activity,
  Files,
  Folder,
  GitBranch,
  ListChecks,
  Play,
  Plus,
  RefreshCw,
  Shrink,
  Square,
  SquareSlash,
} from 'lucide-react';
import type {
  Effort,
  NativeCapabilities,
  NativeMetrics,
  NativeSession,
  PermissionMode,
  Session,
} from '@cc-desk-tunnel/protocol';
import { pathKey } from '@cc-desk-tunnel/protocol';
import type { FileAttachment } from '@cc-desk-tunnel/protocol';
import type { Draft } from './drafts.ts';
import Attachments from './Attachments.tsx';
import { folderName } from './paths.ts';
import { slashCommands } from './commands.ts';
import ComposerControls from './ComposerControls.tsx';
import PermissionMenu from './PermissionMenu.tsx';
import { IconButton } from './ui.tsx';
import type { MenuPosition } from './ui.tsx';

export type Scenario = 'chat' | 'tool' | 'question' | 'error';
// A draft that is only a slash and an optional command name opens the command menu.
const slashDraft = /^[/\\][^ \n]*$/;

// The branch the project's working tree is on, read from the project by the desktop; it is looked at again
// whenever the window comes back to the front or a run ends, the moments it may have changed.
function useBranch(path: string | null, running: boolean) {
  const [branch, setBranch] = useState<{ path: string; value: string | null } | null>(null);
  useEffect(() => {
    if (!window.desktop || !path) return;
    let current = true;
    const read = () =>
      void window.desktop!.gitBranch(path).then(
        (value) => current && setBranch({ path, value }),
        () => current && setBranch(null),
      );
    read();
    window.addEventListener('focus', read);
    return () => {
      current = false;
      window.removeEventListener('focus', read);
    };
  }, [path, running]);
  return branch?.path === path ? branch?.value : null;
}

export default function Composer({
  session,
  projectName,
  chooseProject,
  draft,
  updateDraft,
  deviceId,
  attachmentDeviceId,
  native,
  localProject,
  showChanges,
  localActions,
  modeDisplay,
  connected,
  busy,
  refreshing,
  canRefreshModels,
  ownsRun,
  inputDisabled,
  controlsDisabled,
  slashOpen,
  setSlashOpen,
  scenario,
  setScenario,
  capabilities,
  nativeSession,
  metrics,
  openAccount,
  send,
  resume,
  refresh,
  configure,
  stop,
}: {
  session: Session;
  // Absent for a session that belongs to no project.
  projectName: string | null;
  // Opens the list of projects the session can be moved to; absent while it cannot be moved.
  chooseProject?: (position: MenuPosition) => void;
  draft: Draft;
  updateDraft: (update: (draft: Draft) => Draft) => void;
  deviceId?: string;
  attachmentDeviceId?: string;
  native: boolean;
  localProject: boolean;
  showChanges: () => void;
  localActions: { name: string; title: string; detail: string; reason: string }[];
  modeDisplay: { label: string; detail: string };
  connected: boolean;
  busy: boolean;
  refreshing: boolean;
  canRefreshModels: boolean;
  ownsRun: boolean;
  inputDisabled: boolean;
  controlsDisabled: boolean;
  slashOpen: boolean;
  setSlashOpen: (open: boolean) => void;
  scenario: Scenario;
  setScenario: (scenario: Scenario) => void;
  capabilities: NativeCapabilities | null;
  nativeSession: NativeSession | null;
  metrics: NativeMetrics | null;
  openAccount: () => void;
  // Sends the draft, or the text given instead of it.
  send: (text?: string) => void;
  // Present when the session's last turn was stopped or cut off: takes it up again without a message.
  resume?: () => void;
  refresh: () => void;
  configure: (values: {
    model?: string | null;
    effort?: Effort | null;
    permissionMode?: PermissionMode;
  }) => Promise<void>;
  stop: () => void;
}) {
  const input = useRef<HTMLTextAreaElement>(null);
  const setDraft = (text: string) => updateDraft((current) => ({ ...current, text }));
  const canAttach = !!window.desktop && !!attachmentDeviceId && !inputDisabled;
  const branch = useBranch(localProject ? session.projectPath : null, !!session.activeRun);
  const [dropping, setDropping] = useState(false);
  // The command menu: this window's own actions, then Claude Code's commands that fit what follows the slash. Enter
  // runs the one picked; Tab or a click puts a command in the box, to be given its arguments.
  // Until the keys pick one, the first that can be used is picked.
  const [pick, setPick] = useState<number | null>(null);
  const menu = useRef<HTMLDivElement>(null);
  const typed = slashOpen ? draft.text.slice(1).toLowerCase() : '';
  const items: {
    key: string;
    icon: ReactNode;
    title: ReactNode;
    detail: ReactNode;
    disabled: boolean;
    run: () => void;
    fill?: string;
  }[] = [
    ...localActions
      .filter((action) => action.name.startsWith(typed))
      .map((action) => ({
        key: action.name,
        icon:
          action.name === 'plan' ? (
            <ListChecks />
          ) : action.name === 'changes' ? (
            <Files />
          ) : action.name === 'status' ? (
            <Activity />
          ) : action.name === 'compact' ? (
            <Shrink />
          ) : (
            <RefreshCw />
          ),
        title: action.title,
        detail: draft.adding ? '正在添加文件' : action.reason || action.detail,
        disabled: !!action.reason || !!draft.adding,
        run: () => send(`/${action.name}`),
      })),
    ...(slashOpen ? slashCommands(capabilities, typed) : []).map((command) => ({
      key: `/${command.name}`,
      icon: <SquareSlash />,
      title: (
        <>
          /{command.name}
          {command.argumentHint && <em>{command.argumentHint}</em>}
        </>
      ),
      detail: command.description,
      disabled: inputDisabled || !!draft.adding,
      run: () => send(`/${command.name}`),
      fill: `/${command.name} `,
    })),
  ];
  const menuShown = native && slashOpen && items.length > 0;
  const at =
    pick === null
      ? Math.max(
          0,
          items.findIndex((item) => !item.disabled),
        )
      : Math.min(pick, items.length - 1);
  useEffect(() => {
    menu.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [at, menuShown]);
  function fill(text: string) {
    setDraft(text);
    setSlashOpen(false);
    input.current?.focus();
  }
  useLayoutEffect(() => {
    // Grow with the draft; the stylesheet's max-height decides when scrolling takes over.
    if (!input.current) return;
    input.current.style.height = 'auto';
    input.current.style.height = `${input.current.scrollHeight}px`;
  }, [draft.text, session.id]);
  async function attach(source: Promise<string[]> | File[]) {
    if (!canAttach) return;
    const owner = attachmentDeviceId!;
    updateDraft((current) => ({
      ...current,
      adding: (current.adding ?? 0) + 1,
      attachmentError: '',
    }));
    try {
      const found: FileAttachment[] = [];
      const errors: string[] = [];
      for (const file of await source) {
        let path = typeof file === 'string' ? file : window.desktop!.pathForFile(file);
        const name = typeof file === 'string' ? folderName(file) : file.name;
        try {
          if (!path && typeof file !== 'string' && file.type.startsWith('image/'))
            path = await window.desktop!.saveImage(
              file.type,
              new Uint8Array(await file.arrayBuffer()),
            );
          if (!path) throw new Error('没有可用的本机文件路径。');
          const attachment: FileAttachment = { path, name: folderName(path), deviceId: owner };
          found.push(attachment);
          const info = await window.desktop!.inspectPath(path);
          if (info.kind !== 'file') throw new Error('本机找不到这个文件。');
          attachment.size = info.size;
        } catch (error) {
          errors.push(`${name}：${error instanceof Error ? error.message : '添加失败'}`);
        }
      }
      updateDraft((current) => {
        const keys = new Set(
          current.attachments.map((file) => `${file.deviceId}:${pathKey(file.path)}`),
        );
        const added = found.filter((file) => {
          const key = `${file.deviceId}:${pathKey(file.path)}`;
          if (keys.has(key)) return false;
          keys.add(key);
          return true;
        });
        return {
          ...current,
          attachments: [...current.attachments, ...added],
          attachmentError: errors.join('\n'),
        };
      });
      input.current?.focus();
    } catch (error) {
      updateDraft((current) => ({
        ...current,
        attachmentError: error instanceof Error ? error.message : '添加文件失败。',
      }));
    } finally {
      updateDraft((current) => ({ ...current, adding: current.adding! - 1 }));
    }
  }
  return (
    <div className="composer-area">
      {menuShown && (
        <div className="slash-menu" role="listbox" aria-label="会话命令" ref={menu}>
          {items.map((item, index) => (
            <button
              key={item.key}
              type="button"
              role="option"
              aria-selected={index === at}
              disabled={item.disabled}
              // The message box keeps the focus, and with it the keys.
              onMouseDown={(event) => event.preventDefault()}
              onMouseEnter={() => setPick(index)}
              onClick={() => (item.fill ? fill(item.fill) : item.run())}
            >
              {item.icon}
              <span>
                {item.title}
                <small>{item.detail}</small>
              </span>
            </button>
          ))}
        </div>
      )}
      <div className="composer-context">
        <button
          type="button"
          className="chip quiet"
          aria-label="会话所在的项目"
          aria-haspopup="menu"
          title={session.projectPath}
          disabled={!chooseProject}
          onClick={(event) => {
            const box = event.currentTarget.getBoundingClientRect();
            chooseProject!({ x: box.left, y: box.top - 6, above: true });
          }}
        >
          <Folder />
          <span>{projectName ?? '普通会话'}</span>
        </button>
        {branch && (
          <span className="chip quiet" title="项目当前所在的 git 分支">
            <GitBranch />
            <span>{branch}</span>
          </span>
        )}
        {localProject && (
          <button type="button" className="chip quiet changes-trigger" onClick={showChanges}>
            <Files />
            <span>查看改动</span>
          </button>
        )}
      </div>
      <form
        className={`composer ${dropping ? 'dropping' : ''}${draft.attachments.length ? ' with-attachments' : ''}`}
        onSubmit={(event) => {
          event.preventDefault();
          send();
        }}
        onDragOver={(event) => {
          if (!canAttach || !event.dataTransfer.types.includes('Files')) return;
          event.preventDefault();
          setDropping(true);
        }}
        onDragLeave={() => setDropping(false)}
        onDrop={(event) => {
          setDropping(false);
          if (!canAttach || !event.dataTransfer.files.length) return;
          event.preventDefault();
          void attach([...event.dataTransfer.files]);
        }}
      >
        {draft.attachments.length > 0 && (
          <Attachments
            files={draft.attachments}
            deviceId={deviceId}
            disabled={inputDisabled}
            remove={(file) =>
              updateDraft((current) => ({
                ...current,
                attachments: current.attachments.filter((item) => item !== file),
                attachmentError: '',
              }))
            }
          />
        )}
        {!!draft.adding && (
          <p className="attachment-pending" role="status">
            正在添加文件…
          </p>
        )}
        {draft.attachmentError && (
          <p className="attachment-error" role="alert">
            {draft.attachmentError}
          </p>
        )}
        <textarea
          ref={input}
          aria-label="消息"
          placeholder={
            session.activeRun?.surface === 'terminal'
              ? '会话在终端中打开，关闭终端后可以在这里接着聊'
              : '随心输入…'
          }
          value={draft.text}
          disabled={inputDisabled}
          maxLength={16000}
          rows={2}
          onChange={(event) => {
            setDraft(event.target.value);
            setSlashOpen(native && slashDraft.test(event.target.value));
            setPick(null);
          }}
          onPaste={(event) => {
            // Pasted text is left to the browser, also when a program put a picture of it beside the text.
            if (!canAttach || !event.clipboardData.files.length) return;
            const files = [...event.clipboardData.files];
            const text = event.clipboardData.getData('text/plain');
            const usable = files.filter(
              (file) =>
                window.desktop!.pathForFile(file) || (!text && file.type.startsWith('image/')),
            );
            if (!usable.length) return;
            event.preventDefault();
            void attach(usable);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              setSlashOpen(false);
              return;
            }
            if (menuShown && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
              event.preventDefault();
              setPick((at + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length);
              return;
            }
            if (menuShown && event.key === 'Tab' && !event.shiftKey) {
              event.preventDefault();
              const command = items[at].fill;
              if (command) fill(command);
              return;
            }
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              if (!menuShown) send();
              else if (!items[at].disabled) items[at].run();
            }
          }}
        />
        <div className="composer-toolbar">
          {window.desktop && (
            <IconButton
              title={attachmentDeviceId ? '添加文件' : '只能向本机执行的会话添加文件'}
              className="attach-button"
              disabled={!canAttach}
              onClick={() => void attach(window.desktop!.chooseFiles())}
            >
              <Plus />
            </IconButton>
          )}
          {!native ? (
            <label className="scenario-label">
              场景
              <select
                aria-label="模拟场景"
                value={scenario}
                onChange={(event) => setScenario(event.target.value as Scenario)}
                disabled={!!session.activeRun || busy}
              >
                <option value="chat">对话</option>
                <option value="tool">工具审批</option>
                <option value="question">提问</option>
                <option value="error">上游错误</option>
              </select>
            </label>
          ) : (
            <PermissionMenu
              mode={session.permissionMode}
              display={modeDisplay}
              disabled={controlsDisabled}
              change={(permissionMode) => void configure({ permissionMode })}
            />
          )}
          <span className="toolbar-space" />
          {native && (
            <ComposerControls
              key={session.id}
              model={session.model}
              effort={session.effort}
              capabilities={capabilities}
              nativeSession={nativeSession}
              metrics={metrics}
              openAccount={openAccount}
              disabled={controlsDisabled}
              configure={configure}
              refresh={refresh}
              refreshing={refreshing}
              canRefreshModels={canRefreshModels}
            />
          )}
          {session.activeRun &&
            session.activeRun.waiting !== 'background' &&
            session.activeRun.surface !== 'terminal' && (
              <IconButton
                title="停止运行"
                className="stop-button"
                disabled={!connected || !ownsRun || busy}
                onClick={stop}
              >
                <Square />
              </IconButton>
            )}
          {resume && !draft.text.trim() && !draft.attachments.length && !draft.adding ? (
            <IconButton title="接着上一轮继续" className="send-button" onClick={resume}>
              <Play />
            </IconButton>
          ) : (
            (!session.activeRun || native) && (
              <button
                type="submit"
                className="icon-button send-button"
                aria-label="发送消息"
                title="发送消息"
                disabled={
                  (!draft.text.trim() && !draft.attachments.length) ||
                  inputDisabled ||
                  !!draft.adding
                }
              >
                <ArrowUp />
              </button>
            )
          )}
        </div>
      </form>
    </div>
  );
}
