import { useEffect, useRef, useState } from 'react';
import { runWorking } from '@cc-desk-tunnel/protocol';
import type { Session } from '@cc-desk-tunnel/protocol';
import type { ProxyClient } from './client.ts';
import { isHere } from './device.ts';

export type ChangeSummary = {
  added: number;
  removed: number;
  count: number;
  error?: string;
};
export type TurnReview = { id: string; sessionId: string; directory: string; joined: boolean };
type Tracking = TurnReview & {
  run?: string;
  pendingRun?: string;
  ready: Promise<void>;
  tool?: number;
};

export function useTurnChanges(client: ProxyClient, report: (message: string) => void) {
  const tracks = useRef(new Map<string, Tracking>()).current;
  const [live, setLive] = useState<Record<string, TurnReview & { summary: ChangeSummary }>>({});
  const desktop = window.desktop;
  function begin(session: Session, joined: boolean, run?: string) {
    const id = crypto.randomUUID();
    const record: Tracking = {
      id,
      sessionId: session.id,
      directory: session.projectPath,
      joined,
      run,
      ready: desktop!.startTurnChanges(id, session.projectPath).catch((error: Error) => {
        report('无法记录本轮更改：' + error.message);
      }),
    };
    tracks.set(session.id, record);
    return record;
  }
  function end(record: Tracking) {
    tracks.delete(record.sessionId);
    setLive((previous) => {
      const next = { ...previous };
      delete next[record.sessionId];
      return next;
    });
    void desktop!.finishTurnChanges(record.id).catch((error: Error) => report(error.message));
  }
  useEffect(() => {
    if (!desktop?.startTurnChanges) return;
    const unsubscribe = desktop.onTurnChanges((id, summary) => {
      const current = [...tracks.values()].find((item) => item.id === id);
      if (current) {
        const { id, sessionId, directory, joined } = current;
        setLive((previous) => ({
          ...previous,
          [sessionId]: { id, sessionId, directory, joined, summary },
        }));
      }
    });
    let lastSessions: Session[] | undefined;
    let lastEvents: typeof client.state.events | undefined;
    function sync() {
      const { sessions, device, status, events, selectedId } = client.state;
      if (status === 'reconnecting') return;
      if (status !== 'connected') {
        for (const item of tracks.values()) end(item);
        lastSessions = undefined;
        return;
      }
      if (sessions !== lastSessions) {
        lastSessions = sessions;
        const live = new Set<string>();
        for (const session of sessions) {
          if (
            !isHere(session, device) ||
            session.activeRun?.surface === 'terminal' ||
            !runWorking(session.activeRun)
          )
            continue;
          const run = session.activeRun!.id;
          live.add(session.id);
          let current = tracks.get(session.id);
          if (
            current &&
            ((current.run && current.run !== run) || current.directory !== session.projectPath)
          ) {
            end(current);
            current = undefined;
          }
          if (current) current.run = run;
          else begin(session, true, run);
        }
        for (const item of tracks.values()) {
          if (live.has(item.sessionId)) continue;
          const session = sessions.find((s) => s.id === item.sessionId);
          if (
            !session ||
            item.run ||
            (item.pendingRun && session.activeRun?.id !== item.pendingRun)
          )
            end(item);
        }
      }
      if (selectedId && events !== lastEvents) {
        const current = tracks.get(selectedId);
        const tool = events[selectedId]?.findLast(
          (e) => e.runId === current?.run && e.payload.type === 'tool.result',
        );
        if (current && tool && current.tool !== tool.sequence) {
          current.tool = tool.sequence;
          void desktop!
            .refreshTurnChanges(current.id)
            .catch((error: Error) => report(error.message));
        }
      }
      lastEvents = events;
    }
    sync();
    const stop = client.subscribe(sync);
    return () => {
      stop();
      unsubscribe();
      for (const current of tracks.values()) end(current);
    };
  }, [client, desktop, tracks, report]);

  // Prepare before dispatch, including scheduled work in a session other than the selected one.
  // Failing to read a directory is reported separately and never prevents sending the message.
  async function send(
    command: Extract<
      Parameters<ProxyClient['request']>[0],
      { type: 'message.send' | 'run.continue' }
    >,
  ) {
    const session = client.state.sessions.find((s) => s.id === command.sessionId);
    if (
      !desktop?.startTurnChanges ||
      !session ||
      !isHere(session, client.state.device) ||
      runWorking(session.activeRun)
    )
      return client.request(command);
    const connectionId = client.state.connectionId;
    const record = tracks.get(session.id) ?? begin(session, false);
    record.pendingRun = session.activeRun?.id;
    try {
      await record.ready;
      const target = client.state.sessions.find((s) => s.id === session.id);
      if (
        client.state.connectionId !== connectionId ||
        !target ||
        !isHere(target, client.state.device) ||
        target.projectPath !== record.directory
      )
        throw new Error('准备本轮比较时连接或会话目录已变化，请重新发送。');
      const result = await client.request(command);
      // A message to an idle background run can be acknowledged before it returns to the foreground.
      if (!record.run && !record.pendingRun && tracks.get(session.id) === record) end(record);
      return result;
    } catch (error) {
      if (!record.run && tracks.get(session.id) === record) end(record);
      throw error;
    }
  }
  return { live, send };
}
