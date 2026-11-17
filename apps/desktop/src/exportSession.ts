import type { Session, SessionEvent } from '@cc-desk-tunnel/protocol';
import { messageText } from '@cc-desk-tunnel/protocol';
import type { ProxyClient } from './client.ts';
import { conversation } from '@cc-desk-tunnel/protocol/transcript';
import type { Step, Turn } from '@cc-desk-tunnel/protocol/transcript';
import { pictureNote, toolPictures } from './pictures.ts';

// A fence longer than any run of backticks inside, so the content cannot close it early.
function fenced(text: string) {
  let longest = 2;
  for (const match of text.matchAll(/`+/g)) longest = Math.max(longest, match[0].length);
  const fence = '`'.repeat(longest + 1);
  return `${fence}\n${text}\n${fence}`;
}

// A picture a tool looked at is named by its type and size, not written out as its data.
function toolOutput(output: string) {
  const pictures = toolPictures(output);
  return pictures
    ? [pictures.text, ...pictures.pictures.map(pictureNote)].filter(Boolean).join('\n')
    : output;
}

// The whole session as one Markdown document: questions, answers, and under each answer what was done to
// reach it — thinking, tool calls with their input and output — folded into <details>.
function turnMarkdown(turns: Turn[], offset = 0) {
  const parts: string[] = [];
  const step = (item: Step): string[] => {
    if (item.kind === 'assistant') return [item.text];
    if (item.kind === 'notice' || item.kind === 'note') return [`> ${item.text}`];
    if (item.kind === 'compact')
      return [
        `> ${item.endedAt ? '上下文已压缩' : '上下文压缩未完成'}${item.previousTokens == null ? '' : ` · 压缩前 ${item.previousTokens.toLocaleString()} tokens`}`,
      ];
    if (item.kind !== 'work') return [];
    return item.items.map((work) =>
      work.kind === 'tool'
        ? `<details>\n<summary>工具 ${work.name} · ${work.status}</summary>\n\n${fenced(work.input)}\n\n${work.output || work.liveOutput ? fenced(toolOutput(work.output ?? work.liveOutput!)) : ''}\n</details>`
        : `<details>\n<summary>思考</summary>\n\n${work.text}\n</details>`,
    );
  };
  for (const [index, turn] of turns.entries()) {
    parts.push(`## 第 ${offset + index + 1} 轮`);
    if (turn.question && !turn.question.continued)
      parts.push(
        `### 你 · ${new Date(turn.question.at).toLocaleString('zh-CN')}`,
        messageText(turn.question.text, turn.question.attachments),
      );
    const body = [...turn.steps.flatMap(step), ...(turn.answer ? [turn.answer.text] : [])];
    if (body.length) parts.push('### Claude Code', ...body);
    if (turn.continuations.length) parts.push(`> 继续执行 ${turn.continuations.length} 次`);
    for (const notice of turn.notices) parts.push(`> ${notice.text}`);
  }
  return `${parts.join('\n\n')}\n`;
}

function heading(session: Session, capturedAt: string) {
  return `# ${session.title}\n\n- 项目：\`${session.projectPath}\`\n- 导出时间：${new Date(capturedAt).toLocaleString('zh-CN')}\n\n`;
}

export function markdown(session: Session, events: SessionEvent[]) {
  return heading(session, new Date().toISOString()) + turnMarkdown(conversation(events));
}

// Read an independent snapshot. Neither the selected session nor its live/reconnect cursor changes.
export async function exportSession(
  client: ProxyClient,
  session: Session,
  options: {
    signal?: AbortSignal;
    progress?: (read: number, total: number) => void;
  } = {},
) {
  const { signal, progress } = options;
  let throughSequence: number | undefined;
  let sequence = 0,
    read = 0,
    turns = 0;
  const parts: string[] = [];
  let fragment: SessionEvent | undefined;
  for (;;) {
    signal?.throwIfAborted();
    const page = await client.fetch(
      {
        type: 'session.read',
        purpose: 'export',
        sessionId: session.id,
        direction: 'after',
        sequence,
        ...(throughSequence === undefined ? {} : { throughSequence }),
      },
      signal,
    );
    signal?.throwIfAborted();
    if (throughSequence === undefined) {
      throughSequence = page.throughSequence;
      fragment = page.fragment;
      parts.push(heading(page.session, page.capturedAt));
    }
    const entries = conversation([
      ...page.events,
      ...(!page.hasLater && fragment ? [fragment] : []),
    ]);
    for (let i = 0; i < entries.length; i += 32) {
      parts.push(turnMarkdown(entries.slice(i, i + 32), turns + i));
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      signal?.throwIfAborted();
    }
    turns += entries.length;
    read += page.events.length;
    progress?.(read, page.totalEvents);
    if (!page.hasLater) break;
    sequence = page.lastSequence;
  }
  signal?.throwIfAborted();
  const text = parts.join('\n');
  const name = `${session.title.replace(/[\\/:*?"<>|\r\n]+/g, ' ').trim() || '会话'}.md`;
  if (window.desktop) return window.desktop.saveFile(name, text);
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([text], { type: 'text/markdown' }));
  link.download = name;
  link.click();
  URL.revokeObjectURL(link.href);
  return true;
}
