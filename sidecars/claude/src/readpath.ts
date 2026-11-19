/**
 * The agent's door to the owner's databases: an in-process MCP server named `readpath` with two
 * tools, `query` and `sources`. It holds no policy and no credential. Each call is sent to the
 * daemon as a `readpath_request` or `readpath_sources` event and waits for `answer_readpath`;
 * the daemon decides (it has already judged the call at the gate), connects and masks.
 *
 * SDK names used here, from code.claude.com/docs/en/agent-sdk (checked against the pinned
 * package's types, not guessed):
 * - `createSdkMcpServer({ name, version, tools })` returns an `McpSdkServerConfigWithInstance`;
 * - `tool(name, description, zodRawShape, handler)` builds one tool; the handler returns a
 *   `CallToolResult` (`{ content: [{ type: 'text', text }], isError? }`);
 * - the server goes into `options.mcpServers` under its name, so its tools are called
 *   `mcp__readpath__query` and `mcp__readpath__sources`; `strictMcpConfig` leaves it alone
 *   because it is passed in code, and every call still passes the `PreToolUse` hook and
 *   `canUseTool`.
 */
import { randomUUID } from 'node:crypto';
import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { Pending } from './gate.js';
import type { Event } from './protocol.js';
import type { ReadpathResult } from './generated/ReadpathResult.js';

/** The server's name; the tools are `mcp__readpath__<tool>`. Equals `READPATH_SERVER` in core. */
export const READPATH_SERVER = 'readpath';
/** How long a call waits for the daemon's answer before it fails with a fixed text. */
export const READPATH_TIMEOUT_MS = 60_000;

/** Fixed texts: nothing of the request or of a failure is ever put in them. */
export const NO_ANSWER = 'The read path did not answer in time.';
const UNAVAILABLE = 'The read path is unavailable.';

/** Daemon answers keyed by request id; `null` when the connection closed or the wait ran out. */
export class PendingReadpath extends Pending<ReadpathResult | null> {
  constructor() {
    super(null);
  }
}

type Send = (e: Event) => boolean | void;
type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };

const text = (t: string, isError = false): ToolResult => ({
  content: [{ type: 'text', text: t }],
  ...(isError ? { isError: true } : {}),
});

/** Turns the daemon's answer into the tool's result; the daemon already masked and clipped it. */
function render(answer: ReadpathResult | null): ToolResult {
  if (answer === null) return text(NO_ANSWER, true);
  switch (answer.type) {
    case 'ok':
      return text(
        JSON.stringify({
          columns: answer.columns,
          rows: answer.rows,
          truncated: answer.truncated,
          masked_columns: answer.masked_columns,
        }),
      );
    case 'sources':
      return text(JSON.stringify(answer.sources));
    case 'error':
      return text(`The query was not run: ${answer.kind}`, true);
  }
}

/** Builds the `readpath` server for one run. */
export function makeReadpathServer(
  send: Send,
  pending: PendingReadpath,
  runId: string,
  timeoutMs: number = READPATH_TIMEOUT_MS,
): McpSdkServerConfigWithInstance {
  const ask = async (event: (requestId: string) => Event, signal?: AbortSignal): Promise<ToolResult> => {
    if (pending.isClosed) return text(UNAVAILABLE, true);
    const requestId = randomUUID();
    const timeout = AbortSignal.timeout(timeoutMs);
    const answer = pending.wait(requestId, signal ? AbortSignal.any([signal, timeout]) : timeout);
    // An event too large for the line is never sent; the wait is ended at once.
    if (send(event(requestId)) === false) pending.answer(requestId, null);
    return render(await answer);
  };
  return createSdkMcpServer({
    name: READPATH_SERVER,
    version: '1.0.0',
    tools: [
      tool(
        'query',
        'Runs one read-only SQL statement on a configured database source and returns masked, size-limited rows. Use the sources tool to list the source names.',
        { source: z.string(), statement: z.string() },
        async (args) =>
          ask((request_id) => ({
            type: 'readpath_request',
            run_id: runId,
            request_id,
            source: args.source,
            statement: args.statement,
          })),
      ),
      tool('sources', 'Lists the configured database sources: name, engine and environment.', {}, async () =>
        ask((request_id) => ({ type: 'readpath_sources', run_id: runId, request_id })),
      ),
    ],
  });
}
