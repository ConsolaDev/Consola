import { describe, expect, it } from 'vitest';
import type { AgentHarnessQuery } from '@consola/automation-engine';
import type { Harness } from '../../shared/harness';
import type { HarnessCapabilitiesResult } from '../../shared/types';
import { getDriver, toolPolicyProblem } from '../drivers';
import type { HarnessCapabilitiesCache } from '../HarnessCapabilitiesCache';
import {
  agentHarnessRefusal,
  agentHarnessView,
  cachedModels,
  SERVERS_AND_SKILLS_LATER,
} from './agentHarness';

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

  it("a Codex harness gives the Codex driver's own read-only refusal", () => {
    const codex = view(query({ harnessId: 'codex-1' }));
    expect(codex.problem).toBe(toolPolicyProblem({ driverId: 'codex' }, 'read-only'));
    expect(codex.problem).not.toBeNull();
    expect(codex.agentProblem).toBeNull();
  });

  it('an agent that names a server or a skill is refused until they arrive', () => {
    expect(SERVERS_AND_SKILLS_LATER).toBe(
      'Servers and skills for agents arrive with the next update',
    );
    for (const named of [
      query({ harnessId: 'claude-work', mcpServers: [{ name: 'notion' }] }),
      query({ harnessId: 'claude-work', skills: ['incident-triage'] }),
      query({ mcpServers: [{ name: 'grafana', tools: ['query_logs'] }] }),
    ])
      expect(view(named).agentProblem).toBe(SERVERS_AND_SKILLS_LATER);
    // On a harness it cannot run on at all, that is said first.
    expect(view(query({ harnessId: 'nope', mcpServers: [{ name: 'notion' }] })).agentProblem).toBe(
      UNKNOWN,
    );
    expect(view(query({ harnessId: 'off', skills: ['incident-triage'] })).agentProblem).toBe(
      '`off` is turned off: turn it on in Settings › Harnesses, or change `harness:`',
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
