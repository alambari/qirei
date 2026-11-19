import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SDK_VERSION, buildOptions, type GateHooks } from '../src/sdk.js';
import type { StartRun } from '../src/protocol.js';

const hooks: GateHooks = {
  preToolUse: async () => ({}),
  canUseTool: async () => ({ behavior: 'deny', message: 'no' }),
};

const base: StartRun = { run_id: 'run-1', cwd: '/work/PROJ-123', prompt: 'p', allowed_tool_names: [], env: {} };

test('options_hold_no_policy_and_load_no_user_settings', () => {
  const o = buildOptions(base, hooks);
  assert.deepEqual(o.settingSources, []);
  assert.deepEqual(o.allowedTools, []);
  assert.equal(o.permissionMode, 'default');
  assert.equal(o.includePartialMessages, false);
  assert.equal(o.canUseTool, hooks.canUseTool);
  assert.deepEqual(o.hooks, { PreToolUse: [{ matcher: undefined, timeout: 86400, hooks: [hooks.preToolUse] }] });
  assert.equal(o.cwd, '/work/PROJ-123');
  assert.equal(o.allowDangerouslySkipPermissions, undefined);
  assert.equal(o.tools, undefined, 'no names: the SDK default tool set');
  for (const k of ['model', 'maxTurns', 'maxBudgetUsd', 'resume'] as const) assert.equal(k in o, false, k);
});

test('options carry the skills allowlist and the plugin folder', () => {
  const o = buildOptions(
    { ...base, skills: ['qirei-skills:alpha', 'qirei-skills:beta'], skills_plugin_dir: '/agent/run-1/skills-plugin' },
    hooks,
  );
  assert.deepEqual(o.skills, ['qirei-skills:alpha', 'qirei-skills:beta']);
  assert.deepEqual(o.plugins, [{ type: 'local', path: '/agent/run-1/skills-plugin' }]);
  assert.deepEqual(o.allowedTools, [], 'skill names never become allow rules');
  // The list is a copy: a later change to the command cannot reach the options.
  const start: StartRun = { ...base, skills: ['qirei-skills:alpha'], skills_plugin_dir: '/p' };
  const copy = buildOptions(start, hooks);
  start.skills?.push('qirei-skills:evil');
  assert.deepEqual(copy.skills, ['qirei-skills:alpha']);
});

test('no plugin without a folder', () => {
  // No skills at all: the list is still sent, empty, so the SDK offers the run none.
  const none = buildOptions(base, hooks);
  assert.deepEqual(none.skills, []);
  assert.equal('plugins' in none, false);
  // An empty folder name is no folder.
  const blank = buildOptions({ ...base, skills_plugin_dir: '' }, hooks);
  assert.equal('plugins' in blank, false);
  // Names without a folder still go through as the allowlist; they match nothing.
  const names = buildOptions({ ...base, skills: ['qirei-skills:alpha'] }, hooks);
  assert.deepEqual(names.skills, ['qirei-skills:alpha']);
  assert.equal('plugins' in names, false);
});

test('options_carry_the_start_fields', () => {
  const o = buildOptions(
    {
      ...base,
      model: 'claude-test',
      resume_session_id: 'sess-0',
      max_turns: 12,
      max_budget_usd: 2.5,
      allowed_tool_names: ['Read', 'AskUserQuestion'],
      env: { PATH: '/usr/bin', QIREI_EXAMPLE: '1' },
    },
    hooks,
  );
  assert.equal(o.model, 'claude-test');
  assert.equal(o.resume, 'sess-0');
  assert.equal(o.maxTurns, 12);
  assert.equal(o.maxBudgetUsd, 2.5);
  assert.deepEqual(o.tools, ['Read', 'AskUserQuestion']);
  assert.deepEqual(o.allowedTools, [], 'tool names never become allow rules');
  assert.equal(o.env?.['PATH'], '/usr/bin', 'start.env wins over process.env');
  assert.equal(o.env?.['QIREI_EXAMPLE'], '1');
  assert.equal(o.env?.['HOME'], process.env['HOME'], 'process.env is inherited');
});

test('sdk_version_matches_the_pinned_dependency', () => {
  const pkg = JSON.parse(
    readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'package.json'), 'utf8'),
  ) as { dependencies: Record<string, string> };
  assert.equal(SDK_VERSION, pkg.dependencies['@anthropic-ai/claude-agent-sdk']);
});

test('the sdk environment holds only allowlisted variables and start.env', () => {
  const planted = { QIREI_FAKE_SECRET: 'x1', EXAMPLE_API_TOKEN: 'x2', DATABASE_URL: 'x3', LANG: 'en_US.UTF-8', TZ: 'UTC' };
  const saved = new Map(Object.keys(planted).map((k) => [k, process.env[k]]));
  Object.assign(process.env, planted);
  try {
    const env = buildOptions({ ...base, env: { ANTHROPIC_API_KEY: 'from-daemon' } }, hooks).env ?? {};
    for (const k of ['QIREI_FAKE_SECRET', 'EXAMPLE_API_TOKEN', 'DATABASE_URL']) assert.equal(k in env, false, k);
    assert.equal(env['LANG'], 'en_US.UTF-8');
    assert.equal(env['TZ'], 'UTC');
    assert.equal(env['PATH'], process.env['PATH']);
    assert.equal(env['ANTHROPIC_API_KEY'], 'from-daemon');
    const allowed = new Set(['PATH', 'HOME', 'USER', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'TMPDIR', 'SHELL', 'TZ', 'NODE_ENV', 'ANTHROPIC_API_KEY']);
    for (const k of Object.keys(env)) assert.ok(allowed.has(k), `unexpected variable ${k}`);
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test('options map agents to the SDK field names', () => {
  const start: StartRun = {
    ...base,
    agents: {
      reviewer: {
        description: 'Reviews a diff',
        prompt: 'You review diffs.',
        tools: ['Read', 'Grep'],
        disallowed_tools: ['Bash'],
        model: 'sonnet',
        skills: ['qirei-skills:alpha'],
        mcp_servers: ['notes'],
        max_turns: 8,
        permission_mode: 'plan',
      },
      small: { description: 'd', prompt: 'p' },
    },
  };
  const o = buildOptions(start, hooks);
  assert.deepEqual(o.agents, {
    reviewer: {
      description: 'Reviews a diff',
      prompt: 'You review diffs.',
      tools: ['Read', 'Grep'],
      disallowedTools: ['Bash'],
      model: 'sonnet',
      skills: ['qirei-skills:alpha'],
      mcpServers: ['notes'],
      maxTurns: 8,
      permissionMode: 'plan',
    },
    // A field the daemon left out is left out: nothing is filled in.
    small: { description: 'd', prompt: 'p' },
  });
  // The sidecar adds no policy of its own to the main agent either.
  assert.equal(o.permissionMode, 'default');
  // The options hold copies, not the parsed command's arrays.
  start.agents!['reviewer']!.tools!.push('Write');
  assert.deepEqual(o.agents!['reviewer']!.tools, ['Read', 'Grep']);
});

test('options carry mcpServers without env', () => {
  const start: StartRun = {
    ...base,
    mcp_servers: {
      notes: { command: '/opt/tools/notes-server', args: ['--root=/work/notes'] },
      docs: { command: 'npx', args: [] },
    },
  };
  const o = buildOptions(start, hooks);
  assert.deepEqual(o.mcpServers, {
    notes: { command: '/opt/tools/notes-server', args: ['--root=/work/notes'] },
    docs: { command: 'npx', args: [] },
  });
  // Exactly a program and arguments: no env, no url, no type, no timeout.
  for (const server of Object.values(o.mcpServers ?? {})) {
    assert.deepEqual(Object.keys(server).sort(), ['args', 'command']);
  }
  // The arguments are copies.
  start.mcp_servers!['notes']!.args.push('--extra');
  assert.deepEqual((o.mcpServers!['notes'] as { args: string[] }).args, ['--root=/work/notes']);
  // The daemon's `start.env` is for the CLI, never for a server: nothing of it is copied over.
  const withEnv = buildOptions({ ...start, env: { ANTHROPIC_API_KEY: 'placeholder' } }, hooks);
  assert.equal(JSON.stringify(withEnv.mcpServers).includes('placeholder'), false);
  // Only the declared servers count: no other configuration adds one.
  assert.equal(o.strictMcpConfig, true);
  assert.equal(buildOptions(base, hooks).strictMcpConfig, true);
});

test('no mcpServers key when none are given', () => {
  assert.equal('mcpServers' in buildOptions(base, hooks), false);
  assert.equal('mcpServers' in buildOptions({ ...base, mcp_servers: {} }, hooks), false);
});

test('no agents key when none are given', () => {
  assert.equal('agents' in buildOptions(base, hooks), false);
  assert.equal('agents' in buildOptions({ ...base, agents: {} }, hooks), false);
});
