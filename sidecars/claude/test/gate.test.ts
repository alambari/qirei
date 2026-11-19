import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { PreToolUseHookInput, SyncHookJSONOutput } from '@anthropic-ai/claude-agent-sdk';
import { ApprovedCalls, PendingQuestions, PendingRequests, makeCanUseTool, makeGate } from '../src/gate.js';
import type { Event } from '../src/protocol.js';

function hookInput(over: Partial<PreToolUseHookInput> = {}): PreToolUseHookInput {
  return {
    session_id: 's-1',
    transcript_path: '/work/transcript.jsonl',
    cwd: '/work/PROJ-123',
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command: 'git status' },
    tool_use_id: 'tu-1',
    ...over,
  };
}

function setup() {
  const sent: Event[] = [];
  const pending = new PendingRequests();
  const gate = makeGate((e) => void sent.push(e), pending, 'run-1');
  return { sent, pending, gate };
}

const tick = () => new Promise((r) => setTimeout(r, 5));

function decision(out: unknown) {
  const o = (out as SyncHookJSONOutput).hookSpecificOutput as
    | { hookEventName: string; permissionDecision?: string; permissionDecisionReason?: string; updatedInput?: unknown }
    | undefined;
  assert.ok(o, 'hook returns hookSpecificOutput');
  assert.equal(o.hookEventName, 'PreToolUse');
  return o;
}

test('gate_waits_for_the_daemon_answer', async () => {
  const { sent, pending, gate } = setup();
  let settled = false;
  const p = gate(hookInput({ agent_id: 'agent-7' }), 'tu-1', { signal: new AbortController().signal }).then((r) => {
    settled = true;
    return r;
  });
  await tick();
  assert.equal(settled, false);
  assert.equal(sent.length, 1);
  const req = sent[0]!;
  assert.equal(req.type, 'permission_request');
  if (req.type !== 'permission_request') return;
  assert.equal(req.run_id, 'run-1');
  assert.equal(req.agent_id, 'agent-7');
  assert.equal(req.tool_use_id, 'tu-1');
  assert.equal(req.tool_name, 'Bash');
  assert.deepEqual(req.input, { command: 'git status' });
  assert.equal(pending.answer(req.request_id, { type: 'allow' }), true);
  const allow = decision(await p);
  assert.equal(allow.permissionDecision, 'allow');
  assert.equal(allow.updatedInput, undefined);

  const p2 = gate(hookInput({ tool_use_id: 'tu-2' }), 'tu-2', { signal: new AbortController().signal });
  await tick();
  const req2 = sent[1]!;
  assert.equal(req2.type, 'permission_request');
  if (req2.type !== 'permission_request') return;
  assert.equal('agent_id' in req2, false, 'absent agent_id is omitted');
  pending.answer(req2.request_id, { type: 'deny', message: 'writes to production are never allowed' });
  const deny = decision(await p2);
  assert.equal(deny.permissionDecision, 'deny');
  assert.equal(deny.permissionDecisionReason, 'writes to production are never allowed');

  const p3 = gate(hookInput({ tool_use_id: 'tu-3' }), 'tu-3', { signal: new AbortController().signal });
  await tick();
  const req3 = sent[2]!;
  if (req3.type !== 'permission_request') return assert.fail('expected permission_request');
  pending.answer(req3.request_id, { type: 'allow', updated_input: { command: 'git status --short' } });
  const changed = decision(await p3);
  assert.equal(changed.permissionDecision, 'allow');
  assert.deepEqual(changed.updatedInput, { command: 'git status --short' });
});

test('closing_the_connection_denies_pending_requests', async () => {
  const { sent, pending, gate } = setup();
  const signal = new AbortController().signal;
  const a = gate(hookInput({ tool_use_id: 'a' }), 'a', { signal });
  const b = gate(hookInput({ tool_use_id: 'b' }), 'b', { signal });
  await tick();
  assert.equal(sent.length, 2);
  pending.closeAll();
  for (const out of [await a, await b]) assert.equal(decision(out).permissionDecision, 'deny');
  // After the connection closed, a new call is denied without waiting.
  const c = decision(await gate(hookInput({ tool_use_id: 'c' }), 'c', { signal }));
  assert.equal(c.permissionDecision, 'deny');
  assert.equal(sent.length, 2);
});

test('gate_never_decides_by_itself', async () => {
  const { sent, pending, gate } = setup();
  let settled = false;
  void gate(hookInput(), 'tu-1', { signal: new AbortController().signal }).then(() => (settled = true));
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(settled, false, 'no answer, no decision');
  assert.equal(pending.answer('unknown-id', { type: 'allow' }), false, 'an unknown id answers nothing');
  await tick();
  assert.equal(settled, false);

  // A hook event other than PreToolUse is denied, never allowed.
  const other = await gate(
    { ...hookInput(), hook_event_name: 'PostToolUse' } as unknown as PreToolUseHookInput,
    'x',
    { signal: new AbortController().signal },
  );
  assert.equal(decision(other).permissionDecision, 'deny');

  // An aborted call is denied.
  const ac = new AbortController();
  const aborted = gate(hookInput({ tool_use_id: 'ab' }), 'ab', { signal: ac.signal });
  await tick();
  ac.abort();
  assert.equal(decision(await aborted).permissionDecision, 'deny');

  // An allow carrying an input that is not an object is denied.
  const bad = gate(hookInput({ tool_use_id: 'bad' }), 'bad', { signal: new AbortController().signal });
  await tick();
  const req = sent.at(-1)!;
  if (req.type !== 'permission_request') return assert.fail('expected permission_request');
  pending.answer(req.request_id, { type: 'allow', updated_input: 'rm -rf /' });
  assert.equal(decision(await bad).permissionDecision, 'deny');
});

test('a permission request that cannot be sent is denied', async () => {
  const pending = new PendingRequests();
  const gate = makeGate(() => false, pending, 'run-1');
  const out = await gate(hookInput(), 'tu-1', { signal: new AbortController().signal });
  assert.equal(decision(out).permissionDecision, 'deny');
});

describe('an SDK safety check on a call the daemon allowed', () => {
  function escalationSetup() {
    const sent: Event[] = [];
    const logs: string[] = [];
    const permissions = new PendingRequests();
    const questions = new PendingQuestions();
    const approved = new ApprovedCalls();
    const send = (e: Event) => void sent.push(e);
    const gate = makeGate(send, permissions, 'run-1', approved);
    const canUseTool = makeCanUseTool(send, { questions, permissions, approved }, 'run-1', (_l, m) => logs.push(m));
    const signal = new AbortController().signal;
    const allowAtGate = async (id: string) => {
      const p = gate(hookInput({ tool_use_id: id, tool_name: 'Write', tool_input: { file_path: '/work/.git/config' } }), id, { signal });
      await tick();
      const req = sent.at(-1)!;
      if (req.type !== 'permission_request') throw new Error('expected permission_request');
      permissions.answer(req.request_id, { type: 'allow' });
      assert.equal(decision(await p).permissionDecision, 'allow');
    };
    const escalate = (id: string) =>
      canUseTool('Write', { file_path: '/work/.git/config' }, { signal, toolUseID: id, requestId: `r-${id}` });
    return { sent, logs, permissions, allowAtGate, escalate };
  }

  test('is relayed to the daemon again and honours an allow', async () => {
    const { sent, logs, permissions, allowAtGate, escalate } = escalationSetup();
    await allowAtGate('tu-1');
    const p = escalate('tu-1');
    await tick();
    assert.equal(sent.length, 2, 'the gate request, then a fresh request');
    assert.deepEqual(logs, ['sdk safety check: asking again for tool_use_id tu-1']);
    const again = sent[1]!;
    if (again.type !== 'permission_request') return assert.fail('expected a fresh permission_request');
    assert.equal(again.tool_use_id, 'tu-1');
    assert.equal(again.tool_name, 'Write');
    assert.equal(again.reason, 'sdk_safety_check', 'the daemon learns why it is asked again');
    assert.equal('reason' in sent[0]!, false, 'the first request carries no reason');
    assert.notEqual(again.request_id, (sent[0] as { request_id: string }).request_id);
    permissions.answer(again.request_id, { type: 'allow' });
    const r = await p;
    assert.equal(r?.behavior, 'allow');
    if (r?.behavior === 'allow') assert.deepEqual(r.updatedInput, { file_path: '/work/.git/config' });
    // One approval covers one escalation.
    assert.equal((await escalate('tu-1'))?.behavior, 'deny');
  });

  test('is relayed to the daemon again and honours a deny', async () => {
    const { sent, permissions, allowAtGate, escalate } = escalationSetup();
    await allowAtGate('tu-2');
    const p = escalate('tu-2');
    await tick();
    const again = sent.at(-1)!;
    if (again.type !== 'permission_request') return assert.fail('expected a fresh permission_request');
    permissions.answer(again.request_id, { type: 'deny', message: 'not under .git' });
    const r = await p;
    assert.equal(r?.behavior, 'deny');
    if (r?.behavior === 'deny') assert.equal(r.message, 'not under .git');
  });

  test('without a recorded allow is denied without asking', async () => {
    const { sent, escalate } = escalationSetup();
    const r = await escalate('tu-never');
    assert.equal(r?.behavior, 'deny');
    assert.equal(sent.some((e) => e.type === 'permission_request'), false);
  });

  test('is denied when the connection closes while it waits', async () => {
    const { sent, permissions, allowAtGate, escalate } = escalationSetup();
    await allowAtGate('tu-3');
    const p = escalate('tu-3');
    await tick();
    assert.equal(sent.at(-1)?.type, 'permission_request');
    permissions.closeAll();
    assert.equal((await p)?.behavior, 'deny');
  });
});
