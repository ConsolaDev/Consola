import { afterEach, describe, expect, it, vi } from 'vitest';
import { stepsHarness, WORKSPACE_ID } from './steps/steps.test-helpers';

/*
 * What `resolveSteps` guards that `parseFactory` never hands it: an agent
 * whose skill is not in the factory. A parse drops such an agent, so only a
 * parse that does not hold together reaches the guard; this file makes one
 * (the agent kept, its skill dropped) to show the entry is refused in words
 * and its run copies nothing it does not have (review M7).
 */

const parse = vi.hoisted(() => ({ dropSkills: false }));
vi.mock('@consola/factory-spec', async (original) => {
  const actual = await original<typeof import('@consola/factory-spec')>();
  return {
    ...actual,
    parseFactory: (files: Parameters<typeof actual.parseFactory>[0]) => {
      const read = actual.parseFactory(files);
      return parse.dropSkills ? { ...read, skills: {} } : read;
    },
  };
});
afterEach(() => {
  parse.dropSkills = false;
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
