import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { PendingReadpath, makeReadpathServer, NO_ANSWER } from '../src/readpath.js';
import { buildOptions } from '../src/sdk.js';
import { parseCommand, type Event, type StartRun } from '../src/protocol.js';

async function connect(timeoutMs = 2000) {
  const sent: Event[] = [];
  const pending = new PendingReadpath();
  const server = makeReadpathServer((e) => void sent.push(e), pending, 'run-1', timeoutMs);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.instance.connect(b);
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(a);
  return { sent, pending, client };
}

const tick = () => new Promise((r) => setTimeout(r, 5));
const textOf = (r: unknown) => ((r as { content: { text: string }[] }).content[0] as { text: string }).text;

test('the server exposes exactly query and sources', async () => {
  const { client } = await connect();
  const tools = (await client.listTools()).tools.map((t) => t.name).sort();
  assert.deepEqual(tools, ['query', 'sources']);
});

test('query sends one readpath_request and returns the answer text', async () => {
  const { sent, pending, client } = await connect();
  const call = client.callTool({ name: 'query', arguments: { source: 'example', statement: 'select 1' } });
  await tick();
  assert.equal(sent.length, 1);
  const req = sent[0]!;
  assert.equal(req.type, 'readpath_request');
  if (req.type !== 'readpath_request') return;
  assert.equal(req.run_id, 'run-1');
  assert.equal(req.source, 'example');
  assert.equal(req.statement, 'select 1');
  pending.answer(req.request_id, { type: 'ok', columns: ['n'], rows: [['1']], truncated: false, masked_columns: [] });
  const result = await call;
  assert.equal(result.isError, undefined);
  assert.deepEqual(JSON.parse(textOf(result)), { columns: ['n'], rows: [['1']], truncated: false, masked_columns: [] });
});

test('an error answer is an error result with the kind only', async () => {
  const { sent, pending, client } = await connect();
  const call = client.callTool({ name: 'query', arguments: { source: 'example', statement: 'drop table secrets' } });
  await tick();
  const req = sent[0]!;
  if (req.type !== 'readpath_request') throw new Error('no request');
  pending.answer(req.request_id, { type: 'error', kind: 'only reading statements are allowed' });
  const result = await call;
  assert.equal(result.isError, true);
  assert.equal(textOf(result), 'The query was not run: only reading statements are allowed');
});

test('sources sends readpath_sources', async () => {
  const { sent, pending, client } = await connect();
  const call = client.callTool({ name: 'sources', arguments: {} });
  await tick();
  const req = sent[0]!;
  assert.equal(req.type, 'readpath_sources');
  if (req.type !== 'readpath_sources') return;
  pending.answer(req.request_id, { type: 'sources', sources: [{ name: 'example', engine: 'postgres', environment: 'staging' }] });
  assert.deepEqual(JSON.parse(textOf(await call)), [{ name: 'example', engine: 'postgres', environment: 'staging' }]);
});

test('a missing answer times out with a fixed error', async () => {
  const { client } = await connect(30);
  const result = await client.callTool({ name: 'query', arguments: { source: 'example', statement: 'select 1' } });
  assert.equal(result.isError, true);
  assert.equal(textOf(result), NO_ANSWER);
});

test('a closed connection fails a call at once', async () => {
  const { pending, client } = await connect();
  pending.closeAll();
  const result = await client.callTool({ name: 'query', arguments: { source: 'example', statement: 'select 1' } });
  assert.equal(result.isError, true);
});

test('options register the in-process server after declared connectors', () => {
  const start: StartRun = {
    type: undefined as never,
    run_id: 'r',
    cwd: '/work',
    prompt: 'p',
    allowed_tool_names: [],
    env: {},
    mcp_servers: { readpath: { command: '/bin/evil', args: [] } },
  } as unknown as StartRun;
  const pending = new PendingReadpath();
  const server = makeReadpathServer(() => undefined, pending, 'r');
  const o = buildOptions(start, {
    preToolUse: async () => ({}),
    canUseTool: async () => ({ behavior: 'deny', message: 'x' }),
    readpath: server,
  });
  assert.equal((o.mcpServers as Record<string, { type?: string }>)['readpath']?.type, 'sdk');
});

test('answer_readpath is parsed and a malformed one is refused', () => {
  const ok = parseCommand(
    JSON.stringify({ type: 'answer_readpath', run_id: 'r', request_id: 'q', result: { type: 'error', kind: 'k' } }),
  );
  assert.equal(ok.ok, true);
  const bad = parseCommand(JSON.stringify({ type: 'answer_readpath', run_id: 'r', request_id: 'q', result: { type: 'ok', rows: 'x' } }));
  assert.equal(bad.ok, false);
});
