/**
 * The permission gate. The sidecar decides nothing: every tool call is sent to the daemon as a
 * `permission_request` and waits for its `answer_permission`. Every path without an answer denies.
 */
import { randomUUID } from 'node:crypto';
import type {
  CanUseTool,
  HookCallback,
  PermissionResult,
  SyncHookJSONOutput,
} from '@anthropic-ai/claude-agent-sdk';
import type { Event, PermissionAnswer, QuestionDto } from './protocol.js';

/** Writes an event; returns false when it could not be sent (too large), so a request fails closed. */
type Send = (e: Event) => boolean | void;

/** Requests waiting for a daemon answer, keyed by request id. Closing resolves each with `closed`. */
export class Pending<T> {
  private readonly waiting = new Map<string, (v: T) => void>();
  private closed = false;

  constructor(private readonly closedValue: T) {}

  /** True once the daemon connection is gone; new requests then resolve at once. */
  get isClosed(): boolean {
    return this.closed;
  }

  /** Registers `id` and resolves with its answer, with the closed value on close, or on `signal` abort. */
  wait(id: string, signal?: AbortSignal): Promise<T> {
    if (this.closed || signal?.aborted) return Promise.resolve(this.closedValue);
    return new Promise<T>((resolve) => {
      const onAbort = () => {
        this.waiting.delete(id);
        resolve(this.closedValue);
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.waiting.set(id, (v) => {
        signal?.removeEventListener('abort', onAbort);
        resolve(v);
      });
    });
  }

  /** Delivers an answer. Returns false when nothing waits for `id`. */
  answer(id: string, value: T): boolean {
    const resolve = this.waiting.get(id);
    if (!resolve) return false;
    this.waiting.delete(id);
    resolve(value);
    return true;
  }

  /** Resolves every waiting request with the closed value and refuses new ones. */
  closeAll(): void {
    this.closed = true;
    for (const [id, resolve] of this.waiting) {
      this.waiting.delete(id);
      resolve(this.closedValue);
    }
  }
}

const CLOSED_MESSAGE = 'The permission gate is unavailable.';
const CONNECTION_CLOSED: PermissionAnswer = { type: 'deny', message: CLOSED_MESSAGE };

/** Permission requests; closing the daemon connection denies each. */
export class PendingRequests extends Pending<PermissionAnswer> {
  constructor() {
    super(CONNECTION_CLOSED);
  }
}

/** Question answers keyed by question text; `null` when the connection closed or the call aborted. */
export class PendingQuestions extends Pending<Record<string, string[]> | null> {
  constructor() {
    super(null);
  }
}

/** Most recent daemon-allowed tool calls kept for an escalation; older ones are forgotten (and denied). */
const APPROVED_KEEP = 1024;

/**
 * Tool calls the daemon allowed at the gate, by `tool_use_id`. The SDK can still send such a call to
 * `canUseTool` when its own safety checks want confirmation; only a recorded call may then be asked
 * about again, and each record covers one escalation.
 */
export class ApprovedCalls {
  private readonly ids = new Set<string>();

  record(toolUseId: string): void {
    if (toolUseId === '') return;
    this.ids.delete(toolUseId);
    this.ids.add(toolUseId);
    if (this.ids.size > APPROVED_KEEP) {
      const oldest = this.ids.values().next().value;
      if (oldest !== undefined) this.ids.delete(oldest);
    }
  }

  /** Removes the record and reports whether there was one. */
  take(toolUseId: string): boolean {
    return this.ids.delete(toolUseId);
  }
}

type PermissionRequestFields = {
  agent_id?: string;
  tool_use_id: string;
  tool_name: string;
  input: unknown;
  reason?: string;
};

/** The `reason` of a request the SDK's own safety checks escalated after the daemon allowed it. */
export const SDK_SAFETY_CHECK = 'sdk_safety_check';

/** Sends one `permission_request` and waits for its answer; an unsendable request is denied. */
async function relay(
  send: Send,
  pending: PendingRequests,
  runId: string,
  fields: PermissionRequestFields,
  signal: AbortSignal,
): Promise<PermissionAnswer> {
  if (pending.isClosed) return CONNECTION_CLOSED;
  const requestId = randomUUID();
  const answer = pending.wait(requestId, signal);
  const sent = send({ type: 'permission_request', request_id: requestId, run_id: runId, ...fields });
  if (sent === false) pending.answer(requestId, { type: 'deny', message: 'The tool input is too large to review.' });
  return answer;
}

function hookDecision(
  decision: 'allow' | 'deny',
  reason: string,
  updatedInput?: Record<string, unknown>,
): SyncHookJSONOutput {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: decision,
      permissionDecisionReason: reason,
      ...(updatedInput === undefined ? {} : { updatedInput }),
    },
  };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Builds the `PreToolUse` hook for one run. It sends a `permission_request` and returns the
 * daemon's answer as the hook decision; it allows only when the daemon answered `allow`.
 */
export function makeGate(
  send: Send,
  pending: PendingRequests,
  runId: string,
  approved: ApprovedCalls = new ApprovedCalls(),
): HookCallback {
  return async (input, toolUseID, { signal }) => {
    if (input.hook_event_name !== 'PreToolUse') {
      return hookDecision('deny', 'The permission gate only handles tool calls.');
    }
    const toolUseId = input.tool_use_id ?? toolUseID ?? '';
    const decision = await relay(
      send,
      pending,
      runId,
      {
        ...(typeof input.agent_id === 'string' ? { agent_id: input.agent_id } : {}),
        tool_use_id: toolUseId,
        tool_name: input.tool_name,
        input: input.tool_input ?? null,
      },
      signal,
    );
    if (decision.type !== 'allow') return hookDecision('deny', decision.message);
    if (decision.updated_input === undefined || decision.updated_input === null) {
      approved.record(toolUseId);
      return hookDecision('allow', 'Allowed by the daemon.');
    }
    if (!isPlainObject(decision.updated_input)) {
      return hookDecision('deny', 'The daemon sent an invalid tool input.');
    }
    approved.record(toolUseId);
    return hookDecision('allow', 'Allowed by the daemon.', decision.updated_input);
  };
}

/** Reads the SDK's AskUserQuestion input into protocol questions; undefined when malformed. */
function readQuestions(input: Record<string, unknown>): QuestionDto[] | undefined {
  const raw = input['questions'];
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const out: QuestionDto[] = [];
  for (const q of raw) {
    if (!isPlainObject(q) || typeof q['question'] !== 'string' || !Array.isArray(q['options'])) return undefined;
    const options = [];
    for (const o of q['options']) {
      if (!isPlainObject(o) || typeof o['label'] !== 'string') return undefined;
      options.push({ label: o['label'], description: typeof o['description'] === 'string' ? o['description'] : '' });
    }
    out.push({
      question: q['question'],
      header: typeof q['header'] === 'string' ? q['header'] : '',
      multi_select: q['multiSelect'] === true,
      options,
    });
  }
  return out;
}

/** What `canUseTool` needs from its run: the pending maps and the calls allowed at the gate. */
export interface CanUseToolDeps {
  questions: PendingQuestions;
  permissions: PendingRequests;
  approved: ApprovedCalls;
}

/**
 * Builds the `canUseTool` callback for one run.
 *
 * - `AskUserQuestion`: the questions go to the daemon and the answers come back as
 *   `updatedInput.answers`.
 * - A call the daemon allowed at the gate that the SDK's own safety checks still want confirmed: it
 *   is sent to the daemon again as a fresh `permission_request`, and that answer applies. Never
 *   allowed without the second answer.
 * - Anything else (no recorded allow, for example after a hook error or timeout) is denied.
 */
export function makeCanUseTool(
  send: Send,
  deps: CanUseToolDeps,
  runId: string,
  log: (level: string, message: string) => void,
): CanUseTool {
  const { questions, permissions, approved } = deps;
  return async (toolName, input, options): Promise<PermissionResult> => {
    const { signal } = options;
    if (toolName !== 'AskUserQuestion') {
      if (!approved.take(options.toolUseID)) {
        log('warn', `denied a ${toolName} call that reached canUseTool without an allow from the gate`);
        return {
          behavior: 'deny',
          message: 'The SDK asked for extra confirmation of a call the permission gate did not approve.',
        };
      }
      log('info', `sdk safety check: asking again for tool_use_id ${options.toolUseID}`);
      const decision = await relay(
        send,
        permissions,
        runId,
        {
          ...(typeof options.agentID === 'string' ? { agent_id: options.agentID } : {}),
          tool_use_id: options.toolUseID,
          tool_name: toolName,
          input,
          reason: SDK_SAFETY_CHECK,
        },
        signal,
      );
      if (decision.type !== 'allow') return { behavior: 'deny', message: decision.message };
      if (decision.updated_input === undefined || decision.updated_input === null) return { behavior: 'allow', updatedInput: input };
      if (!isPlainObject(decision.updated_input)) return { behavior: 'deny', message: 'The daemon sent an invalid tool input.' };
      return { behavior: 'allow', updatedInput: decision.updated_input };
    }
    const parsed = readQuestions(input);
    if (!parsed) return { behavior: 'deny', message: 'The questions could not be read.' };
    if (questions.isClosed) return { behavior: 'deny', message: 'Nobody is available to answer.' };
    const requestId = randomUUID();
    const answer = questions.wait(requestId, signal);
    if (send({ type: 'question', request_id: requestId, run_id: runId, questions: parsed }) === false) {
      questions.answer(requestId, null);
    }
    const answers = await answer;
    if (answers === null) return { behavior: 'deny', message: 'The question was not answered.' };
    // The tool's input schema takes one string per question; several labels are joined with ", ".
    const joined: Record<string, string> = {};
    for (const [q, labels] of Object.entries(answers)) joined[q] = labels.join(', ');
    return { behavior: 'allow', updatedInput: { ...input, answers: joined } };
  };
}
