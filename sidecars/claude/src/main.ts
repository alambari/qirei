/**
 * Entry point: protocol commands on stdin, protocol events on stdout, nothing else on stdout.
 * Started by the daemon with `node dist/src/main.js`.
 */
import { format } from 'node:util';
import { RealSdk } from './sdk.js';
import { encodeEvent } from './protocol.js';
import { runSidecar } from './sidecar.js';

// A stray console call from a dependency must not corrupt the protocol stream.
for (const k of ['log', 'info', 'debug', 'warn', 'error'] as const) {
  console[k] = (...args: unknown[]) => void process.stderr.write(format(...args) + '\n');
}

// When the daemon closes our stdout (EPIPE), stop like at the end of input and exit 0.
const outputGone = new AbortController();
process.stdout.on('error', () => outputGone.abort());

const exit = (code: number) => {
  if (outputGone.signal.aborted) process.exit(code);
  process.stdout.write('', () => process.exit(code));
};

process.on('uncaughtException', (err) => {
  const line = encodeEvent({ type: 'failure', message: `sidecar crashed: ${err.name}` });
  if (line !== undefined && !outputGone.signal.aborted) process.stdout.write(line);
  exit(1);
});

const code = await runSidecar({
  input: process.stdin,
  write: (line) => {
    if (!outputGone.signal.aborted) process.stdout.write(line);
  },
  sdk: new RealSdk(),
  stop: outputGone.signal,
});
exit(code);
