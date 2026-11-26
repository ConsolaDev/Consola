import { parseFactory } from '@consola/factory-spec';
import type { Automation } from '@consola/factory-spec';
import { describe, expect, it } from 'vitest';
import { approvalOf, approvalReason, judgeAnswer, willRun } from './runApproval.js';
import type { ApprovalRun, RunAnswer } from './runApproval.js';
import type { Team } from './team.js';

const DEPLOY = `on: { manual: {} }
scope: storefront
steps:
  - id: build
    run: pnpm build
  - id: check
    agent: reviewer
    prompt: Check the build.
  - id: note
    prompt: Write the release note.
`;

const deploy: Automation = (() => {
  const parsed = parseFactory({
    factoryYml: 'version: 1\n',
    automations: { deploy: DEPLOY },
    agents: { reviewer: '---\ndescription: Reviews.\n---\nYou review.\n' },
    skills: {},
    stray: [],
    laterFolders: [],
    unread: [],
    outside: [],
  });
  const [found] = parsed.automations;
  if (!found) throw new Error(JSON.stringify(parsed.issues));
  return found;
})();

const platform: Team = { id: 'team-platform', name: 'Platform', first: false, memberIds: ['fay'] };

const waiting: ApprovalRun = {
  kind: 'automation',
  status: 'needs-approval',
  automation: 'deploy',
  version: 3,
};

const answered: RunAnswer = { decision: 'approved', by: 'fay', at: '2026-11-23T10:00:00.000Z' };

describe('approvalReason', () => {
  it('says why a run asks, in the words of its mode', () => {
    expect(approvalReason(waiting, 'confirm')).toBe('deploy asks before every run.');
    expect(approvalReason(waiting, 'auto')).toBe(
      "Version 3 of deploy hasn't been approved to run on its own yet.",
    );
    expect(approvalReason(waiting, null)).toBe(
      "Version 3 of deploy hasn't been approved to run on its own yet.",
    );
    expect(approvalReason({ ...waiting, kind: 'request', automation: null }, null)).toBe(
      "This factory's orchestrator hasn't been approved at this version yet.",
    );
  });
});

describe('willRun', () => {
  it('lists each command and each agent step, as written', () => {
    expect(willRun(deploy)).toEqual({
      commands: [{ step: 'build', command: 'pnpm build' }],
      agents: [
        { step: 'check', agent: 'reviewer', prompt: 'Check the build.' },
        { step: 'note', agent: null, prompt: 'Write the release note.' },
      ],
    });
    expect(willRun(null)).toEqual({ commands: [], agents: [] });
  });

  it('lists the steps inside a loop, and nothing for a gate or the loop itself', () => {
    const SHIP = `on: { manual: {} }
scope: storefront
steps:
  - id: fix
    prompt: Fix the bug.
  - id: polish
    repeat: { max: 3, until: steps.check.clean }
    steps:
      - id: check
        run: pnpm lint --format json
        outputs: { clean: boolean }
      - id: tidy
        agent: reviewer
        prompt: Tidy what the check found.
  - id: decide
    gate: { ask: Ship it? }
`;
    const [ship] = parseFactory({
      factoryYml: 'version: 1\n',
      automations: { ship: SHIP },
      agents: { reviewer: '---\ndescription: Reviews.\n---\nYou review.\n' },
      skills: {},
      stray: [],
      laterFolders: [],
      unread: [],
      outside: [],
    }).automations;
    if (!ship) throw new Error('the automation did not parse');

    // Approving lets every command and agent step run, those a loop repeats too.
    expect(willRun(ship)).toEqual({
      commands: [{ step: 'check', command: 'pnpm lint --format json' }],
      agents: [
        { step: 'fix', agent: null, prompt: 'Fix the bug.' },
        { step: 'tidy', agent: 'reviewer', prompt: 'Tidy what the check found.' },
      ],
    });
  });
});

describe('willRun, with a call (the merge of slice 3 and 5a)', () => {
  it('lists no call, in a loop or not, and never as an agent: the cell has no call to describe yet', () => {
    const SHIP = `on: { manual: {} }
scope: storefront
steps:
  - id: fix
    prompt: Fix the bug.
  - id: post
    uses: slack#chat_post_message
    with: { channel: C0SUPPORT1, text: Fixed. }
  - id: polish
    repeat: { max: 2, until: "steps.tidy.done" }
    steps:
      - id: tidy
        uses: consola#cleanup_stale_sessions
        with: { pr_states: [merged] }
        outputs: { done: boolean }
`;
    const [ship] = parseFactory({
      factoryYml: 'version: 1\nmcpServers:\n  slack:\n    command: /opt/sprocket/bin/slack-mcp\n',
      automations: { ship: SHIP },
      agents: {},
      skills: {},
      stray: [],
      laterFolders: [],
      unread: [],
      outside: [],
    }).automations;
    if (!ship) throw new Error('the automation did not parse');

    expect(willRun(ship)).toEqual({
      commands: [],
      agents: [{ step: 'fix', agent: null, prompt: 'Fix the bug.' }],
    });
  });
});

describe('approvalOf', () => {
  it('asks while the run waits, saying who may answer and whether the caller may', () => {
    const approval = approvalOf({
      run: waiting,
      automation: { ...deploy, mode: 'confirm' },
      team: platform,
      personId: 'fay',
      answer: null,
    });
    expect(approval).toEqual({
      version: 3,
      reason: 'deploy asks before every run.',
      team: { id: 'team-platform', name: 'Platform' },
      mayAnswer: true,
      will: willRun(deploy),
      answer: null,
    });
    const forDana = approvalOf({
      run: waiting,
      automation: deploy,
      team: platform,
      personId: 'dana',
      answer: null,
    });
    expect(forDana?.mayAnswer).toBe(false);
  });

  it('stays once answered, after the run moves on, and is none for a run never asked', () => {
    const running = { ...waiting, status: 'running' as const };
    expect(
      approvalOf({
        run: running,
        automation: deploy,
        team: platform,
        personId: 'fay',
        answer: answered,
      })?.answer,
    ).toEqual(answered);
    expect(
      approvalOf({
        run: running,
        automation: deploy,
        team: platform,
        personId: 'fay',
        answer: null,
      }),
    ).toBeNull();
  });

  it("lists nothing a request's approval lets run", () => {
    const request = { ...waiting, kind: 'request' as const, automation: null };
    expect(
      approvalOf({ run: request, automation: null, team: platform, personId: 'fay', answer: null })
        ?.will,
    ).toEqual({ commands: [], agents: [] });
  });
});

describe('judgeAnswer', () => {
  it('lets anyone on the team answer a waiting run at its version, and no one else', () => {
    expect(judgeAnswer(waiting, platform, 'fay', 3)).toBe('allowed');
    expect(judgeAnswer(waiting, platform, 'dana', 3)).toBe('not-allowed');
  });

  it('refuses in order: the team first, then waiting, then the version', () => {
    const done = { ...waiting, status: 'completed' as const };
    expect(judgeAnswer(done, platform, 'dana', 2)).toBe('not-allowed');
    expect(judgeAnswer(done, platform, 'fay', 2)).toBe('not-waiting');
    expect(judgeAnswer(waiting, platform, 'fay', 2)).toBe('version-moved');
  });
});
