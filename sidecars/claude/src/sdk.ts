/**
 * The boundary to the Claude Agent SDK. `RealSdk` is the only code that calls `query()`; tests use a
 * scripted adapter instead. The options built here hold no policy: no settings files, no allow
 * rules, the default permission mode, and every tool call routed through the PreToolUse gate.
 */
import {
  query,
  type AgentDefinition,
  type CanUseTool,
  type HookCallback,
  type McpSdkServerConfigWithInstance,
  type Options,
  type Query,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import type { AgentDefinitionDto, StartRun } from './protocol.js';
import { READPATH_SERVER } from './readpath.js';

/** The pinned SDK version, announced in `ready`. A test keeps it equal to package.json. */
export const SDK_VERSION = '0.3.316';

/** Seconds the SDK waits for the gate: one day, so an owner can answer a gate the next morning. */
export const GATE_TIMEOUT_SECONDS = 86_400;

/** The callbacks a run gives the SDK. Both only relay to the daemon. */
export interface GateHooks {
  preToolUse: HookCallback;
  canUseTool: CanUseTool;
  /** The in-process read path server; the run's own, relaying to the daemon. */
  readpath?: McpSdkServerConfigWithInstance;
}

/** An SDK message as the mapper reads it: a tagged object of unknown fields. */
export type SdkMessageLike = { readonly type: string; readonly [key: string]: unknown };

export interface SdkAdapter {
  /** SDK version announced in `ready`. */
  readonly version: string;
  /** Starts a run. `prompts` yields the first prompt and every later user message, and ends on stop. */
  run(start: StartRun, hooks: GateHooks, prompts: AsyncIterable<string>): AsyncIterable<SdkMessageLike>;
  interrupt(runId: string): Promise<void>;
  /** Ends one task (a subagent) of the run; the run itself goes on. */
  stopTask(runId: string, taskId: string): Promise<void>;
  /** Ends the run and its SDK process. */
  stop(runId: string): Promise<void>;
}

/**
 * The only variables the SDK child (and so every tool it runs) inherits from the sidecar. Anything
 * else, credentials included, arrives through `start.env` from the daemon.
 */
export const BASE_ENV_ALLOWLIST = [
  'PATH', 'HOME', 'USER', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'TMPDIR', 'SHELL', 'TZ', 'NODE_ENV',
] as const;

/** The SDK child's environment: allowlisted base variables, then the daemon's `start.env`. */
export function sdkEnv(start: StartRun): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of BASE_ENV_ALLOWLIST) {
    const v = process.env[k];
    if (v !== undefined) env[k] = v;
  }
  return { ...env, ...start.env };
}

/**
 * Maps one subagent to the SDK's `AgentDefinition` field names. A field the daemon left out is left
 * out, and the arrays are copied: nothing is added, checked or decided here.
 */
export function agentDefinition(a: AgentDefinitionDto): AgentDefinition {
  return {
    description: a.description,
    prompt: a.prompt,
    ...(a.tools === undefined ? {} : { tools: [...a.tools] }),
    ...(a.disallowed_tools === undefined ? {} : { disallowedTools: [...a.disallowed_tools] }),
    ...(a.model === undefined ? {} : { model: a.model }),
    ...(a.skills === undefined ? {} : { skills: [...a.skills] }),
    ...(a.mcp_servers === undefined ? {} : { mcpServers: [...a.mcp_servers] }),
    ...(a.max_turns === undefined ? {} : { maxTurns: a.max_turns }),
    ...(a.permission_mode === undefined ? {} : { permissionMode: a.permission_mode }),
  };
}

/** Builds the `query()` options for a run. Exported so a test can pin every value. */
export function buildOptions(start: StartRun, hooks: GateHooks): Options {
  return {
    cwd: start.cwd,
    // `env` replaces the child's environment entirely, so nothing outside the allowlist leaks in.
    env: sdkEnv(start),
    settingSources: [],
    allowedTools: [],
    permissionMode: 'default',
    includePartialMessages: false,
    hooks: { PreToolUse: [{ matcher: undefined, timeout: GATE_TIMEOUT_SECONDS, hooks: [hooks.preToolUse] }] },
    canUseTool: hooks.canUseTool,
    // The names only narrow the built-in tool set; an empty list keeps the SDK default rather
    // than removing every tool. Permission still comes from the gate alone.
    ...(start.allowed_tool_names.length > 0 ? { tools: [...start.allowed_tool_names] } : {}),
    // Always set: the SDK documents `skills` as the list of skills the main session may use, and
    // an empty list enables none. Without it the CLI's own defaults would apply. The names are
    // `<plugin>:<skill>`, built by the daemon, which also decides every Skill call.
    skills: [...(start.skills ?? [])],
    // Only the daemon's generated, read-only folder; no other plugin is ever loaded.
    ...(start.skills_plugin_dir ? { plugins: [{ type: 'local' as const, path: start.skills_plugin_dir }] } : {}),
    // Only the subagents the daemon sent; with none, no key, so the SDK adds none of its own.
    ...(start.agents && Object.keys(start.agents).length > 0
      ? { agents: Object.fromEntries(Object.entries(start.agents).map(([name, a]) => [name, agentDefinition(a)])) }
      : {}),
    // Only the connectors the daemon sent, as a program and arguments and no `env`: no value ever
    // travels with a connector. With none, no key.
    ...((start.mcp_servers && Object.keys(start.mcp_servers).length > 0) || hooks.readpath
      ? {
          mcpServers: {
            ...Object.fromEntries(
              Object.entries(start.mcp_servers ?? {}).map(([name, s]) => [name, { command: s.command, args: [...s.args] }]),
            ),
            // After the declared ones, so a connector of the same name cannot take its place.
            ...(hooks.readpath ? { [READPATH_SERVER]: hooks.readpath } : {}),
          },
        }
      : {}),
    // Only what `mcpServers` and the agent definitions name: no `.mcp.json` in the work folder,
    // no plugin's servers and no other configuration adds a connector the owner did not declare.
    strictMcpConfig: true,
    ...(start.model === undefined ? {} : { model: start.model }),
    ...(start.max_turns === undefined ? {} : { maxTurns: start.max_turns }),
    ...(start.max_budget_usd === undefined ? {} : { maxBudgetUsd: start.max_budget_usd }),
    ...(start.resume_session_id === undefined ? {} : { resume: start.resume_session_id }),
  };
}

async function* userMessages(prompts: AsyncIterable<string>): AsyncGenerator<SDKUserMessage> {
  for await (const text of prompts) {
    yield { type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null };
  }
}

/** Runs the real SDK with streaming input, one `query()` per run. */
export class RealSdk implements SdkAdapter {
  readonly version = SDK_VERSION;
  private readonly runs = new Map<string, Query>();

  run(start: StartRun, hooks: GateHooks, prompts: AsyncIterable<string>): AsyncIterable<SdkMessageLike> {
    const q = query({ prompt: userMessages(prompts), options: buildOptions(start, hooks) });
    this.runs.set(start.run_id, q);
    const runs = this.runs;
    return (async function* () {
      try {
        for await (const m of q) yield m;
      } finally {
        if (runs.get(start.run_id) === q) runs.delete(start.run_id);
      }
    })();
  }

  async interrupt(runId: string): Promise<void> {
    await this.runs.get(runId)?.interrupt();
  }

  async stopTask(runId: string, taskId: string): Promise<void> {
    await this.runs.get(runId)?.stopTask(taskId);
  }

  async stop(runId: string): Promise<void> {
    const q = this.runs.get(runId);
    this.runs.delete(runId);
    q?.close();
  }
}
