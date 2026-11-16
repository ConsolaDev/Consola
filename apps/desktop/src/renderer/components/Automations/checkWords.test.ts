import { describe, expect, it } from 'vitest';
import type { CheckView } from '../../../shared/automations';
import {
    allowBannerWords,
    allowNotes,
    checkStatusLine,
    grantWords,
    skippedWords,
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
        const line = checkStatusLine(check({ lastAt: '2026-11-16T11:58:00.000Z', items: 4, fired: 1 }), now);
        expect(line).toBe('Checked 2m ago: 4 items, 1 new');
    });

    it('reads one item as "1 item"', () => {
        expect(checkStatusLine(check({ lastAt: '2026-11-16T11:58:00.000Z', items: 1, fired: 0 }), now)).toBe(
            'Checked 2m ago: 1 item, 0 new',
        );
    });

    it('says what a baseline is watching, and what makes it run', () => {
        expect(checkStatusLine(check({ lastAt: '2026-11-16T11:58:00.000Z', items: 4, baseline: true, changed: '.head' }), now)).toBe(
            'Watching 4 items. It runs for new ones, and when `.head` changes.',
        );
        expect(checkStatusLine(check({ lastAt: '2026-11-16T11:58:00.000Z', items: 4, baseline: true }), now)).toBe(
            'Watching 4 items. It runs for new ones.',
        );
        expect(checkStatusLine(check({ lastAt: '2026-11-16T11:58:00.000Z', items: 1, baseline: true }), now)).toBe(
            'Watching 1 item. It runs for new ones.',
        );
    });

    it('says why the last check failed, before anything else', () => {
        expect(checkStatusLine(check({ lastAt: '2026-11-16T11:58:00.000Z', items: 4, error: 'exit 1: boom' }), now)).toBe(
            'Last check failed: exit 1: boom',
        );
    });

    it('says nothing before the first check', () => {
        expect(checkStatusLine(check(), now)).toBeNull();
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
        expect(grantWords('auto')).toBe('It then checks, and runs on its own when something is new or changed.');
        expect(grantWords('confirm')).toBe('It then checks; each run still waits for your approval.');
        expect(grantWords('notify')).toBe('It then checks, and runs dry runs: agents review, commands only report.');
    });
});

describe('triggerNodeWords', () => {
    it('names a poll and a manual entry, and leaves the others to today\'s node', () => {
        expect(triggerNodeWords({ source: 'poll', check: check() })).toEqual({ kicker: 'Command check', title: 'Every 30m · command' });
        expect(triggerNodeWords({ source: 'manual' })).toEqual({ kicker: 'On demand', title: 'On demand' });
        expect(triggerNodeWords({ source: 'cron' })).toBeNull();
        expect(triggerNodeWords({ source: 'event' })).toBeNull();
    });

    it('reads a template preview, which has no check, from its trigger text', () => {
        expect(triggerNodeWords({ source: 'poll', trigger: 'poll: every 30m' })).toEqual({
            kicker: 'Command check',
            title: 'Every 30m · command',
        });
        expect(triggerNodeWords({ source: 'poll', check: check({ every: '2 hours' }) })?.title).toBe('Every 2h · command');
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
