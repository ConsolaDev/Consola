// @effect-diagnostics nodeBuiltinImport:off - A test key for the server's pass check.
import { generateKeyPairSync } from 'node:crypto';
import { ThreadId } from '@t3tools/contracts';
import * as Effect from 'effect/Effect';
import * as HttpServerRequest from 'effect/http/HttpServerRequest';
import * as HttpServerResponse from 'effect/http/HttpServerResponse';
import { describe, expect, it } from 'vite-plus/test';
import { AGENT_RUN_TOOLS, toolValue } from '../core/agentRunTools.ts';
import type { AgentRunSession, ThreadHandle } from '../runtime/threadRuntime.ts';
import { MCP_PATH, serveMcp } from './mcpHttp.ts';
import { listenHost } from './rpcServer.ts';

const TOKEN = 'a-token-for-the-sprocket-orchestrator';
const ORCHESTRATOR = ThreadId.make('session-sprocket-run');
const CHILD = 'session-sprocket-run-review-1';

/** An agent run whose one token is `TOKEN`, and whose `delegate_task` only records the call. */
const fakeRun = () => {
  const calls: Array<{ caller: string; name: string; args: unknown }> = [];
  const agentRun = {
    tools: AGENT_RUN_TOOLS,
    threadForToken: (token: string) => (token === TOKEN ? ORCHESTRATOR : null),
    callTool: (caller: string, name: string, args: unknown) =>
      Effect.sync(() => {
        calls.push({ caller, name, args });
        return toolValue({
          taskId: CHILD,
          threadId: CHILD,
          status: 'running',
          next: 'End your turn.',
        });
      }),
  } as unknown as AgentRunSession;
  return { agentRun, calls };
};

const post = (body: unknown, headers: Record<string, string> = {}, method = 'POST') =>
  new Request(`http://127.0.0.1:7420${MCP_PATH}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
  });

const answer = async (agentRun: AgentRunSession, request: Request) => {
  const response = HttpServerResponse.toWeb(
    await Effect.runPromise(
      serveMcp(agentRun).pipe(
        Effect.provideService(
          HttpServerRequest.HttpServerRequest,
          HttpServerRequest.fromWeb(request),
        ),
      ),
    ),
  );
  const text = await response.text();
  return { status: response.status, body: text === '' ? null : JSON.parse(text) };
};

const bearer = { authorization: `Bearer ${TOKEN}` };
const listTools = { jsonrpc: '2.0', id: 1, method: 'tools/list' };

describe('serveMcp', () => {
  it('refuses a request with no token, a wrong one, or another method, before reading anything', async () => {
    const { agentRun, calls } = fakeRun();
    expect(await answer(agentRun, post(listTools))).toEqual({ status: 401, body: null });
    expect(await answer(agentRun, post(listTools, { authorization: `Bearer ${TOKEN}x` }))).toEqual({
      status: 401,
      body: null,
    });
    expect(await answer(agentRun, post(listTools, { authorization: TOKEN }))).toEqual({
      status: 401,
      body: null,
    });
    expect((await answer(agentRun, post(null, bearer, 'GET'))).status).toBe(405);
    expect((await answer(agentRun, post(null, bearer, 'DELETE'))).status).toBe(405);
    const unread = await answer(
      agentRun,
      post({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'delegate_task' } }),
    );
    expect(unread.status).toBe(401);
    expect(calls).toEqual([]);
  });

  it('initializes as a stateless tool server and hears notifications with 202', async () => {
    const { agentRun } = fakeRun();
    const initialized = await answer(
      agentRun,
      post(
        {
          jsonrpc: '2.0',
          id: 0,
          method: 'initialize',
          params: {
            protocolVersion: '2025-06-18',
            capabilities: {},
            clientInfo: { name: 'claude-code' },
          },
        },
        bearer,
      ),
    );
    expect(initialized).toEqual({
      status: 200,
      body: {
        jsonrpc: '2.0',
        id: 0,
        result: {
          protocolVersion: '2025-06-18',
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'consola-agent-run', version: '1.0.0' },
        },
      },
    });
    expect(
      await answer(agentRun, post({ jsonrpc: '2.0', method: 'notifications/initialized' }, bearer)),
    ).toEqual({ status: 202, body: null });
    expect(
      (await answer(agentRun, post({ jsonrpc: '2.0', id: 3, method: 'resources/list' }, bearer)))
        .body.error.code,
    ).toBe(-32_601);
  });

  it('lists the tools and answers a delegate_task call as the thread the token names', async () => {
    const { agentRun, calls } = fakeRun();
    const listed = await answer(agentRun, post(listTools, bearer));
    expect(listed.body.result.tools.map((tool: { name: string }) => tool.name)).toEqual(
      AGENT_RUN_TOOLS.map((tool) => tool.name),
    );

    const called = await answer(
      agentRun,
      post(
        {
          jsonrpc: '2.0',
          id: 4,
          method: 'tools/call',
          params: { name: 'delegate_task', arguments: { agent: 'review', task: 'Review #12.' } },
        },
        bearer,
      ),
    );
    expect(calls).toEqual([
      {
        caller: ORCHESTRATOR,
        name: 'delegate_task',
        args: { agent: 'review', task: 'Review #12.' },
      },
    ]);
    expect(called.status).toBe(200);
    expect(called.body.result.isError).toBe(false);
    expect(called.body.result.structuredContent).toEqual({
      taskId: CHILD,
      threadId: CHILD,
      status: 'running',
      next: 'End your turn.',
    });
    expect(JSON.parse(called.body.result.content[0].text)).toEqual(
      called.body.result.structuredContent,
    );
  });

  it('answers a batch in one body, and a body that is no JSON with a parse error', async () => {
    const { agentRun } = fakeRun();
    const batch = await answer(
      agentRun,
      post(
        [
          listTools,
          { jsonrpc: '2.0', method: 'notifications/initialized' },
          { jsonrpc: '2.0', id: 5, method: 'ping' },
        ],
        bearer,
      ),
    );
    expect(batch.body.map((each: { id: number }) => each.id)).toEqual([1, 5]);
    const broken = await answer(
      agentRun,
      new Request(`http://127.0.0.1:7420${MCP_PATH}`, {
        method: 'POST',
        headers: bearer,
        body: '{',
      }),
    );
    expect(broken).toEqual({
      status: 400,
      body: { jsonrpc: '2.0', id: null, error: { code: -32_700, message: 'Parse error' } },
    });
  });
});

/** `tools/list` to a listening host's `/mcp`, over the network. */
const sendListTools = (port: number, headers: Record<string, string>) =>
  // @effect-diagnostics-next-line globalFetch:off - a request over the network to the host's port.
  fetch(`http://127.0.0.1:${port}${MCP_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(listTools),
  });

describe('the host’s /mcp route', () => {
  const publicKeyPem = generateKeyPairSync('ed25519')
    .publicKey.export({ type: 'spki', format: 'pem' })
    .toString();

  const serving = (runtime: ThreadHandle) =>
    listenHost({
      port: 0,
      host: '127.0.0.1',
      sessionId: ORCHESTRATOR,
      publicKeyPem,
      runtime,
    });

  it('serves an agent run’s tools, and is a 404 like any other path for every other session', () =>
    Effect.gen(function* () {
      const { agentRun } = fakeRun();
      const run = yield* serving({ agentRun } as unknown as ThreadHandle);
      const plain = yield* serving({ agentRun: null } as unknown as ThreadHandle);
      const listed = yield* Effect.promise(() => sendListTools(run.port, bearer));
      expect(listed.status).toBe(200);
      expect(listed.headers.get('access-control-allow-origin')).toBeNull();
      const body = (yield* Effect.promise(() => listed.json())) as {
        result: { tools: unknown[] };
      };
      expect(body.result.tools).toHaveLength(AGENT_RUN_TOOLS.length);
      expect((yield* Effect.promise(() => sendListTools(run.port, {}))).status).toBe(401);
      expect((yield* Effect.promise(() => sendListTools(plain.port, bearer))).status).toBe(404);
    }).pipe(Effect.scoped, Effect.runPromise));
});
