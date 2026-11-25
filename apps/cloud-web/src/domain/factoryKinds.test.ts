import { describe, expect, it } from 'vitest';
import { checkFactory, factoryCheckOf } from './factoryCheck';
import { draftOf, withRemoved } from './factoryDraft';
import {
  bodyLine,
  checkNaming,
  FACTORY_YML_SKELETON,
  kindOfPath,
  NAME_RULE,
  type NameFacts,
  NEW_KINDS,
  namingParts,
  namingStart,
  nameFactsOf,
  pathFor,
  skeletonFor,
  skillOf,
} from './factoryKinds';

const file = (path: string, content: string) => ({ path, content });

describe('the skeletons', () => {
  const each = [
    file('factory.yml', FACTORY_YML_SKELETON),
    file(pathFor('automation', 'nightly'), skeletonFor('automation', 'nightly')),
    file(pathFor('agent', 'reviewer'), skeletonFor('agent', 'reviewer')),
    file(pathFor('skill', 'triage'), skeletonFor('skill', 'triage')),
  ];

  it('each pass the checker alone', () => {
    for (const one of each) expect(checkFactory([one]), one.path).toEqual([]);
  });

  it('pass it all together, with an empty file inside the skill', () => {
    expect(checkFactory([...each, file('skills/triage/refs/queries.md', '')])).toEqual([]);
  });

  it('start an automation only when someone starts it', () => {
    expect(skeletonFor('automation', 'nightly')).toMatch(/^on: manual$/m);
  });

  it('name a skill by its folder, and leave a file inside a skill empty', () => {
    expect(skeletonFor('skill', 'catalog-portal')).toMatch(/^name: catalog-portal$/m);
    expect(skeletonFor('skill-file', 'refs/queries.md')).toBe('');
  });
});

describe('the name rule', () => {
  const names = ['ok', 'Bad', 'a_b', '-a', 'a b', 'a.b', '9x', 'x-', 'é', '', 'a'.repeat(64)];

  it('is the checker’s, for every kind a name makes', () => {
    for (const name of [...names, 'a'.repeat(65)]) {
      for (const kind of NEW_KINDS) {
        const accepted =
          checkFactory([file(pathFor(kind, name), skeletonFor(kind, name))]).length === 0;
        expect(accepted, `${kind} ${JSON.stringify(name)}`).toBe(NAME_RULE.test(name));
      }
    }
  });
});

describe('a path’s kind', () => {
  it('is what the format reads it as', () => {
    expect(kindOfPath('factory.yml')).toBe('factory');
    expect(kindOfPath('automations/nightly.yaml')).toBe('automation');
    expect(kindOfPath('agents/reviewer.md')).toBe('agent');
    expect(kindOfPath('skills/triage/SKILL.md')).toBe('skill');
    expect(kindOfPath('skills/triage/refs/queries.md')).toBe('skill-file');
    expect(kindOfPath('evals/smoke.yaml')).toBeNull();
    expect(skillOf('skills/triage/refs/queries.md')).toBe('triage');
    expect(skillOf('agents/reviewer.md')).toBeNull();
  });
});

describe('naming a file', () => {
  const facts: NameFacts = nameFactsOf(
    withRemoved(
      draftOf({
        version: 1,
        files: [
          file('factory.yml', 'version: 1\n'),
          file('agents/reviewer.md', 'x'),
          file('agents/old.md', 'x'),
          file('automations/nightly.yaml', 'x'),
          file('skills/triage/SKILL.md', 'x'),
          file('skills/triage/refs/queries.md', 'x'),
        ],
      }),
      'agents/old.md',
    ),
    ['weekly'],
  );

  it('puts the fixed parts of the path around the field', () => {
    expect(namingParts({ type: 'new', kind: 'agent' })).toEqual({
      before: 'agents/',
      after: '.md',
    });
    expect(namingParts({ type: 'new', kind: 'automation' })).toEqual({
      before: 'automations/',
      after: '.yaml',
    });
    expect(namingParts({ type: 'new', kind: 'skill' })).toEqual({ before: 'skills/', after: '/' });
    expect(namingParts({ type: 'new-in-skill', skill: 'triage' })).toEqual({
      before: 'skills/triage/',
      after: '',
    });
    expect(namingParts({ type: 'rename', path: 'skills/triage/refs/queries.md' })).toEqual({
      before: 'skills/triage/',
      after: '',
    });
    expect(namingParts({ type: 'rename-skill', skill: 'triage' })).toEqual({
      before: 'skills/',
      after: '/',
    });
  });

  it('starts empty for a new file, and with the current name for a rename', () => {
    expect(namingStart({ type: 'new', kind: 'agent' })).toBe('');
    expect(namingStart({ type: 'rename', path: 'agents/reviewer.md' })).toBe('reviewer');
    expect(namingStart({ type: 'rename', path: 'skills/triage/refs/queries.md' })).toBe(
      'refs/queries.md',
    );
    expect(namingStart({ type: 'rename-skill', skill: 'triage' })).toBe('triage');
  });

  it('makes the path from a good name', () => {
    expect(checkNaming({ type: 'new', kind: 'agent' }, 'sprocket', facts)).toEqual({
      ok: true,
      path: 'agents/sprocket.md',
    });
    expect(checkNaming({ type: 'new', kind: 'skill' }, 'sorting', facts)).toEqual({
      ok: true,
      path: 'skills/sorting/SKILL.md',
    });
    expect(checkNaming({ type: 'new-in-skill', skill: 'triage' }, 'refs/labels.md', facts)).toEqual(
      { ok: true, path: 'skills/triage/refs/labels.md' },
    );
    expect(checkNaming({ type: 'rename-skill', skill: 'triage' }, 'sorting', facts)).toEqual({
      ok: true,
      path: 'skills/sorting/',
    });
  });

  it('says why a name cannot be made', () => {
    const agent = { type: 'new', kind: 'agent' } as const;
    expect(checkNaming(agent, '', facts)).toEqual({ ok: false, problem: 'empty', path: null });
    expect(checkNaming(agent, 'Reviewer', facts)).toEqual({
      ok: false,
      problem: 'rule',
      path: null,
    });
    expect(checkNaming(agent, 'reviewer', facts)).toEqual({
      ok: false,
      problem: 'taken',
      path: 'agents/reviewer.md',
    });
    expect(checkNaming(agent, 'old', facts)).toEqual({
      ok: false,
      problem: 'removed',
      path: 'agents/old.md',
    });
    expect(checkNaming({ type: 'new', kind: 'automation' }, 'weekly', facts)).toEqual({
      ok: false,
      problem: 'defined',
      path: 'automations/weekly.yaml',
    });
    expect(checkNaming({ type: 'new', kind: 'skill' }, 'triage', facts).ok).toBe(false);
  });

  it('accepts a file’s own name on a rename, and its saved one', () => {
    expect(checkNaming({ type: 'rename', path: 'agents/reviewer.md' }, 'reviewer', facts)).toEqual({
      ok: true,
      path: 'agents/reviewer.md',
    });
    expect(checkNaming({ type: 'rename-skill', skill: 'triage' }, 'triage', facts)).toEqual({
      ok: true,
      path: 'skills/triage/',
    });
    expect(checkNaming({ type: 'rename', path: 'agents/checker.md' }, 'reviewer', facts).ok).toBe(
      false,
    );
  });

  it('checks a path inside a skill as a factory path', () => {
    const inSkill = { type: 'new-in-skill', skill: 'triage' } as const;
    for (const bad of [
      'refs//a.md',
      './a.md',
      'refs/../a.md',
      'a\\b.md',
      '/a.md',
      'a.md/',
      'a\tb',
    ]) {
      expect(checkNaming(inSkill, bad, facts), bad).toEqual({
        ok: false,
        problem: 'path',
        path: null,
      });
    }
    expect(checkNaming(inSkill, 'a'.repeat(250), facts)).toEqual({
      ok: false,
      problem: 'long',
      path: null,
    });
    expect(checkNaming(inSkill, 'refs/queries.md', facts).ok).toBe(false);
    expect(checkNaming(inSkill, 'SKILL.md', facts).ok).toBe(false);
  });
});

describe('the caret in a new file', () => {
  it('lands on the first line of its body', () => {
    expect(bodyLine(FACTORY_YML_SKELETON)).toBe(3);
    expect(bodyLine(skeletonFor('automation', 'nightly'))).toBe(2);
    expect(bodyLine(skeletonFor('agent', 'reviewer'))).toBe(5);
    expect(bodyLine(skeletonFor('skill', 'triage'))).toBe(6);
    expect(bodyLine('')).toBe(1);
  });
});

describe('factoryCheckOf', () => {
  it('names the automations factory.yml defines', () => {
    const yml =
      'version: 1\nautomations:\n  - name: weekly\n    on: manual\n    applies_to: [pr]\n    steps:\n      - run: echo hi\n';
    expect(factoryCheckOf([file('factory.yml', yml)])).toEqual({
      problems: [],
      definedAutomations: ['weekly'],
    });
    expect(
      factoryCheckOf([file(pathFor('automation', 'nightly'), skeletonFor('automation', 'nightly'))])
        .definedAutomations,
    ).toEqual([]);
  });
});
