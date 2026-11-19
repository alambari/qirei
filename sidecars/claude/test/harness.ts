import { PassThrough } from 'node:stream';
import type { Command, Event } from '../src/protocol.js';
import { runSidecar } from '../src/sidecar.js';
import type { SdkAdapter } from '../src/sdk.js';

/** Runs the sidecar in process over an in-memory stdin, collecting every event it writes. */
export function harness(sdk: SdkAdapter, stop?: AbortSignal) {
  const input = new PassThrough();
  const events: Event[] = [];
  const raw: string[] = [];
  const done = runSidecar({
    input,
    write: (line) => {
      raw.push(line);
      events.push(JSON.parse(line) as Event);
    },
    sdk,
    ...(stop ? { stop } : {}),
  });
  const send = (cmd: Command) => input.write(JSON.stringify(cmd) + '\n');
  const waitFor = async <T extends Event>(pred: (e: Event) => e is T, ms = 2000): Promise<T> => {
    const until = Date.now() + ms;
    for (;;) {
      const hit = events.find(pred);
      if (hit) return hit;
      if (Date.now() > until) throw new Error(`timed out; events so far: ${JSON.stringify(events)}`);
      await new Promise((r) => setTimeout(r, 2));
    }
  };
  return { input, events, raw, done, send, waitFor };
}

export const is =
  <K extends Event['type']>(type: K) =>
  (e: Event): e is Extract<Event, { type: K }> =>
    e.type === type;

export const START = {
  type: 'start',
  run_id: 'run-1',
  cwd: '/work/PROJ-123',
  prompt: 'Look at PROJ-123',
  allowed_tool_names: [],
  env: {},
} as const satisfies Command;
