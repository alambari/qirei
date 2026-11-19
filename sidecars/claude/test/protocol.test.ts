import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_LINE_BYTES, encodeEvent, parseCommand } from '../src/protocol.js';

test('start accepts null optionals and drops them', () => {
  const p = parseCommand(
    JSON.stringify({ type: 'start', run_id: 'r', cwd: '/w', prompt: 'p', model: null, max_turns: null, allowed_tool_names: [], env: {} }),
  );
  assert.deepEqual(p, { ok: true, command: { type: 'start', run_id: 'r', cwd: '/w', prompt: 'p', allowed_tool_names: [], env: {} } });
});

test('start parses skills and the plugin folder', () => {
  const start = { type: 'start', run_id: 'r', cwd: '/w', prompt: 'p', allowed_tool_names: [], env: {} };
  assert.deepEqual(
    parseCommand(JSON.stringify({ ...start, skills: ['qirei-skills:example-docs'], skills_plugin_dir: '/agent/r/skills-plugin' })),
    { ok: true, command: { ...start, skills: ['qirei-skills:example-docs'], skills_plugin_dir: '/agent/r/skills-plugin' } },
  );
  // Both are optional, and `null` is dropped like any other optional field.
  assert.deepEqual(parseCommand(JSON.stringify({ ...start, skills: null, skills_plugin_dir: null })), { ok: true, command: start });
  assert.deepEqual(parseCommand(JSON.stringify({ ...start, skills: [] })), { ok: true, command: { ...start, skills: [] } });
});

test('start rejects non-string skills', () => {
  const start = { type: 'start', run_id: 'r', cwd: '/w', prompt: 'p', allowed_tool_names: [], env: {} };
  for (const extra of [
    { skills: 'qirei-skills:a' },
    { skills: [1] },
    { skills: ['a', null] },
    { skills: { a: 'b' } },
    { skills_plugin_dir: 3 },
    { skills_plugin_dir: ['/x'] },
  ]) {
    const p = parseCommand(JSON.stringify({ ...start, ...extra }));
    assert.equal(p.ok, false, JSON.stringify(extra));
  }
});

test('start parses agents', () => {
  const start = { type: 'start', run_id: 'r', cwd: '/w', prompt: 'p', allowed_tool_names: [], env: {} };
  const full = {
    description: 'Reviews a diff',
    prompt: 'You review diffs.',
    tools: ['Read', 'Grep'],
    disallowed_tools: ['Bash'],
    model: 'sonnet',
    skills: ['qirei-skills:alpha'],
    mcp_servers: ['notes'],
    max_turns: 8,
    permission_mode: 'plan',
  };
  assert.deepEqual(parseCommand(JSON.stringify({ ...start, agents: { reviewer: full } })), {
    ok: true,
    command: { ...start, agents: { reviewer: full } },
  });
  // Only description and prompt are required; `null` optionals are dropped like any other.
  const minimal = { description: 'd', prompt: 'p' };
  const nulls = { ...minimal, tools: null, disallowed_tools: null, model: null, skills: null, mcp_servers: null, max_turns: null, permission_mode: null };
  assert.deepEqual(parseCommand(JSON.stringify({ ...start, agents: { a: nulls } })), {
    ok: true,
    command: { ...start, agents: { a: minimal } },
  });
  for (const mode of ['default', 'plan', 'dontAsk']) {
    assert.equal(parseCommand(JSON.stringify({ ...start, agents: { a: { ...minimal, permission_mode: mode } } })).ok, true, mode);
  }
  // Absent or null: no agents. An empty map is kept as an empty map.
  assert.deepEqual(parseCommand(JSON.stringify({ ...start, agents: null })), { ok: true, command: start });
  assert.deepEqual(parseCommand(JSON.stringify({ ...start, agents: {} })), { ok: true, command: { ...start, agents: {} } });
});

test('start parses mcp servers', () => {
  const start = { type: 'start', run_id: 'r', cwd: '/w', prompt: 'p', allowed_tool_names: [], env: {} };
  const servers = {
    notes: { command: '/opt/tools/notes-server', args: ['--root=/work/notes'] },
    docs: { command: 'npx', args: [] },
  };
  assert.deepEqual(parseCommand(JSON.stringify({ ...start, mcp_servers: servers })), {
    ok: true,
    command: { ...start, mcp_servers: servers },
  });
  // Absent or null: none. An empty map is kept as an empty map.
  assert.deepEqual(parseCommand(JSON.stringify({ ...start, mcp_servers: null })), { ok: true, command: start });
  assert.deepEqual(parseCommand(JSON.stringify({ ...start, mcp_servers: {} })), { ok: true, command: { ...start, mcp_servers: {} } });
  // A name such as `__proto__` is a plain name.
  const parsed = parseCommand(`{"type":"start","run_id":"r","cwd":"/w","prompt":"p","allowed_tool_names":[],"env":{},"mcp_servers":{"__proto__":{"command":"x","args":[]}}}`);
  assert.equal(parsed.ok, true);
  if (parsed.ok && parsed.command.type === 'start') {
    assert.deepEqual(Object.keys(parsed.command.mcp_servers ?? {}), ['__proto__']);
    assert.equal(Object.getPrototypeOf(parsed.command.mcp_servers), Object.prototype);
  }
});

test('rejects a server with env', () => {
  const start = { type: 'start', run_id: 'r', cwd: '/w', prompt: 'p', allowed_tool_names: [], env: {} };
  const ok = { command: 'x', args: [] };
  for (const mcp_servers of [
    'a',
    ['a'],
    { a: 'text' },
    { a: null },
    { a: { ...ok, env: { KEY: 'value' } } },
    { a: { ...ok, env: {} } },
    { a: { ...ok, url: 'http://localhost:3000' } },
    { a: { ...ok, type: 'stdio' } },
    { a: { ...ok, headers: {} } },
    { a: { command: 'x' } },
    { a: { args: [] } },
    { a: { command: 1, args: [] } },
    { a: { command: 'x', args: 'y' } },
    { a: { command: 'x', args: [1] } },
    { good: ok, bad: { ...ok, env: {} } },
  ]) {
    const parsed = parseCommand(JSON.stringify({ ...start, mcp_servers }));
    assert.equal(parsed.ok, false, JSON.stringify(mcp_servers));
    // The reason never quotes the line.
    if (!parsed.ok) assert.equal(parsed.reason.includes('KEY'), false);
  }
});

test('rejects a malformed agent', () => {
  const start = { type: 'start', run_id: 'r', cwd: '/w', prompt: 'p', allowed_tool_names: [], env: {} };
  const ok = { description: 'd', prompt: 'p' };
  for (const agents of [
    'a',
    ['a'],
    { a: 'text' },
    { a: null },
    { a: ['x'] },
    { a: { description: 'd' } },
    { a: { prompt: 'p' } },
    { a: { ...ok, description: 1 } },
    { a: { ...ok, tools: 'Read' } },
    { a: { ...ok, tools: [1] } },
    { a: { ...ok, disallowed_tools: { a: 'b' } } },
    { a: { ...ok, skills: 'x' } },
    { a: { ...ok, mcp_servers: [null] } },
    { a: { ...ok, model: 3 } },
    { a: { ...ok, max_turns: '3' } },
    { a: { ...ok, max_turns: null, permission_mode: 'bypassPermissions' } },
    { a: { ...ok, permission_mode: 'acceptEdits' } },
    { a: { ...ok, permission_mode: 'auto' } },
    { a: { ...ok, permission_mode: 7 } },
    { good: ok, bad: { ...ok, tools: 3 } },
  ]) {
    const p = parseCommand(JSON.stringify({ ...start, agents }));
    assert.equal(p.ok, false, JSON.stringify(agents));
    if (!p.ok) assert.ok(!p.reason.includes('bypassPermissions') && !p.reason.includes('acceptEdits'));
  }
});

test('malformed commands are rejected without echoing content', () => {
  for (const line of [
    'nope',
    '{"type":"launch"}',
    '{"type":"answer_permission","request_id":"x","decision":{"type":"allow_always"}}',
    '{"type":"answer_permission","request_id":"x","decision":{"type":"deny"}}',
    '{"type":"answer_question","request_id":"x","answers":{"q":"not a list"}}',
    '{"type":"start","run_id":"r","cwd":"/w","prompt":"p","allowed_tool_names":[],"env":{"K":1}}',
  ]) {
    const p = parseCommand(line);
    assert.equal(p.ok, false, line);
    if (!p.ok) assert.ok(!p.reason.includes('allow_always') && !p.reason.includes('not a list'));
  }
});

test('answers parse into their protocol shape', () => {
  assert.deepEqual(parseCommand('{"type":"answer_permission","request_id":"x","decision":{"type":"allow","updated_input":null}}'), {
    ok: true,
    command: { type: 'answer_permission', request_id: 'x', decision: { type: 'allow' } },
  });
  assert.deepEqual(parseCommand('{"type":"answer_question","request_id":"x","answers":{"q":["a","b"]}}'), {
    ok: true,
    command: { type: 'answer_question', request_id: 'x', answers: { q: ['a', 'b'] } },
  });
});

test('an event over the line limit is not encoded', () => {
  assert.equal(encodeEvent({ type: 'log', level: 'info', message: 'x'.repeat(MAX_LINE_BYTES) }), undefined);
  assert.equal(encodeEvent({ type: 'log', level: 'info', message: 'ok' }), '{"type":"log","level":"info","message":"ok"}\n');
});
