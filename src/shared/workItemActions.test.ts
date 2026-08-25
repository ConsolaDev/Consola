import { describe, expect, it } from 'vitest';
import {
  createDefaultActions,
  createDefaultSectionDefaults,
  defaultActionNameForType,
  validateActionsWrite,
  type WorkItemAction,
} from './workItemActions';

function idOf(actions: WorkItemAction[], name: string): string {
  const action = actions.find((candidate) => candidate.name === name);
  if (!action) throw new Error(`no default action named ${name}`);
  return action.id;
}

describe('createDefaultActions', () => {
  it('seeds the five defaults in order, typed by what they apply to', () => {
    const actions = createDefaultActions();
    expect(actions.map((action) => [action.name, action.appliesTo])).toEqual([
      ['Review', ['pr']],
      ['Address review', ['pr']],
      ['Fix CI', ['pr']],
      ['Implement', ['issue']],
      ['Triage', ['issue']],
    ]);
  });

  it('carries the spec bodies verbatim', () => {
    expect(createDefaultActions().map((action) => action.prompt)).toEqual([
      'Review the changes and summarise your findings before writing any review comments.',
      'Read every unresolved review thread with `gh pr view {{number}} --comments`. Address each one: change the code or reply explaining why not. Push, then summarise what you did per thread.',
      'Find the failing checks with `gh pr checks {{number}}`, reproduce locally, fix, push.',
      'Investigate it and propose a plan before changing anything.',
      'Reproduce, label the severity, and comment your findings. Do not change code.',
    ]);
  });

  it('mints fresh, unique ids on every call so two workspaces never share a record', () => {
    const first = createDefaultActions();
    const second = createDefaultActions();
    expect(new Set(first.map((action) => action.id)).size).toBe(5);
    expect(first.map((action) => action.id)).not.toEqual(second.map((action) => action.id));
    expect(first[0].appliesTo).not.toBe(second[0].appliesTo);
  });
});

describe('createDefaultSectionDefaults', () => {
  it('points each section at the default action of that name, by id', () => {
    const actions = createDefaultActions();
    expect(createDefaultSectionDefaults(actions)).toEqual({
      'needs-your-review': idOf(actions, 'Review'),
      'needs-team-review': idOf(actions, 'Review'),
      'needs-action': idOf(actions, 'Address review'),
      waiting: idOf(actions, 'Fix CI'),
      issues: idOf(actions, 'Implement'),
    });
  });

  it('leaves drafts and ready-to-merge without a default', () => {
    const defaults = createDefaultSectionDefaults(createDefaultActions());
    expect(defaults).not.toHaveProperty('your-drafts');
    expect(defaults).not.toHaveProperty('ready-to-merge');
  });

  it('omits a section whose named action is missing rather than pointing at nothing', () => {
    const withoutReview = createDefaultActions().filter((action) => action.name !== 'Review');
    const defaults = createDefaultSectionDefaults(withoutReview);
    expect(defaults).not.toHaveProperty('needs-your-review');
    expect(defaults).not.toHaveProperty('needs-team-review');
    expect(defaults.issues).toBe(idOf(withoutReview, 'Implement'));
  });
});

describe('defaultActionNameForType', () => {
  it("is Review for PRs and Implement for issues — the split today's hardcoded prompt made", () => {
    expect(defaultActionNameForType('pr')).toBe('Review');
    expect(defaultActionNameForType('issue')).toBe('Implement');
  });
});

describe('validateActionsWrite', () => {
  const actions = createDefaultActions();
  const sectionDefaults = createDefaultSectionDefaults(actions);

  it('accepts the seeded defaults', () => {
    expect(validateActionsWrite({ actions, sectionDefaults })).toEqual({ ok: true });
  });

  it('accepts an empty list with no defaults — an unbound workspace', () => {
    expect(validateActionsWrite({ actions: [], sectionDefaults: {} })).toEqual({ ok: true });
  });

  it('rejects duplicate ids', () => {
    const duplicated = [...actions, { ...actions[0], name: 'Review again' }];
    expect(validateActionsWrite({ actions: duplicated, sectionDefaults })).toEqual({
      ok: false,
      message: `Duplicate action id: ${actions[0].id}`,
    });
  });

  it('rejects an action that applies to nothing', () => {
    const write = { actions: [{ ...actions[0], appliesTo: [] }], sectionDefaults: {} };
    expect(validateActionsWrite(write)).toEqual({
      ok: false,
      message: '"Review" must apply to pull requests, issues, or both.',
    });
  });

  it('rejects an action that applies to an item type that does not exist', () => {
    const write = {
      actions: [{ ...actions[0], appliesTo: ['pull'] as unknown as WorkItemAction['appliesTo'] }],
      sectionDefaults: {},
    };
    expect(validateActionsWrite(write)).toEqual({
      ok: false,
      message: '"Review" applies to an unknown item type.',
    });
  });

  it('rejects an empty prompt — whitespace counts as empty', () => {
    const write = { actions: [{ ...actions[0], prompt: '   ' }], sectionDefaults: {} };
    expect(validateActionsWrite(write)).toEqual({ ok: false, message: '"Review" needs a prompt.' });
  });

  it('rejects an empty name', () => {
    const write = { actions: [{ ...actions[0], name: ' ' }], sectionDefaults: {} };
    expect(validateActionsWrite(write)).toEqual({ ok: false, message: 'Every action needs a name.' });
  });

  it('rejects a default pointing at an action that does not exist', () => {
    expect(
      validateActionsWrite({ actions, sectionDefaults: { issues: 'gone' } })
    ).toEqual({
      ok: false,
      message: 'The default for "issues" points at an action that does not exist.',
    });
  });

  it('rejects a default whose action does not apply to the section item type', () => {
    expect(
      validateActionsWrite({ actions, sectionDefaults: { issues: idOf(actions, 'Review') } })
    ).toEqual({
      ok: false,
      message: '"Review" cannot be the default for "issues": it does not apply to issues.',
    });
    expect(
      validateActionsWrite({ actions, sectionDefaults: { waiting: idOf(actions, 'Implement') } })
    ).toEqual({
      ok: false,
      message: '"Implement" cannot be the default for "waiting": it does not apply to pull requests.',
    });
  });

  it('rejects a section it does not know', () => {
    const write = {
      actions,
      sectionDefaults: { merged: idOf(actions, 'Review') } as unknown as typeof sectionDefaults,
    };
    expect(validateActionsWrite(write)).toEqual({ ok: false, message: 'Unknown inbox section: merged' });
  });

  it('rejects payloads that are not a list and an object — what IPC can deliver', () => {
    expect(
      validateActionsWrite({ actions: 'nope' as unknown as WorkItemAction[], sectionDefaults: {} })
    ).toEqual({ ok: false, message: 'Actions must be a list.' });
    expect(
      validateActionsWrite({ actions: [], sectionDefaults: null as unknown as typeof sectionDefaults })
    ).toEqual({ ok: false, message: 'Section defaults must be an object.' });
  });
});
