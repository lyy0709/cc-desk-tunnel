import { useEffect, useState } from 'react';
import type { TerminalActivity, Session, SessionEvent } from '@cc-desk-tunnel/protocol';
import { permissionLabel } from './PermissionMenu.tsx';
import type { TaskProgress } from './client.ts';

// Both the composer and the connection card use this run's native facts, never an earlier run's mode.
export function sessionRuntime(
  session: Session | undefined,
  events: SessionEvent[],
  connected: boolean,
  native: boolean,
) {
  const run = session?.activeRun;
  const current = run ? events.filter((event) => event.runId === run.id) : [];
  const project = current.findLast((event) => event.payload.type === 'native.project_mcp')?.payload;
  const projectMcp = project?.type === 'native.project_mcp' ? project.status : undefined;
  const projectLabel =
    projectMcp &&
    {
      connected: '已连接',
      pending: '连接中',
      failed: '连接失败',
      'needs-auth': '需要认证',
      disabled: '已禁用',
      missing: '原生进程未列出项目工具',
      not_applied: '原生进程未加载配置',
      policy: '已收到托管策略，请刷新确认状态',
      unknown: '原生进程报告了未知状态',
    }[projectMcp];
  const initialized = current.findLast((event) => event.payload.type === 'native.session')?.payload;
  const nativeSession = initialized?.type === 'native.session' ? initialized : null;
  const reported = current.findLast(
    (event) =>
      event.payload.type === 'native.permission' ||
      (event.payload.type === 'native.session' && event.payload.permissionMode !== undefined),
  )?.payload;
  const mode =
    reported?.type === 'native.permission' || reported?.type === 'native.session'
      ? reported.permissionMode
      : undefined;
  const requested = nativeSession?.requestedPermissionMode ?? session?.permissionMode;
  const last = events.findLast((event) => event.payload.type === 'run.status')?.payload;
  const ended =
    last?.type === 'run.status'
      ? ({ completed: '已完成', failed: '失败', cancelled: '已停止' } as Record<string, string>)[
          last.status
        ]
      : undefined;
  const started =
    !!nativeSession ||
    current.some((event) =>
      ['text.delta', 'thinking.delta', 'tool.requested'].includes(event.payload.type),
    );
  const task =
    run?.surface === 'terminal'
      ? terminalState(run.activity)
      : run?.waiting === 'approval'
        ? '等待审批'
        : run?.waiting === 'question'
          ? '等待回答'
          : run?.waiting === 'background'
            ? '后台等待'
            : run?.status === 'awaiting_approval'
              ? '等待审批'
              : run
                ? native && !started
                  ? '启动中'
                  : '运行中'
                : session
                  ? (ended ?? '待命')
                  : '未选择会话';
  return {
    nativeSession,
    projectMcp,
    projectLabel,
    task: connected ? task : `最后已知：${task}`,
    modeLabel: run
      ? mode
        ? permissionLabel(mode)
        : task === '启动中'
          ? '启动中'
          : '模式待确认'
      : permissionLabel(session?.permissionMode),
    modeDetail: run
      ? `请求模式：${permissionLabel(requested)}；原生模式：${mode ? permissionLabel(mode) : '等待确认'}`
      : `下次运行：${permissionLabel(session?.permissionMode)}`,
  };
}

// A session a terminal of `ccdt` holds, as its CLI's hooks report what it is doing.
export function terminalState(activity?: TerminalActivity) {
  if (activity === 'working') return '终端运行中';
  if (activity === 'waiting') return '终端等你确认';
  return '终端打开中';
}

// The service's clock as this window knows it, and when something last came from a session's run.
export type Clock = { now: () => number; activityAt: (sessionId: string) => number };

// Draws its component again as time passes, and only while there is something to count: nothing above it
// is drawn again for the passing of a second.
function useTick(active: boolean, every = 1000) {
  const [, tick] = useState(0);
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => tick((count) => count + 1), every);
    return () => clearInterval(timer);
  }, [active, every]);
}
export function span(seconds: number) {
  const whole = Math.max(0, Math.floor(seconds));
  if (whole < 60) return `${whole} 秒`;
  if (whole < 3600) return `${Math.floor(whole / 60)} 分 ${whole % 60} 秒`;
  return `${Math.floor(whole / 3600)} 小时 ${Math.floor((whole % 3600) / 60)} 分`;
}

// Whether a run is alive. A tool that takes long tells its time in its own row above, and counts as word of
// the run; a run with no tool at work from which nothing has come for a minute says so, in words that do not
// call it stuck. The dot breathes while there is word of the run and rests when there is none.
// (The idea of telling a live run from a silent one: #47, kilisamemarisaaa.)
export function RunStatus({
  tool,
  since,
  clock,
  connected,
  suffix,
  label = '运行中',
}: {
  // A tool is at work now.
  tool: boolean;
  since: number;
  clock: Clock;
  connected: boolean;
  suffix: string;
  label?: string;
}) {
  useTick(!tool, 5000);
  const quiet = (clock.now() - since) / 1000;
  const silent = label === '运行中' && !tool && quiet >= 60;
  return (
    <div className="run-indicator" role="status">
      <span className={`running-dot${connected && !silent ? ' breathing' : ''}`} />
      {silent ? `仍在运行 · 已 ${Math.floor(quiet / 60)} 分钟没有新输出` : label}
      {suffix}
    </div>
  );
}

// Under a background task: how long it has been waited for, and what it last said of itself when it says
// anything. A shell command says nothing; a subagent tells its tools. None of it is kept once the task ends.
// (The idea of showing that a background task is alive: #45, kilisamemarisaaa.)
export function TaskLine({
  since,
  progress,
  clock,
  connected,
}: {
  since: number;
  progress: TaskProgress | undefined;
  clock: Clock;
  connected: boolean;
}) {
  useTick(connected);
  const said =
    progress?.summary ??
    (progress?.tool
      ? `${progress.toolUses ? `第 ${progress.toolUses} 次工具调用 · ` : ''}${progress.tool}`
      : '');
  return (
    <small>
      已等待 {span((clock.now() - since) / 1000)}
      {said && ` · ${said}`}
    </small>
  );
}
