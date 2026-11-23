import { afterEach, describe, expect, it, vi } from 'vitest';
import { stepsHarness, WORKSPACE_ID } from './steps/steps.test-helpers';

/*
 * What `resolveSteps` guards that `parseFactory` never hands it: an agent
 * whose skill is not in the factory. A parse drops such an agent, so only a
 * parse that does not hold together reaches the guard; this file makes one
 * (the agent kept, its skill dropped) to show the entry is refused in words
 * and its run copies nothing it does not have (review M7).
 */

const parse = vi.hoisted(() => ({ dropSkills: false, dropEnvironments: false }));
vi.mock('@consola/factory-spec', async (original) => {
  const actual = await original<typeof import('@consola/factory-spec')>();
  return {
    ...actual,
    parseFactory: (files: Parameters<typeof actual.parseFactory>[0]) => {
      const read = actual.parseFactory(files);
      if (parse.dropEnvironments) return { ...read, environments: {} };
      return parse.dropSkills ? { ...read, skills: {} } : read;
    },
  };
});
afterEach(() => {
  parse.dropSkills = false;
  parse.dropEnvironments = false;
});

const FILES = {
  'automations/investigate.yaml':
    'on: manual\nscope: catalog-portal\nmode: auto\nsteps:\n  - id: look\n    agent: investigator\n',
  'agents/investigator.md':
    '---\nharness: claude-work\nskills: [incident-triage]\n---\nStart from the alert.\n',
  'skills/incident-triage/SKILL.md':
    "---\nname: incident-triage\ndescription: The team's triage checklist.\n---\nCheck the last deploy first.\n",
};
const CLAUDE_WORK = { name: 'Claude work', problem: null };

describe('an agent whose skill a parse lost', () => {
  it('refuses its entry in words, and runs nothing', async () => {
    parse.dropSkills = true;
    const h = await stepsHarness({ files: FILES, agentHarnesses: { 'claude-work': CLAUDE_WORK } });
    const [entry] = h.service.list(WORKSPACE_ID);
    expect(entry.name).toBe('investigate');
    expect(entry.problem).toBe(
      'agents/investigator.md names the skill `incident-triage`, and skills/incident-triage/ is not in this factory',
    );
    await expect(h.service.trigger(WORKSPACE_ID, 'investigate')).rejects.toThrow(/cannot run/);
    expect(h.world.launches).toEqual([]);
  });

  it('runs once the parse holds the skill', async () => {
    const h = await stepsHarness({ files: FILES, agentHarnesses: { 'claude-work': CLAUDE_WORK } });
    expect(h.service.list(WORKSPACE_ID)[0].problem).toBeUndefined();
  });
});

describe('a write agent whose environment a parse lost (slice 3-B)', () => {
  const WRITING = {
    'factory.yml':
      'version: 1\nrepos: [sprocket/catalog-portal]\nautomations:\n  - name: fix\n    on: manual\n    mode: auto\n    checkout: { repo: sprocket/catalog-portal, branch: "fix/{{run.id}}" }\n    steps:\n      - id: fix\n        agent: fixer\n        prompt: Fix it.\n',
    'agents/fixer.md':
      '---\nharness: claude-work\ntools: write\nenvironment: sandboxed\n---\nFix it.\n',
    'environments/sandboxed.yaml': 'isolation: sandbox\n',
  };

  it('refuses its entry in words, before anything else is asked of it', async () => {
    parse.dropEnvironments = true;
    const h = await stepsHarness({
      files: WRITING,
      agentHarnesses: { 'claude-work': CLAUDE_WORK },
    });
    expect(h.service.list(WORKSPACE_ID)[0].problem).toBe(
      'agents/fixer.md names the environment `sandboxed`, and environments/sandboxed.yaml is not in this factory',
    );
  });

  it('with its environment the entry gets as far as the write keys the engine does not run yet', async () => {
    // On a host that makes runs' own checkouts (slice 3-B Task 12), what is left is the write agent.
    const h = await stepsHarness({
      files: WRITING,
      agentHarnesses: { 'claude-work': CLAUDE_WORK },
      runCheckouts: true,
    });
    expect(h.service.list(WORKSPACE_ID)[0].problem).toBe(
      '`tools: write` runs from the next update; this automation does not run yet.',
    );
  });

  it('asks the host about the agent with its tools and its environment, at apply and at resolve', async () => {
    const h = await stepsHarness({
      files: WRITING,
      agentHarnesses: { 'claude-work': CLAUDE_WORK },
    });
    const asked = h.world.harnessQueries.filter((query) => query?.harnessId === 'claude-work');
    // Once for the folder's apply (`reapply`), once for the entry's resolve.
    expect(asked.length).toBeGreaterThanOrEqual(2);
    for (const query of asked)
      expect(query).toMatchObject({
        tools: 'write',
        environment: { name: 'sandboxed', isolation: 'sandbox', network: [], env: [] },
      });
  });
});
