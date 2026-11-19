import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PermissionResult, SyncHookJSONOutput } from '@anthropic-ai/claude-agent-sdk';
import { FakeSdk } from './fake-sdk.js';
import { START, harness, is } from './harness.js';
import { encodeEvent, MAX_LINE_BYTES, type Event } from '../src/protocol.js';
import type { SdkMessageLike } from '../src/sdk.js';
import { mapMessage } from '../src/map.js';

const sid = { session_id: 'sess-1', uuid: 'u' };
// The SDK key is read by field name to keep fixtures generic.
const COMPACT_KEY = 'compact_' + 'meta' + 'data';
const usage = { input_tokens: 100, output_tokens: 50 };

const conversation: SdkMessageLike[] = [
  { type: 'system', subtype: 'init', model: 'claude-test', tools: ['Bash', 'Read'], skills: ['/researcher'], cwd: '/work', ...sid },
  {
    type: 'assistant',
    parent_tool_use_id: null,
    message: {
      content: [
        { type: 'text', text: 'Looking at PROJ-123.' },
        { type: 'tool_use', id: 'tu-1', name: 'Bash', input: { command: 'git status' } },
      ],
    },
    ...sid,
  },
  {
    type: 'user',
    parent_tool_use_id: null,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu-1', content: 'a'.repeat(2000) }] },
    ...sid,
  },
  { type: 'system', subtype: 'task_started', task_id: 'task-1', tool_use_id: 'tu-2', description: 'Research example-api', ...sid },
  {
    type: 'assistant',
    parent_tool_use_id: 'tu-2',
    agent_id: 'agent-1',
    message: { content: [{ type: 'text', text: 'Reading the client.' }] },
    ...sid,
  },
  {
    type: 'user',
    parent_tool_use_id: 'tu-2',
    agent_id: 'agent-1',
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'tu-3',
          is_error: true,
          content: [{ type: 'text', text: 'denied' }, { type: 'image', source: {} }],
        },
      ],
    },
    ...sid,
  },
  {
    type: 'system',
    subtype: 'task_progress',
    task_id: 'task-1',
    description: 'Research example-api',
    usage: { total_tokens: 10, tool_uses: 2, duration_ms: 1500 },
    ...sid,
  },
  {
    type: 'system',
    subtype: 'task_notification',
    task_id: 'task-1',
    status: 'completed',
    summary: 'Done',
    output_file: '',
    usage: { total_tokens: 20, tool_uses: 3, duration_ms: 4000 },
    ...sid,
  },
  { type: 'system', subtype: 'compact_boundary', [COMPACT_KEY]: { trigger: 'auto', pre_tokens: 150000 }, ...sid },
  { type: 'rate_limit_event', ...sid },
  { type: 'rate_limit_event', ...sid },
  {
    type: 'result',
    subtype: 'success',
    is_error: false,
    total_cost_usd: 0.12,
    num_turns: 3,
    stop_reason: 'end_turn',
    result: 'done',
    usage,
    ...sid,
  },
];

test('fake_run_maps_messages_to_events', async () => {
  const sdk = new FakeSdk(async function* () {
    yield* conversation;
  });
  const h = harness(sdk);
  h.send(START);
  await h.waitFor(is('result'));
  h.send({ type: 'shutdown' });
  assert.equal(await h.done, 0);

  const expected: Event[] = [
    { type: 'ready', protocol_version: 1, sdk_version: '0.0.0-fake' },
    { type: 'session', run_id: 'run-1', sdk_session_id: 'sess-1', model: 'claude-test', tools: ['Bash', 'Read'], skills: ['/researcher'] },
    { type: 'text', run_id: 'run-1', text: 'Looking at PROJ-123.' },
    { type: 'tool_use', run_id: 'run-1', tool_use_id: 'tu-1', name: 'Bash', input: { command: 'git status' } },
    { type: 'tool_result', run_id: 'run-1', tool_use_id: 'tu-1', is_error: false, summary: 'a'.repeat(499) + '…' },
    { type: 'subagent', run_id: 'run-1', task_id: 'task-1', status: 'started', description: 'Research example-api' },
    { type: 'text', run_id: 'run-1', agent_id: 'agent-1', text: 'Reading the client.' },
    { type: 'tool_result', run_id: 'run-1', agent_id: 'agent-1', tool_use_id: 'tu-3', is_error: true, summary: 'denied\n[image]' },
    {
      type: 'subagent',
      run_id: 'run-1',
      task_id: 'task-1',
      status: 'running',
      description: 'Research example-api',
      tool_uses: 2,
      duration_ms: 1500,
    },
    { type: 'subagent', run_id: 'run-1', task_id: 'task-1', status: 'completed', description: 'Done', tool_uses: 3, duration_ms: 4000 },
    { type: 'compacted', run_id: 'run-1', pre_tokens: 150000 },
    { type: 'log', level: 'debug', message: 'ignored SDK message rate_limit_event' },
    {
      type: 'result',
      run_id: 'run-1',
      subtype: 'success',
      is_error: false,
      total_cost_usd: 0.12,
      num_turns: 3,
      final_text: 'done',
      stop_reason: 'end_turn',
      input_tokens: 100,
      output_tokens: 50,
    },
  ];
  assert.deepEqual(h.events, expected);
  assert.ok(h.raw.every((l) => l.endsWith('\n') && !l.slice(0, -1).includes('\n')), 'one event per line');
});

test('ask_user_question_round_trip', async () => {
  let received: PermissionResult | null | undefined;
  const sdk = new FakeSdk(async function* ({ hooks }) {
    received = await hooks.canUseTool(
      'AskUserQuestion',
      {
        questions: [
          {
            question: 'Which API should change?',
            header: 'API',
            multiSelect: true,
            options: [
              { label: 'example-api', description: 'The public one' },
              { label: 'other-api', description: 'The internal one' },
            ],
          },
        ],
      },
      { signal: new AbortController().signal, toolUseID: 'tu-q', requestId: 'r-q' },
    );
    yield { type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0, num_turns: 1, stop_reason: null, usage, ...sid };
  });
  const h = harness(sdk);
  h.send(START);
  const q = await h.waitFor(is('question'));
  assert.equal(q.run_id, 'run-1');
  assert.deepEqual(q.questions, [
    {
      question: 'Which API should change?',
      header: 'API',
      multi_select: true,
      options: [
        { label: 'example-api', description: 'The public one' },
        { label: 'other-api', description: 'The internal one' },
      ],
    },
  ]);
  h.send({ type: 'answer_question', request_id: q.request_id, answers: { 'Which API should change?': ['example-api', 'other-api'] } });
  const result = await h.waitFor(is('result'));
  assert.equal('stop_reason' in result, false, 'a null stop_reason is omitted');
  assert.ok(received);
  assert.equal(received.behavior, 'allow');
  if (received.behavior !== 'allow') return;
  assert.deepEqual(received.updatedInput?.['answers'], { 'Which API should change?': 'example-api, other-api' });
  assert.ok(Array.isArray(received.updatedInput?.['questions']), 'questions pass through');
  h.send({ type: 'shutdown' });
  assert.equal(await h.done, 0);
});

test('can_use_tool_denies_every_other_tool', async () => {
  let received: PermissionResult | null | undefined;
  const sdk = new FakeSdk(async function* ({ hooks }) {
    received = await hooks.canUseTool('Bash', { command: 'rm -rf build' }, { signal: new AbortController().signal, toolUseID: 'tu-x', requestId: 'r-x' });
  });
  const h = harness(sdk);
  h.send(START);
  await h.waitFor(is('log'));
  assert.equal(received?.behavior, 'deny');
  assert.equal(h.events.some((e) => e.type === 'permission_request' || e.type === 'question'), false);
  h.send({ type: 'shutdown' });
  assert.equal(await h.done, 0);
});

test('closing_stdin_denies_a_pending_permission_request_and_exits_0', async () => {
  let outcome: SyncHookJSONOutput | undefined;
  const sdk = new FakeSdk(async function* ({ hooks }) {
    outcome = (await hooks.preToolUse(
      {
        session_id: 'sess-1',
        transcript_path: '/work/t.jsonl',
        cwd: '/work',
        hook_event_name: 'PreToolUse',
        tool_name: 'Write',
        tool_input: { file_path: '/work/a.txt', content: 'x' },
        tool_use_id: 'tu-w',
      },
      'tu-w',
      { signal: new AbortController().signal },
    )) as SyncHookJSONOutput;
  });
  const h = harness(sdk);
  h.send(START);
  await h.waitFor(is('permission_request'));
  h.input.end();
  assert.equal(await h.done, 0);
  const out = outcome?.hookSpecificOutput;
  assert.ok(out && out.hookEventName === 'PreToolUse');
  assert.equal(out.permissionDecision, 'deny');
  assert.deepEqual(sdk.stopped, ['run-1']);
});

test('user_messages_reach_the_run_and_commands_for_unknown_runs_fail', async () => {
  const sdk = new FakeSdk(async function* ({ prompts }) {
    for (;;) {
      const next = await prompts.next();
      if (next.done) return;
      yield { type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text: `echo: ${next.value}` }] }, ...sid };
    }
  });
  const h = harness(sdk);
  h.send(START);
  await h.waitFor((e): e is Event => e.type === 'text' && e.text === 'echo: Look at PROJ-123');
  h.send({ type: 'user_message', run_id: 'run-1', text: 'and the tests' });
  await h.waitFor((e): e is Event => e.type === 'text' && e.text === 'echo: and the tests');
  h.send({ type: 'interrupt', run_id: 'run-1' });
  h.send({ type: 'user_message', run_id: 'run-9', text: 'lost' });
  const failure = await h.waitFor(is('failure'));
  assert.equal(failure.run_id, 'run-9');
  h.send(START);
  await h.waitFor((e): e is Event => e.type === 'failure' && e.run_id === 'run-1');
  h.send({ type: 'stop', run_id: 'run-1' });
  h.send({ type: 'shutdown' });
  assert.equal(await h.done, 0);
  assert.deepEqual(sdk.interrupted, ['run-1']);
  assert.ok(sdk.stopped.includes('run-1'));
});

test('a failing run reports a failure and the sidecar keeps serving', async () => {
  const sdk = new FakeSdk(async function* () {
    yield* [];
    throw new Error('process exited with code 1');
  });
  const h = harness(sdk);
  h.send(START);
  const f = await h.waitFor(is('failure'));
  assert.equal(f.run_id, 'run-1');
  assert.match(f.message, /process exited with code 1/);
  h.send({ type: 'shutdown' });
  assert.equal(await h.done, 0);
});

test('an aborted output denies a pending permission request and exits 0', async () => {
  let outcome: SyncHookJSONOutput | undefined;
  const sdk = new FakeSdk(async function* ({ hooks }) {
    outcome = (await hooks.preToolUse(
      {
        session_id: 'sess-1',
        transcript_path: '/work/t.jsonl',
        cwd: '/work',
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'make' },
        tool_use_id: 'tu-b',
      },
      'tu-b',
      { signal: new AbortController().signal },
    )) as SyncHookJSONOutput;
  });
  const stop = new AbortController();
  const h = harness(sdk, stop.signal);
  h.send(START);
  await h.waitFor(is('permission_request'));
  stop.abort();
  assert.equal(await h.done, 0);
  const out = outcome?.hookSpecificOutput;
  assert.ok(out && out.hookEventName === 'PreToolUse');
  assert.equal(out.permissionDecision, 'deny');
});

test('maps_last_tool_name_from_task_progress_and_omits_it_when_absent', () => {
  const progress = (extra: Record<string, unknown>): SdkMessageLike => ({
    type: 'system',
    subtype: 'task_progress',
    task_id: 'task-1',
    description: 'Research example-api',
    usage: { total_tokens: 10, tool_uses: 2, duration_ms: 1500 },
    ...extra,
    ...sid,
  });
  const base = {
    type: 'subagent',
    run_id: 'run-1',
    task_id: 'task-1',
    status: 'running',
    description: 'Research example-api',
    tool_uses: 2,
    duration_ms: 1500,
  };
  assert.deepEqual(mapMessage('run-1', progress({ last_tool_name: 'Read' })), [{ ...base, last_tool: 'Read' }]);
  // Absent or not a string: the key is left out, not sent as null.
  for (const extra of [{}, { last_tool_name: 7 }]) {
    const [event] = mapMessage('run-1', progress(extra)) ?? [];
    assert.ok(event && !('last_tool' in event), JSON.stringify(event));
  }
  // Only progress carries it.
  const [started] = mapMessage('run-1', {
    type: 'system',
    subtype: 'task_started',
    task_id: 'task-1',
    description: 'x',
    last_tool_name: 'Read',
    ...sid,
  }) ?? [];
  assert.ok(started && !('last_tool' in started));
});

test('stop_task_calls_the_runs_query_and_rejects_a_bad_task_id', async () => {
  const sdk = new FakeSdk(async function* ({ prompts }) {
    for (;;) {
      const next = await prompts.next();
      if (next.done) return;
      yield* [];
    }
  });
  const h = harness(sdk);
  h.send(START);
  await h.waitFor(is('ready'));
  const at100 = 'a'.repeat(100);
  h.send({ type: 'stop_task', run_id: 'run-1', task_id: 'task_1.a:b-2' });
  h.send({ type: 'stop_task', run_id: 'run-1', task_id: at100 });
  // Each of these is discarded with a log line that does not repeat the id.
  const bad = ['', 'a'.repeat(101), 'two words', 'a/b', 'line\nbreak', 'caf\u00e9', '../x'];
  for (const task_id of bad) h.send({ type: 'stop_task', run_id: 'run-1', task_id });
  h.send({ type: 'stop_task', run_id: '', task_id: 't-1' });
  // A non-string id is a malformed line too.
  h.input.write(JSON.stringify({ type: 'stop_task', run_id: 'run-1', task_id: 7 }) + '\n');
  h.send({ type: 'shutdown' });
  assert.equal(await h.done, 0);
  assert.deepEqual(sdk.stoppedTasks, [
    ['run-1', 'task_1.a:b-2'],
    ['run-1', at100],
  ]);
  const warnings = h.events.filter((e) => e.type === 'log' && e.level === 'warn');
  assert.equal(warnings.length, bad.length + 2);
  assert.ok(!h.raw.some((l) => ['two words', 'break', 'caf', '../x'].some((id) => l.includes(id))), 'a log line repeated an id');
  // The run was not stopped or interrupted.
  assert.deepEqual(sdk.interrupted, []);
});

test('stop_task_for_an_unknown_run_reports_no_run', async () => {
  const sdk = new FakeSdk(async function* () {
    yield* [];
  });
  const h = harness(sdk);
  h.send({ type: 'stop_task', run_id: 'run-9', task_id: 't-1' });
  const failure = await h.waitFor(is('failure'));
  assert.equal(failure.run_id, 'run-9');
  assert.equal(failure.message, 'no active run with this id');
  assert.deepEqual(sdk.stoppedTasks, []);
  h.send({ type: 'shutdown' });
  assert.equal(await h.done, 0);
});

test('a_refused_stop_task_is_logged_and_the_run_goes_on', async () => {
  const sdk = new FakeSdk(async function* ({ prompts }) {
    for (;;) {
      const next = await prompts.next();
      if (next.done) return;
      yield { type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text: `echo: ${next.value}` }] }, ...sid };
    }
  });
  sdk.stopTaskError = new Error('no such task secret-detail\nsecond line');
  const h = harness(sdk);
  h.send(START);
  h.send({ type: 'stop_task', run_id: 'run-1', task_id: 't-1' });
  const warn = await h.waitFor((e): e is Event => e.type === 'log' && e.level === 'warn');
  // The text is fixed: nothing of the SDK's error (its message, any line of it) or of the task id.
  assert.equal(warn.type === 'log' && warn.message, 'stopping a task failed');
  h.send({ type: 'user_message', run_id: 'run-1', text: 'still here' });
  await h.waitFor((e): e is Event => e.type === 'text' && e.text === 'echo: still here');
  h.send({ type: 'shutdown' });
  assert.equal(await h.done, 0);
});

test('only a successful result carries the bounded final answer', () => {
  const base = { type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0, num_turns: 1, usage: {} };
  const [ok] = mapMessage('run-1', { ...base, result: 'final answer' }) ?? [];
  assert.equal(ok?.type === 'result' && ok.final_text, 'final answer');
  const [failed] = mapMessage('run-1', { ...base, subtype: 'error', is_error: true, result: 'untrusted error' }) ?? [];
  assert.equal(failed?.type === 'result' && 'final_text' in failed, false);
  const [at] = mapMessage('run-1', { ...base, result: 'x'.repeat(165_000) }) ?? [];
  assert.equal(at?.type === 'result' && at.final_text?.length, 165_000);
  const [long] = mapMessage('run-1', { ...base, result: 'x'.repeat(165_001) }) ?? [];
  assert.equal(long?.type === 'result' && long.final_text?.length, 165_000);
});


test('twenty maximal drafts fit without truncation and escaped text fits the frame', () => {
  const base = { type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0, num_turns: 1, usage: {} };
  const drafts = Array.from({length: 20}, (_, i) => `<<<qirei-draft T${i+1}>>>\n${'😀'.repeat(4000)}\n<<<end>>>\n`).join('');
  const [result] = mapMessage('run-1', { ...base, result: drafts }) ?? [];
  assert.ok(result?.type === 'result' && result.final_text === drafts);
  const [escaped] = mapMessage('run-1', { ...base, result: '\u0001'.repeat(165_000) }) ?? [];
  const line = escaped && encodeEvent(escaped);
  assert.ok(line);
  assert.ok(Buffer.byteLength(line) <= MAX_LINE_BYTES + 1);
});
