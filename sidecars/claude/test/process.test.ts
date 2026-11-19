import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Event } from '../src/protocol.js';

const MAIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'main.js');

/** Starts the built sidecar, feeds it `input`, then returns its exit code and every stdout line. */
function runProcess(feed: (stdin: NodeJS.WritableStream) => void): Promise<{ code: number | null; lines: string[] }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [MAIN], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d: string) => (out += d));
    child.stderr.resume();
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('sidecar did not exit'));
    }, 15000);
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, lines: out.split('\n').filter((l) => l.length > 0) });
    });
    feed(child.stdin);
  });
}

const parse = (lines: string[]) => lines.map((l) => JSON.parse(l) as Event);

test('ready_is_first_and_carries_the_protocol_version', async () => {
  const { code, lines } = await runProcess((s) => s.end('{"type":"shutdown"}\n'));
  assert.equal(code, 0);
  const events = parse(lines);
  assert.deepEqual(events[0], { type: 'ready', protocol_version: 1, sdk_version: '0.3.316' });
});

test('shutdown_exits_0', async () => {
  const { code, lines } = await runProcess((s) => s.write('{"type":"shutdown"}\n'));
  assert.equal(code, 0);
  assert.equal(parse(lines).length, 1);
});

test('stdin_end_exits_0', async () => {
  const { code } = await runProcess((s) => s.end());
  assert.equal(code, 0);
});

test('an_oversized_stdin_line_is_discarded_and_reported_once', async () => {
  const size = 1.5 * 1024 * 1024;
  const { code, lines } = await runProcess((s) => {
    const chunk = 'x'.repeat(64 * 1024);
    for (let i = 0; i < size / chunk.length; i++) s.write(chunk);
    s.write('\n');
    s.write('not json\n');
    s.end('{"type":"shutdown"}\n');
  });
  assert.equal(code, 0);
  const events = parse(lines);
  assert.equal(events[0]?.type, 'ready');
  const logs = events.filter((e) => e.type === 'log');
  assert.equal(logs.length, 2, JSON.stringify(logs));
  assert.deepEqual(logs[0], { type: 'log', level: 'warn', message: `discarded a command line of ${size} bytes over the 1048576 byte limit` });
  assert.deepEqual(logs[1], { type: 'log', level: 'warn', message: 'discarded a malformed command line of 8 bytes' });
  assert.ok(lines.every((l) => Buffer.byteLength(l) < 4096), 'nothing of the long line is echoed');
});

test('a closed stdout makes the sidecar exit 0', async () => {
  const code = await new Promise<number | null>((resolve, reject) => {
    const child = spawn(process.execPath, [MAIN], { stdio: ['pipe', 'pipe', 'pipe'] });
    child.stderr.resume();
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('sidecar did not exit'));
    }, 15000);
    child.on('close', (c) => {
      clearTimeout(timer);
      resolve(c);
    });
    child.stdout.once('data', () => {
      // The daemon goes away: close our end of stdout, then make the sidecar write.
      child.stdout.destroy();
      const poke = setInterval(() => child.stdin.write('not json\n', () => undefined), 20);
      child.on('close', () => clearInterval(poke));
    });
    child.stdin.on('error', () => undefined);
  });
  assert.equal(code, 0);
});
