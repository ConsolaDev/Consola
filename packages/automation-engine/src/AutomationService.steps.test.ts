import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { automationVersion, parseFactorySpec, stableStringify, type RunRecord } from '@consola/factory-spec';
import { inboxItem } from './inboxItems.test-helpers';
import {
    CHECKOUT_HEAD,
    checkoutPathFor,
    REVIEW_BODY,
    stepsHarness,
    WORKSPACE_ID,
    type StepsHarness,
    type StepsHarnessOptions,
} from './steps/steps.test-helpers';
import { StartedByHandError } from './support';
import type { InboxItemView, SessionView } from './views';

const NAME = 'review-assigned-prs';
const KEY = `${WORKSPACE_ID} ${NAME}`;
const SUMMARISE_BODY = 'Summarise {{title}} for someone who has not read it.';

/** One `- name:` entry: its `on:` and other keys as given, then `steps:` with each item's lines. */
function entry(name: string, head: string, ...steps: string[]): string {
    const items = steps.map((step) => `      ${step.replace(/\n/g, '\n      ')}`).join('\n');
    return `  - name: ${name}\n${head}    steps:\n${items}\n`;
}
const file = (...entries: string[]) => `version: 1\nautomations:\n${entries.join('')}`;

/** A file holding one entry named review-assigned-prs. */
function factory(head: string, ...steps: string[]): string {
    return file(entry(NAME, head, ...steps));
}
const ON_REVIEW = '    on: { github: pull_request.review_requested }\n';
const DAILY_IN_API = '    on: { cron: "0 9 * * 1-5" }\n    scope: api\n';

const PUBLISH = 'gh api "repos/$REPO/pulls/$NUMBER/reviews" -f commit_id="$CONSOLA_CHECKOUT_HEAD" -f event=COMMENT -F body=@"$BODY_FILE"';

/** The shipped review template, shortened: an action step, then a command that posts what it found. */
const TEMPLATE = factory(
    `${ON_REVIEW}    mode: auto\n`,
    '- id: review\n  action: Review\n  outputs:\n    verdict: { enum: [approve, comment, request-changes] }',
    `- id: publish\n  if: steps.review.verdict != 'approve'\n  run: ${PUBLISH}\n  env: { REPO: "{{item.repo}}", NUMBER: "{{item.number}}", BODY_FILE: "{{steps.review.handover.file}}" }`
);

const only = (yaml: string) => parseFactorySpec(yaml).automations[0];

async function listed(options: StepsHarnessOptions) {
    const h = await stepsHarness(options);
    return h.service.list(WORKSPACE_ID)[0];
}

describe('a steps entry, resolved against its workspace', () => {
    it("resolves, its version covering each action step's body", async () => {
        const h = await stepsHarness({ yaml: TEMPLATE });
        expect(h.service.list(WORKSPACE_ID)[0]).toMatchObject({ name: NAME, asksFirst: true });
        expect(h.service.list(WORKSPACE_ID)[0].problem).toBeUndefined();

        h.store.accept(KEY, automationVersion(only(TEMPLATE), stableStringify({ review: REVIEW_BODY })));
        await h.service.syncWorkspaces();
        expect(h.service.list(WORKSPACE_ID)[0].asksFirst).toBeUndefined();

        // Editing the action in settings changes what the step runs: it asks again.
        const review = h.world.workspace.actions[0];
        h.world.workspace.actions[0] = { ...review, prompt: `${REVIEW_BODY} Be brief.` };
        await h.service.syncWorkspaces();
        expect(h.service.list(WORKSPACE_ID)[0].asksFirst).toBe(true);
    });

    it('hashes no body when no step names an action', async () => {
        const yaml = factory(`${DAILY_IN_API}    mode: auto\n`, '- prompt: Summarise what changed in api.', '- run: git log -1');
        const h = await stepsHarness({ yaml });
        h.store.accept(KEY, automationVersion(only(yaml)));
        await h.service.syncWorkspaces();
        expect(h.service.list(WORKSPACE_ID)[0]).toMatchObject({ name: NAME });
        expect(h.service.list(WORKSPACE_ID)[0].problem).toBeUndefined();
        expect(h.service.list(WORKSPACE_ID)[0].asksFirst).toBeUndefined();
    });

    it("hashes every action step's body, not only the first", async () => {
        const yaml = factory(`${ON_REVIEW}    mode: auto\n`, '- id: review\n  action: Review', '- id: summary\n  action: Summarise');
        const h = await stepsHarness({ yaml });
        h.world.workspace.actions.push({ name: 'Summarise', appliesTo: ['pr'], prompt: SUMMARISE_BODY });
        await h.service.syncWorkspaces();
        h.store.accept(KEY, automationVersion(only(yaml), stableStringify({ review: REVIEW_BODY, summary: SUMMARISE_BODY })));
        expect(h.service.list(WORKSPACE_ID)[0].problem).toBeUndefined();
        expect(h.service.list(WORKSPACE_ID)[0].asksFirst).toBeUndefined();

        // The second step's action edited: what the entry runs changed, so it asks again.
        h.world.workspace.actions[2] = { ...h.world.workspace.actions[2], prompt: `${SUMMARISE_BODY} Be brief.` };
        await h.service.syncWorkspaces();
        expect(h.service.list(WORKSPACE_ID)[0].asksFirst).toBe(true);
    });

    it('asks first under notify only when its dry run would start something', async () => {
        const yaml = factory(`${ON_REVIEW}    mode: notify\n`, '- action: Review');
        const agentStep = await stepsHarness({ yaml });
        expect(agentStep.service.list(WORKSPACE_ID)[0]).toMatchObject({ mode: 'notify', asksFirst: true });
        agentStep.store.accept(KEY, automationVersion(only(yaml), stableStringify({ 'step-1': REVIEW_BODY })));
        expect(agentStep.service.list(WORKSPACE_ID)[0].asksFirst).toBeUndefined();

        const fetches = await listed({ yaml: factory(`${DAILY_IN_API}    mode: notify\n`, '- run: git fetch --prune\n  dry_run: run', '- run: git log -1') });
        expect(fetches.asksFirst).toBe(true);

        const reportsOnly = await listed({ yaml: factory(`${DAILY_IN_API}    mode: notify\n`, '- run: git log -1') });
        expect(reportsOnly.problem).toBeUndefined();
        expect(reportsOnly.asksFirst).toBeUndefined();
    });

    it.each<[string, StepsHarnessOptions, string]>([
        ['an action step naming an action the workspace lacks', { yaml: factory(ON_REVIEW, '- action: Nope') }, 'no action named Nope in this workspace'],
        [
            'an action step whose action does not apply to the items',
            { yaml: factory(ON_REVIEW, '- action: Triage') },
            'the Triage action does not apply to pull requests',
        ],
        [
            'an agent step on a harness that cannot run read-only',
            { yaml: factory(ON_REVIEW, '- prompt: Review it.'), harness: { name: 'Codex', problem: 'Codex sessions cannot be made read-only yet.' } },
            'Codex can’t run read-only automation sessions: Codex sessions cannot be made read-only yet',
        ],
        [
            'a run: step on Windows',
            { yaml: factory(ON_REVIEW, '- run: gh pr view "$NUMBER"\n  env: { NUMBER: "{{item.number}}" }'), platform: 'win32' },
            'run: steps need a POSIX shell, which Windows does not have',
        ],
        [
            'an item field the connection lacks',
            { yaml: factory(ON_REVIEW, '- run: echo "$LABELS"\n  env: { LABELS: "{{item.labels}}" }') },
            '`item.labels`: github items have no field `labels` (they have: key, url, repo, number, type, title, author)',
        ],
        [
            'a scope on an event whose items have a repository',
            { yaml: factory(`${ON_REVIEW}    scope: api\n`, '- prompt: Review it.') },
            'scope: a github item runs in a worktree of its own repository, so it takes no scope',
        ],
        [
            'a schedule naming a scope the workspace lacks',
            { yaml: factory('    on: { cron: "0 9 * * 1-5" }\n    scope: web\n', '- prompt: Summarise web.') },
            'no scope named "web" in this workspace; it has: catalog-portal, api',
        ],
    ])('has a problem for %s', async (_name, options, problem) => {
        expect((await listed(options)).problem).toBe(problem);
    });

    it('refuses an untrusted item field in a prompt when the file loads, before the runner sees it', async () => {
        const h = await stepsHarness({ yaml: factory(ON_REVIEW, '- prompt: "Review {{item.title}}."') });
        expect(h.service.list(WORKSPACE_ID)).toEqual([]);
        expect(h.service.snapshot(WORKSPACE_ID).issues.map((issue) => issue.message)).toContain(
            'item.title: it is text someone else wrote; the step gets it below its prompt as data.'
        );
    });

    it('reports the first step with a problem, in file order', async () => {
        expect((await listed({ yaml: factory(ON_REVIEW, '- action: Triage', '- action: Nope') })).problem).toBe(
            'the Triage action does not apply to pull requests'
        );
        expect((await listed({ yaml: factory(ON_REVIEW, '- action: Nope', '- action: Triage') })).problem).toBe(
            'no action named Nope in this workspace'
        );
    });

    it('reports scope, then steps, then item fields, then Windows, then the harness', async () => {
        const cannotRestrict = { name: 'Codex', problem: 'Codex sessions cannot be made read-only yet.' };
        const labels = '- run: echo "$LABELS"\n  env: { LABELS: "{{item.labels}}" }';
        const everything = { platform: 'win32', harness: cannotRestrict } as const;

        expect(
            (await listed({ ...everything, yaml: factory('    on: { cron: "0 9 * * 1-5" }\n    scope: web\n', '- prompt: Look.', '- run: ls') }))
                .problem
        ).toBe('no scope named "web" in this workspace; it has: catalog-portal, api');
        expect((await listed({ ...everything, yaml: factory(ON_REVIEW, '- action: Nope', labels) })).problem).toBe(
            'no action named Nope in this workspace'
        );
        expect((await listed({ ...everything, yaml: factory(ON_REVIEW, '- action: Review', labels) })).problem).toBe(
            '`item.labels`: github items have no field `labels` (they have: key, url, repo, number, type, title, author)'
        );
        expect((await listed({ ...everything, yaml: factory(ON_REVIEW, '- action: Review', '- run: ls') })).problem).toBe(
            'run: steps need a POSIX shell, which Windows does not have'
        );
        expect((await listed({ harness: cannotRestrict, yaml: factory(ON_REVIEW, '- action: Review', '- run: ls') })).problem).toBe(
            'Codex can’t run read-only automation sessions: Codex sessions cannot be made read-only yet'
        );
    });

    it('needs no harness for an entry of commands only', async () => {
        const entry = await listed({
            yaml: factory(DAILY_IN_API, '- run: git fetch --prune'),
            harness: { name: 'Codex', problem: 'Codex sessions cannot be made read-only yet.' },
        });
        expect(entry.problem).toBeUndefined();
        expect(entry.nextRunAt).not.toBeNull();
    });

    it('needs no POSIX shell for an entry of agent steps only', async () => {
        expect((await listed({ yaml: factory(ON_REVIEW, '- action: Review'), platform: 'win32' })).problem).toBeUndefined();
    });
});

describe('a steps entry, as the panel lists it', () => {
    it('shows each step, its if:, and what it runs', async () => {
        const entry = await listed({ yaml: TEMPLATE });
        expect(entry).toMatchObject({
            kind: 'agent',
            target: 'steps',
            runs: 'Steps: review → publish',
            steps: [
                { id: 'review', kind: 'agent', summary: 'Review action' },
                {
                    id: 'publish',
                    kind: 'run',
                    if: "steps.review.verdict != 'approve'",
                    summary: 'gh api "repos/$REPO/pulls/$NUMBER/reviews" -f commit_id="$CONSOLA_CHECKOUT_HEAD"…',
                },
            ],
        });
        expect(entry.steps![0]).not.toHaveProperty('if');
    });

    it('says Prompt for a prompt step, and gives a command its first line', async () => {
        const yaml = factory(DAILY_IN_API, '- prompt: Summarise what changed.', '- run: |\n\n    git fetch --prune\n    git log -1');
        expect((await listed({ yaml })).steps).toEqual([
            { id: 'step-1', kind: 'agent', summary: 'Prompt' },
            { id: 'step-2', kind: 'run', summary: 'git fetch --prune' },
        ]);
    });

    it('lists an entry of commands only as a tool', async () => {
        expect(await listed({ yaml: factory(DAILY_IN_API, '- run: git fetch --prune') })).toMatchObject({ kind: 'tool', target: 'steps' });
    });

    it('still shows its steps while it has a problem', async () => {
        expect(await listed({ yaml: factory(ON_REVIEW, '- action: Nope') })).toMatchObject({
            problem: 'no action named Nope in this workspace',
            steps: [{ id: 'step-1', kind: 'agent', summary: 'Nope action' }],
        });
    });
});

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const PR51 = inboxItem({ repo: 'sprocket/catalog-portal', number: 51 });
const PR52 = inboxItem({ repo: 'sprocket/catalog-portal', number: 52, title: 'Cache the catalog' });
const PR51_LABEL = 'sprocket/catalog-portal#51 “Add retries” by @alice';
const TEMPLATE_VERSION = automationVersion(only(TEMPLATE), stableStringify({ review: REVIEW_BODY }));
/** Weekdays at 9 in api: a command, then an agent step. */
const DAILY = factory(`${DAILY_IN_API}    mode: auto\n`, '- id: fresh\n  run: git fetch --prune', '- id: summary\n  prompt: Summarise what changed in api.');
const COMMANDS_ONLY = factory(`${DAILY_IN_API}    mode: auto\n`, '- id: fresh\n  run: git fetch --prune', '- id: log\n  run: git log -1');
/** Weekdays at 9 in api: one prompt step. */
const SUMMARY = factory(`${DAILY_IN_API}    mode: auto\n`, '- id: summary\n  prompt: Summarise what changed in api.');

/** A harness whose event automations have had their first look at an empty Inbox, which fires nothing. */
async function watching(options: StepsHarnessOptions): Promise<StepsHarness> {
    const h = await stepsHarness(options);
    await h.poll([]);
    return h;
}

/** Accept every entry in `yaml` at its current version, as a person approving each once would. */
function acceptEvery(h: StepsHarness, yaml: string): void {
    for (const automation of parseFactorySpec(yaml).automations) {
        const bodies: Record<string, string> = {};
        for (const step of automation.steps ?? []) {
            if (step.kind === 'agent' && step.action) bodies[step.id] = h.world.workspace.actions.find((action) => action.name === step.action)!.prompt;
        }
        const body = Object.keys(bodies).length > 0 ? stableStringify(bodies) : undefined;
        h.store.accept(`${WORKSPACE_ID} ${automation.name}`, automationVersion(automation, body));
    }
}

/** A run as history first recorded it: what it was the moment it was added. */
function firstRecorded(h: StepsHarness, runId: string): RunRecord | undefined {
    return h.history.appends.find((line) => line.run.id === runId)?.run;
}

/** ws-1's `runs/`. */
const runsDir = (h: StepsHarness) => path.dirname(h.folder.runDir(WORKSPACE_ID, 'any'));

/** A session the person started on `item` with the Review action. */
function byHand(item: InboxItemView, at: Date): SessionView {
    const { number } = item.workItem;
    return {
        id: `hand-${number}`,
        workspaceId: WORKSPACE_ID,
        name: `PR ${number}`,
        scopeId: 'scope-catalog-portal',
        harnessId: 'claude',
        claudeSessionId: `claude-hand-${number}`,
        createdAt: at.getTime(),
        workItemKey: item.key,
        workItemAction: 'Review',
    };
}

describe('firing a steps run', () => {
    it('a scheduled steps run records its definition and a light result', async () => {
        const h = await stepsHarness({ yaml: DAILY });
        h.advance(HOUR);
        await h.tick();
        const [run] = h.store.runs();
        expect(run).toMatchObject({
            automationId: NAME,
            actionName: 'steps',
            actionVersion: automationVersion(only(DAILY)),
            trigger: { kind: 'cron' },
            status: 'needs-approval',
        });
        // Light: what each step is and where it runs, none of what it says.
        expect(run.result).toEqual({ kind: 'steps-run', steps: [{ id: 'fresh', kind: 'run' }, { id: 'summary', kind: 'agent' }], scope: 'api' });
        expect(run.steps).toEqual([
            { id: 'fresh', kind: 'run', status: 'pending', attempt: 1 },
            { id: 'summary', kind: 'agent', status: 'pending', attempt: 1 },
        ]);
        expect(run).not.toHaveProperty('approval');
        expect(run).not.toHaveProperty('dryRun');
        expect(JSON.stringify(run)).not.toContain('Summarise what changed');
        expect(h.folder.readDefinition(WORKSPACE_ID, run.id)).toEqual({ automation: only(DAILY), version: run.actionVersion, actions: {} });

        // An action step's body is in the snapshot, by step id.
        const event = await watching({ yaml: TEMPLATE });
        await event.poll([PR51]);
        const [reviewing] = event.store.runs();
        expect(event.folder.readDefinition(WORKSPACE_ID, reviewing.id)).toEqual({
            automation: only(TEMPLATE),
            version: TEMPLATE_VERSION,
            actions: { review: { name: 'Review', body: REVIEW_BODY, groupId: 'g-1' } },
        });
        expect(reviewing.result).toEqual({
            kind: 'steps-run',
            steps: [
                { id: 'review', kind: 'agent' },
                { id: 'publish', kind: 'run' },
            ],
            item: { url: PR51.url, title: 'Add retries', author: 'alice', label: PR51_LABEL },
        });
        expect(JSON.stringify(reviewing)).not.toContain('say what should change');
    });

    it('an auto entry asks once, and approving lets it run on its own', async () => {
        const h = await watching({ yaml: TEMPLATE });
        await h.poll([PR51]);
        const [asked] = h.store.runs();
        expect(asked).toMatchObject({
            status: 'needs-approval',
            mode: 'confirm',
            summary: `Steps: review → publish: ${PR51_LABEL}. Approve once to let this new or changed automation run on its own.`,
        });
        expect(h.notices).toEqual([
            {
                title: `${NAME} needs your approval`,
                body: `${asked.summary} Review it in Consola.`,
                runId: asked.id,
                workspaceId: WORKSPACE_ID,
                needsApproval: true,
            },
        ]);

        expect(await h.service.approve(asked.id)).toMatchObject({ status: 'queued', approvedAt: h.now().toISOString() });
        expect(h.store.acceptedVersion(KEY)).toBe(TEMPLATE_VERSION);
        expect(h.service.list(WORKSPACE_ID)[0].asksFirst).toBeUndefined();

        // Approved, it started: its review is working in #51's checkout.
        await h.flush();
        expect(h.store.get(asked.id)?.status).toBe('running');
        expect(h.world.launches.map((launch) => launch.step?.name)).toEqual(['Add retries · review']);

        await h.poll([PR51, PR52]);
        const next = h.store.runs()[0];
        expect(next).toMatchObject({
            trigger: { item: { number: 52 } },
            status: 'running',
            mode: 'auto',
            summary: 'Steps: review → publish: sprocket/catalog-portal#52 “Cache the catalog” by @alice.',
        });
        // It went in line without asking, and started on its own.
        expect(firstRecorded(h, next.id)?.status).toBe('queued');
        expect(h.notices).toHaveLength(1);
        expect(h.world.launches.map((launch) => launch.step?.name)).toEqual(['Add retries · review', 'Cache the catalog · review']);
    });

    it('confirm waits before the first step', async () => {
        const h = await watching({ yaml: factory(`${ON_REVIEW}    mode: confirm\n`, '- id: review\n  action: Review') });
        await h.poll([PR51]);
        const [asked] = h.store.runs();
        expect(asked).toMatchObject({ status: 'needs-approval', mode: 'confirm', summary: `Steps: review: ${PR51_LABEL}.` });
        expect(await h.service.approve(asked.id)).toMatchObject({ status: 'queued', steps: [{ id: 'review', status: 'pending' }] });
        // Approving one run of a confirm entry lets no other run alone.
        expect(h.store.acceptedVersion(KEY)).toBeUndefined();
        await h.poll([PR51, PR52]);
        expect(h.store.runs()[0]).toMatchObject({ trigger: { item: { number: 52 } }, status: 'needs-approval', mode: 'confirm' });
    });

    it("an agent's request always waits", async () => {
        const h = await stepsHarness({ yaml: DAILY });
        h.store.accept(KEY, automationVersion(only(DAILY)));
        const asked = (await h.service.trigger(WORKSPACE_ID, NAME, { sessionId: 's-9' }))!;
        expect(asked).toMatchObject({
            status: 'needs-approval',
            mode: 'confirm',
            trigger: { kind: 'manual', by: 'agent', actorId: 's-9' },
            summary: 'Steps: fresh → summary in api. An agent asked for this run.',
        });
        expect(h.notices).toMatchObject([{ needsApproval: true, actorId: 's-9' }]);

        // A person's Run now of the same accepted version goes straight in line.
        h.service.dismiss(asked.id);
        const run = (await h.service.trigger(WORKSPACE_ID, NAME))!;
        expect(run).toMatchObject({ mode: 'auto', trigger: { by: 'person' } });
        expect(firstRecorded(h, run.id)?.status).toBe('queued');
        expect(h.notices).toHaveLength(1);
    });

    it('notify is a dry run that asks first when it starts anything', async () => {
        const reviews = factory(
            `${ON_REVIEW}    mode: notify\n`,
            '- id: review\n  action: Review',
            '- id: publish\n  run: gh pr comment "$NUMBER" --body-file handover.md\n  env: { NUMBER: "{{item.number}}" }'
        );
        const h = await watching({ yaml: reviews });
        await h.poll([PR51]);
        const [asked] = h.store.runs();
        expect(asked).toMatchObject({ status: 'needs-approval', mode: 'confirm', dryRun: true });
        expect(asked.summary).toMatch(/ Approve once to let this new or changed automation run on its own\.$/);
        expect(await h.service.approve(asked.id)).toMatchObject({ status: 'queued', mode: 'confirm', dryRun: true });
        expect(h.store.acceptedVersion(KEY)).toBe(automationVersion(only(reviews), stableStringify({ review: REVIEW_BODY })));
        expect(h.service.list(WORKSPACE_ID)[0].asksFirst).toBeUndefined();
        await h.poll([PR51, PR52]);
        const next = h.store.runs()[0];
        expect(next).toMatchObject({ trigger: { item: { number: 52 } }, mode: 'notify', dryRun: true });
        expect(firstRecorded(h, next.id)?.status).toBe('queued');

        // Only reported commands: nothing would start, so it never asks.
        const reportsOnly = factory(`${DAILY_IN_API}    mode: notify\n`, '- run: git log -1');
        const reports = await stepsHarness({ yaml: reportsOnly });
        const byPerson = (await reports.service.trigger(WORKSPACE_ID, NAME))!;
        expect(byPerson).toMatchObject({ mode: 'notify', dryRun: true });
        expect(firstRecorded(reports, byPerson.id)?.status).toBe('queued');
        expect(reports.notices).toEqual([]);
        // Nor when an agent asks: a run of its own, in line.
        const asking = await stepsHarness({ yaml: reportsOnly });
        const byAgent = (await asking.service.trigger(WORKSPACE_ID, NAME, { sessionId: 's-9' }))!;
        expect(byAgent).toMatchObject({ mode: 'notify', dryRun: true, trigger: { by: 'agent', actorId: 's-9' } });
        expect(firstRecorded(asking, byAgent.id)?.status).toBe('queued');
        expect(asking.notices).toEqual([]);

        // A command marked to run in a dry run would start something: it asks.
        const fetches = await stepsHarness({ yaml: factory(`${DAILY_IN_API}    mode: notify\n`, '- run: git fetch --prune\n  dry_run: run', '- run: git log -1') });
        expect(await fetches.service.trigger(WORKSPACE_ID, NAME)).toMatchObject({ status: 'needs-approval', mode: 'confirm', dryRun: true });
    });

    it('a one-step entry under notify still starts nothing', async () => {
        const h = await watching({ yaml: `version: 1\nautomations:\n  - name: ${NAME}\n${ON_REVIEW}    mode: notify\n    run: { action: Review }\n` });
        await h.poll([PR51]);
        const [run] = h.store.runs();
        expect(run).toMatchObject({ status: 'completed', mode: 'notify', summary: `${PR51_LABEL}. Nothing started (notify).` });
        expect(run.trigger.item).toEqual({ key: PR51.key, url: PR51.url, title: 'Add retries' });
        expect(run).not.toHaveProperty('dryRun');
        expect(run).not.toHaveProperty('steps');
        expect(h.notices).toMatchObject([{ title: NAME, body: `${PR51_LABEL}.`, needsApproval: false }]);
    });

    it('an event fire snapshots the item', async () => {
        const h = await watching({ yaml: TEMPLATE });
        await h.poll([PR51]);
        const [run] = h.store.runs();
        expect(run.trigger).toEqual({
            kind: 'event',
            at: h.now().toISOString(),
            connection: 'github',
            events: ['pull_request.review_requested'],
            item: { key: PR51.key, url: PR51.url, title: 'Add retries', repo: 'sprocket/catalog-portal', number: 51, type: 'pr', author: 'alice' },
        });

        // #51 leaving the list and coming back while its run waits creates nothing.
        await h.poll([]);
        await h.poll([PR51]);
        expect(h.store.runs().map((candidate) => candidate.id)).toEqual([run.id]);
    });

    it('an action edited after the fire does not change what the run executes', async () => {
        const h = await watching({ yaml: TEMPLATE });
        await h.poll([PR51]);
        const [run] = h.store.runs();
        h.world.workspace.actions[0] = { ...h.world.workspace.actions[0], prompt: `${REVIEW_BODY} Be brief.` };
        await h.service.syncWorkspaces();
        expect(h.folder.readDefinition(WORKSPACE_ID, run.id)).toMatchObject({ version: run.actionVersion, actions: { review: { body: REVIEW_BODY } } });
    });

    it('a queued run is rejected when its automation changes', async () => {
        const summarise = factory(`${DAILY_IN_API}    mode: auto\n`, '- id: summary\n  prompt: Summarise what changed in api.');
        // No agent slot: it waits in line.
        const h = await stepsHarness({ yaml: summarise, maxConcurrentAgents: 0 });
        const asked = (await h.service.trigger(WORKSPACE_ID, NAME))!;
        const queued = await h.service.approve(asked.id);
        await h.flush();
        expect(h.store.get(queued.id)?.status).toBe('queued');

        await h.setYaml(summarise.replace('Summarise what changed in api.', 'Summarise what changed in api this week.'));
        h.world.maxConcurrentAgents = 2;
        // It has not started, so its approval no longer covers what it would run. The next pump (a tick's) says so.
        await h.tick();
        expect(h.store.get(queued.id)).toMatchObject({
            status: 'rejected',
            summary: 'Its automation changed since it was queued.',
            steps: [{ id: 'summary', status: 'not-run' }],
        });
        expect(h.world.launches).toEqual([]);
    });

    it('a review started by hand on the item is not done twice', async () => {
        // No agent slot, so a run that fires waits in line.
        const h = await watching({ yaml: TEMPLATE, maxConcurrentAgents: 0 });
        h.store.accept(KEY, TEMPLATE_VERSION);
        h.advance(1000);
        h.world.workspace.sessions.push(byHand(PR51, h.now()));
        h.advance(1000);
        await h.poll([PR51]);
        const [rejected] = h.store.runs();
        expect(rejected).toMatchObject({
            status: 'rejected',
            summary: 'Already started by hand: “PR 51”.',
            result: { kind: 'steps-run' },
            // Ended before its first step.
            steps: [
                { id: 'review', status: 'not-run' },
                { id: 'publish', status: 'not-run' },
            ],
        });
        // It never runs, so there is nothing to snapshot.
        expect(h.folder.readDefinition(WORKSPACE_ID, rejected.id)).toBeNull();

        // Nor while a run waits in line.
        await h.poll([PR51, PR52]);
        const [queued] = h.store.runs();
        expect(queued).toMatchObject({ trigger: { item: { number: 52 } }, status: 'queued' });
        h.advance(1000);
        h.world.workspace.sessions.push(byHand(PR52, h.now()));
        h.world.maxConcurrentAgents = 2;
        await h.tick();
        expect(h.store.get(queued.id)).toMatchObject({ status: 'rejected', summary: 'Already started by hand: “PR 52”.' });
        expect(h.world.checkouts.prepared).toEqual([]);

        // Only an action step names what a session started by hand would be labelled.
        const prompted = await watching({ yaml: factory(`${ON_REVIEW}    mode: confirm\n`, '- prompt: Review it.') });
        prompted.advance(1000);
        prompted.world.workspace.sessions.push(byHand(PR51, prompted.now()));
        prompted.advance(1000);
        await prompted.poll([PR51]);
        expect(prompted.store.runs()[0]).toMatchObject({ status: 'needs-approval' });
    });

    it('records a run whose definition could not be written as failed, and the next fire is a run of its own', async () => {
        const h = await stepsHarness({ yaml: DAILY });
        // runs/ is a file: no run folder can be made under it.
        fs.mkdirSync(path.dirname(runsDir(h)), { recursive: true });
        fs.writeFileSync(runsDir(h), '');
        const failed = (await h.service.trigger(WORKSPACE_ID, NAME))!;
        expect(failed).toMatchObject({
            status: 'failed',
            finishedAt: h.now().toISOString(),
            result: { kind: 'steps-run' },
            steps: [
                { id: 'fresh', status: 'not-run' },
                { id: 'summary', status: 'not-run' },
            ],
        });
        expect(failed.error).toMatch(/^Could not write its definition: \S.*[^.]\.$/);
        expect(h.notices).toMatchObject([{ title: `${NAME} could not start`, needsApproval: false, runId: failed.id }]);

        fs.rmSync(runsDir(h));
        const next = (await h.service.trigger(WORKSPACE_ID, NAME))!;
        expect(next).toMatchObject({ status: 'needs-approval' });
        expect(next.id).not.toBe(failed.id);
        expect(h.folder.readDefinition(WORKSPACE_ID, next.id)).not.toBeNull();
    });

    it('records an item run whose definition could not be written as failed, and says so', async () => {
        const h = await watching({ yaml: TEMPLATE });
        h.store.accept(KEY, TEMPLATE_VERSION);
        fs.mkdirSync(path.dirname(runsDir(h)), { recursive: true });
        fs.writeFileSync(runsDir(h), '');
        await h.poll([PR51]);
        const [failed] = h.store.runs();
        expect(failed).toMatchObject({
            status: 'failed',
            trigger: { kind: 'event', item: { number: 51 } },
            steps: [
                { id: 'review', status: 'not-run' },
                { id: 'publish', status: 'not-run' },
            ],
        });
        expect(failed.error).toMatch(/^Could not write its definition: \S.*[^.]\.$/);
        expect(h.notices).toMatchObject([{ title: `${NAME} could not start`, body: expect.any(String), runId: failed.id, needsApproval: false }]);
        expect(h.world.checkouts.prepared).toEqual([]);
        expect(h.world.launches).toEqual([]);
    });

    it('a schedule keeps one steps run at a time', async () => {
        // No agent slot at first, so the run waits in line.
        const h = await stepsHarness({ yaml: SUMMARY, maxConcurrentAgents: 0 });
        h.store.accept(KEY, automationVersion(only(SUMMARY)));
        h.advance(HOUR);
        await h.tick();
        const [first] = h.store.runs();
        expect(first).toMatchObject({ status: 'queued', trigger: { kind: 'cron' } });

        // The next occurrence, and a Run now, while it waits in line: that run is the answer.
        h.advance(DAY);
        await h.tick();
        expect(await h.service.trigger(WORKSPACE_ID, NAME)).toMatchObject({ id: first.id });
        expect(h.store.runs()).toHaveLength(1);

        // Started, it holds its place while it runs.
        h.world.maxConcurrentAgents = undefined;
        await h.tick();
        expect(h.store.get(first.id)).toMatchObject({ status: 'running', startedAt: h.now().toISOString() });
        h.advance(DAY);
        await h.tick();
        expect(await h.service.trigger(WORKSPACE_ID, NAME)).toMatchObject({ id: first.id });
        expect(h.store.runs()).toHaveLength(1);

        // Once it ends, the next fire is a run of its own.
        await h.world.endTurn('session-1');
        expect(h.store.get(first.id)?.status).toBe('completed');
        const next = (await h.service.trigger(WORKSPACE_ID, NAME))!;
        expect(firstRecorded(h, next.id)?.status).toBe('queued');
        expect(next.id).not.toBe(first.id);
    });
});

const MINUTE = 60 * 1000;
/** #51's automation checkout, as the fake host places it. */
const CHECKOUT = checkoutPathFor(PR51.workItem);
const ON_REVIEW_AUTO = `${ON_REVIEW}    mode: auto\n`;
const DAILY_AUTO = `${DAILY_IN_API}    mode: auto\n`;
/** A first step that decides how the night went, and a second that writes it up. */
const ONE = '- id: one\n  prompt: Read what changed in api overnight.\n  outputs:\n    mood: { enum: [calm, worrying] }';
const TWO = '- id: two\n  prompt: Write up the {{steps.one.mood}} night for the team.';
const NIGHTLY = entry('nightly', DAILY_AUTO, ONE, TWO);
const WEEKLY = entry('weekly', DAILY_AUTO, '- id: digest\n  prompt: Sum up the week in api.');
/** A one-step prompt on the same schedule: a legacy agent run, in the same lane as agent steps. */
const legacy = (name: string) => `  - name: ${name}\n${DAILY_AUTO}    run: { prompt: Sum up api. }\n`;
/** One prompt step on #51's review requests, under `name`. */
const look = (name: string, verb: string) => entry(name, ON_REVIEW_AUTO, `- id: look\n  prompt: ${verb} {{item.url}}.`);
const TWO_LOOKS = file(look(NAME, 'Look at'), look('second-look', 'Look again at'));
/** The review, then a summary that reads its handover: two agent steps on one item. */
const PAIR = factory(
    ON_REVIEW_AUTO,
    '- id: review\n  action: Review\n  outputs:\n    verdict: { enum: [approve, comment, request-changes] }',
    '- id: summary\n  prompt: Summarise the review of {{item.url}} for the team.\n  reads: [review.handover]'
);

/** A started harness over `yaml`, every entry in it accepted, so each runs on its own. */
async function accepted(yaml: string, options: StepsHarnessOptions = {}): Promise<StepsHarness> {
    const h = await stepsHarness({ yaml, ...options });
    acceptEvery(h, yaml);
    return h;
}

/** The statuses of a run's steps on each line history recorded for it, repeats folded. */
function stepLines(h: StepsHarness, runId: string): string[] {
    const lines = h.history.appends
        .filter((line) => line.run.id === runId)
        .map((line) => (line.run.steps ?? []).map((step) => step.status).join(' '));
    return lines.filter((line, index) => line !== lines[index - 1]);
}

const byName = (h: StepsHarness, name: string) => h.store.runs().find((run) => run.automationId === name)!;
const launched = (h: StepsHarness) => h.world.launches.map((launch) => launch.step?.name ?? launch.run.automation);

describe('running a steps run', () => {
    it('two prompt steps on a schedule run one after the other in the scope folder', async () => {
        const h = await accepted(file(NIGHTLY));
        h.advance(HOUR);
        await h.tick();
        const [run] = h.store.runs();
        expect(run).toMatchObject({
            automationId: 'nightly',
            status: 'running',
            trigger: { kind: 'cron' },
            startedAt: h.now().toISOString(),
            checkout: { cwd: '/code/api', scopeId: 'scope-api' },
        });
        const [one] = h.world.launches;
        expect(h.world.launches).toHaveLength(1);
        expect(one).toMatchObject({
            workspaceId: WORKSPACE_ID,
            run: { id: run.id, automation: 'nightly' },
            step: { id: 'one', attempt: 1, cwd: '/code/api', scopeId: 'scope-api', name: 'nightly · one' },
        });
        expect(one).not.toHaveProperty('item');
        expect(one.prompt).toContain('[Consola] Step "one" (1 of 2) of the automation "nightly" (run run-1), in api. ');
        expect(one.prompt).toContain('\n\nRead what changed in api overnight.\n\n');
        expect(h.store.get(run.id)!.steps).toMatchObject([
            { id: 'one', status: 'running', attempt: 1, sessionId: 'session-1', conversation: { harnessId: 'claude', id: 'claude-1', cwd: '/code/api' } },
            { id: 'two', status: 'pending' },
        ]);

        // Step two waits for one to end with its outputs.
        h.advance(MINUTE);
        const broadcasts = h.world.broadcasts.length;
        expect(h.world.setOutputs('session-1', { mood: 'calm' })).toMatchObject({ isError: false });
        await h.world.endTurn('session-1');
        const ended = h.now().toISOString();
        expect(h.store.get(run.id)!.steps![0]).toMatchObject({ status: 'completed', outputs: { mood: 'calm' }, finishedAt: ended });
        expect(h.store.get(run.id)!.updatedAt).toBe(ended);
        expect(h.world.broadcasts.length).toBeGreaterThan(broadcasts);
        const outputsFile = path.join(h.folder.attemptDir(WORKSPACE_ID, run.id, 'one', 1), 'outputs.json');
        expect(JSON.parse(fs.readFileSync(outputsFile, 'utf8'))).toEqual({ mood: 'calm' });
        expect(h.world.launches[1].step).toEqual({ id: 'two', attempt: 1, cwd: '/code/api', scopeId: 'scope-api', name: 'nightly · two' });
        expect(h.world.launches[1].prompt).toContain('\n\nWrite up the calm night for the team.\n\n');

        await h.world.endTurn('session-2');
        expect(h.store.get(run.id)).toMatchObject({ status: 'completed', summary: 'one → two (calm)', finishedAt: ended });
        expect(h.store.get(run.id)).not.toHaveProperty('sessionId');
        // The click opens the run page: there is no session to open.
        expect(h.notices).toEqual([{ title: 'nightly: done', body: 'one → two (calm)', runId: run.id, workspaceId: WORKSPACE_ID, needsApproval: false }]);
        // Each transition is its own line, written before the next step starts.
        expect(stepLines(h, run.id)).toEqual([
            'pending pending',
            'queued pending',
            'running pending',
            'completed pending',
            'completed queued',
            'completed running',
            'completed completed',
        ]);
    });

    it('if: false skips, a failure makes later steps not-run', async () => {
        const yaml = file(
            entry(
                'nightly',
                DAILY_AUTO,
                ONE,
                "- id: alarm\n  if: steps.one.mood == 'worrying'\n  prompt: Say what is worrying.",
                '- id: two\n  prompt: Write up the night.',
                '- id: three\n  prompt: File the write-up.'
            )
        );
        const h = await accepted(yaml);
        const run = (await h.service.trigger(WORKSPACE_ID, 'nightly'))!;
        await h.flush();
        h.world.setOutputs('session-1', { mood: 'calm' });
        await h.world.endTurn('session-1');
        expect(h.store.get(run.id)!.steps).toMatchObject([
            { id: 'one', status: 'completed' },
            { id: 'alarm', status: 'skipped', skipped: "if: steps.one.mood == 'worrying' is false" },
            { id: 'two', status: 'running', sessionId: 'session-2' },
            { id: 'three', status: 'pending' },
        ]);
        // The skip is recorded on its own, before the next step is queued.
        expect(stepLines(h, run.id)).toContain('completed skipped pending pending');

        await h.world.endTurn('session-2', { exitCode: 1, lastLine: 'Rate limited.' });
        const error = 'It stopped before finishing (exit 1): Rate limited.';
        expect(h.store.get(run.id)).toMatchObject({
            status: 'failed',
            error,
            steps: [
                { id: 'one', status: 'completed' },
                { id: 'alarm', status: 'skipped' },
                { id: 'two', status: 'failed', error },
                { id: 'three', status: 'not-run' },
            ],
        });
        expect(launched(h)).toEqual(['nightly · one', 'nightly · two']);
        expect(h.notices).toEqual([{ title: 'nightly did not finish', body: error, runId: run.id, workspaceId: WORKSPACE_ID, needsApproval: false }]);
    });

    it('a step that ends without what it declares fails, saying what is missing', async () => {
        const yaml = file(entry('nightly', DAILY_AUTO, `${ONE}\n  artifacts: [notes]`, TWO));
        const h = await accepted(yaml);
        const nothing = (await h.service.trigger(WORKSPACE_ID, 'nightly'))!;
        await h.flush();
        await h.world.endTurn('session-1');
        expect(h.store.get(nothing.id)).toMatchObject({
            status: 'failed',
            error: 'ended without setting mood, and without writing notes',
            steps: [{ id: 'one', status: 'failed' }, { id: 'two', status: 'not-run' }],
        });
        // Its outputs are written only for an attempt that has them all.
        expect(fs.existsSync(path.join(h.folder.attemptDir(WORKSPACE_ID, nothing.id, 'one', 1), 'outputs.json'))).toBe(false);

        const noNotes = (await h.service.trigger(WORKSPACE_ID, 'nightly'))!;
        await h.flush();
        h.world.setOutputs('session-2', { mood: 'calm' });
        await h.world.endTurn('session-2');
        expect(h.store.get(noNotes.id)).toMatchObject({ status: 'failed', error: 'ended without writing notes' });

        // A stop is told in the words a one-step run uses.
        const stopped = (await h.service.trigger(WORKSPACE_ID, 'nightly'))!;
        await h.flush();
        await h.world.endTurn('session-3', { exitCode: 143, stopped: 'you stopped it' });
        expect(h.store.get(stopped.id)).toMatchObject({ status: 'failed', error: 'It stopped before finishing: you stopped it.' });
    });

    it('a step session finds its step tools when its CLI first connects', async () => {
        const h = await accepted(file(NIGHTLY));
        const seen: unknown[] = [];
        // Inside the launch: the session is on the record, and its CLI is about to ask for its tools.
        h.world.onLaunch = (request, session) => {
            seen.push({
                declaration: h.service.stepIO().declaration(session.id),
                step: h.store.get(request.run.id)?.steps?.[0].status,
                written: !h.world.setOutputs(session.id, { mood: 'calm' }).isError,
            });
        };
        await h.service.trigger(WORKSPACE_ID, 'nightly');
        await h.flush();
        expect(seen).toEqual([
            { declaration: { outputs: { mood: { type: 'enum', values: ['calm', 'worrying'] } }, writable: ['handover'] }, step: 'running', written: true },
        ]);
    });

    it('a step whose working folder is gone fails before it launches', async () => {
        const h = await accepted(file(NIGHTLY));
        h.world.goneFolders.add('/code/api');
        const run = (await h.service.trigger(WORKSPACE_ID, 'nightly'))!;
        await h.flush();
        const error = 'Its working folder is gone: /code/api.';
        expect(h.store.get(run.id)).toMatchObject({
            status: 'failed',
            error,
            steps: [{ id: 'one', status: 'failed', error }, { id: 'two', status: 'not-run' }],
        });
        expect(h.world.launches).toEqual([]);
    });

    it('an item run prepares its automation checkout once and records head', async () => {
        const h = await watching({ yaml: PAIR });
        acceptEvery(h, PAIR);
        await h.poll([PR51]);
        const [run] = h.store.runs();
        expect(h.world.checkouts.prepared).toEqual([
            { workspaceId: WORKSPACE_ID, workItem: PR51.workItem, startedByHand: { label: 'Review', since: run.createdAt } },
        ]);
        expect(run).toMatchObject({ status: 'running', checkout: { cwd: CHECKOUT, scopeId: 'scope-catalog-portal', head: CHECKOUT_HEAD } });

        h.world.setOutputs('session-1', { verdict: 'comment' });
        h.world.writeArtifact('session-1', 'handover', 'Two retries are unbounded.');
        await h.world.endTurn('session-1');
        expect(h.world.checkouts.prepared).toHaveLength(1);
        // Every step names the run's own checkout as its folder, so the host never prepares the Inbox's worktree for it.
        expect(h.world.launches.map((launch) => launch.step?.cwd)).toEqual([CHECKOUT, CHECKOUT]);
        const summary = h.world.launches[1];
        expect(summary).toMatchObject({
            step: { id: 'summary', attempt: 1, cwd: CHECKOUT, scopeId: 'scope-catalog-portal', name: 'Add retries · summary' },
            item: { workItem: PR51.workItem, title: 'Add retries', label: NAME },
        });
        // Only the first agent step, an action, is what a person may have started by hand; a prompt step has no group.
        expect(summary.item).not.toHaveProperty('startedByHandSince');
        expect(summary.item).not.toHaveProperty('groupId');
        expect(summary.prompt).toContain('\n\nSummarise the review of https://github.com/sprocket/catalog-portal/pull/51 for the team.\n\n');
        expect(summary.prompt).toContain('\n  - review.handover (from step "review", 26 B)\n');

        await h.world.endTurn('session-2');
        expect(h.store.get(run.id)).toMatchObject({ status: 'completed', summary: 'review → summary (comment)', checkout: { head: CHECKOUT_HEAD } });
    });

    it("an action step renders the action's placeholders with the title pointed at the fence, and carries its name and group", async () => {
        const h = await watching({ yaml: TEMPLATE });
        h.store.accept(KEY, TEMPLATE_VERSION);
        await h.poll([PR51]);
        const [run] = h.store.runs();
        const [review] = h.world.launches;
        expect(review).toMatchObject({
            workspaceId: WORKSPACE_ID,
            run: { id: run.id, automation: NAME },
            item: { workItem: PR51.workItem, title: 'Add retries', label: 'Review', groupId: 'g-1', startedByHandSince: run.createdAt },
            step: { id: 'review', attempt: 1, cwd: CHECKOUT, scopeId: 'scope-catalog-portal', name: 'Add retries · review' },
        });
        const sections = review.prompt.split('\n\n');
        expect(sections[0]).toMatch(
            /^\[Consola\] Step "review" \(1 of 2\) of the automation "review-assigned-prs" \(run run-1\), for pull request #51 in sprocket\/catalog-portal \(https:\/\/github\.com\/sprocket\/catalog-portal\/pull\/51\), in a dedicated git worktree for it\. /
        );
        expect(sections[1]).toBe('Review the title quoted below and say what should change before it merges.');
        expect(review.prompt).toMatch(/\n<untrusted-data>\ntitle: "Add retries"\nauthor: "alice"\n<\/untrusted-data>$/);
        expect(h.store.get(run.id)!.steps![0]).toMatchObject({
            status: 'running',
            sessionId: 'session-1',
            conversation: { harnessId: 'claude', id: 'claude-1', cwd: CHECKOUT },
        });
    });

    it('a run reads its item as it is when it starts', async () => {
        const h = await watching({ yaml: TEMPLATE, maxConcurrentAgents: 0 });
        h.store.accept(KEY, TEMPLATE_VERSION);
        await h.poll([PR51]);
        const [run] = h.store.runs();
        await h.poll([{ ...PR51, title: 'Add retries with backoff', author: 'bob' }]);
        h.world.maxConcurrentAgents = undefined;
        await h.tick();
        expect(h.store.get(run.id)!.trigger.item).toMatchObject({ number: 51, title: 'Add retries with backoff', author: 'bob' });
        expect(h.world.launches[0]).toMatchObject({ item: { title: 'Add retries with backoff' }, step: { name: 'Add retries with backoff · review' } });
        expect(h.world.launches[0].prompt).toMatch(/\ntitle: "Add retries with backoff"\nauthor: "bob"\n/);
    });

    it('a checkout failure fails the run before its first step, saying why', async () => {
        const h = await watching({ yaml: TEMPLATE });
        h.store.accept(KEY, TEMPLATE_VERSION);
        const why = 'A full-tools session was launched in this item\'s automation checkout (“PR 51”), so Consola will not move it. Delete that session, then retry.';
        h.world.checkouts.fails = new Error(why);
        await h.poll([PR51]);
        const [run] = h.store.runs();
        expect(run).toMatchObject({
            status: 'failed',
            error: why,
            checkout: { cwd: CHECKOUT },
            steps: [
                { id: 'review', status: 'not-run' },
                { id: 'publish', status: 'not-run' },
            ],
        });
        expect(run.checkout).not.toHaveProperty('head');
        expect(h.world.launches).toEqual([]);
        expect(h.notices).toEqual([{ title: `${NAME} could not start`, body: why, runId: run.id, workspaceId: WORKSPACE_ID, needsApproval: false }]);
    });

    it('a review started by hand while the run was getting ready is not done twice', async () => {
        // At the launch: the first step, an action, asks the host to look under the lock an Inbox click takes.
        const h = await watching({ yaml: TEMPLATE });
        h.store.accept(KEY, TEMPLATE_VERSION);
        h.world.launchThrows = new StartedByHandError('PR 51');
        await h.poll([PR51]);
        const [run] = h.store.runs();
        expect(h.world.launches).toMatchObject([{ item: { label: 'Review', startedByHandSince: run.createdAt } }]);
        const rejected = {
            status: 'rejected',
            summary: 'Already started by hand: “PR 51”.',
            steps: [
                { id: 'review', status: 'not-run' },
                { id: 'publish', status: 'not-run' },
            ],
        };
        expect(h.store.get(run.id)).toMatchObject(rejected);
        expect(h.notices).toEqual([]);

        // At the preparation: the checkout refuses under the same lock.
        const preparing = await watching({ yaml: TEMPLATE });
        preparing.store.accept(KEY, TEMPLATE_VERSION);
        preparing.world.checkouts.fails = new StartedByHandError('PR 51');
        await preparing.poll([PR51]);
        expect(preparing.store.runs()[0]).toMatchObject(rejected);
        expect(preparing.world.launches).toEqual([]);
        expect(preparing.notices).toEqual([]);
    });

    it('a second run on the same item waits for the checkout, then prepares it afresh', async () => {
        const h = await watching({ yaml: TWO_LOOKS });
        acceptEvery(h, TWO_LOOKS);
        await h.poll([PR51]);
        const first = byName(h, NAME);
        const second = byName(h, 'second-look');
        expect(first.status).toBe('running');
        expect(second).toMatchObject({ status: 'queued', summary: "waiting for this item's checkout" });
        expect(h.world.checkouts.prepared).toHaveLength(1);
        expect(h.world.launches.map((launch) => launch.run.id)).toEqual([first.id]);
        expect(h.service.snapshot(WORKSPACE_ID).queue).toEqual({ [second.id]: 1 });

        // Waiting is written when it starts, not at every look.
        const lines = h.history.appends.length;
        await h.tick();
        expect(h.history.appends.length).toBe(lines);

        await h.world.endTurn('session-1');
        expect(h.store.get(first.id)?.status).toBe('completed');
        expect(h.world.checkouts.prepared).toHaveLength(2);
        expect(h.store.get(second.id)).toMatchObject({
            status: 'running',
            summary: `Steps: look: ${PR51_LABEL}.`,
            checkout: { cwd: CHECKOUT, head: CHECKOUT_HEAD },
        });
        expect(h.world.launches.map((launch) => launch.run.id)).toEqual([first.id, second.id]);
    });

    it('a run still preparing its checkout holds it', async () => {
        const h = await watching({ yaml: TWO_LOOKS });
        acceptEvery(h, TWO_LOOKS);
        let release!: () => void;
        h.world.checkouts.gate = new Promise((resolve) => (release = resolve));
        await h.poll([PR51]);
        const first = byName(h, NAME);
        const second = byName(h, 'second-look');
        expect(h.world.checkouts.prepared).toHaveLength(1);
        // Claimed before the fetch: the record names the folder, not yet the commit.
        expect(first).toMatchObject({ status: 'running', checkout: { cwd: CHECKOUT } });
        expect(first.checkout).not.toHaveProperty('head');
        expect(second).toMatchObject({ status: 'queued', summary: "waiting for this item's checkout" });
        expect(h.world.launches).toEqual([]);

        h.world.checkouts.gate = undefined;
        release();
        await h.flush();
        expect(h.world.launches.map((launch) => launch.run.id)).toEqual([first.id]);
        expect(h.world.checkouts.prepared).toHaveLength(1);
        expect(h.store.get(second.id)?.status).toBe('queued');

        await h.world.endTurn('session-1');
        expect(h.world.checkouts.prepared).toHaveLength(2);
        expect(h.world.launches.map((launch) => launch.run.id)).toEqual([first.id, second.id]);
    });

    it("a session running in the item's checkout holds it too", async () => {
        const h = await watching({ yaml: TEMPLATE });
        h.store.accept(KEY, TEMPLATE_VERSION);
        h.world.busyFolders.add(CHECKOUT);
        await h.poll([PR51]);
        const [run] = h.store.runs();
        expect(run).toMatchObject({ status: 'queued', summary: "waiting for this item's checkout" });
        expect(h.world.checkouts.prepared).toEqual([]);

        h.world.busyFolders.clear();
        await h.tick();
        expect(h.store.get(run.id)).toMatchObject({ status: 'running', summary: `Steps: review → publish: ${PR51_LABEL}.` });
        expect(h.world.checkouts.prepared).toHaveLength(1);
    });

    it('a working run holds its checkout, whichever workspace it is in', async () => {
        const h = await watching({ yaml: TEMPLATE });
        h.store.accept(KEY, TEMPLATE_VERSION);
        // Its preparation never ends: it stays started and unfinished.
        h.world.checkouts.gate = new Promise(() => {});
        expect(h.service.checkoutHeld(CHECKOUT)).toBe(false);
        await h.poll([PR51]);
        const [run] = h.store.runs();
        expect(h.service.checkoutHeld(CHECKOUT)).toBe(true);
        // By its item too, wherever the folder is.
        expect(h.service.checkoutHeld('/elsewhere', PR51.key)).toBe(true);
        expect(h.service.checkoutHeld('/elsewhere')).toBe(false);
        expect(h.service.checkoutHeld(checkoutPathFor(PR52.workItem), PR52.key)).toBe(false);

        // One service serves every workspace, and the folder is one per item: another workspace's run holds it as well.
        h.store.add({ ...structuredClone(run), id: 'run-ws-2', attribution: { ...run.attribution, workspaceId: 'ws-2' } });
        h.store.update(run.id, { status: 'failed', finishedAt: h.now().toISOString() });
        expect(h.service.checkoutHeld(CHECKOUT)).toBe(true);
        h.store.update('run-ws-2', { status: 'completed', finishedAt: h.now().toISOString() });
        expect(h.service.checkoutHeld(CHECKOUT)).toBe(false);
    });

    it('a started run goes ahead of runs that have not started', async () => {
        const yaml = file(NIGHTLY, WEEKLY);
        const h = await accepted(yaml, { maxConcurrentAgents: 1 });
        await h.service.trigger(WORKSPACE_ID, 'nightly');
        const weekly = (await h.service.trigger(WORKSPACE_ID, 'weekly'))!;
        await h.flush();
        expect(h.store.get(weekly.id)?.status).toBe('queued');

        h.world.setOutputs('session-1', { mood: 'worrying' });
        await h.world.endTurn('session-1');
        expect(launched(h)).toEqual(['nightly · one', 'nightly · two']);
        expect(h.store.get(weekly.id)?.status).toBe('queued');

        await h.world.endTurn('session-2');
        expect(launched(h)).toEqual(['nightly · one', 'nightly · two', 'weekly · digest']);
    });

    it("each lane numbers its own line, legacy runs and steps alike: started runs first, then the rest as they joined", async () => {
        const yaml = file(NIGHTLY, WEEKLY, legacy('legacy'), legacy('legacy-two'));
        const h = await accepted(yaml);
        const nightly = (await h.service.trigger(WORKSPACE_ID, 'nightly'))!;
        const legacyRun = (await h.service.trigger(WORKSPACE_ID, 'legacy'))!;
        await h.flush();
        expect(launched(h)).toEqual(['nightly · one', 'legacy']);

        // One slot from here on: both of those are working, so what comes next waits.
        h.world.maxConcurrentAgents = 1;
        h.advance(MINUTE);
        const weekly = (await h.service.trigger(WORKSPACE_ID, 'weekly'))!;
        h.advance(MINUTE);
        const legacyTwo = (await h.service.trigger(WORKSPACE_ID, 'legacy-two'))!;
        h.advance(MINUTE);
        h.world.setOutputs('session-1', { mood: 'calm' });
        await h.world.endTurn('session-1');
        // Nightly has started, so its next step is first in line.
        expect(h.store.get(nightly.id)!.steps).toMatchObject([{ status: 'completed' }, { status: 'queued' }]);
        expect(h.service.snapshot(WORKSPACE_ID).queue).toEqual({ [nightly.id]: 1, [weekly.id]: 2, [legacyTwo.id]: 3 });

        await h.world.endTurn('session-2');
        expect(h.store.get(legacyRun.id)?.status).toBe('completed');
        expect(launched(h)).toEqual(['nightly · one', 'legacy', 'nightly · two']);
        expect(h.service.snapshot(WORKSPACE_ID).queue).toEqual({ [weekly.id]: 1, [legacyTwo.id]: 2 });
    });

    it('a started run finishes on its snapshot; a queued run of the old version is rejected', async () => {
        const yaml = factory(ON_REVIEW_AUTO, '- id: one\n  prompt: Look at {{item.url}}.', '- id: two\n  prompt: Write up {{item.url}}.');
        const h = await watching({ yaml, maxConcurrentAgents: 1 });
        acceptEvery(h, yaml);
        await h.poll([PR51, PR52]);
        const started = h.store.runs().find((run) => run.trigger.item?.number === 51)!;
        const waiting = h.store.runs().find((run) => run.trigger.item?.number === 52)!;
        expect(waiting.status).toBe('queued');

        await h.setYaml(yaml.replace('Write up {{item.url}}.', 'Write up {{item.url}} in one line.'));
        await h.world.endTurn('session-1');
        expect(launched(h)).toEqual(['Add retries · one', 'Add retries · two']);
        expect(h.world.launches[1].prompt).toContain('\n\nWrite up https://github.com/sprocket/catalog-portal/pull/51.\n\n');

        await h.world.endTurn('session-2');
        expect(h.store.get(started.id)?.status).toBe('completed');
        expect(h.store.get(waiting.id)).toMatchObject({
            status: 'rejected',
            summary: 'Its automation changed since it was queued.',
            steps: [
                { id: 'one', status: 'not-run' },
                { id: 'two', status: 'not-run' },
            ],
        });
        expect(h.world.launches).toHaveLength(2);
    });

    it('a session closed mid-step fails the step and frees its slot', async () => {
        const yaml = file(NIGHTLY, WEEKLY);
        const h = await accepted(yaml, { maxConcurrentAgents: 1 });
        const nightly = (await h.service.trigger(WORKSPACE_ID, 'nightly'))!;
        const weekly = (await h.service.trigger(WORKSPACE_ID, 'weekly'))!;
        await h.flush();
        h.world.workspace.sessions = h.world.workspace.sessions.filter((session) => session.id !== 'session-1');
        await h.service.syncWorkspaces();
        await h.flush();
        const error = 'Its session was closed before it finished.';
        expect(h.store.get(nightly.id)).toMatchObject({
            status: 'failed',
            error,
            steps: [{ id: 'one', status: 'failed', error }, { id: 'two', status: 'not-run' }],
        });
        expect(launched(h)).toEqual(['nightly · one', 'weekly · digest']);
        expect(h.store.get(weekly.id)?.status).toBe('running');
        // The person closed it: as for a one-step run, nothing to tell them.
        expect(h.notices).toEqual([]);
    });

    it('a missing definition fails the run', async () => {
        const h = await accepted(file(NIGHTLY));
        const run = (await h.service.trigger(WORKSPACE_ID, 'nightly'))!;
        await h.flush();
        const folder = h.folder.runDir(WORKSPACE_ID, run.id);
        fs.rmSync(path.join(folder, 'definition.json'));
        await h.service.syncWorkspaces();
        const error = `Its definition is gone from ${folder}; it cannot continue.`;
        expect(h.store.get(run.id)).toMatchObject({
            status: 'failed',
            error,
            steps: [{ id: 'one', status: 'failed', error }, { id: 'two', status: 'not-run' }],
        });
        expect(h.notices).toEqual([{ title: 'nightly did not finish', body: error, runId: run.id, workspaceId: WORKSPACE_ID, needsApproval: false }]);
        // Its turn ending afterwards changes nothing.
        await h.world.endTurn('session-1');
        expect(h.store.get(run.id)).toMatchObject({ status: 'failed', error });
    });

    it('a definition that cannot be read for now leaves a started run as it is', async () => {
        const h = await accepted(file(NIGHTLY));
        const run = (await h.service.trigger(WORKSPACE_ID, 'nightly'))!;
        await h.flush();
        const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
        onTestFinished(() => logged.mockRestore());
        const definition = path.join(h.folder.runDir(WORKSPACE_ID, run.id), 'definition.json');
        const text = fs.readFileSync(definition, 'utf8');
        fs.writeFileSync(definition, 'not json');
        await h.service.syncWorkspaces();
        // Only a definition that is gone ends it; one that fails to read is logged, and the run waits.
        expect(h.store.get(run.id)).toMatchObject({
            status: 'running',
            steps: [{ id: 'one', status: 'running', sessionId: 'session-1' }, { id: 'two', status: 'pending' }],
        });
        expect(logged).toHaveBeenCalledWith(expect.stringContaining(run.id), expect.any(Error));
        expect(h.notices).toEqual([]);

        // Readable again, it goes on.
        fs.writeFileSync(definition, text);
        h.world.setOutputs('session-1', { mood: 'calm' });
        await h.world.endTurn('session-1');
        expect(launched(h)).toEqual(['nightly · one', 'nightly · two']);
    });

    it('a steps run starts only into a free slot, and the line keeps its order', async () => {
        const look = (name: string) => entry(name, DAILY_AUTO, '- id: one\n  prompt: Look at api.');
        const yaml = file(legacy('first'), look('a'), look('b'), legacy('l'));
        const h = await accepted(yaml, { maxConcurrentAgents: 1 });
        await h.service.trigger(WORKSPACE_ID, 'first');
        h.advance(1000);
        const a = (await h.service.trigger(WORKSPACE_ID, 'a'))!;
        h.advance(1000);
        const b = (await h.service.trigger(WORKSPACE_ID, 'b'))!;
        h.advance(1000);
        const l = (await h.service.trigger(WORKSPACE_ID, 'l'))!;
        await h.flush();
        expect(launched(h)).toEqual(['first']);

        // One slot frees: the first in line takes it, and nothing else starts.
        await h.world.endTurn('session-1');
        expect(launched(h)).toEqual(['first', 'a · one']);
        expect(h.store.get(a.id)!.steps).toMatchObject([{ id: 'one', status: 'running' }]);
        expect(h.service.snapshot(WORKSPACE_ID).queue).toEqual({ [b.id]: 1, [l.id]: 2 });
        for (const waiting of [b, l]) expect(h.store.get(waiting.id)?.status).toBe('queued');
        expect(h.store.get(b.id)).not.toHaveProperty('startedAt');
        // No run holds `running` without a step working.
        const running = h.store.runs().filter((run) => run.status === 'running' && run.steps);
        expect(running.every((run) => run.steps!.some((step) => step.status === 'running'))).toBe(true);
    });

    it('a step a restart cut off is not started again in a new session, and holds no slot meanwhile', async () => {
        const yaml = file(NIGHTLY, WEEKLY);
        let h = await accepted(yaml, { maxConcurrentAgents: 1 });
        const nightly = (await h.service.trigger(WORKSPACE_ID, 'nightly'))!;
        await h.flush();
        h = await h.relaunch();
        // Back in line with its session, for the resume that picks it up there.
        expect(h.store.get(nightly.id)).toMatchObject({
            status: 'running',
            steps: [{ id: 'one', status: 'queued', attempt: 1, sessionId: 'session-1' }, { id: 'two', status: 'pending' }],
        });
        expect(launched(h)).toEqual(['nightly · one']);
        expect(h.service.snapshot(WORKSPACE_ID).queue).toEqual({ [nightly.id]: 1 });

        // It takes no slot: another run starts in the only one.
        await h.service.trigger(WORKSPACE_ID, 'weekly');
        await h.flush();
        expect(launched(h)).toEqual(['nightly · one', 'weekly · digest']);
        // Its old session ending settles nothing: no step is running in it.
        await h.world.endTurn('session-1');
        expect(h.store.get(nightly.id)).toMatchObject({ status: 'running', steps: [{ status: 'queued', sessionId: 'session-1' }, { status: 'pending' }] });
        expect(h.notices).toEqual([]);
    });

    it('an attempt set running names no earlier session until its own launches', async () => {
        const h = await accepted(file(NIGHTLY));
        const run = (await h.service.trigger(WORKSPACE_ID, 'nightly'))!;
        await h.flush();
        // No slot when one ends, so two waits in line.
        h.world.maxConcurrentAgents = 0;
        h.world.setOutputs('session-1', { mood: 'calm' });
        await h.world.endTurn('session-1');
        // As an earlier execution would leave it: a conversation on the record.
        const stale = { harnessId: 'claude', id: 'claude-1', cwd: '/code/api' };
        h.store.update(run.id, { steps: h.store.get(run.id)!.steps!.map((step) => (step.id === 'two' ? { ...step, conversation: stale } : step)) });
        const seen: unknown[] = [];
        h.world.onLaunch = () => {
            // The earlier session's turn ending while this one launches settles nothing.
            h.service.turnEnded('session-1', { exitCode: 0 });
            seen.push(h.store.get(run.id)!.steps![1]);
        };
        h.world.maxConcurrentAgents = undefined;
        await h.tick();
        expect(seen).toHaveLength(1);
        expect(seen[0]).toMatchObject({ id: 'two', status: 'running' });
        expect(seen[0]).not.toHaveProperty('conversation');
        expect(seen[0]).not.toHaveProperty('sessionId');
        expect(h.store.get(run.id)!.steps![1]).toMatchObject({ status: 'running', sessionId: 'session-2', conversation: { id: 'claude-2' } });
    });

    it('a run that cannot go on once its checkout is prepared fails, and the line moves on', async () => {
        const h = await watching({ yaml: TEMPLATE, maxConcurrentAgents: 1 });
        h.store.accept(KEY, TEMPLATE_VERSION);
        const escaped: unknown[] = [];
        const listener = (reason: unknown) => escaped.push(reason);
        process.on('unhandledRejection', listener);
        onTestFinished(() => {
            process.off('unhandledRejection', listener);
        });
        const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
        onTestFinished(() => logged.mockRestore());
        let release!: () => void;
        h.world.checkouts.gate = new Promise((resolve) => (release = resolve));
        await h.poll([PR51, PR52]);
        const first = h.store.runs().find((run) => run.trigger.item?.number === 51)!;
        const second = h.store.runs().find((run) => run.trigger.item?.number === 52)!;
        expect(second.status).toBe('queued');

        // While it prepares, its definition becomes one Consola cannot run.
        fs.writeFileSync(path.join(h.folder.runDir(WORKSPACE_ID, first.id), 'definition.json'), '{}');
        h.world.checkouts.gate = undefined;
        release();
        await h.flush();
        expect(h.store.get(first.id)).toMatchObject({
            status: 'failed',
            error: expect.stringMatching(/\S/),
            steps: [
                { id: 'review', status: 'not-run' },
                { id: 'publish', status: 'not-run' },
            ],
        });
        expect(escaped).toEqual([]);
        expect(logged).toHaveBeenCalledWith(expect.stringContaining(first.id), expect.any(Error));
        // The pump ran again: #52 has the slot now.
        expect(h.world.checkouts.prepared).toHaveLength(2);
        expect(h.store.get(second.id)?.status).toBe('running');
    });
});

describe('a steps run, as Activity lists it', () => {
    it('a steps run with an agent step lists as agent, a commands-only one as tool', async () => {
        const agent = await stepsHarness({ yaml: DAILY });
        const run = (await agent.service.trigger(WORKSPACE_ID, NAME))!;
        expect(agent.service.snapshot(WORKSPACE_ID).runs).toMatchObject([{ id: run.id, kind: 'agent', result: { kind: 'steps-run' } }]);

        const tool = await stepsHarness({ yaml: COMMANDS_ONLY });
        await tool.service.trigger(WORKSPACE_ID, NAME);
        expect(tool.service.snapshot(WORKSPACE_ID).runs).toMatchObject([{ kind: 'tool' }]);
    });

    it('leaves a steps run that already ended as it ended when asked to stop it', async () => {
        const h = await stepsHarness({ yaml: DAILY });
        const run = (await h.service.trigger(WORKSPACE_ID, NAME))!;
        h.service.dismiss(run.id);
        expect(() => h.service.stop(run.id)).not.toThrow();
        expect(h.store.get(run.id)).toMatchObject({
            status: 'rejected',
            // Dismissed before its first step.
            steps: [
                { id: 'fresh', status: 'not-run' },
                { id: 'summary', status: 'not-run' },
            ],
        });
    });
});

describe('run folders', () => {
    it("folders history dropped are swept at start, and a deleted workspace's runs go with it", async () => {
        let h = await watching({ yaml: TEMPLATE });
        await h.poll([PR51]);
        const [dismissed] = h.store.runs();
        h.service.dismiss(dismissed.id);
        await h.poll([PR51, PR52]);
        const [waiting] = h.store.runs();
        // A folder no run in history names: a crash between the write and the record, say.
        h.folder.writeDefinition(WORKSPACE_ID, 'stray', h.folder.readDefinition(WORKSPACE_ID, waiting.id)!);
        expect(fs.readdirSync(runsDir(h)).sort()).toEqual([dismissed.id, waiting.id, 'stray'].sort());

        // A month on, retention drops the dismissed run; the waiting one stays, and so does its folder.
        h.advance(31 * DAY);
        h = await h.relaunch();
        expect(h.store.runs().map((run) => run.id)).toEqual([waiting.id]);
        expect(fs.readdirSync(runsDir(h))).toEqual([waiting.id]);

        // Retention dropping a workspace's last steps run still reaches its folder.
        h.service.dismiss(waiting.id);
        h.advance(31 * DAY);
        h = await h.relaunch();
        expect(h.store.runs()).toEqual([]);
        expect(fs.readdirSync(runsDir(h))).toEqual([]);

        // A deleted workspace's runs/ goes with its history.
        await h.poll([]);
        await h.poll([PR51]);
        expect(h.store.runs()).toHaveLength(1);
        h.world.workspaceDeleted = true;
        await h.service.syncWorkspaces();
        expect(h.store.runs()).toEqual([]);
        expect(fs.existsSync(runsDir(h))).toBe(false);
    });

    it('logs a sweep that fails, and starts anyway', async () => {
        let h = await watching({ yaml: TEMPLATE });
        await h.poll([PR51]);
        const [run] = h.store.runs();
        // runs/ replaced by a file: it cannot be listed.
        fs.rmSync(runsDir(h), { recursive: true });
        fs.writeFileSync(runsDir(h), '');
        const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
        onTestFinished(() => logged.mockRestore());

        h = await h.relaunch();
        expect(logged).toHaveBeenCalledWith(`Could not sweep ${WORKSPACE_ID}'s run folders.`, expect.any(Error));
        expect(h.service.list(WORKSPACE_ID).map((entry) => entry.name)).toEqual([NAME]);
        expect(h.store.get(run.id)?.status).toBe('needs-approval');
    });
});
