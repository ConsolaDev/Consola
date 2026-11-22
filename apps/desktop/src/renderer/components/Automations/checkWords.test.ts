import { describe, expect, it } from 'vitest';
import type { CheckView } from '../../../shared/automations';
import {
  allowAgentLines,
  allowAgentSections,
  allowBannerWords,
  allowNotes,
  checkStatusLine,
  grantWords,
  noNextCheckWords,
  openFileWords,
  pollRunsEmptyWords,
  skippedWords,
  RUNNING_VERSION_NOTE,
  triggerNodeWords,
} from './checkWords';

const now = new Date('2026-11-16T12:00:00.000Z');
const check = (overrides: Partial<CheckView> = {}): CheckView => ({
  command: 'gh api /notifications --jq .',
  every: '30 minutes',
  ...overrides,
});

describe('checkStatusLine', () => {
  it('says when it last checked and what it found', () => {
    const line = checkStatusLine(
      check({ lastAt: '2026-11-16T11:58:00.000Z', items: 4, fired: 1 }),
      now,
    );
    expect(line).toBe('Checked 2m ago: 4 items, 1 new');
  });

  it('reads one item as "1 item"', () => {
    expect(
      checkStatusLine(check({ lastAt: '2026-11-16T11:58:00.000Z', items: 1, fired: 0 }), now),
    ).toBe('Checked 2m ago: 1 item, 0 new');
  });

  it('says what a baseline is watching, and what makes it run', () => {
    expect(
      checkStatusLine(
        check({ lastAt: '2026-11-16T11:58:00.000Z', items: 4, baseline: true, changed: '.head' }),
        now,
      ),
    ).toBe('Watching 4 items. It runs for new ones, and when `.head` changes.');
    expect(
      checkStatusLine(check({ lastAt: '2026-11-16T11:58:00.000Z', items: 4, baseline: true }), now),
    ).toBe('Watching 4 items. It runs for new ones.');
    expect(
      checkStatusLine(check({ lastAt: '2026-11-16T11:58:00.000Z', items: 1, baseline: true }), now),
    ).toBe('Watching 1 item. It runs for new ones.');
  });

  it('says why the last check failed, before anything else', () => {
    expect(
      checkStatusLine(
        check({ lastAt: '2026-11-16T11:58:00.000Z', items: 4, error: 'exit 1: boom' }),
        now,
      ),
    ).toBe('Last check failed: exit 1: boom');
  });

  it('says nothing before the first check', () => {
    expect(checkStatusLine(check(), now)).toBeNull();
  });
});

describe('noNextCheckWords', () => {
  it('says a check is running once it has checked before, rather than that it never has', () => {
    expect(noNextCheckWords(check({ lastAt: '2026-11-16T11:58:00.000Z' }), false)).toBe(
      'Checking…',
    );
  });

  it('says it has not checked before its first check ends', () => {
    expect(noNextCheckWords(check(), false)).toBe('Not checked yet');
  });

  it('says it is not checking while it waits for Allow, whatever it checked before', () => {
    expect(noNextCheckWords(check({ lastAt: '2026-11-16T11:58:00.000Z' }), true)).toBe(
      'Not checking yet',
    );
    expect(noNextCheckWords(undefined, true)).toBe('Not checking yet');
  });
});

describe('pollRunsEmptyWords', () => {
  it('says a confirm poll asks to run for what is new or changed', () => {
    expect(pollRunsEmptyWords({ mode: 'confirm', check: check() })).toBe(
      'It checks every 30 minutes, and asks to run for what is new or changed. Check now looks right away.',
    );
  });

  it('says the other modes run for it', () => {
    for (const mode of ['auto', 'notify'] as const)
      expect(pollRunsEmptyWords({ mode, check: check() }), mode).toBe(
        'It checks every 30 minutes, and runs for what is new or changed. Check now looks right away.',
      );
  });

  it('says it is not checking yet while it waits for Allow', () => {
    expect(pollRunsEmptyWords({ mode: 'auto', check: check(), needsAllow: true })).toBe(
      'It is not checking yet: allow it above.',
    );
  });
});

describe('skippedWords', () => {
  it('says how many were left out and why, and nothing when none were', () => {
    expect(skippedWords(2)).toBe('2 skipped: their repositories are not in this workspace');
    expect(skippedWords(0)).toBeNull();
  });
});

describe('allowBannerWords', () => {
  it('says what allowing lets Consola do', () => {
    expect(allowBannerWords(check())).toBe(
      'Not checking yet. Allowing it lets Consola run this command every 30 minutes, as you.',
    );
  });
});

describe('grantWords', () => {
  it('says what allowing grants, by mode', () => {
    expect(grantWords('auto')).toBe(
      'It then checks, and runs on its own when something is new or changed.',
    );
    expect(grantWords('confirm')).toBe('It then checks; each run still waits for your approval.');
    expect(grantWords('notify')).toBe(
      'It then checks, and runs dry runs: agents review, commands only report.',
    );
  });
});

describe('triggerNodeWords', () => {
  it("names a poll and a manual entry, and leaves the others to today's node", () => {
    expect(triggerNodeWords({ source: 'poll', check: check() })).toEqual({
      kicker: 'Command check',
      title: 'Every 30m · command',
    });
    expect(triggerNodeWords({ source: 'manual' })).toEqual({
      kicker: 'On demand',
      title: 'On demand',
    });
    expect(triggerNodeWords({ source: 'cron' })).toBeNull();
    expect(triggerNodeWords({ source: 'event' })).toBeNull();
  });

  it('reads a template preview, which has no check, from its trigger text', () => {
    expect(triggerNodeWords({ source: 'poll', trigger: 'poll: every 30m' })).toEqual({
      kicker: 'Command check',
      title: 'Every 30m · command',
    });
    expect(triggerNodeWords({ source: 'poll', check: check({ every: '2 hours' }) })?.title).toBe(
      'Every 2h · command',
    );
  });
});

describe('allowNotes', () => {
  const run = { id: 'a', kind: 'run' as const, summary: 'gh pr view' };
  const agent = { id: 'b', kind: 'agent' as const, summary: 'Prompt' };

  it('says a command runs as the person, and in a pull request whose code it runs', () => {
    expect(allowNotes({ steps: [agent, run], takesItem: 'pr' })).toEqual([
      'Its commands run as you (your logins, the bound GitHub account).',
      "In a pull request's worktree, a command that builds or tests runs the author's code with your logins.",
    ]);
    expect(allowNotes({ steps: [run], takesItem: 'pr-or-issue' })).toHaveLength(2);
    expect(allowNotes({ steps: [run], takesItem: 'item' })).toEqual([
      'Its commands run as you (your logins, the bound GitHub account).',
    ]);
  });

  it('has none without a command', () => {
    expect(allowNotes({ steps: [agent], takesItem: 'pr' })).toEqual([]);
    expect(allowNotes({ takesItem: 'pr' })).toEqual([]);
  });
});

describe('allowAgentLines', () => {
  const step = (id: string, agentFile?: string) => ({
    id,
    kind: 'agent' as const,
    summary: 'Prompt',
    ...(agentFile ? { agentFile } : {}),
  });

  it('lists each agent file the steps name once, in step order', () => {
    expect(
      allowAgentLines({
        steps: [
          step('look', 'agents/reviewer.md'),
          step('tell', 'agents/noter.md'),
          { id: 'fetch', kind: 'run' as const, summary: 'git fetch' },
          step('again', 'agents/reviewer.md'),
        ],
      }),
    ).toEqual([
      { file: 'agents/reviewer.md', text: 'Uses agents/reviewer.md' },
      { file: 'agents/noter.md', text: 'Uses agents/noter.md' },
    ]);
  });

  it('lists none for an entry with no agent step', () => {
    expect(allowAgentLines({ steps: [step('look')] })).toEqual([]);
    expect(allowAgentLines({})).toEqual([]);
  });
});

describe('allowAgentSections (review B1)', () => {
  const step = (id: string, agentFile?: string) => ({
    id,
    kind: 'agent' as const,
    summary: 'Prompt',
    ...(agentFile ? { agentFile } : {}),
  });
  const view = {
    version: 'v1',
    steps: [step('look', 'agents/reviewer.md'), step('tell', 'agents/noter.md')],
  };
  const loaded = {
    version: 'v1',
    readsItems: false,
    agents: [
      {
        name: 'reviewer',
        file: 'agents/reviewer.md',
        description: 'Reviews the PR.',
        body: 'APPLIED-V1-BODY\n',
        mcpServers: [],
        skills: [],
      },
      {
        name: 'noter',
        file: 'agents/noter.md',
        body: 'Write a note.\n',
        mcpServers: [],
        skills: [],
      },
    ],
  };

  it("shows each agent's description and body once main has read this version, and Allow may go", () => {
    expect(allowAgentSections(view, loaded, false)).toEqual({
      ready: true,
      readsItems: false,
      agents: [
        {
          file: 'agents/reviewer.md',
          text: 'Uses agents/reviewer.md',
          openLabel: 'Open',
          description: 'Reviews the PR.',
          body: 'APPLIED-V1-BODY\n',
        },
        {
          file: 'agents/noter.md',
          text: 'Uses agents/noter.md',
          openLabel: 'Open',
          body: 'Write a note.\n',
        },
      ],
    });
  });

  it('holds Allow back until the bodies of the version it would accept are there', () => {
    for (const notYet of [undefined, null, { ...loaded, version: 'v0' }]) {
      const sections = allowAgentSections(view, notYet, false);
      expect(sections.ready).toBe(false);
      expect(sections.agents.map((agent) => agent.body)).toEqual([undefined, undefined]);
    }
    // A body the read does not hold is not shown as if it were.
    const missing = allowAgentSections(view, { ...loaded, agents: [loaded.agents[0]] }, false);
    expect(missing.ready).toBe(false);
  });

  it('while the folder does not apply, says the body is the running version, and Open is the file as it is now', () => {
    const sections = allowAgentSections(view, loaded, true);
    expect(sections.ready).toBe(true);
    expect(sections.agents.map((agent) => [agent.openLabel, agent.note])).toEqual([
      ['Open as it is now', RUNNING_VERSION_NOTE],
      ['Open as it is now', RUNNING_VERSION_NOTE],
    ]);
  });

  it('is ready at once for an entry without agents', () => {
    expect(allowAgentSections({ version: 'v1', steps: [step('look')] }, undefined, true)).toEqual({
      ready: true,
      readsItems: false,
      agents: [],
    });
  });

  it("gives each agent's server lines, with the tools the probe listed, its skills, and the item line at this version (2-C)", () => {
    const investigating = {
      version: 'v1',
      readsItems: true,
      agents: [
        {
          ...loaded.agents[0],
          mcpServers: [
            { name: 'claude.ai Coralogix', knownTools: ['query_logs', 'list_alerts'] },
            { name: 'grafana', tools: ['query_logs'] },
          ],
          skills: ['incident-triage'],
        },
        loaded.agents[1],
      ],
    };
    const sections = allowAgentSections(view, investigating, false);
    expect(sections.readsItems).toBe(true);
    expect(sections.agents[0]).toMatchObject({
      servers: [
        'claude.ai Coralogix: all its tools (query_logs, list_alerts), including any that post or change things',
        'grafana: query_logs only',
      ],
      skills: ['incident-triage'],
    });
    // An agent naming neither has neither key.
    expect(Object.prototype.hasOwnProperty.call(sections.agents[1], 'servers')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(sections.agents[1], 'skills')).toBe(false);
    // Read for another version, nothing of it is shown.
    const stale = allowAgentSections(view, { ...investigating, version: 'v0' }, false);
    expect(stale.readsItems).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(stale.agents[0], 'servers')).toBe(false);
  });
});

describe('openFileWords', () => {
  it('names the file as it is now while the folder does not apply', () => {
    expect(openFileWords(false)).toBe('Open in editor');
    expect(openFileWords(true)).toBe('Open as it is now');
  });
});
