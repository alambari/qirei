// A scripted stand-in for the Claude Agent SDK. Used only by tests; the sidecar never ships it.
import type { GateHooks, SdkAdapter, SdkMessageLike } from '../src/sdk.js';
import type { StartRun } from '../src/protocol.js';

export interface ScriptContext {
  start: StartRun;
  hooks: GateHooks;
  prompts: AsyncIterator<string>;
}

export type Script = (ctx: ScriptContext) => AsyncIterable<SdkMessageLike>;

export class FakeSdk implements SdkAdapter {
  readonly version = '0.0.0-fake';
  readonly interrupted: string[] = [];
  readonly stopped: string[] = [];
  readonly stoppedTasks: [string, string][] = [];
  /** When set, `stopTask` rejects with it (the SDK refuses an unknown task). */
  stopTaskError?: Error;

  constructor(private readonly script: Script) {}

  run(start: StartRun, hooks: GateHooks, prompts: AsyncIterable<string>): AsyncIterable<SdkMessageLike> {
    return this.script({ start, hooks, prompts: prompts[Symbol.asyncIterator]() });
  }

  async interrupt(runId: string): Promise<void> {
    this.interrupted.push(runId);
  }

  async stopTask(runId: string, taskId: string): Promise<void> {
    this.stoppedTasks.push([runId, taskId]);
    if (this.stopTaskError) throw this.stopTaskError;
  }

  async stop(runId: string): Promise<void> {
    this.stopped.push(runId);
  }
}
