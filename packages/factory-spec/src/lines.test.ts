import { describe, expect, it } from 'vitest';
import { parseFactory } from './factory';
import { automationLines } from './lines';

const FACTORY_YML = `version: 1
automations:
  - name: nightly
    on: { cron: "0 3 * * *" }
    scope: storefront
    steps:
      - id: build
        run: pnpm build

      - id: report
        prompt: |
          Summarise the build.
          Name anything slow.

        max_turns: 4
    # trailing comment, not the entry's

  - name: digest
    on: { cron: "30 8 * * 1-5" }
    run: { prompt: "Summarise my Inbox." }
    scope: api
    mode: auto
`;

const REVIEW = `# Reviews every pull request.
on: { github: { events: [pull_request.opened] } }
steps:
  - id: review
    prompt: Review it.
    max_turns: 12
  - id: comment
    run: gh pr comment "$PR" --body-file review.md
    env: { PR: "{{item.number}}" }
`;

describe('automationLines', () => {
  it("gives an entry of factory.yml its own lines, and each step's, without what trails them", () => {
    expect(automationLines('factory.yml', FACTORY_YML, 'nightly')).toEqual({
      range: { start: 3, end: 15 },
      steps: [
        { start: 7, end: 8 },
        { start: 10, end: 15 },
      ],
    });
    // A legacy entry has no steps.
    expect(automationLines('factory.yml', FACTORY_YML, 'digest')).toEqual({
      range: { start: 18, end: 22 },
      steps: [],
    });
  });

  it('gives an automation in a file of its own the whole file', () => {
    expect(automationLines('automations/review-prs.yaml', REVIEW, 'review-prs')).toEqual({
      range: { start: 1, end: 9 },
      steps: [
        { start: 4, end: 6 },
        { start: 7, end: 9 },
      ],
    });
    expect(automationLines('automations/x.yaml', 'on: manual', 'x')?.range).toEqual({
      start: 1,
      end: 1,
    });
  });

  it("puts the steps in the order the parsed automation's steps hold them", () => {
    const parsed = parseFactory({
      factoryYml: 'version: 1\n',
      automations: { 'review-prs': REVIEW },
      agents: {},
      skills: {},
      stray: [],
      laterFolders: [],
      unread: [],
      outside: [],
    });
    const [automation] = parsed.automations;
    const lines = automationLines('automations/review-prs.yaml', REVIEW, 'review-prs');
    const ids = automation?.steps?.map((step) => step.id);
    expect(ids).toEqual(['review', 'comment']);
    expect(REVIEW.split('\n')[(lines?.steps[1]?.start ?? 0) - 1]).toContain('id: comment');
  });

  it('is undefined for another file, an entry the file does not hold, or YAML that does not read', () => {
    expect(automationLines('factory.yml', FACTORY_YML, 'missing')).toBeUndefined();
    expect(automationLines('automations/other.yaml', REVIEW, 'review-prs')).toBeUndefined();
    expect(automationLines('agents/reviewer.md', REVIEW, 'review-prs')).toBeUndefined();
    expect(
      automationLines('factory.yml', 'version: 1\nautomations:\n  - name: a\n   bad: [\n', 'a'),
    ).toBeUndefined();
    expect(automationLines('automations/a.yaml', 'on: [\n', 'a')).toBeUndefined();
  });

  it('reads lines from a file whose rules fail, since only its shape is read', () => {
    const text = 'on: { cron: "0 3 * * *" }\nsteps:\n  - run: x\n    colour: red\n';
    expect(automationLines('automations/a.yaml', text, 'a')).toEqual({
      range: { start: 1, end: 4 },
      steps: [{ start: 3, end: 4 }],
    });
  });
});
