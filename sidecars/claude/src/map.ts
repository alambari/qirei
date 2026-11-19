/**
 * Translates SDK messages into protocol events. Pure: no I/O, no decisions.
 *
 * Fields are read defensively because the daemon validates every event; a message whose shape is
 * not recognised yields `undefined` so the caller can log it once and move on.
 */
import type { Event } from './protocol.js';
import type { SdkMessageLike } from './sdk.js';

/** Longest `tool_result` summary in characters. The full tool output never leaves the sidecar. */
export const SUMMARY_CHARS = 500;
/** Final text is bounded in UTF-16 units before it enters the wire. */
export const FINAL_TEXT_UNITS = 165_000;

type Rec = Record<string, unknown>;

const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const count = (v: unknown): number | undefined => {
  const n = num(v);
  return n !== undefined && n >= 0 ? Math.floor(n) : undefined;
};
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : []);

/** Cuts to `SUMMARY_CHARS` code points, marking a cut with an ellipsis. */
export function summarize(text: string): string {
  const chars = Array.from(text);
  if (chars.length <= SUMMARY_CHARS) return text;
  return chars.slice(0, SUMMARY_CHARS - 1).join('') + '…';
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((b) => (isRec(b) ? (b['type'] === 'text' ? (str(b['text']) ?? '') : `[${str(b['type']) ?? 'content'}]`) : ''))
    .join('\n');
}

function blocks(msg: SdkMessageLike): unknown[] {
  const inner = msg['message'];
  if (!isRec(inner)) return [];
  const content = inner['content'];
  return Array.isArray(content) ? content : [];
}

/** `agent_id` when the message comes from a subagent; spread into events so absence omits the key. */
function agent(msg: SdkMessageLike): { agent_id?: string } {
  const id = str(msg['agent_id']);
  return id === undefined ? {} : { agent_id: id };
}

function optionalText<K extends string>(key: K, v: string | undefined): Partial<Record<K, string>> {
  return v === undefined ? {} : ({ [key]: v } as Record<K, string>);
}

function optional<K extends string>(key: K, v: number | undefined): Partial<Record<K, number>> {
  return v === undefined ? {} : ({ [key]: v } as Record<K, number>);
}

function system(runId: string, msg: SdkMessageLike): Event[] | undefined {
  const usage = isRec(msg['usage']) ? msg['usage'] : {};
  const taskId = str(msg['task_id']) ?? '';
  switch (msg['subtype']) {
    case 'init':
      return [
        {
          type: 'session',
          run_id: runId,
          sdk_session_id: str(msg['session_id']) ?? '',
          model: str(msg['model']) ?? '',
          tools: strings(msg['tools']),
          skills: strings(msg['skills']),
        },
      ];
    case 'task_started':
      return [{ type: 'subagent', run_id: runId, task_id: taskId, status: 'started', description: str(msg['description']) ?? '' }];
    case 'task_progress':
      return [
        {
          type: 'subagent',
          run_id: runId,
          task_id: taskId,
          status: 'running',
          description: str(msg['description']) ?? '',
          ...optional('tool_uses', count(usage['tool_uses'])),
          ...optional('duration_ms', count(usage['duration_ms'])),
          // Only the tool's name: nothing of its input or output leaves the SDK message.
          ...optionalText('last_tool', str(msg['last_tool_name'])),
        },
      ];
    case 'task_notification':
      return [
        {
          type: 'subagent',
          run_id: runId,
          task_id: taskId,
          status: str(msg['status']) ?? 'completed',
          description: str(msg['summary']) ?? '',
          ...optional('tool_uses', count(usage['tool_uses'])),
          ...optional('duration_ms', count(usage['duration_ms'])),
        },
      ];
    case 'compact_boundary': {
      // The SDK key is read by field name to keep fixtures generic.
      const info = Object.values(msg).find((v): v is Rec => isRec(v) && 'pre_tokens' in v) ?? {};
      return [{ type: 'compacted', run_id: runId, pre_tokens: count(info['pre_tokens']) ?? 0 }];
    }
    default:
      return undefined;
  }
}

/** Maps one SDK message; `undefined` means the message kind is not part of the protocol. */
export function mapMessage(runId: string, msg: SdkMessageLike): Event[] | undefined {
  switch (msg.type) {
    case 'assistant': {
      const out: Event[] = [];
      for (const b of blocks(msg)) {
        if (!isRec(b)) continue;
        if (b['type'] === 'text' && typeof b['text'] === 'string') {
          out.push({ type: 'text', run_id: runId, ...agent(msg), text: b['text'] });
        } else if (b['type'] === 'tool_use') {
          out.push({
            type: 'tool_use',
            run_id: runId,
            ...agent(msg),
            tool_use_id: str(b['id']) ?? '',
            name: str(b['name']) ?? '',
            input: b['input'] ?? null,
          });
        }
      }
      return out;
    }
    case 'user': {
      // Plain user text (the prompt echoed back, or a synthetic message) carries nothing new.
      const out: Event[] = [];
      for (const b of blocks(msg)) {
        if (!isRec(b) || b['type'] !== 'tool_result') continue;
        out.push({
          type: 'tool_result',
          run_id: runId,
          ...agent(msg),
          tool_use_id: str(b['tool_use_id']) ?? '',
          is_error: b['is_error'] === true,
          summary: summarize(resultText(b['content'])),
        });
      }
      return out;
    }
    case 'system':
      return system(runId, msg);
    case 'result': {
      const usage = isRec(msg['usage']) ? msg['usage'] : {};
      const stop = str(msg['stop_reason']);
      const answer = msg['subtype'] === 'success' && msg['is_error'] === false ? str(msg['result']) : undefined;
      let finalText = answer?.slice(0, FINAL_TEXT_UNITS);
      if (finalText !== undefined && /[\uD800-\uDBFF]$/.test(finalText)) finalText = finalText.slice(0, -1);
      return [
        {
          type: 'result',
          run_id: runId,
          subtype: str(msg['subtype']) ?? '',
          is_error: msg['is_error'] === true,
          total_cost_usd: num(msg['total_cost_usd']) ?? 0,
          num_turns: count(msg['num_turns']) ?? 0,
          ...(finalText === undefined ? {} : { final_text: finalText }),
          ...(stop === undefined ? {} : { stop_reason: stop }),
          input_tokens: count(usage['input_tokens']) ?? 0,
          output_tokens: count(usage['output_tokens']) ?? 0,
        },
      ];
    }
    default:
      return undefined;
  }
}

/** Short name of a message kind for logs, such as `system/status`. Never includes content. */
export function messageKind(msg: SdkMessageLike): string {
  const sub = str(msg['subtype']);
  const kind = sub === undefined ? msg.type : `${msg.type}/${sub}`;
  return kind.replace(/[^A-Za-z0-9_/.-]/g, '').slice(0, 64);
}
