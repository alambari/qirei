/**
 * The sidecar's command loop, independent of process stdio so tests can drive it in process.
 *
 * Reads commands, starts runs on the SDK adapter, relays their messages as events, and routes the
 * daemon's answers to the waiting gate. When the input ends or `shutdown` arrives, every pending
 * request is denied, every run is stopped, and the loop resolves with exit code 0.
 */
import { ApprovedCalls, PendingQuestions, PendingRequests, makeCanUseTool, makeGate } from './gate.js';
import { readLines } from './lines.js';
import { mapMessage, messageKind } from './map.js';
import { MAX_LINE_BYTES, PROTOCOL_VERSION, encodeEvent, parseCommand, type Event, type StartRun } from './protocol.js';
import { AsyncQueue } from './queue.js';
import { PendingReadpath, makeReadpathServer } from './readpath.js';
import type { SdkAdapter } from './sdk.js';

export interface SidecarIo {
  input: AsyncIterable<Uint8Array | string>;
  /** Writes one complete protocol line. Nothing else may reach stdout. */
  write: (line: string) => void;
  sdk: SdkAdapter;
  /** Aborted when the output is gone (the daemon closed our stdout); handled like the end of input. */
  stop?: AbortSignal;
}

interface Run {
  prompts: AsyncQueue<string>;
  task: Promise<void>;
}

/** How long shutdown waits for runs to wind down before the process exits anyway. */
const STOP_GRACE_MS = 5_000;
const ERROR_CHARS = 500;

/** One line of an error, cut short; error text from the SDK names a failure, not user data. */
function errorMessage(err: unknown): string {
  const text = err instanceof Error ? err.message : 'unknown error';
  const line = text.split('\n')[0] ?? '';
  return line.length > ERROR_CHARS ? line.slice(0, ERROR_CHARS - 1) + '…' : line || 'unknown error';
}

/** Iterates `src` until it ends or `signal` aborts, whichever comes first. */
async function* untilAborted<T>(src: AsyncIterable<T>, signal?: AbortSignal): AsyncGenerator<T> {
  if (!signal) {
    yield* src;
    return;
  }
  const it = src[Symbol.asyncIterator]();
  const aborted = new Promise<IteratorResult<T>>((resolve) => {
    const done = () => resolve({ value: undefined, done: true });
    if (signal.aborted) done();
    else signal.addEventListener('abort', done, { once: true });
  });
  try {
    for (;;) {
      const r = await Promise.race([it.next(), aborted]);
      if (r.done) return;
      yield r.value;
    }
  } finally {
    void it.return?.()?.catch(() => undefined);
  }
}

export async function runSidecar({ input, write, sdk, stop }: SidecarIo): Promise<number> {
  const permissions = new PendingRequests();
  const questions = new PendingQuestions();
  const readpath = new PendingReadpath();
  const runs = new Map<string, Run>();
  const ignoredKinds = new Set<string>();

  const send = (e: Event): boolean => {
    const line = encodeEvent(e);
    if (line !== undefined) {
      write(line);
      return true;
    }
    const note = encodeEvent({ type: 'log', level: 'warn', message: `dropped a ${e.type} event over the ${MAX_LINE_BYTES} byte limit` });
    if (note !== undefined) write(note);
    return false;
  };
  const log = (level: string, message: string) => void send({ type: 'log', level, message });

  const startRun = (start: StartRun) => {
    const id = start.run_id;
    if (runs.has(id)) {
      send({ type: 'failure', run_id: id, message: 'a run with this id is already active' });
      return;
    }
    const prompts = new AsyncQueue<string>();
    prompts.push(start.prompt);
    const approved = new ApprovedCalls();
    const hooks = {
      preToolUse: makeGate(send, permissions, id, approved),
      canUseTool: makeCanUseTool(send, { questions, permissions, approved }, id, log),
      readpath: makeReadpathServer(send, readpath, id),
    };
    const run: Run = { prompts, task: Promise.resolve() };
    runs.set(id, run);
    run.task = (async () => {
      try {
        for await (const msg of sdk.run(start, hooks, prompts)) {
          const events = mapMessage(id, msg);
          if (events === undefined) {
            const kind = messageKind(msg);
            if (!ignoredKinds.has(kind)) {
              ignoredKinds.add(kind);
              log('debug', `ignored SDK message ${kind}`);
            }
            continue;
          }
          for (const e of events) send(e);
        }
      } catch (err) {
        send({ type: 'failure', run_id: id, message: errorMessage(err) });
      } finally {
        prompts.close();
        if (runs.get(id) === run) runs.delete(id);
      }
    })();
  };

  const stopRun = async (id: string) => {
    const run = runs.get(id);
    run?.prompts.close();
    try {
      await sdk.stop(id);
    } catch (err) {
      log('warn', `stopping a run failed: ${errorMessage(err)}`);
    }
  };

  const noRun = (id: string) => send({ type: 'failure', run_id: id, message: 'no active run with this id' });

  send({ type: 'ready', protocol_version: PROTOCOL_VERSION, sdk_version: sdk.version });

  const lines = readLines(untilAborted(input, stop), MAX_LINE_BYTES, (bytes) =>
    log('warn', `discarded a command line of ${bytes} bytes over the ${MAX_LINE_BYTES} byte limit`),
  );
  loop: for await (const line of lines) {
    if (line.trim() === '') continue;
    const parsed = parseCommand(line);
    if (!parsed.ok) {
      log('warn', `discarded a malformed command line of ${Buffer.byteLength(line, 'utf8')} bytes`);
      continue;
    }
    const cmd = parsed.command;
    switch (cmd.type) {
      case 'start':
        startRun(cmd);
        break;
      case 'user_message':
        if (!runs.get(cmd.run_id)?.prompts.push(cmd.text)) noRun(cmd.run_id);
        break;
      case 'interrupt':
        if (!runs.has(cmd.run_id)) noRun(cmd.run_id);
        else sdk.interrupt(cmd.run_id).catch((err: unknown) => log('warn', `interrupt failed: ${errorMessage(err)}`));
        break;
      case 'stop':
        await stopRun(cmd.run_id);
        break;
      case 'stop_task':
        // Fixed text: neither the task id nor the SDK's error message is logged, because an SDK
        // error can quote what it was given and a log line names a failure only.
        if (!runs.has(cmd.run_id)) noRun(cmd.run_id);
        else sdk.stopTask(cmd.run_id, cmd.task_id).catch(() => log('warn', 'stopping a task failed'));
        break;
      case 'answer_permission':
        if (!permissions.answer(cmd.request_id, cmd.decision)) log('warn', 'an answer arrived for no pending permission request');
        break;
      case 'answer_question':
        if (!questions.answer(cmd.request_id, cmd.answers)) log('warn', 'an answer arrived for no pending question');
        break;
      case 'answer_readpath':
        if (!readpath.answer(cmd.request_id, cmd.result)) log('warn', 'an answer arrived for no pending read path request');
        break;
      case 'shutdown':
        break loop;
    }
  }

  // The daemon is gone or asked us to stop: nothing may stay allowed-by-default.
  const active = [...runs];
  permissions.closeAll();
  questions.closeAll();
  readpath.closeAll();
  await Promise.all(active.map(([id]) => stopRun(id)));
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([
    Promise.all(active.map(([, r]) => r.task)),
    new Promise((resolve) => (timer = setTimeout(resolve, STOP_GRACE_MS))),
  ]);
  clearTimeout(timer);
  return 0;
}
