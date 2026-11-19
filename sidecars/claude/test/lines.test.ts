import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readLines } from '../src/lines.js';

async function* chunks(parts: Array<string | Uint8Array>): AsyncGenerator<Uint8Array> {
  for (const p of parts) yield typeof p === 'string' ? Buffer.from(p, 'utf8') : p;
}

async function collect(
  parts: Array<string | Uint8Array>,
  maxBytes: number,
): Promise<{ lines: string[]; oversized: number[] }> {
  const oversized: number[] = [];
  const lines: string[] = [];
  for await (const line of readLines(chunks(parts), maxBytes, (n) => oversized.push(n))) lines.push(line);
  return { lines, oversized };
}

test('partial_lines_are_joined_across_chunks', async () => {
  const e = Buffer.from('é', 'utf8');
  const { lines, oversized } = await collect(
    ['{"a"', ':1}\n{"b":', '2}\r\n', Buffer.from([0x22, e[0]!]), Buffer.from([e[1]!, 0x22, 0x0a]), 'tail'],
    1024,
  );
  assert.deepEqual(lines, ['{"a":1}', '{"b":2}', '"é"', 'tail']);
  assert.deepEqual(oversized, []);
});

test('oversized_line_is_discarded_and_reported_once', async () => {
  const long = 'x'.repeat(25);
  const parts = ['short\n', long.slice(0, 7), long.slice(7, 14), long.slice(14), '\nok\n'];
  const { lines, oversized } = await collect(parts, 10);
  assert.deepEqual(lines, ['short', 'ok']);
  assert.deepEqual(oversized, [25]);
});

test('a line of exactly the limit is kept', async () => {
  const { lines, oversized } = await collect(['y'.repeat(10) + '\n', 'z'.repeat(11) + '\n'], 10);
  assert.deepEqual(lines, ['y'.repeat(10)]);
  assert.deepEqual(oversized, [11]);
});

test('an oversized line in one chunk with its newline is reported once', async () => {
  const { lines, oversized } = await collect(['a'.repeat(30) + '\nb\n' + 'c'.repeat(12)], 10);
  assert.deepEqual(lines, ['b']);
  assert.deepEqual(oversized, [30, 12]);
});
