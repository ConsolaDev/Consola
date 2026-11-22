import { describe, expect, it } from 'vitest';
import { FactoryFolder } from '@consola/automation-engine';
import { isOpenableFile } from '../../renderer/components/Automations/presentation';

/**
 * The issue list offers Open only for a path Open accepts (review M7): the
 * renderer's copy of `FactoryFolder.pathOf`'s rule (the renderer may take only
 * the engine's types). This keeps the two one rule.
 */

const PATHS = [
  'factory.yml',
  'automations/catalog-review.yaml',
  'agents/reviewer.md',
  'skills/incident-triage/SKILL.md',
  // Strays, a skill's folder and its other files, folders, and names that are no names.
  'agents/notes.txt',
  'automations/x.yml',
  'automations/drafts',
  'skills/readme.md',
  'skills/incident-triage',
  'skills/incident-triage/',
  'skills/incident-triage/refs/queries.md',
  'skills/incident-triage/skill.md',
  'agents/',
  'automations/',
  'agents/Reviewer.md',
  'agents/a/b.md',
  'automations/-x.yaml',
  'runs/r1/state.json',
  '../factory.yml',
  'factory.yaml',
  '',
];

describe('isOpenableFile', () => {
  it.each(PATHS)('agrees with the reader on %j', (relative) => {
    const folder = new FactoryFolder('/home/me/.consola/workspaces/ws-1');
    expect(isOpenableFile(relative)).toBe(folder.pathOf(relative) !== null);
  });

  it("offers the factory's own four kinds of file, and nothing else", () => {
    expect(PATHS.filter(isOpenableFile)).toEqual([
      'factory.yml',
      'automations/catalog-review.yaml',
      'agents/reviewer.md',
      'skills/incident-triage/SKILL.md',
    ]);
  });
});
