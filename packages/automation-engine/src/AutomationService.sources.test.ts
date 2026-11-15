import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { automationVersion, parseFactorySpec, stableStringify } from '@consola/factory-spec';
import { listDefinition } from './AutomationService';
import {
    factoryWith,
    PR_51_URL,
    RE_REVIEW_COMMAND,
    RE_REVIEW_ENTRY,
    RE_REVIEW_NAME,
    sourcesHarness,
    WORKSPACE_ID,
    type SourcesHarness,
} from './sources/sources.test-helpers';
import type { FakeCommand } from './steps/steps.test-helpers';

/** A poll on GitHub work items, with the job and any other keys as given (each line at the entry's indent). */
function pollOnItems(job: string, extra = ''): string {
    return `- name: checker
  on:
    poll:
      every: 30m
      run: ./list-prs
      item: { github: .url }
${extra}${job}`;
}

/** A run on demand: `applies_to` as given (none when empty), then the job. */
function onDemand(appliesTo: string, job: string): string {
    return `- name: on-demand
  on: manual
${appliesTo ? `  applies_to: ${appliesTo}\n` : ''}${job}`;
}

const TOOL = '  run: { tool: consola#cleanup_stale_sessions }\n';
const PROMPT = '  run: { prompt: Look at it. }\n';
const ACTION = (name: string) => `  run: { action: ${name} }\n`;
const ACTION_STEP = (name: string) => `  steps:\n    - id: act\n      action: ${name}\n`;

const view = (h: SourcesHarness) => h.service.list(WORKSPACE_ID)[0];
const problemOf = (h: SourcesHarness) => view(h).problem;

/** Allow the entry `name` at the version its view shows; that version. Its first check starts at once. */
function allowAsShown(h: SourcesHarness, name = RE_REVIEW_NAME): string {
    const shown = h.service.list(WORKSPACE_ID).find((candidate) => candidate.name === name)!;
    expect(shown).toMatchObject({ needsAllow: true, version: expect.any(String) });
    h.service.allow(WORKSPACE_ID, name, shown.version!);
    return shown.version!;
}

/** Sprocket with no account bound. */
async function unbound(h: SourcesHarness): Promise<void> {
    h.world.workspace.provider = undefined;
    await h.service.syncWorkspaces();
}

/** The Triage action, made to apply to nothing. */
async function triageAppliesToNothing(h: SourcesHarness): Promise<void> {
    h.world.workspace.actions = h.world.workspace.actions.map((action) => (action.name === 'Triage' ? { ...action, appliesTo: [] } : action));
    await h.service.syncWorkspaces();
}

describe('resolving', () => {
    it("lists the spec's template as a poll on pull requests or issues", async () => {
        const h = await sourcesHarness({ yaml: factoryWith(RE_REVIEW_ENTRY) });
        expect(problemOf(h)).toBeUndefined();
        expect(view(h)).toMatchObject({
            name: RE_REVIEW_NAME,
            source: 'poll',
            onEvent: true,
            trigger: 'Every 30 minutes, checks with a command',
            takesItem: 'pr-or-issue',
            runs: 'Steps: fresh → review → publish',
        });
        expect(view(h).check).toEqual({ command: RE_REVIEW_COMMAND, every: '30 minutes', changed: '.head' });
    });

    it('lists a run on demand as on demand', async () => {
        const h = await sourcesHarness({ yaml: factoryWith(onDemand('[pr]', ACTION('Review'))) });
        expect(problemOf(h)).toBeUndefined();
        expect(view(h)).toMatchObject({ source: 'manual', onEvent: false, trigger: 'On demand', takesItem: 'pr' });
        expect(view(h).check).toBeUndefined();

        await h.setYaml(factoryWith(onDemand('', '  scope: api\n' + PROMPT)));
        expect(problemOf(h)).toBeUndefined();
        expect(view(h)).toMatchObject({ source: 'manual', onEvent: false, trigger: 'On demand' });
        expect(view(h)).not.toHaveProperty('takesItem');
    });

    describe('a poll', () => {
        it('runs no tool', async () => {
            const h = await sourcesHarness({ yaml: factoryWith(pollOnItems(TOOL)) });
            // Before anything about its item: an account bound, or not, does not change what it may run.
            await unbound(h);
            expect(problemOf(h)).toBe(
                'tools run on a schedule; a poll starts an agent session or steps (`run: { action: … }`, `run: { prompt: … }` or `steps:`)'
            );
        });

        it("with item: needs that connection's account bound", async () => {
            const h = await sourcesHarness({ yaml: factoryWith(pollOnItems(PROMPT, '  scope: api\n')) });
            h.world.urlConnections.clear();
            await unbound(h);
            expect(problemOf(h)).toBe('this workspace has no github account bound; bind one in its settings');
        });

        it('with item: needs a connection that reads work item URLs', async () => {
            const h = await sourcesHarness({ yaml: factoryWith(pollOnItems(PROMPT, '  scope: api\n')) });
            h.world.urlConnections.clear();
            await h.service.syncWorkspaces();
            expect(problemOf(h)).toBe('github cannot read work item URLs, so `item:` cannot name it');
        });

        it('with item: takes no scope when its items have a repository', async () => {
            const h = await sourcesHarness({ yaml: factoryWith(pollOnItems(ACTION_STEP('Triage'), '  scope: api\n')) });
            await triageAppliesToNothing(h);
            expect(problemOf(h)).toBe('scope: a github item works in a checkout of its own repository, so it takes no scope');
        });

        it('with item: runs an action that applies to pull requests or to issues', async () => {
            for (const job of [ACTION('Review'), ACTION('Triage'), ACTION_STEP('Review'), ACTION_STEP('Triage')]) {
                const h = await sourcesHarness({ yaml: factoryWith(pollOnItems(job)) });
                expect(problemOf(h), job).toBeUndefined();
                expect(view(h).takesItem, job).toBe('pr-or-issue');
            }
        });

        it('with item: runs no action that applies to neither, as a step or as its run', async () => {
            for (const job of [ACTION('Triage'), ACTION_STEP('Triage')]) {
                const h = await sourcesHarness({ yaml: factoryWith(pollOnItems(job)) });
                await triageAppliesToNothing(h);
                expect(problemOf(h), job).toBe('the Triage action applies to neither pull requests nor issues; write it as a prompt');
            }
        });

        it('with key: takes an item of its check, in its scope', async () => {
            const keyed = `- name: tickets
  on:
    poll: { every: 1h, run: ./tickets, key: .id }
  scope: api
${PROMPT}`;
            const h = await sourcesHarness({ yaml: factoryWith(keyed) });
            expect(problemOf(h)).toBeUndefined();
            expect(view(h)).toMatchObject({
                source: 'poll',
                onEvent: true,
                trigger: 'Every 1 hour, checks with a command',
                takesItem: 'item',
                check: { command: './tickets', every: '1 hour' },
            });
            expect(view(h).check).not.toHaveProperty('changed');
        });
    });

    describe('a run on demand with applies_to', () => {
        it('needs a connection bound', async () => {
            // Before the action: whether Triage applies to pull requests is asked of a connection's items.
            const h = await sourcesHarness({ yaml: factoryWith(onDemand('[pr]', ACTION('Triage'))) });
            await unbound(h);
            expect(problemOf(h)).toBe('applies_to needs a connection bound to this workspace; bind one in its settings');
        });

        it('runs an action only when it applies to every type it lists', async () => {
            for (const job of [ACTION('Triage'), ACTION_STEP('Triage')]) {
                const h = await sourcesHarness({ yaml: factoryWith(onDemand('[pr, issue]', job)) });
                expect(problemOf(h), job).toBe('the Triage action does not apply to pull requests');
            }
            const h = await sourcesHarness({ yaml: factoryWith(onDemand('[issue]', ACTION('Triage'))) });
            expect(problemOf(h)).toBeUndefined();
            expect(view(h).takesItem).toBe('issue');
        });

        it('takes pull requests or issues when it lists both', async () => {
            const h = await sourcesHarness({ yaml: factoryWith(onDemand('[issue, pr]', PROMPT)) });
            expect(problemOf(h)).toBeUndefined();
            expect(view(h).takesItem).toBe('pr-or-issue');
        });
    });

    it("says what each entry's runs take, absent when they take no item", async () => {
        const event = `- name: on-review
  on: { github: pull_request.review_requested }
${PROMPT}`;
        const daily = `- name: daily
  on: { cron: "0 9 * * 1-5" }
  scope: api
${PROMPT}`;
        const h = await sourcesHarness({ yaml: factoryWith(event, daily) });
        const [onReview, onSchedule] = h.service.list(WORKSPACE_ID);
        expect(onReview).toMatchObject({ source: 'event', onEvent: true, takesItem: 'pr' });
        expect(onSchedule).toMatchObject({ source: 'cron', onEvent: false });
        expect(onSchedule).not.toHaveProperty('takesItem');
        expect(onSchedule).not.toHaveProperty('check');
    });

    it('never makes a run without an item for an entry whose runs take one', async () => {
        const h = await sourcesHarness({ yaml: factoryWith(RE_REVIEW_ENTRY, onDemand('[pr]', ACTION('Review'))) });
        for (const name of [RE_REVIEW_NAME, 'on-demand']) {
            await h.service.trigger(WORKSPACE_ID, name).catch(() => null);
            await h.service.trigger(WORKSPACE_ID, name, { sessionId: 's-9' }).catch(() => null);
        }
        await h.flush();
        expect(h.store.runs()).toEqual([]);
        await expect(h.service.trigger(WORKSPACE_ID, 'on-demand')).rejects.toThrow('Pick an item to run it on.');
    });

    it("a poll's definition ignores its interval", () => {
        const at = (every: string, command = './list-prs') =>
            parseFactorySpec(factoryWith(pollOnItems(PROMPT).replace('every: 30m', `every: ${every}`).replace('./list-prs', command)))
                .automations[0];
        const account = { id: 'github', accountLogin: 'JaviDev' };
        expect(at('2h').trigger).toMatchObject({ kind: 'poll', everyMs: 7_200_000 });
        expect(listDefinition({ automation: at('30m') }, account)).toBe(listDefinition({ automation: at('2h') }, account));
        // What it watches is still in it: the command, and whose account it runs as.
        expect(listDefinition({ automation: at('30m', './other-prs') }, account)).not.toBe(listDefinition({ automation: at('30m') }, account));
        expect(listDefinition({ automation: at('30m') }, { ...account, accountLogin: 'alice' })).not.toBe(listDefinition({ automation: at('30m') }, account));
    });

    it("an event's definition hashes as it did before polls existed", () => {
        const [automation] = parseFactorySpec(
            factoryWith(`- name: on-review\n  on: { github: pull_request.review_requested }\n  filter: { authors_not: [bob] }\n${PROMPT}`)
        ).automations;
        const provider = { id: 'github', accountLogin: 'JaviDev', org: 'sprocket' };
        const before = createHash('sha256')
            .update(stableStringify({ trigger: automation.trigger, filter: automation.filter, account: { id: 'github', login: 'JaviDev', org: 'sprocket' } }))
            .digest('hex')
            .slice(0, 16);
        expect(listDefinition({ automation }, provider)).toBe(before);
    });
});

describe('allowing', () => {
    const KEY = `${WORKSPACE_ID} ${RE_REVIEW_NAME}`;
    /** What a run of a poll entry not allowed yet says it asks for. */
    const NOT_CHECKING_YET = 'It is not checking yet: approving runs this run only. Allow it on its page to let it check and run on its own.';
    /** The template with its check command edited: a new version. */
    const EDITED = RE_REVIEW_ENTRY.replace('first: 50', 'first: 20');

    const needsOk = (name: string) => ({
        title: `\`${name}\` needs your OK to start checking`,
        body: 'Review it in Consola.',
        workspaceId: WORKSPACE_ID,
        automation: name,
        needsApproval: false,
    });
    const changed = (name: string) => ({ ...needsOk(name), title: `\`${name}\` changed, and has stopped checking until you allow it` });

    it('nothing is spawned before allow', async () => {
        const h = await sourcesHarness({ yaml: factoryWith(RE_REVIEW_ENTRY) });
        for (let tick = 0; tick < 3; tick++) {
            h.advance(40 * 60_000);
            await h.tick();
        }
        expect(h.world.commands).toEqual([]);
        expect(view(h).needsAllow).toBe(true);
    });

    it('allow with a stale version is refused', async () => {
        const h = await sourcesHarness({ yaml: factoryWith(RE_REVIEW_ENTRY) });
        const allowed = allowAsShown(h);
        await h.setPoll(EDITED);
        expect(() => h.service.allow(WORKSPACE_ID, RE_REVIEW_NAME, allowed)).toThrow('It changed since you looked; review it again.');
        expect(h.store.acceptedVersion(KEY)).toBe(allowed);
        expect(view(h).needsAllow).toBe(true);
    });

    it('allow accepts, and the entry no longer needs it', async () => {
        const h = await sourcesHarness({ yaml: factoryWith(RE_REVIEW_ENTRY) });
        const broadcasts = h.world.broadcasts.length;
        const allowed = allowAsShown(h);
        expect(h.store.acceptedVersion(KEY)).toBe(allowed);
        expect(view(h)).not.toHaveProperty('needsAllow');
        expect(view(h)).not.toHaveProperty('version');
        // The page drops its banner without waiting for anything else to change.
        expect(h.world.broadcasts.length).toBeGreaterThan(broadcasts);
    });

    it('allow refuses an entry that cannot check, and one with no check', async () => {
        const daily = `- name: daily\n  on: { cron: "0 9 * * 1-5" }\n  scope: api\n${PROMPT}`;
        const h = await sourcesHarness({ yaml: factoryWith(RE_REVIEW_ENTRY, daily) });
        const shown = view(h).version!;
        await unbound(h);
        expect(() => h.service.allow(WORKSPACE_ID, RE_REVIEW_NAME, shown)).toThrow(
            `${RE_REVIEW_NAME} can't check while it has a problem: this workspace has no github account bound; bind one in its settings.`
        );
        expect(() => h.service.allow(WORKSPACE_ID, 'daily', shown)).toThrow('daily has no check command to allow.');
        expect(h.store.acceptedVersion(KEY)).toBeUndefined();
        expect(h.store.acceptedVersion(`${WORKSPACE_ID} daily`)).toBeUndefined();
    });

    it('saveEntry takes it back', async () => {
        const h = await sourcesHarness({ yaml: factoryWith(RE_REVIEW_ENTRY) });
        allowAsShown(h);
        const saved = await h.service.saveEntry(WORKSPACE_ID, RE_REVIEW_ENTRY, { replace: true });
        expect(saved).toMatchObject({ name: RE_REVIEW_NAME, replaced: true, needsAllow: true });
        expect(view(h).needsAllow).toBe(true);
        expect(h.store.acceptedVersion(KEY)).toBeUndefined();
        // The same version, allowed once and taken back: a notification asks again.
        expect(h.notices).toEqual([needsOk(RE_REVIEW_NAME)]);
    });

    it('saveEntry of an entry with no check says nothing about allowing', async () => {
        const h = await sourcesHarness();
        const saved = await h.service.saveEntry(WORKSPACE_ID, `- name: daily\n  on: { cron: "0 9 * * 1-5" }\n  scope: api\n${PROMPT}`, { replace: false });
        expect(saved).not.toHaveProperty('needsAllow');
        expect(h.notices).toEqual([]);
    });

    it('a hand edit that changes the version notifies once', async () => {
        const h = await sourcesHarness({ yaml: factoryWith(RE_REVIEW_ENTRY) });
        allowAsShown(h);
        await h.setPoll(EDITED);
        await h.service.reload(WORKSPACE_ID);
        expect(h.notices).toEqual([changed(RE_REVIEW_NAME)]);
        expect(h.notices[0]).not.toHaveProperty('runId');
        expect(view(h).needsAllow).toBe(true);
    });

    it('an edit to every alone keeps it allowed', async () => {
        const h = await sourcesHarness({ yaml: factoryWith(RE_REVIEW_ENTRY) });
        const allowed = allowAsShown(h);
        await h.setPoll(RE_REVIEW_ENTRY.replace('every: 30m', 'every: 2h'));
        expect(view(h).check?.every).toBe('2 hours');
        expect(view(h)).not.toHaveProperty('needsAllow');
        expect(h.store.acceptedVersion(KEY)).toBe(allowed);
        expect(h.notices).toEqual([]);
    });

    it('a new poll entry asks once', async () => {
        const h = await sourcesHarness();
        await h.setPoll();
        expect(h.notices).toEqual([needsOk(RE_REVIEW_NAME)]);
        expect(h.notices[0]).not.toHaveProperty('runId');
        await h.service.reload(WORKSPACE_ID);
        await h.service.syncWorkspaces();
        expect(h.notices).toHaveLength(1);
    });

    it('a launch does not re-announce an entry that was never allowed', async () => {
        const h = await sourcesHarness();
        await h.setPoll();
        expect(h.notices).toHaveLength(1);
        const next = await h.relaunch();
        expect(next.notices).toHaveLength(1);
        expect(view(next).needsAllow).toBe(true);
        // Recorded at launch, not just passed over: a later look stays quiet too.
        await next.service.reload(WORKSPACE_ID);
        expect(next.notices).toHaveLength(1);
    });

    it('an entry edited while Consola was closed is announced as changed at launch', async () => {
        const h = await sourcesHarness({ yaml: factoryWith(RE_REVIEW_ENTRY) });
        allowAsShown(h);
        // Unedited, an allowed entry is not announced at all.
        const same = await h.relaunch();
        expect(same.notices).toEqual([]);
        const next = await same.relaunchWith(factoryWith(EDITED));
        expect(next.notices).toEqual([changed(RE_REVIEW_NAME)]);
        expect(view(next).needsAllow).toBe(true);
    });

    it('a run of an entry not allowed yet says approving runs only that run', async () => {
        const h = await sourcesHarness({ yaml: factoryWith(RE_REVIEW_ENTRY) });
        const run = await h.fire();
        expect(run.status).toBe('needs-approval');
        expect(run.summary!.slice(-NOT_CHECKING_YET.length)).toBe(NOT_CHECKING_YET);
        expect(run.summary).not.toContain('Approve once to let this new or changed automation run on its own.');
    });

    it('an allowed confirm poll still asks for each run', async () => {
        const h = await sourcesHarness({ yaml: factoryWith(RE_REVIEW_ENTRY.replace('mode: auto', 'mode: confirm')) });
        allowAsShown(h);
        const run = await h.fire();
        expect(run).toMatchObject({ status: 'needs-approval', mode: 'confirm' });
        expect(run.summary).not.toContain(NOT_CHECKING_YET);
    });

    it('an allowed notify poll runs dry runs', async () => {
        const notifyReview = `- name: notify-review
  on:
    poll: { every: 30m, run: ./list-prs, item: { github: .url } }
  mode: notify
  steps:
    - id: review
      prompt: Review it and say what should change.
`;
        // No agent slot is free, so the run stays in line where the test can see it.
        const h = await sourcesHarness({ yaml: factoryWith(notifyReview), maxConcurrentAgents: 0 });
        allowAsShown(h, 'notify-review');
        const run = await h.fire('notify-review');
        expect(run).toMatchObject({ status: 'queued', mode: 'notify', dryRun: true });
    });

    it('editing an action a step names stops the checks', async () => {
        const h = await sourcesHarness({ yaml: factoryWith(pollOnItems(ACTION_STEP('Review'))) });
        const allowed = allowAsShown(h, 'checker');
        // Allowing ran its first check at once; it ends before the edit.
        await h.check();
        const checked = h.world.commands.length;
        h.world.workspace.actions = h.world.workspace.actions.map((action) =>
            action.name === 'Review' ? { ...action, prompt: 'Review {{title}} again, more briefly.' } : action
        );
        await h.service.syncWorkspaces();
        expect(view(h)).toMatchObject({ needsAllow: true });
        expect(view(h).version).not.toBe(allowed);
        expect(h.notices).toEqual([changed('checker')]);
        h.advance(30 * 60_000);
        await h.tick();
        expect(h.world.commands).toHaveLength(checked);
    });
});

describe('checking', () => {
    const MINUTE = 60_000;
    /** What #51 looks like to the template's check: its URL, title and head. */
    const PR_51_ROW = { url: PR_51_URL, title: 'Fix the cart total', head: 'a' };
    /** The template with its check command edited: a new version, which needs Allow again. */
    const EDITED_CHECK = RE_REVIEW_ENTRY.replace('first: 50', 'first: 20');
    const BOOM = { stderr: 'boom\n', result: { exitCode: 1, lastStderrLine: 'boom' } };

    const checkOf = (h: SourcesHarness, name = RE_REVIEW_NAME) => h.service.list(WORKSPACE_ID).find((entry) => entry.name === name)!.check!;
    const automationOf = (command: FakeCommand) => command.spec.env.CONSOLA_AUTOMATION;
    const cantCheck = (error: string, name = RE_REVIEW_NAME) => ({
        title: `\`${name}\` can't check: ${error}`,
        body: 'Review it in Consola.',
        workspaceId: WORKSPACE_ID,
        automation: name,
        needsApproval: false,
    });
    /** A poll on GitHub work items named `name`, running a prompt. */
    const checker = (name: string) => pollOnItems(PROMPT).replace('name: checker', `name: ${name}`);

    /** ws-1 holding the template, allowed: its first check is running. */
    async function allowedTemplate(options: Parameters<typeof sourcesHarness>[0] = {}): Promise<SourcesHarness> {
        const h = await sourcesHarness({ yaml: factoryWith(RE_REVIEW_ENTRY), ...options });
        allowAsShown(h);
        await h.flush();
        return h;
    }

    it('the first check comes at the first tick after start, once allowed', async () => {
        const h = await sourcesHarness({ yaml: factoryWith(RE_REVIEW_ENTRY) });
        expect(h.world.commands).toEqual([]);
        allowAsShown(h);
        await h.flush();
        expect(h.world.commands.map(automationOf)).toEqual([RE_REVIEW_NAME]);
        await h.check();
        // Nothing of when it last checked outlives a quit: the first tick after start-up checks.
        const next = await h.relaunch();
        await next.flush();
        expect(next.world.commands.map(automationOf)).toEqual([RE_REVIEW_NAME, RE_REVIEW_NAME]);
    });

    it('the next is due every after the last ended', async () => {
        const h = await allowedTemplate();
        // The check takes five minutes: the interval counts from its end.
        h.advance(5 * MINUTE);
        await h.check();
        const ended = h.now().getTime();
        expect(checkOf(h)).toMatchObject({ lastAt: new Date(ended).toISOString(), nextAt: new Date(ended + 30 * MINUTE).toISOString() });
        h.advance(30 * MINUTE - 1);
        await h.tick();
        expect(h.world.commands).toHaveLength(1);
        h.advance(1);
        await h.tick();
        expect(h.world.commands).toHaveLength(2);
    });

    it("a check runs in the workspace's folder as you, with hooks off", async () => {
        const h = await allowedTemplate();
        const [{ spec }] = h.world.commands;
        const logs = h.folder.checkFiles(WORKSPACE_ID, RE_REVIEW_NAME);
        expect(spec).toMatchObject({
            command: RE_REVIEW_COMMAND,
            cwd: h.folder.workspaceDir(WORKSPACE_ID),
            env: { CONSOLA_AUTOMATION: RE_REVIEW_NAME, GH_TOKEN: 'gho_stub', GIT_CONFIG_KEY_0: 'core.hooksPath' },
            secrets: ['gho_stub'],
            timeoutMs: 60_000,
            stdoutPath: logs.stdout,
            stderrPath: logs.stderr,
        });
        // No env: of its own, no run and no step: there is no item yet.
        expect(Object.keys(spec.env).filter((name) => name.startsWith('CONSOLA_'))).toEqual(['CONSOLA_AUTOMATION']);
        expect(h.world.commandEnvAsked).toEqual([WORKSPACE_ID]);
        expect(h.store.runs()).toEqual([]);
    });

    it('at most two checks at once, one per automation', async () => {
        const names = ['checker-a', 'checker-b', 'checker-c'];
        const h = await sourcesHarness({ yaml: factoryWith(...names.map(checker)) });
        for (const name of names) allowAsShown(h, name);
        await h.flush();
        expect(h.world.commands.map(automationOf)).toEqual(['checker-a', 'checker-b']);
        await h.world.commands[0].end({ stdout: '[]' });
        expect(h.world.commands.map(automationOf)).toEqual(['checker-a', 'checker-b', 'checker-c']);
        // Check now on one that is running: that check is the one asked for.
        expect(await h.service.trigger(WORKSPACE_ID, 'checker-b')).toBeNull();
        await h.flush();
        expect(h.world.commands).toHaveLength(3);
        await h.check();
        expect(h.world.commands).toHaveLength(3);
        // All three due together: two start, the third once one ends.
        h.advance(30 * MINUTE);
        await h.tick();
        expect(h.world.commands.slice(3).map(automationOf)).toEqual(['checker-a', 'checker-b']);
        await h.world.commands[4].end({ stdout: '[]' });
        expect(h.world.commands.slice(3).map(automationOf)).toEqual(['checker-a', 'checker-b', 'checker-c']);
    });

    it('Check now with no free slot checks as soon as one frees', async () => {
        const names = ['checker-a', 'checker-b', 'checker-c'];
        const h = await sourcesHarness({ yaml: factoryWith(...names.map(checker)) });
        for (const name of names) allowAsShown(h, name);
        await h.check();
        expect(h.world.commands).toHaveLength(3);
        h.advance(MINUTE);
        for (const name of names) await h.service.trigger(WORKSPACE_ID, name);
        await h.flush();
        expect(h.world.commands.slice(3).map(automationOf)).toEqual(['checker-a', 'checker-b']);
        await h.world.commands[3].end({ stdout: '[]' });
        expect(h.world.commands.slice(3).map(automationOf)).toEqual(['checker-a', 'checker-b', 'checker-c']);
    });

    describe('a check that fails before it runs is a failed check', () => {
        it.each<[string, (h: SourcesHarness) => void, (h: SourcesHarness) => Promise<void>, string]>([
            [
                'its token cannot be borrowed',
                (h) => {
                    h.world.commandEnvThrows = new Error('no oauth token found for github.com account JaviDev');
                },
                async () => {},
                'Its environment could not be prepared (no oauth token found for github.com account JaviDev); nothing ran.',
            ],
            [
                'its command cannot be started',
                (h) => {
                    h.world.onCommand = () => {
                        throw new Error('spawn failed with GH_TOKEN=gho_stub');
                    };
                },
                async () => {},
                'The command could not start (spawn failed with GH_TOKEN=***); nothing ran.',
            ],
            [
                'its result rejects',
                () => {},
                async (h) => h.world.commands[h.world.commands.length - 1].neverStarted(new Error('spawn /bin/sh ENOENT')),
                'The command could not start (spawn /bin/sh ENOENT); nothing ran.',
            ],
        ])('when %s', async (_name, arrange, settle, error) => {
            const h = await sourcesHarness({ yaml: factoryWith(RE_REVIEW_ENTRY) });
            arrange(h);
            allowAsShown(h);
            await h.flush();
            await settle(h);
            expect(checkOf(h)).toMatchObject({ error, lastAt: h.now().toISOString() });
            expect(h.notices).toEqual([cantCheck(error)]);
            // Not left running: the next due tick tries again, as the same run of failures.
            expect(h.world.commandEnvAsked).toHaveLength(1);
            h.advance(60 * MINUTE);
            await h.tick();
            await settle(h);
            expect(h.world.commandEnvAsked).toHaveLength(2);
            expect(checkOf(h).error).toBe(error);
            expect(h.notices).toHaveLength(1);
        });
    });

    it('a check never takes an agent or a command slot', async () => {
        const busy = (name: string) => `- name: ${name}\n  on: { cron: "0 9 * * 1-5" }\n  scope: api\n  mode: auto\n  steps:\n    - id: wait\n      run: sleep 600\n`;
        const yaml = factoryWith(busy('busy-a'), busy('busy-b'), RE_REVIEW_ENTRY);
        const h = await sourcesHarness({ yaml, maxConcurrentAgents: 0, maxConcurrentCommands: 2 });
        for (const automation of parseFactorySpec(yaml).automations) {
            if (automation.trigger.kind === 'cron') h.store.accept(`${WORKSPACE_ID} ${automation.name}`, automationVersion(automation));
        }
        await h.service.trigger(WORKSPACE_ID, 'busy-a');
        await h.service.trigger(WORKSPACE_ID, 'busy-b');
        await h.flush();
        // Both command slots are held by running steps.
        expect(h.world.commands.map((command) => command.spec.env.CONSOLA_STEP)).toEqual(['wait', 'wait']);
        expect(h.store.runs().map((run) => run.status)).toEqual(['running', 'running']);
        allowAsShown(h);
        await h.flush();
        expect(h.world.commands.map(automationOf)).toEqual([undefined, undefined, RE_REVIEW_NAME]);
    });

    it('a failed check records why and notifies once per run of failures', async () => {
        const h = await allowedTemplate();
        await h.world.commands[0].end(BOOM);
        expect(h.service.list(WORKSPACE_ID)[0].check!.error).toBe('exit 1: boom');
        // A failure doubles the wait.
        h.advance(60 * MINUTE);
        await h.tick();
        await h.world.commands[1].end(BOOM);
        expect(h.service.list(WORKSPACE_ID)[0].check!.error).toBe('exit 1: boom');
        expect(h.notices).toEqual([cantCheck('exit 1: boom')]);
        h.advance(60 * MINUTE);
        await h.check();
        expect(h.world.commands).toHaveLength(3);
        expect(checkOf(h)).not.toHaveProperty('error');
        expect(checkOf(h)).toMatchObject({ items: 0, fired: 0, skipped: 0 });
        // Its next failure starts a new run of them.
        h.advance(30 * MINUTE);
        await h.tick();
        await h.world.commands[3].end(BOOM);
        expect(h.notices).toEqual([cantCheck('exit 1: boom'), cantCheck('exit 1: boom')]);
    });

    it('output it cannot read is a failed check', async () => {
        const h = await allowedTemplate();
        await h.world.commands[0].end({ stdout: '{}' });
        const error = 'Its stdout is a JSON object, not an array of objects.';
        expect(checkOf(h)).toMatchObject({ error });
        expect(checkOf(h)).not.toHaveProperty('items');
        expect(h.notices).toEqual([cantCheck(error)]);
    });

    it('a check that succeeds keeps what it found', async () => {
        const h = await allowedTemplate();
        h.pollOutput([PR_51_ROW, { ...PR_51_ROW, url: PR_51_URL.replace('/51', '/52'), title: 'Tidy the basket' }]);
        await h.check();
        expect(checkOf(h)).toEqual({
            command: RE_REVIEW_COMMAND,
            every: '30 minutes',
            changed: '.head',
            lastAt: h.now().toISOString(),
            items: 2,
            fired: 0,
            skipped: 0,
            nextAt: new Date(h.now().getTime() + 30 * MINUTE).toISOString(),
        });
        // A check is not a run: nothing is recorded while nothing fires.
        expect(h.store.runs()).toEqual([]);
        expect(h.notices).toEqual([]);
    });

    it('a result that lands after the entry changed is dropped', async () => {
        const h = await allowedTemplate();
        await h.setPoll(EDITED_CHECK);
        await h.world.commands[0].end({ stdout: JSON.stringify([PR_51_ROW]) });
        expect(checkOf(h)).not.toHaveProperty('lastAt');
        expect(checkOf(h)).not.toHaveProperty('items');
        expect(view(h).needsAllow).toBe(true);
        // The new version does not check until it is allowed.
        expect(h.world.commands).toHaveLength(1);
        h.advance(30 * MINUTE);
        await h.tick();
        expect(h.world.commands).toHaveLength(1);
        expect(h.notices.map((notice) => notice.title)).toEqual([`\`${RE_REVIEW_NAME}\` changed, and has stopped checking until you allow it`]);
    });

    it('a result that lands after its allowance was taken back is dropped', async () => {
        const h = await allowedTemplate();
        await h.service.saveEntry(WORKSPACE_ID, RE_REVIEW_ENTRY, { replace: true });
        await h.world.commands[0].end(BOOM);
        expect(checkOf(h)).not.toHaveProperty('error');
        expect(h.notices.map((notice) => notice.title)).toEqual([`\`${RE_REVIEW_NAME}\` needs your OK to start checking`]);
    });

    it('Check now starts it at once', async () => {
        const h = await allowedTemplate();
        await h.check();
        h.advance(MINUTE);
        expect(await h.service.trigger(WORKSPACE_ID, RE_REVIEW_NAME)).toBeNull();
        await h.flush();
        expect(h.world.commands.map(automationOf)).toEqual([RE_REVIEW_NAME, RE_REVIEW_NAME]);
        expect(h.store.runs()).toEqual([]);
    });

    it('Check now refuses an entry not allowed yet', async () => {
        const h = await sourcesHarness({ yaml: factoryWith(RE_REVIEW_ENTRY) });
        await expect(h.service.trigger(WORKSPACE_ID, RE_REVIEW_NAME)).rejects.toThrow(
            `\`${RE_REVIEW_NAME}\` is not checking yet: allow it first.`
        );
        await h.flush();
        expect(h.world.commands).toEqual([]);
        expect(h.world.commandEnvAsked).toEqual([]);
    });

    it('quitting stops a running check', async () => {
        const h = await allowedTemplate();
        h.service.shutdown();
        expect(h.world.commands[0].stops).toBe(1);
        await h.world.commands[0].end({ result: { exitCode: null, signal: 'SIGTERM', stopped: true } });
        await h.tick();
        expect(h.notices).toEqual([]);
        expect(h.world.commands).toHaveLength(1);
    });

    it('deleting a workspace stops its check and removes its logs', async () => {
        const h = await allowedTemplate();
        const logs = path.dirname(h.folder.checkFiles(WORKSPACE_ID, RE_REVIEW_NAME).stdout);
        expect(fs.existsSync(logs)).toBe(true);
        h.world.workspaceDeleted = true;
        await h.service.syncWorkspaces();
        expect(h.world.commands[0].stops).toBe(1);
        expect(fs.existsSync(logs)).toBe(false);
        // Whatever it reports afterwards changes nothing.
        await h.world.commands[0].neverStarted(new Error('spawn /bin/sh ENOENT'));
        expect(h.notices).toEqual([]);
    });

    it("a clean load sweeps the logs of checks it no longer has; a broken one keeps them", async () => {
        const h = await allowedTemplate();
        await h.check();
        const logs = path.dirname(h.folder.checkFiles(WORKSPACE_ID, RE_REVIEW_NAME).stdout);
        expect(fs.existsSync(logs)).toBe(true);
        // A typo hides the entry: its logs stay, as its records do.
        const broken = factoryWith(RE_REVIEW_ENTRY.replace('every: 30m', 'every: 30x'));
        expect(parseFactorySpec(broken).issues).not.toEqual([]);
        await h.setYaml(broken);
        expect(fs.existsSync(logs)).toBe(true);
        await h.setPoll();
        expect(fs.existsSync(logs)).toBe(true);
        // Renamed: the old name's logs go.
        await h.setPoll(RE_REVIEW_ENTRY.replace(`name: ${RE_REVIEW_NAME}`, 'name: re-review'));
        expect(fs.existsSync(logs)).toBe(false);
    });

    it('a launch sweeps the logs of a check renamed while Consola was closed', async () => {
        const h = await allowedTemplate();
        await h.check();
        const logs = path.dirname(h.folder.checkFiles(WORKSPACE_ID, RE_REVIEW_NAME).stdout);
        expect(fs.existsSync(logs)).toBe(true);
        await h.relaunchWith(factoryWith(RE_REVIEW_ENTRY.replace(`name: ${RE_REVIEW_NAME}`, 'name: re-review')));
        expect(fs.existsSync(logs)).toBe(false);
    });
});
