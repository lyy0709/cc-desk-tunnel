import type { SDKUserMessage, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { EventPayload, MessagePriority } from '@cc-desk-tunnel/protocol';
import { DomainError } from './errors.ts';

// This is only the SDK's input transport. Claude Code owns scheduling and merging turns.
export class NativeInput {
  private messages: {
    id: string;
    text: string;
    scheduled?: 'scheduled' | 'manual';
    priority?: MessagePriority;
  }[] = [];
  private outstanding = new Map<string, { delivered: boolean; received: boolean }>();
  private wake?: () => void;
  private ended = false;
  private accepting = true;
  private sessionId: string;
  private emit: (event: EventPayload) => void;
  onDrain?: () => void;
  constructor(sessionId: string, emit: (event: EventPayload) => void) {
    this.sessionId = sessionId;
    this.emit = emit;
  }

  assertWritable() {
    if (!this.accepting)
      throw new DomainError('run_finishing', '原生运行正在收尾，请待结束后发送。');
    if (this.outstanding.size >= 32)
      throw new DomainError('input_busy', '已有较多补充消息等待原生处理，请稍后发送。');
  }
  submit(id: string, text: string, scheduled?: 'scheduled' | 'manual', priority?: MessagePriority) {
    this.assertWritable();
    this.outstanding.set(id, { delivered: false, received: false });
    this.messages.push({ id, text, scheduled, priority });
    this.emit({ type: 'message.delivery', messageId: id, status: 'submitted' });
    this.wake?.();
  }
  async *stream(): AsyncGenerator<SDKUserMessage> {
    while (!this.ended) {
      const message = this.messages.shift();
      if (!message) {
        await new Promise<void>((resolve) => {
          this.wake = resolve;
        });
        continue;
      }
      this.outstanding.get(message.id)!.delivered = true;
      this.emit({ type: 'message.delivery', messageId: message.id, status: 'queued' });
      if (!this.messages.length) this.onDrain?.();
      yield {
        type: 'user',
        uuid: message.id as SDKUserMessage['uuid'],
        message: { role: 'user', content: message.text },
        parent_tool_use_id: null,
        session_id: this.sessionId,
        ...(message.priority ? { priority: message.priority } : {}),
        origin: message.scheduled
          ? {
              kind: 'task-notification',
              subkind: 'scheduled-trigger',
              fireReason: message.scheduled,
            }
          : { kind: 'human' },
      };
    }
  }
  observe(message: SDKMessage) {
    if (
      !['stream_event', 'assistant', 'result'].includes(message.type) ||
      ('parent_tool_use_id' in message && message.parent_tool_use_id)
    )
      return;
    const echoed = message as { user_message_uuid?: string; user_message_uuids?: string[] };
    const ids =
      echoed.user_message_uuids ?? (echoed.user_message_uuid ? [echoed.user_message_uuid] : []);
    for (const id of ids) {
      const pending = this.outstanding.get(id);
      if (!pending) continue;
      if (!pending.received)
        this.emit({ type: 'message.delivery', messageId: id, status: 'received' });
      pending.received = true;
      if (message.type === 'result') this.outstanding.delete(id);
    }
  }
  // `waiting` says background tasks are still alive in the CLI; the turn their completion starts is yet to come.
  endTurn(result: Extract<SDKMessage, { type: 'result' }>, waiting = false) {
    // An error ends this turn, not the native turns already waiting behind it.
    if ((result.queued_turn_count ?? 0) > 0) return false;
    // Seal synchronously before post-turn metrics, so new inputs cannot be lost in cleanup.
    if (result.is_error || (!this.outstanding.size && !(result.queued_turn_count ?? 0))) {
      if (waiting && !result.is_error) return false;
      this.accepting = false;
      return true;
    }
    if (
      !result.user_message_uuid &&
      !result.user_message_uuids &&
      !(result.queued_turn_count ?? 0)
    ) {
      this.accepting = false; // An older producer cannot confirm individual sends; never invent a receipt.
      return true;
    }
    return false;
  }
  get awaitingReceipt() {
    return (
      !this.messages.length &&
      [...this.outstanding.values()].some((message) => message.delivered && !message.received)
    );
  }
  close() {
    if (this.ended) return;
    this.accepting = false;
    this.ended = true;
    this.wake?.();
    this.messages = [];
    for (const [messageId, pending] of this.outstanding) {
      if (!pending.received)
        this.emit({
          type: 'message.delivery',
          messageId,
          status: pending.delivered ? 'unconfirmed' : 'not_sent',
        });
    }
    this.outstanding.clear();
  }
}
