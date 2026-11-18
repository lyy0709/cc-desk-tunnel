import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import {
  ArrowUp,
  ArrowDown,
  ChevronDown,
  CornerDownRight,
  ListEnd,
  MoreHorizontal,
  Pencil,
  Trash2,
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
  MessagePriority,
  Session,
} from '@cc-desk-tunnel/protocol';
import type { FileAttachment } from '@cc-desk-tunnel/protocol';
import type { Draft } from './drafts.ts';
import type { ChangeSummary } from './turnChanges.ts';
import { changeDraftText, insertDraftFiles } from './drafts.ts';
import Attachments from './Attachments.tsx';
import { folderName } from './paths.ts';
import { slashCommands } from './commands.ts';
import ComposerControls from './ComposerControls.tsx';
import PermissionMenu from './PermissionMenu.tsx';
import { IconButton, Menu } from './ui.tsx';
import type { MenuPosition } from './ui.tsx';
import { followupModes, usePrefs } from './prefs.ts';
import { comboOf, keyFor, show } from './shortcuts.ts';

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
  followup,
  sendingQueued,
  sendQueued,
  updateDraft,
  deviceId,
  attachmentDeviceId,
  native,
  localProject,
  showChanges,
  turnChanges,
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
  followup: MessagePriority;
  sendingQueued: string | null;
  sendQueued: (id: string, priority: MessagePriority) => void;
  updateDraft: (update: (draft: Draft) => Draft) => void;
  deviceId?: string;
  attachmentDeviceId?: string;
  native: boolean;
  localProject: boolean;
  showChanges: () => void;
  turnChanges?: { summary: ChangeSummary; expanded: boolean; open: () => void };
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
  send: (text?: string, priority?: MessagePriority) => void;
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
  const [sendMenu, setSendMenu] = useState<
    (MenuPosition & { queuedId?: string; stashed?: true }) | null
  >(null);
  const draggedQueue = useRef<string | null>(null);
  const [queueDropTarget, setQueueDropTarget] = useState<string | null>(null);
  const chord = useRef<number | null>(null);
  const prefs = usePrefs();
  const steerKey = prefs.shortcuts.enabled ? keyFor(prefs, 'steer') : '';
  const following = native && !!session.activeRun && session.activeRun.surface !== 'terminal';
  const delivery = draft.requeue
    ? 'later'
    : session.activeRun?.waiting === 'question'
      ? 'next'
      : followup;
  const canSend =
    !inputDisabled && !draft.adding && (!!draft.text.trim() || !!draft.attachments.length);
  const queuedIndex = draft.queued?.findIndex((item) => item.id === sendMenu?.queuedId) ?? -1;
  const queuedAction = draft.queued?.[queuedIndex];
  const focusEnd = () =>
    requestAnimationFrame(() => {
      const field = input.current;
      if (!field) return;
      field.focus();
      field.setSelectionRange(field.value.length, field.value.length);
    });
  const restoreStashed = (index: number) => {
    updateDraft((current) => {
      const content = current.stashed?.[index];
      if (!content) return current;
      const stashed = current.stashed!.filter((_, at) => at !== index);
      if (current.text.trim() || current.attachments.length)
        stashed.push({
          text: current.text,
          attachments: current.attachments,
          requeue: current.requeue,
        });
      return {
        ...current,
        ...content,
        requeue: content.requeue,
        stashed,
        attachmentError: undefined,
      };
    });
    setSlashOpen(false);
    focusEnd();
  };
  const moveQueued = (id: string, target: string) => {
    if (sendingQueued) return;
    updateDraft((current) => {
      const queued = [...(current.queued ?? [])];
      const from = queued.findIndex((item) => item.id === id);
      const to = queued.findIndex((item) => item.id === target);
      // A run can finish and submit an item while it is being dragged.
      if (from < 0 || to < 0 || from === to) return current;
      queued.splice(to, 0, queued.splice(from, 1)[0]);
      return { ...current, queued };
    });
  };
  const steer = () => {
    if (inputDisabled || draft.adding) return;
    if (draft.text.trim() || draft.attachments.length) send(undefined, 'now');
    else if (draft.queued?.[0]) sendQueued(draft.queued[0].id, 'now');
  };
  const setDraft = (text: string) => updateDraft((current) => changeDraftText(current, text));
  const canAttach = !!window.desktop && !!attachmentDeviceId && !inputDisabled;
  const branch = useBranch(localProject ? session.projectPath : null, !!session.activeRun);
  const toolbar = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const bar = toolbar.current!;
    const fit = () => {
      bar.classList.remove('compact-permission');
      bar.classList.add('measuring');
      bar.classList.toggle(
        'compact-permission',
        bar.lastElementChild!.getBoundingClientRect().right +
          parseFloat(getComputedStyle(bar).paddingRight) >
          bar.getBoundingClientRect().right,
      );
      bar.classList.remove('measuring');
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(bar);
    for (const child of bar.children) observer.observe(child);
    return () => observer.disconnect();
  }, [
    session,
    native,
    capabilities,
    nativeSession,
    !!resume,
    !!draft.text.trim(),
    !!draft.attachments.length,
    !!draft.adding,
  ]);
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
    if (draft.cursor !== undefined) input.current.setSelectionRange(draft.cursor, draft.cursor);
  }, [draft.text, session.id]);
  async function attach(source: Promise<string[]> | File[]) {
    if (!canAttach) return;
    const owner = attachmentDeviceId!;
    const point = {
      id: crypto.randomUUID(),
      offset: input.current?.selectionStart ?? draft.text.length,
    };
    updateDraft((current) => ({
      ...current,
      adding: (current.adding ?? 0) + 1,
      attachmentError: '',
      insertions: [...(current.insertions ?? []), point],
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
      const cursor = input.current?.selectionStart;
      updateDraft((current) => {
        const offset = current.insertions!.find((item) => item.id === point.id)!.offset;
        const next = insertDraftFiles(current, found, offset);
        return {
          ...next,
          cursor:
            cursor === undefined
              ? next.cursor
              : cursor < offset
                ? cursor
                : cursor + next.text.length - current.text.length,
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
      updateDraft((current) => ({
        ...current,
        adding: current.adding! - 1,
        insertions: current.insertions!.filter((item) => item.id !== point.id),
      }));
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
      {!!turnChanges?.summary.count && (
        <button
          type="button"
          className="turn-changes-pill"
          title={turnChanges.summary.error ?? '查看本轮运行期间的项目目录变化'}
          aria-expanded={turnChanges.expanded}
          onClick={turnChanges.open}
        >
          更改
          {turnChanges.summary.added || turnChanges.summary.removed ? (
            <span className="tool-diff">
              <ins>+{turnChanges.summary.added}</ins>
              <del>−{turnChanges.summary.removed}</del>
            </span>
          ) : (
            ` · ${turnChanges.summary.count} 个文件`
          )}
        </button>
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
        {!!draft.stashed?.length && (
          <button
            type="button"
            className="chip quiet"
            disabled={busy || !!draft.adding}
            aria-label="恢复暂存草稿"
            onClick={(event) => {
              if (draft.stashed!.length === 1) restoreStashed(0);
              else {
                const box = event.currentTarget.getBoundingClientRect();
                setSendMenu({ x: box.left, y: box.top - 6, above: true, stashed: true });
              }
            }}
          >
            <Pencil />
            <span>暂存草稿 {draft.stashed.length}</span>
          </button>
        )}
      </div>
      {!!draft.queued?.length && (
        <div className="queued-messages" role="list" aria-label="待发送消息">
          {draft.queued.map((message) => (
            <div
              className={`queued-message${queueDropTarget === message.id ? ' drop-target' : ''}`}
              role="listitem"
              key={message.id}
              onDragOver={(event) => {
                if (!draggedQueue.current || sendingQueued) return;
                event.preventDefault();
                event.dataTransfer.dropEffect = 'move';
                setQueueDropTarget(message.id);
              }}
              onDrop={(event) => {
                if (!draggedQueue.current) return;
                event.preventDefault();
                moveQueued(draggedQueue.current, message.id);
                draggedQueue.current = null;
                setQueueDropTarget(null);
              }}
            >
              <div className="queued-message-body">
                <button
                  type="button"
                  className="icon-button queued-message-handle"
                  aria-label="拖动排序排队消息"
                  title="拖动排序"
                  disabled={!!sendingQueued || draft.queued!.length < 2}
                  draggable={!sendingQueued && draft.queued!.length > 1}
                  onDragStart={(event) => {
                    draggedQueue.current = message.id;
                    event.dataTransfer.effectAllowed = 'move';
                    event.dataTransfer.setData('text/x-ccdt-queued-message', message.id);
                  }}
                  onDragEnd={() => {
                    draggedQueue.current = null;
                    setQueueDropTarget(null);
                  }}
                >
                  <ListEnd />
                </button>
                <div>
                  <p
                    title={message.text || message.attachments.map((file) => file.name).join('、')}
                  >
                    {message.text || message.attachments.map((file) => file.name).join('、')}
                  </p>
                  {!!message.text.trim() && message.attachments.length > 0 && (
                    <small>{message.attachments.map((file) => file.name).join('、')}</small>
                  )}
                  {sendingQueued === message.id ? (
                    <small>正在提交…</small>
                  ) : (
                    message.paused && !message.error && <small>已暂停</small>
                  )}
                </div>
              </div>
              <div className="queued-message-actions">
                <button
                  type="button"
                  className="copy-button"
                  disabled={inputDisabled || sendingQueued === message.id}
                  onClick={() => sendQueued(message.id, 'now')}
                >
                  <CornerDownRight />
                  {session.activeRun ? '引导' : '发送'}
                </button>
                <IconButton
                  title="移除排队消息"
                  disabled={sendingQueued === message.id}
                  onClick={() =>
                    updateDraft((current) => ({
                      ...current,
                      queued: current.queued?.filter((item) => item.id !== message.id),
                    }))
                  }
                >
                  <Trash2 />
                </IconButton>
                <button
                  type="button"
                  className="icon-button"
                  aria-label="排队消息操作"
                  disabled={sendingQueued === message.id}
                  onClick={(event) => {
                    const box = event.currentTarget.getBoundingClientRect();
                    setSendMenu({
                      x: box.right,
                      y: box.top - 6,
                      above: true,
                      queuedId: message.id,
                    });
                  }}
                >
                  <MoreHorizontal />
                </button>
              </div>
              {message.error && (
                <p className="queued-message-error" role="alert">
                  {message.error}
                </p>
              )}
            </div>
          ))}
        </div>
      )}
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
                ...changeDraftText(
                  current,
                  file.reference
                    ? current.text.replaceAll(`[文件 #${file.reference}]`, '')
                    : current.text,
                ),
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
            if (event.nativeEvent.isComposing) return;
            if (native && steerKey && comboOf(event) === steerKey) {
              event.preventDefault();
              steer();
              return;
            }
            if (
              following &&
              steerKey &&
              event.ctrlKey &&
              !event.altKey &&
              !event.metaKey &&
              !event.shiftKey &&
              event.code === 'KeyX' &&
              event.currentTarget.selectionStart === event.currentTarget.selectionEnd
            ) {
              chord.current = Date.now();
              event.preventDefault();
              return;
            }
            if (
              following &&
              steerKey &&
              event.ctrlKey &&
              !event.altKey &&
              !event.metaKey &&
              !event.shiftKey &&
              event.code === 'KeyS' &&
              chord.current !== null &&
              Date.now() - chord.current < 3000
            ) {
              chord.current = null;
              event.preventDefault();
              steer();
              return;
            }
            if (!['Control', 'Shift', 'Alt', 'Meta'].includes(event.key)) chord.current = null;
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
        <div className="composer-toolbar" ref={toolbar}>
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
          {following && (
            <button
              type="button"
              className="icon-button send-options"
              aria-label="本条消息发送方式"
              disabled={!canSend}
              onClick={(event) => {
                const box = event.currentTarget.getBoundingClientRect();
                setSendMenu({ x: box.right, y: box.top - 6, above: true });
              }}
            >
              <ChevronDown />
            </button>
          )}
          {resume &&
          !draft.text.trim() &&
          !draft.attachments.length &&
          !draft.adding &&
          !draft.queued?.length ? (
            <IconButton title="接着上一轮继续" className="send-button" onClick={resume}>
              <Play />
            </IconButton>
          ) : (
            (!session.activeRun || native) && (
              <button
                type="submit"
                className="icon-button send-button"
                aria-label="发送消息"
                title={
                  following
                    ? `${followupModes.find((item) => item.priority === delivery)!.label}${steerKey ? ` · ${show(steerKey)} 立即引导` : ''}`
                    : '发送消息'
                }
                disabled={
                  (!draft.text.trim() && !draft.attachments.length) ||
                  inputDisabled ||
                  !!draft.adding
                }
              >
                {following && delivery === 'later' ? (
                  <ListEnd />
                ) : following && delivery === 'now' ? (
                  <CornerDownRight />
                ) : (
                  <ArrowUp />
                )}
              </button>
            )
          )}
        </div>
      </form>
      {sendMenu && (!sendMenu.queuedId || queuedAction) && (
        <Menu
          label={sendMenu.stashed ? '暂存草稿' : queuedAction ? '排队消息操作' : '本条消息发送方式'}
          {...sendMenu}
          items={
            sendMenu.stashed
              ? (draft.stashed ?? []).map((content, index) => ({
                  label:
                    `${index + 1}. ${content.text || content.attachments.map((file) => file.name).join('、')}`.slice(
                      0,
                      80,
                    ),
                  icon: <Pencil />,
                  disabled: busy || !!draft.adding,
                  run: () => restoreStashed(index),
                }))
              : queuedAction
                ? [
                    {
                      label: '编辑消息',
                      icon: <Pencil />,
                      disabled: busy || !!draft.adding,
                      detail: draft.adding ? '等待附件添加完成' : undefined,
                      run: () => {
                        updateDraft((current) => {
                          const message = current.queued?.find(
                            (item) => item.id === queuedAction.id,
                          );
                          if (!message) return current;
                          const queued = current.queued!.filter((item) => item.id !== message.id);
                          const stashed = [...(current.stashed ?? [])];
                          if (current.text.trim() || current.attachments.length)
                            stashed.push({
                              text: current.text,
                              attachments: current.attachments,
                              requeue: current.requeue,
                            });
                          return {
                            text: message.text,
                            attachments: message.attachments,
                            queued,
                            stashed,
                            requeue: true,
                          };
                        });
                        setSlashOpen(false);
                        focusEnd();
                      },
                    },
                    {
                      label: '上移',
                      icon: <ArrowUp />,
                      disabled: queuedIndex === 0 || !!sendingQueued,
                      run: () => moveQueued(queuedAction.id, draft.queued![queuedIndex - 1].id),
                    },
                    {
                      label: '下移',
                      icon: <ArrowDown />,
                      disabled: queuedIndex === draft.queued!.length - 1 || !!sendingQueued,
                      run: () => moveQueued(queuedAction.id, draft.queued![queuedIndex + 1].id),
                    },
                    ...(queuedAction.paused
                      ? [
                          {
                            label: '继续排队',
                            icon: <ListEnd />,
                            run: () => {
                              if (!session.activeRun) {
                                sendQueued(queuedAction.id, 'later');
                                return;
                              }
                              updateDraft((current) => ({
                                ...current,
                                queued: current.queued?.map((item) =>
                                  item.id === queuedAction.id
                                    ? { ...item, paused: false, error: undefined }
                                    : item,
                                ),
                              }));
                            },
                          },
                        ]
                      : []),
                  ]
                : followupModes.map((item) => ({
                    label: item.label,
                    detail: item.detail,
                    checked: item.priority === delivery,
                    disabled: !canSend,
                    run: () => send(undefined, item.priority),
                  }))
          }
          onClose={() => setSendMenu(null)}
        />
      )}
    </div>
  );
}
