/**
 * The sidecar protocol: bounded JSON Lines over stdin (commands) and stdout (events).
 *
 * The types are generated from `crates/runtimes/src/protocol.rs` (copied by `npm run bindings`);
 * the constants below must match that file.
 */
import type { AgentDefinitionDto } from './generated/AgentDefinitionDto.js';
import type { Command } from './generated/Command.js';
import type { McpServerDefDto } from './generated/McpServerDefDto.js';
import type { Event } from './generated/Event.js';
import type { PermissionAnswer } from './generated/PermissionAnswer.js';
import type { ReadpathResult } from './generated/ReadpathResult.js';

export type { AgentDefinitionDto } from './generated/AgentDefinitionDto.js';
export type { AgentModeDto } from './generated/AgentModeDto.js';
export type { Command } from './generated/Command.js';
export type { Event } from './generated/Event.js';
export type { PermissionAnswer } from './generated/PermissionAnswer.js';
export type { McpServerDefDto } from './generated/McpServerDefDto.js';
export type { QuestionDto } from './generated/QuestionDto.js';
export type { ReadpathResult } from './generated/ReadpathResult.js';
export type { ReadpathSourceDto } from './generated/ReadpathSourceDto.js';
export type { QuestionOptionDto } from './generated/QuestionOptionDto.js';
export type { StartRun } from './generated/StartRun.js';

/** Version announced in the `ready` event; equals `PROTOCOL_VERSION` in protocol.rs. */
export const PROTOCOL_VERSION = 1;
/** Longest accepted line in bytes, excluding the newline; equals `MAX_LINE_BYTES` in protocol.rs. */
export const MAX_LINE_BYTES = 1_048_576;


/** Encodes one event as a line ending in `\n`, or `undefined` when it would exceed `MAX_LINE_BYTES`. */
export function encodeEvent(e: Event): string | undefined {
  const line = JSON.stringify(e);
  if (Buffer.byteLength(line, 'utf8') > MAX_LINE_BYTES) return undefined;
  return line + '\n';
}

export type Parsed = { ok: true; command: Command } | { ok: false; reason: string };

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string';
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const absent = (v: unknown) => v === undefined || v === null;

function stringMap<T>(v: unknown, item: (x: unknown) => x is T): Record<string, T> | undefined {
  if (!isRec(v)) return undefined;
  const out: Record<string, T> = {};
  for (const [k, x] of Object.entries(v)) {
    if (!item(x)) return undefined;
    out[k] = x;
  }
  return out;
}

const isStrArray = (v: unknown): v is string[] => Array.isArray(v) && v.every(isStr);

/**
 * A task id as the SDK names it, kept to a short set of characters: it is checked here and again by
 * the daemon, so a stray byte or an oversized id never reaches `stopTask`.
 */
export const TASK_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,100}$/;

const AGENT_MODES: readonly unknown[] = ['default', 'plan', 'dontAsk'];

/**
 * One subagent as the daemon serialises it. Only the shape is checked (the daemon has already
 * decided what each field may hold); `null` optionals are dropped. `undefined` means malformed.
 */
function agentDefinition(v: unknown): AgentDefinitionDto | undefined {
  if (!isRec(v) || !isStr(v['description']) || !isStr(v['prompt'])) return undefined;
  const lists = ['tools', 'disallowed_tools', 'skills', 'mcp_servers'] as const;
  if (lists.some((k) => !absent(v[k]) && !isStrArray(v[k]))) return undefined;
  if (!absent(v['model']) && !isStr(v['model'])) return undefined;
  if (!absent(v['max_turns']) && !isNum(v['max_turns'])) return undefined;
  if (!absent(v['permission_mode']) && !AGENT_MODES.includes(v['permission_mode'])) return undefined;
  return {
    description: v['description'],
    prompt: v['prompt'],
    ...(absent(v['tools']) ? {} : { tools: v['tools'] as string[] }),
    ...(absent(v['disallowed_tools']) ? {} : { disallowed_tools: v['disallowed_tools'] as string[] }),
    ...(absent(v['model']) ? {} : { model: v['model'] as string }),
    ...(absent(v['skills']) ? {} : { skills: v['skills'] as string[] }),
    ...(absent(v['mcp_servers']) ? {} : { mcp_servers: v['mcp_servers'] as string[] }),
    ...(absent(v['max_turns']) ? {} : { max_turns: v['max_turns'] as number }),
    ...(absent(v['permission_mode']) ? {} : { permission_mode: v['permission_mode'] as AgentDefinitionDto['permission_mode'] }),
  };
}

function agentMap(v: unknown): Record<string, AgentDefinitionDto> | undefined {
  if (!isRec(v)) return undefined;
  const out: [string, AgentDefinitionDto][] = [];
  for (const [name, def] of Object.entries(v)) {
    const parsed = agentDefinition(def);
    if (!parsed) return undefined;
    out.push([name, parsed]);
  }
  // `fromEntries` defines own properties, so a name such as `__proto__` is just a name.
  return Object.fromEntries(out);
}

/**
 * One connector as the daemon serialises it: a program and its arguments and nothing else. Any
 * other field (`env`, `url`, `type`, `headers`) refuses the command, so no value can travel with a
 * connector even if a newer daemon sent one by mistake. `undefined` means malformed.
 */
function mcpServer(v: unknown): McpServerDefDto | undefined {
  if (!isRec(v) || !isStr(v['command']) || !isStrArray(v['args'])) return undefined;
  if (Object.keys(v).some((k) => k !== 'command' && k !== 'args')) return undefined;
  return { command: v['command'], args: [...v['args']] };
}

function mcpServerMap(v: unknown): Record<string, McpServerDefDto> | undefined {
  if (!isRec(v)) return undefined;
  const out: [string, McpServerDefDto][] = [];
  for (const [name, def] of Object.entries(v)) {
    const parsed = mcpServer(def);
    if (!parsed) return undefined;
    out.push([name, parsed]);
  }
  // As for agents: own properties, so `__proto__` is just a name.
  return Object.fromEntries(out);
}

/**
 * The daemon's answer to a read path request, shape-checked: `ok` with text cells, `sources` with
 * three strings each, or `error` with a kind. `undefined` means malformed.
 */
function readpathResult(v: unknown): ReadpathResult | undefined {
  if (!isRec(v)) return undefined;
  if (v['type'] === 'error') return isStr(v['kind']) ? { type: 'error', kind: v['kind'] } : undefined;
  if (v['type'] === 'sources') {
    const list = v['sources'];
    if (!Array.isArray(list)) return undefined;
    const sources = [];
    for (const s of list) {
      if (!isRec(s) || !isStr(s['name']) || !isStr(s['engine']) || !isStr(s['environment'])) return undefined;
      sources.push({ name: s['name'], engine: s['engine'], environment: s['environment'] });
    }
    return { type: 'sources', sources };
  }
  if (v['type'] === 'ok') {
    const rows = v['rows'];
    if (!isStrArray(v['columns']) || !isStrArray(v['masked_columns']) || typeof v['truncated'] !== 'boolean') return undefined;
    if (!Array.isArray(rows) || !rows.every(isStrArray)) return undefined;
    return { type: 'ok', columns: v['columns'], rows: rows as string[][], truncated: v['truncated'], masked_columns: v['masked_columns'] };
  }
  return undefined;
}

function decision(v: unknown): PermissionAnswer | undefined {
  if (!isRec(v)) return undefined;
  if (v['type'] === 'allow') return absent(v['updated_input']) ? { type: 'allow' } : { type: 'allow', updated_input: v['updated_input'] };
  if (v['type'] === 'deny' && isStr(v['message'])) return { type: 'deny', message: v['message'] };
  return undefined;
}

/**
 * Parses one command line, checking the shape the Rust side serialises. Optional fields may be
 * absent or `null`; `null` is dropped. Reasons never include the line's content.
 */
export function parseCommand(line: string): Parsed {
  let v: unknown;
  try {
    v = JSON.parse(line);
  } catch {
    return { ok: false, reason: 'invalid json' };
  }
  const bad = { ok: false, reason: 'unknown type or missing field' } as const;
  if (!isRec(v) || !isStr(v['type'])) return bad;
  switch (v['type']) {
    case 'start': {
      const env = stringMap(v['env'], isStr);
      if (!isStr(v['run_id']) || !isStr(v['cwd']) || !isStr(v['prompt']) || !isStrArray(v['allowed_tool_names']) || !env) return bad;
      const opt = (k: string, ok: (x: unknown) => boolean) => absent(v[k]) || ok(v[k]);
      if (!opt('model', isStr) || !opt('resume_session_id', isStr) || !opt('max_turns', isNum) || !opt('max_budget_usd', isNum)) return bad;
      // Skill names and the plugin folder are strings only; anything else refuses the command.
      if (!opt('skills', isStrArray) || !opt('skills_plugin_dir', isStr)) return bad;
      // Subagents: a map of definitions, each checked for shape; one bad definition refuses the command.
      const agents = absent(v['agents']) ? undefined : agentMap(v['agents']);
      if (!absent(v['agents']) && !agents) return bad;
      // Connectors: a map of programs, each checked for shape; one bad entry refuses the command.
      const mcpServers = absent(v['mcp_servers']) ? undefined : mcpServerMap(v['mcp_servers']);
      if (!absent(v['mcp_servers']) && !mcpServers) return bad;
      return {
        ok: true,
        command: {
          type: 'start',
          run_id: v['run_id'],
          cwd: v['cwd'],
          prompt: v['prompt'],
          ...(absent(v['model']) ? {} : { model: v['model'] as string }),
          ...(absent(v['resume_session_id']) ? {} : { resume_session_id: v['resume_session_id'] as string }),
          ...(absent(v['max_turns']) ? {} : { max_turns: v['max_turns'] as number }),
          ...(absent(v['max_budget_usd']) ? {} : { max_budget_usd: v['max_budget_usd'] as number }),
          allowed_tool_names: v['allowed_tool_names'],
          env,
          ...(absent(v['skills']) ? {} : { skills: v['skills'] as string[] }),
          ...(absent(v['skills_plugin_dir']) ? {} : { skills_plugin_dir: v['skills_plugin_dir'] as string }),
          ...(agents ? { agents } : {}),
          ...(mcpServers ? { mcp_servers: mcpServers } : {}),
        },
      };
    }
    case 'user_message':
      return isStr(v['run_id']) && isStr(v['text']) ? { ok: true, command: { type: 'user_message', run_id: v['run_id'], text: v['text'] } } : bad;
    case 'interrupt':
    case 'stop':
      return isStr(v['run_id']) ? { ok: true, command: { type: v['type'], run_id: v['run_id'] } } : bad;
    case 'stop_task':
      return isStr(v['run_id']) && v['run_id'] !== '' && isStr(v['task_id']) && TASK_ID_PATTERN.test(v['task_id'])
        ? { ok: true, command: { type: 'stop_task', run_id: v['run_id'], task_id: v['task_id'] } }
        : bad;
    case 'answer_permission': {
      const d = decision(v['decision']);
      return isStr(v['request_id']) && d ? { ok: true, command: { type: 'answer_permission', request_id: v['request_id'], decision: d } } : bad;
    }
    case 'answer_question': {
      const answers = stringMap(v['answers'], isStrArray);
      return isStr(v['request_id']) && answers
        ? { ok: true, command: { type: 'answer_question', request_id: v['request_id'], answers } }
        : bad;
    }
    case 'answer_readpath': {
      const result = readpathResult(v['result']);
      return isStr(v['run_id']) && isStr(v['request_id']) && result
        ? { ok: true, command: { type: 'answer_readpath', run_id: v['run_id'], request_id: v['request_id'], result } }
        : bad;
    }
    case 'shutdown':
      return { ok: true, command: { type: 'shutdown' } };
    default:
      return bad;
  }
}
