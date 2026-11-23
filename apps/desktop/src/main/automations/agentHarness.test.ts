import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { AgentHarnessQuery, EntryAgentsView } from '@consola/automation-engine';
import type { Harness } from '../../shared/harness';
import type { HarnessCapabilitiesResult } from '../../shared/types';
import { getDriver, type HarnessDriver, toolPolicyProblem } from '../drivers';
import type { McpServerReport } from '../drivers/HarnessDriver';
import type { HarnessCapabilitiesCache } from '../HarnessCapabilitiesCache';
import {
  agentHarnessRefusal,
  agentHarnessView,
  cachedModels,
  harnessesWithServers,
  noAgentGrants,
  settledServerTools,
  withKnownTools,
  type WriteAgentHostDeps,
  writeAgentHost,
  writeAgentHostNow,
} from './agentHarness';
import type { McpServersCache, ServersAnswer } from './mcpServersCache';

/** A harness record named Stub, on the claude driver unless `fields` say otherwise. */
function harness(fields: Partial<Harness> = {}): Harness {
  return {
    id: 'stub',
    driverId: 'claude',
    name: 'Stub',
    accentColor: '#888888',
    enabled: true,
    archived: false,
    isBuiltIn: false,
    extraArgs: [],
    createdAt: 0,
    updatedAt: 0,
    ...fields,
  };
}

/** The view of a workspace whose default is `record` (none: no harness record at all). */
const defaultView = (record: Harness | undefined) =>
  agentHarnessView({ harnesses: record ? [record] : [], defaultHarnessId: record?.id });

describe('agentHarnessView, for the default harness', () => {
  it('answers which harnesses can run steps', () => {
    expect(defaultView(harness({ extraArgs: ['--max-turns', '50'] }))).toEqual({
      name: 'Stub',
      problem: null,
      stepProblem:
        "This harness's extra arguments set `--max-turns`, which would override what Consola launches each step's turn with. Remove it in Settings › Harnesses.",
    });
  });

  it('names every flag a step turn compiles that the extra arguments set', () => {
    expect(
      defaultView(harness({ extraArgs: ['--output-format=text', '--max-turns', '9'] })).stepProblem,
    ).toBe(
      "This harness's extra arguments set `--output-format` and `--max-turns`, which would override what Consola launches each step's turn with. Remove them in Settings › Harnesses.",
    );
  });

  it('keeps today’s read-only refusal, and that is no step problem', () => {
    expect(defaultView(harness({ extraArgs: ['--settings', '{}'] }))).toEqual({
      name: 'Stub',
      problem:
        "This harness's extra arguments (--settings) would loosen a read-only session, so automations cannot start sessions on it. Remove them in Settings › Harnesses, or make another harness this workspace’s default.",
      stepProblem: null,
    });
  });

  it('answers for the built-in Claude when the workspace has no harness', () => {
    expect(defaultView(undefined)).toEqual({ name: 'Claude', problem: null, stepProblem: null });
  });

  it('a driver with no step turns to override has no step problem', () => {
    expect(
      defaultView(harness({ driverId: 'codex', extraArgs: ['--max-turns', '50'] })).stepProblem,
    ).toBeNull();
  });

  it('a harness’s own --model is no step problem when no agent sets one', () => {
    expect(defaultView(harness({ extraArgs: ['--model', 'sonnet'] }))).toStrictEqual({
      name: 'Stub',
      problem: null,
      stepProblem: null,
    });
  });
});

describe('agentHarnessView, for an agent', () => {
  const HARNESSES: Harness[] = [
    harness({ id: 'default', name: 'Claude', isBuiltIn: true }),
    harness({ id: 'claude-work', name: 'Claude work' }),
    harness({ id: 'old', name: 'Old', archived: true }),
    harness({ id: 'off', name: 'Off', enabled: false }),
    harness({ id: 'codex-1', name: 'Codex', driverId: 'codex' }),
  ];
  const query = (fields: Partial<AgentHarnessQuery> = {}): AgentHarnessQuery => ({
    mcpServers: [],
    skills: [],
    checkout: 'scope',
    ...fields,
  });
  const view = (
    agent: AgentHarnessQuery,
    harnesses: Harness[] = HARNESSES,
    modelsOf?: (record: Harness | undefined) => readonly string[] | undefined,
  ) =>
    agentHarnessView({
      harnesses,
      defaultHarnessId: 'default',
      agent,
      ...(modelsOf ? { modelsOf } : {}),
    });
  const UNKNOWN =
    "`nope` is not one of Consola's harnesses: add it in Settings › Harnesses, or change `harness:`";

  it("an agent with no harness: the workspace default's answer, with nothing more to say", () => {
    expect(view(query())).toEqual({
      name: 'Claude',
      problem: null,
      stepProblem: null,
      agentProblem: null,
      warning: null,
    });
  });

  it('the harness it names', () => {
    expect(view(query({ harnessId: 'claude-work' }))).toEqual({
      name: 'Claude work',
      problem: null,
      stepProblem: null,
      agentProblem: null,
      warning: null,
    });
  });

  it.each([
    ['nope', UNKNOWN, 'nope'],
    ['old', '`old` is archived: change `harness:` to a harness in use', 'Old'],
    ['off', '`off` is turned off: turn it on in Settings › Harnesses, or change `harness:`', 'Off'],
  ])('a harness it cannot run on: %s', (harnessId, agentProblem, name) => {
    expect(view(query({ harnessId }))).toMatchObject({ name, agentProblem });
  });

  it('an unknown harness has nothing else to check', () => {
    expect(view(query({ harnessId: 'nope', model: 'opus' }))).toEqual({
      name: 'nope',
      problem: null,
      stepProblem: null,
      agentProblem: UNKNOWN,
      warning: null,
    });
  });

  it("a Codex harness gives the Codex driver's own read-only refusal, and why it runs no agent", () => {
    const codex = view(query({ harnessId: 'codex-1' }));
    expect(codex.problem).toBe(toolPolicyProblem({ driverId: 'codex' }, 'read-only'));
    expect(codex.problem).not.toBeNull();
    expect(codex.agentProblem).toBe(
      `${codex.problem} Steps on Codex arrive later; they need a Codex harness with a home of its own.`,
    );
  });

  it("a model the agent sets is one more flag the harness's extra arguments may not set", () => {
    const pinned = [
      ...HARNESSES,
      harness({ id: 'pinned', name: 'Pinned', extraArgs: ['--model', 'sonnet'] }),
    ];
    expect(view(query({ harnessId: 'pinned', model: 'opus' }), pinned).stepProblem).toBe(
      "This harness's extra arguments set `--model`, which would override what Consola launches each step's turn with. Remove it in Settings › Harnesses.",
    );
    expect(view(query({ harnessId: 'pinned' }), pinned).stepProblem).toBeNull();
  });

  it('warns of a model the harness does not list, and never blocks on it', () => {
    const models = (record: Harness | undefined) =>
      record?.id === 'claude-work' ? ['opus', 'claude-opus-5-5'] : undefined;
    const on = (model: string) =>
      view(query({ harnessId: 'claude-work', model }), HARNESSES, models);
    expect(on('opus').warning).toBeNull();
    expect(on('claude-opus-5-5').warning).toBeNull();
    expect(on('opus-9')).toEqual({
      name: 'Claude work',
      problem: null,
      stepProblem: null,
      agentProblem: null,
      warning:
        "`opus-9` is not among the models Claude work lists; `--model` also takes a model's full name, and a step on a model the CLI does not have fails.",
    });
    // No list: nothing to check against.
    expect(view(query({ harnessId: 'claude-work', model: 'opus-9' })).warning).toBeNull();
    expect(view(query({ model: 'opus-9' }), HARNESSES, models).warning).toBeNull();
    // No model: nothing to check.
    expect(view(query({ harnessId: 'claude-work' }), HARNESSES, models).warning).toBeNull();
  });

  it('asks for the models of the harness the agent runs on', () => {
    const asked: Array<string | undefined> = [];
    const models = (record: Harness | undefined) => {
      asked.push(record?.id);
      return [];
    };
    view(query({ harnessId: 'claude-work', model: 'opus' }), HARNESSES, models);
    view(query({ model: 'opus' }), HARNESSES, models);
    view(query({ harnessId: 'nope', model: 'opus' }), HARNESSES, models);
    // No model, nothing to check it against.
    view(query({ harnessId: 'claude-work' }), HARNESSES, models);
    // An unknown harness has no models to ask for.
    expect(asked).toEqual(['claude-work', 'default']);
  });
});

describe("agentHarnessView, for an agent's servers and skills", () => {
  const SLACK = 'https://mcp.slack.example/mcp';
  const GRAFANA: McpServerReport = {
    name: 'grafana',
    source: 'user',
    transport: 'stdio',
    tools: ['query_logs'],
    status: 'connected',
  };
  const NEEDS_AUTH_SLACK: McpServerReport = {
    name: 'claude.ai Slack',
    source: 'connector',
    transport: 'claudeai-proxy',
    url: SLACK,
    status: 'needs-auth',
  };
  const HARNESSES: Harness[] = [
    harness({ id: 'default', name: 'Claude', isBuiltIn: true }),
    harness({ id: 'claude-work', name: 'Claude work', configDir: '/home/alice/.claude-work' }),
    harness({ id: 'off', name: 'Off', enabled: false }),
    harness({ id: 'codex-1', name: 'Codex', driverId: 'codex' }),
    harness({ id: 'codex-off', name: 'Codex off', driverId: 'codex', enabled: false }),
    harness({ id: 'agy-1', name: 'Antigravity', driverId: 'antigravity' }),
    harness({ id: 'pinned', name: 'Pinned', extraArgs: ['--mcp-config', 'x.json'] }),
  ];
  const query = (fields: Partial<AgentHarnessQuery> = {}): AgentHarnessQuery => ({
    harnessId: 'claude-work',
    mcpServers: [],
    skills: [],
    checkout: 'scope',
    ...fields,
  });
  /** The view with `answer` as every harness's servers; records what it was asked. */
  const view = (
    agent: AgentHarnessQuery,
    answer: ServersAnswer = { state: 'settled', servers: [GRAFANA] },
    driverFor?: (id?: Harness['driverId']) => HarnessDriver,
  ) => {
    const serversNow = vi.fn((_harness: Harness | undefined) => answer);
    const missingServers = vi.fn();
    const result = agentHarnessView({
      harnesses: HARNESSES,
      defaultHarnessId: 'default',
      agent,
      serversNow,
      missingServers,
      ...(driverFor ? { driverFor } : {}),
    });
    return { result, serversNow, missingServers };
  };
  const GRAFANA_AGENT = { mcpServers: [{ name: 'grafana' }] };

  it('a server its harness has: nothing to say, no warning, and its tools as the CLI listed them', () => {
    const { result, serversNow } = view(query(GRAFANA_AGENT));
    expect(result).toEqual({
      name: 'Claude work',
      problem: null,
      stepProblem: null,
      agentProblem: null,
      warning: null,
      serverWarnings: [],
      knownTools: { grafana: ['query_logs'] },
    });
    expect(serversNow).toHaveBeenCalledWith(HARNESSES[1]);
  });

  it('gives each whole server its tools from the answer it compiled against, and a narrowed or untooled one none (review S1)', () => {
    const coralogix: McpServerReport = {
      name: 'claude.ai Coralogix',
      source: 'connector',
      transport: 'claudeai-proxy',
      url: 'https://mcp.coralogix.example/mcp',
      tools: ['query_logs', 'list_alerts'],
      status: 'connected',
    };
    const tracker: McpServerReport = {
      name: 'tracker',
      source: 'user',
      transport: 'http',
      url: 'https://tracker.example/mcp',
      status: 'pending',
    };
    const answer: ServersAnswer = { state: 'settled', servers: [GRAFANA, coralogix, tracker] };
    const { result } = view(
      query({
        mcpServers: [
          { name: 'claude.ai Coralogix' },
          { name: 'grafana', tools: ['query_logs'] },
          { name: 'tracker' },
        ],
      }),
      answer,
    );
    expect(result.serversProblem ?? null).toBeNull();
    expect(result.knownTools).toEqual({ 'claude.ai Coralogix': ['query_logs', 'list_alerts'] });
    // A copy: the cached answer is never handed out to be kept.
    expect(result.knownTools?.['claude.ai Coralogix']).not.toBe(coralogix.tools);

    // A refused compile lists nothing.
    const refused = view(query({ ...GRAFANA_AGENT, checkout: 'item' }), answer).result;
    expect(refused.serversProblem).toBeTruthy();
    expect(refused).not.toHaveProperty('knownTools');
    // Nor does an agent naming skills alone.
    expect(view(query({ skills: ['incident-triage'] }), answer).result).not.toHaveProperty(
      'knownTools',
    );
  });

  it("the person's own server on an item step is refused, at the servers", () => {
    const { result } = view(query({ ...GRAFANA_AGENT, checkout: 'item' }));
    expect(result.agentProblem).toBeNull();
    expect(result.serversProblem).toBe(
      "`grafana` comes from Claude work's own settings, and a step on someone else's pull request or issue starts it, or a helper command it runs for its sign-in, inside the author's checkout, where `npx`, `uvx` or a relative path can run the author's code. On item steps, use a claude.ai connector; this server works in scheduled steps.",
    );
  });

  it('a probe under way: the entry waits', () => {
    const { result } = view(query(GRAFANA_AGENT), { state: 'pending' });
    expect(result.serversPending).toBe(
      'Asking Claude work which MCP servers it has; this applies once it answers.',
    );
    expect(result.serversProblem ?? null).toBeNull();
    expect(result.serversUnknown ?? null).toBeNull();
  });

  it('a probe that failed: why, as the entry’s problem', () => {
    const { result } = view(query(GRAFANA_AGENT), {
      state: 'failed',
      error: 'spawn claude ENOENT',
    });
    expect(result.serversUnknown).toBe(
      "Couldn't ask Claude work which MCP servers it has: spawn claude ENOENT",
    );
    expect(result.serversProblem ?? null).toBeNull();
    expect(result.serversPending ?? null).toBeNull();
  });

  it('a name its harness lacks: refused with what it has, and asked about once more', () => {
    const { result, missingServers } = view(
      query({ mcpServers: [{ name: 'grafanna' }, { name: 'grafana' }, { name: 'tracker' }] }),
    );
    expect(result.serversProblem).toBe(
      "`grafanna` isn't one of Claude work's MCP servers (it has: grafana). Add it with `claude mcp add --scope user`, or fix the name.",
    );
    expect(result.agentProblem).toBeNull();
    expect(missingServers).toHaveBeenCalledTimes(1);
    expect(missingServers).toHaveBeenCalledWith(HARNESSES[1], ['grafanna', 'tracker']);
  });

  it('with no way to ask the CLI, says it could not', () => {
    const result = agentHarnessView({
      harnesses: HARNESSES,
      defaultHarnessId: 'default',
      agent: query(GRAFANA_AGENT),
    });
    expect(result.serversUnknown).toBe(
      "Couldn't ask Claude work which MCP servers it has: its CLI is not asked here.",
    );
  });

  it('skills alone ask no CLI and say nothing', () => {
    const { result, serversNow, missingServers } = view(query({ skills: ['incident-triage'] }));
    expect(serversNow).not.toHaveBeenCalled();
    expect(missingServers).not.toHaveBeenCalled();
    expect(result).toEqual({
      name: 'Claude work',
      problem: null,
      stepProblem: null,
      agentProblem: null,
      warning: null,
      serverWarnings: [],
    });
  });

  it('a server that needs a sign-in is a warning, never a problem', () => {
    const { result } = view(query({ mcpServers: [{ name: 'claude.ai Slack' }] }), {
      state: 'settled',
      servers: [NEEDS_AUTH_SLACK],
    });
    expect(result.serversProblem ?? null).toBeNull();
    expect(result.serverWarnings).toEqual([
      '`claude.ai Slack` needs you to sign in again in Claude work: run `claude`, then /mcp.',
    ]);
  });

  it("a harness's own --mcp-config is a step problem only for an agent with servers", () => {
    expect(view(query({ harnessId: 'pinned', ...GRAFANA_AGENT })).result.stepProblem).toBe(
      "This harness's extra arguments set `--mcp-config`, which would override what Consola launches each step's turn with. Remove it in Settings › Harnesses.",
    );
    expect(view(query({ harnessId: 'pinned' })).result.stepProblem).toBeNull();
  });

  it('a harness turned off says so, and its CLI is not asked', () => {
    const { result, serversNow } = view(query({ harnessId: 'off', ...GRAFANA_AGENT }));
    expect(result.agentProblem).toBe(
      '`off` is turned off: turn it on in Settings › Harnesses, or change `harness:`',
    );
    expect(serversNow).not.toHaveBeenCalled();
    expect(result.serversProblem ?? null).toBeNull();
  });

  it('a Codex harness: its read-only refusal, then why it runs no agent, servers or not', () => {
    const refusal = toolPolicyProblem({ driverId: 'codex' }, 'read-only');
    for (const agent of [
      query({ harnessId: 'codex-1' }),
      query({ harnessId: 'codex-1', ...GRAFANA_AGENT }),
    ]) {
      const { result, serversNow } = view(agent);
      expect(result.agentProblem).toBe(
        `${refusal} Steps on Codex arrive later; they need a Codex harness with a home of its own.`,
      );
      expect(serversNow).not.toHaveBeenCalled();
    }
  });

  it('a Codex harness turned off says that first', () => {
    expect(view(query({ harnessId: 'codex-off' })).result.agentProblem).toBe(
      '`codex-off` is turned off: turn it on in Settings › Harnesses, or change `harness:`',
    );
  });

  it('a narrowing reaches the compile: a tool the server lacks is refused', () => {
    const { result } = view(query({ mcpServers: [{ name: 'grafana', tools: ['post_logs'] }] }));
    expect(result.serversProblem).toBe('`grafana` has no tool `post_logs` (it has: query_logs).');
  });

  it('an Antigravity harness: its own read-only refusal is the reason, and its CLI is not asked', () => {
    const refusal = toolPolicyProblem({ driverId: 'antigravity' }, 'read-only');
    expect(refusal).not.toBeNull();
    const named = view(query({ harnessId: 'agy-1', ...GRAFANA_AGENT }));
    expect(named.result).toMatchObject({ problem: refusal, agentProblem: null });
    expect(named.serversNow).not.toHaveBeenCalled();
    expect(view(query({ harnessId: 'agy-1' })).result).toEqual({
      name: 'Antigravity',
      problem: refusal,
      stepProblem: null,
      agentProblem: null,
      warning: null,
    });
  });

  it("a driver's reason it runs no agent steps stands alone where it has no read-only refusal", () => {
    const later = {
      ...getDriver('claude'),
      agentRefusal: 'Steps here arrive later.',
    } as HarnessDriver;
    const { result, serversNow } = view(query(GRAFANA_AGENT), undefined, () => later);
    expect(result.problem).toBeNull();
    expect(result.agentProblem).toBe('Steps here arrive later.');
    expect(serversNow).not.toHaveBeenCalled();
  });

  it('a driver that runs read-only but compiles no agent refuses one that names servers or skills', () => {
    const plain = { ...getDriver('claude'), compileAgent: undefined } as HarnessDriver;
    const driverFor = () => plain;
    for (const agent of [query(GRAFANA_AGENT), query({ skills: ['incident-triage'] })]) {
      const { result, serversNow } = view(agent, undefined, driverFor);
      expect(result.agentProblem).toBe(noAgentGrants('Claude work'));
      expect(serversNow).not.toHaveBeenCalled();
    }
    expect(noAgentGrants('Claude work')).toBe(
      "Claude work can't give an agent MCP servers or skills.",
    );
    // An agent that names neither has nothing for it to compile.
    expect(view(query(), undefined, driverFor).result.agentProblem).toBeNull();
  });
});

describe('harnessesWithServers', () => {
  const HARNESSES: Harness[] = [
    harness({ id: 'work', name: 'Claude work', configDir: '/home/alice/.claude-work' }),
    harness({ id: 'pending', name: 'Pending', configDir: '/home/alice/.p' }),
    harness({ id: 'failed', name: 'Failed', configDir: '/home/alice/.f', enabled: false }),
    harness({ id: 'never', name: 'Never', configDir: '/home/alice/.n', archived: true }),
  ];
  const answers: Record<string, ServersAnswer> = {
    '/home/alice/.claude-work': {
      state: 'settled',
      servers: [
        {
          name: 'tracker',
          source: 'user',
          transport: 'http',
          url: 'https://t.example',
          status: 'connected',
        },
        { name: 'grafana', source: 'user', transport: 'stdio', status: 'failed' },
      ],
    },
    '/home/alice/.p': { state: 'pending' },
    '/home/alice/.f': { state: 'failed', error: 'spawn claude ENOENT' },
  };
  const throws = () => {
    throw new Error('describing capabilities must start nothing');
  };
  const cache = {
    peek: (_driver: HarnessDriver, config: { configDir?: string }) =>
      answers[config.configDir ?? ''],
    ask: throws,
    get: throws,
    missing: throws,
  } as unknown as McpServersCache;

  it('names the servers of each harness whose answer has settled, and asks nothing', () => {
    expect(harnessesWithServers(HARNESSES, cache)).toStrictEqual([
      {
        id: 'work',
        name: 'Claude work',
        enabled: true,
        archived: false,
        servers: ['tracker', 'grafana'],
      },
      { id: 'pending', name: 'Pending', enabled: true, archived: false },
      { id: 'failed', name: 'Failed', enabled: false, archived: false },
      { id: 'never', name: 'Never', enabled: true, archived: true },
    ]);
  });
});

describe('withKnownTools', () => {
  const VIEW: EntryAgentsView = {
    version: 'v1',
    readsItems: true,
    agents: [
      {
        name: 'investigator',
        file: 'agents/investigator.md',
        harnessId: 'work',
        body: 'B',
        mcpServers: [
          { name: 'claude.ai Coralogix' },
          { name: 'grafana', tools: ['query_logs'] },
          { name: 'tracker' },
        ],
        skills: ['incident-triage'],
      },
      { name: 'summariser', file: 'agents/summariser.md', body: 'S', mcpServers: [], skills: [] },
    ],
  };
  const asked: Array<[string | undefined, string]> = [];
  const toolsOf = (harnessId: string | undefined, server: string) => {
    asked.push([harnessId, server]);
    return server === 'claude.ai Coralogix'
      ? ['query_logs', 'list_alerts']
      : server === 'grafana'
        ? ['query_logs', 'list_dashboards']
        : undefined;
  };

  it("gives a whole server its harness's known tools, never a narrowed one, and leaves the rest as it was", () => {
    asked.length = 0;
    const own = (object: object, key: string) => Object.prototype.hasOwnProperty.call(object, key);
    const shown = withKnownTools(VIEW, toolsOf);
    expect(shown.version).toBe('v1');
    expect(shown.readsItems).toBe(true);
    const [coralogix, grafana, tracker] = shown.agents[0].mcpServers;
    expect(coralogix).toEqual({
      name: 'claude.ai Coralogix',
      knownTools: ['query_logs', 'list_alerts'],
    });
    expect(grafana).toEqual({ name: 'grafana', tools: ['query_logs'] });
    expect(own(tracker, 'knownTools')).toBe(false);
    expect(shown.agents[0].skills).toEqual(['incident-triage']);
    expect(shown.agents[1]).toEqual(VIEW.agents[1]);
    // A narrowed server is never asked about; each whole one is, with its agent's harness.
    expect(asked).toEqual([
      ['work', 'claude.ai Coralogix'],
      ['work', 'tracker'],
    ]);
    // The view it was given is unchanged.
    expect(own(VIEW.agents[0].mcpServers[0], 'knownTools')).toBe(false);
  });
});

describe('settledServerTools', () => {
  const HARNESSES: Harness[] = [
    harness({ id: 'work', name: 'Work stub', configDir: '/home/alice/.claude-work' }),
    harness({ id: 'personal', name: 'Personal stub', configDir: '/home/alice/.claude-personal' }),
    harness({ id: 'slow', name: 'Slow', configDir: '/home/alice/.slow' }),
  ];
  const answers: Record<string, ServersAnswer> = {
    '/home/alice/.claude-work': {
      state: 'settled',
      servers: [
        {
          name: 'claude.ai Coralogix',
          source: 'connector',
          transport: 'claudeai-proxy',
          url: 'https://mcp.coralogix.example/mcp',
          tools: ['query_logs', 'list_alerts'],
          status: 'connected',
        },
        { name: 'grafana', source: 'user', transport: 'stdio', status: 'failed' },
      ],
    },
    '/home/alice/.claude-personal': {
      state: 'settled',
      servers: [
        {
          name: 'claude.ai Coralogix',
          source: 'connector',
          transport: 'claudeai-proxy',
          url: 'https://mcp.coralogix.example/mcp',
          tools: ['list_alerts'],
          status: 'connected',
        },
      ],
    },
    '/home/alice/.slow': { state: 'pending' },
    // The built-in harness, which pins no config folder.
    '': {
      state: 'settled',
      servers: [
        {
          name: 'claude.ai Coralogix',
          source: 'connector',
          transport: 'claudeai-proxy',
          url: 'https://mcp.coralogix.example/mcp',
          tools: ['built_in_only'],
          status: 'connected',
        },
      ],
    },
  };
  const throws = () => {
    throw new Error('opening a card must start nothing');
  };
  const cache = {
    peek: (_driver: HarnessDriver, config: { configDir?: string }) =>
      answers[config.configDir ?? ''],
    ask: throws,
    get: throws,
    missing: throws,
  } as unknown as McpServersCache;

  it("reads the agent's harness's settled answer, else the workspace default's, and asks nothing", () => {
    const toolsOf = settledServerTools(cache, HARNESSES, 'personal');
    expect(toolsOf('work', 'claude.ai Coralogix')).toEqual(['query_logs', 'list_alerts']);
    expect(toolsOf(undefined, 'claude.ai Coralogix')).toEqual(['list_alerts']);
    // A server the answer lists without tools, one it lacks, an answer not settled, a harness not there.
    expect(toolsOf('work', 'grafana')).toBeUndefined();
    expect(toolsOf('work', 'tracker')).toBeUndefined();
    expect(toolsOf('slow', 'claude.ai Coralogix')).toBeUndefined();
    expect(toolsOf('gone', 'claude.ai Coralogix')).toBeUndefined();
  });

  it('reads the built-in harness for an agent naming none in a workspace with no default, and never for a harness not there', () => {
    const toolsOf = settledServerTools(cache, HARNESSES, undefined);
    expect(toolsOf(undefined, 'claude.ai Coralogix')).toEqual(['built_in_only']);
    expect(toolsOf('gone', 'claude.ai Coralogix')).toBeUndefined();
  });
});

describe('agentHarnessRefusal', () => {
  it('refuses an unknown, an archived and a turned-off harness, archived first', () => {
    const harnesses = [
      harness({ id: 'ok' }),
      harness({ id: 'gone', archived: true, enabled: false }),
    ];
    expect(agentHarnessRefusal(harnesses, 'ok')).toBeNull();
    expect(agentHarnessRefusal(harnesses, 'gone')).toBe(
      '`gone` is archived: change `harness:` to a harness in use',
    );
    expect(agentHarnessRefusal([], 'ok')).toBe(
      "`ok` is not one of Consola's harnesses: add it in Settings › Harnesses, or change `harness:`",
    );
  });
});

describe('cachedModels', () => {
  const claudeWork = harness({
    id: 'claude-work',
    name: 'Claude work',
    configDir: '/home/alice/.claude-work',
  });
  const settled = (result: HarnessCapabilitiesResult | undefined) => ({ peek: () => result });

  it("a settled supported answer: each model's value and the model it resolves to", () => {
    expect(
      cachedModels(
        settled({
          supported: true,
          commands: [],
          agents: [],
          outputStyles: [],
          models: [
            {
              value: 'opus',
              resolvedModel: 'claude-opus-5-5',
              displayName: 'Opus',
              description: '',
            },
            {
              value: 'haiku',
              resolvedModel: 'claude-haiku-5-5',
              displayName: 'Haiku',
              description: '',
            },
          ],
        }),
        claudeWork,
      ),
    ).toEqual(['opus', 'claude-opus-5-5', 'haiku', 'claude-haiku-5-5']);
  });

  it('an unsupported answer, or none, gives no list', () => {
    expect(cachedModels(settled({ supported: false, reason: 'No.' }), claudeWork)).toBeUndefined();
    expect(cachedModels(settled(undefined), claudeWork)).toBeUndefined();
  });

  it("peeks with the harness's driver and its launch config", () => {
    const seen: unknown[][] = [];
    const peek: HarnessCapabilitiesCache['peek'] = (...args) => {
      seen.push(args);
      return undefined;
    };
    cachedModels({ peek }, claudeWork);
    cachedModels({ peek }, undefined);
    expect(seen).toEqual([
      [
        getDriver('claude'),
        { binaryPath: undefined, configDir: '/home/alice/.claude-work', extraArgs: [] },
      ],
      [getDriver('claude'), { binaryPath: undefined, configDir: undefined, extraArgs: [] }],
    ]);
  });
});

describe('agentHarnessView and the host, for a write agent (slice 3-B Task 17)', () => {
  const HOST = {
    platform: 'darwin',
    denyRead: ['/h/.ssh'],
    cliVersion: '2.1.330',
    settingsFiles: [],
  };
  const HARNESSES: Harness[] = [
    harness({ id: 'default', name: 'Claude', isBuiltIn: true }),
    harness({ id: 'claude-work', name: 'Claude work', configDir: '/h/.claude-work' }),
    harness({ id: 'codex-work', name: 'codex-work', driverId: 'codex' }),
    harness({ id: 'antigravity-work', name: 'antigravity-work', driverId: 'antigravity' }),
  ];
  const WRITE_AGENT: AgentHarnessQuery = {
    harnessId: 'claude-work',
    mcpServers: [],
    skills: [],
    checkout: 'run-owned',
    tools: 'write',
    environment: { name: 'sandboxed', isolation: 'sandbox', network: [], env: ['CI'] },
  };
  const answerFor = (driver: string, agent: AgentHarnessQuery, host: typeof HOST | 'none' = HOST) =>
    agentHarnessView({
      harnesses: HARNESSES,
      defaultHarnessId: 'default',
      agent: { ...agent, harnessId: driver === 'claude' ? 'claude-work' : `${driver}-work` },
      ...(host !== 'none' ? { host: () => host } : {}),
    });

  it.each([['codex'], ['antigravity']])(
    'a write agent on %s is refused in Consola words',
    (driver) => {
      expect(answerFor(driver, WRITE_AGENT).agentProblem).toBe(
        `Write agents run on Claude only for now: ${driver}-work can't hold a write agent to its environment.`,
      );
    },
  );

  it('a write agent on Claude compiles against the host, and names nothing; one off its run-owned checkout is refused at its harness', () => {
    expect(answerFor('claude', WRITE_AGENT).agentProblem).toBeNull();
    expect(answerFor('claude', { ...WRITE_AGENT, checkout: 'scope' }).agentProblem).toBe(
      'A write agent changes code only on a branch the run cuts from one of `repos:` (invariant 9).',
    );
    expect(answerFor('claude', WRITE_AGENT, { ...HOST, platform: 'linux' }).agentProblem).toBe(
      '`isolation: sandbox` is verified on macOS only so far; this machine runs Linux.',
    );
    expect(answerFor('claude', WRITE_AGENT, 'none').agentProblem).toContain(
      "can't hold a write agent to its environment",
    );
  });

  it('a driver whose compiled grants do not hold the policy is refused as not Claude', () => {
    const loose = {
      ...getDriver('claude'),
      compileAgent: () => ({
        ok: true as const,
        grants: { driverId: 'claude', servers: [], skills: [], strict: true, allowedTools: [] },
        warnings: [],
      }),
    } as HarnessDriver;
    const answer = agentHarnessView({
      harnesses: HARNESSES,
      defaultHarnessId: 'default',
      agent: WRITE_AGENT,
      host: () => HOST,
      driverFor: () => loose,
    });
    expect(answer.agentProblem).toBe(
      "Write agents run on Claude only for now: Claude work can't hold a write agent to its environment.",
    );
  });

  const BUILT_IN = harness({ id: 'default', name: 'Claude', isBuiltIn: true });
  const deps = (
    env: NodeJS.ProcessEnv,
    over: Partial<WriteAgentHostDeps> = {},
  ): WriteAgentHostDeps => ({
    harnesses: () => [BUILT_IN],
    platform: 'darwin',
    home: '/h',
    userData: '/h/Library/Application Support/Consola',
    factoryRoot: '/h/.consola/workspaces',
    loginEnv: () => env,
    versions: { get: async () => '2.1.330', peek: () => undefined },
    readSettings: () => null,
    ...over,
  });
  const hostFor = (
    record: Harness,
    env: NodeJS.ProcessEnv,
    over: Partial<WriteAgentHostDeps> = {},
  ) => writeAgentHost(deps(env, over), record);

  it("a harness that pins nothing puts its effective profile on the deny list: the login environment's, else ~/.claude (Review Focus 9)", async () => {
    expect(
      (await hostFor(BUILT_IN, { CLAUDE_CONFIG_DIR: '/h/.claude-ambient' })).denyRead,
    ).toContain('/h/.claude-ambient');
    const ownDefault = path.join(os.homedir(), '.claude');
    expect((await hostFor(BUILT_IN, {})).denyRead).toContain(
      fs.existsSync(ownDefault) ? fs.realpathSync.native(ownDefault) : ownDefault,
    );
  });

  it('the harness it compiles for is denied even when it is no record (the built-in default)', async () => {
    const host = await writeAgentHost(
      deps({ CLAUDE_CONFIG_DIR: '/h/.claude-ambient' }, { harnesses: () => [] }),
      undefined,
    );
    expect(host.denyRead).toContain('/h/.claude-ambient');
  });

  it('every harness record’s profile is denied, archived ones included', async () => {
    const archived = harness({ id: 'old', configDir: '/h/.claude-old', archived: true });
    const codex = harness({ id: 'cx', driverId: 'codex', configDir: '/h/.codex-work' });
    const host = await hostFor(BUILT_IN, {}, { harnesses: () => [BUILT_IN, archived, codex] });
    expect(host.denyRead).toEqual(expect.arrayContaining(['/h/.claude-old', '/h/.codex-work']));
  });

  it('asks the injected HarnessVersions, never a real probe (review M8)', async () => {
    const get = vi.fn(async () => '2.1.330');
    const work = harness({ id: 'w', configDir: '/h/.claude-work' });
    const host = await hostFor(work, {}, { versions: { get, peek: () => undefined } });
    expect(host.cliVersion).toBe('2.1.330');
    expect(get).toHaveBeenCalledWith(
      expect.objectContaining({ configDirOverride: '/h/.claude-work' }),
    );
    // At apply it never waits: the version already read, else unknown.
    expect(
      writeAgentHostNow(deps({}, { versions: { get, peek: () => undefined } }), work).cliVersion,
    ).toBe('unknown');
    expect(
      writeAgentHostNow(deps({}, { versions: { get, peek: () => '2.1.331' } }), work).cliVersion,
    ).toBe('2.1.331');
    expect(get).toHaveBeenCalledTimes(1);
  });

  it("reads the effective profile's settings.json first: the login environment's CLAUDE_CONFIG_DIR for a harness that pins nothing (review NS6)", async () => {
    const read = vi.fn((_file: string) => null);
    await hostFor(BUILT_IN, { CLAUDE_CONFIG_DIR: '/h/.claude-ambient' }, { readSettings: read });
    expect(read.mock.calls.map(([file]) => file)).toEqual([
      '/h/.claude-ambient/settings.json',
      '/Library/Application Support/ClaudeCode/managed-settings.json',
    ]);
  });

  it('a settings file that cannot be read is said so, which refuses `sandbox`', async () => {
    const host = await hostFor(
      BUILT_IN,
      {},
      {
        readSettings: (file) => {
          if (file.endsWith('managed-settings.json')) throw new Error('EACCES: permission denied');
          return '{"model":"sonnet"}';
        },
      },
    );
    expect(host.settingsFiles).toEqual([
      { path: path.join(os.homedir(), '.claude', 'settings.json'), text: '{"model":"sonnet"}' },
      {
        path: '/Library/Application Support/ClaudeCode/managed-settings.json',
        text: null,
        unreadable: 'EACCES: permission denied',
      },
    ]);
  });
});
