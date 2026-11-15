import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { automationVersion, parseFactorySpec, stableStringify } from '@consola/factory-spec';
import { inboxItem } from './inboxItems.test-helpers';
import { REVIEW_BODY, stepsHarness, WORKSPACE_ID, type StepsHarness, type StepsHarnessOptions } from './steps/steps.test-helpers';
import type { InboxItemView, SessionView } from './views';

const NAME = 'review-assigned-prs';
const KEY = `${WORKSPACE_ID} ${NAME}`;
const SUMMARISE_BODY = 'Summarise {{title}} for someone who has not read it.';

/** A file holding one entry: its `on:` and other keys as given, then `steps:` with each item's lines. */
function factory(head: string, ...steps: string[]): string {
    const items = steps.map((step) => `      ${step.replace(/\n/g, '\n      ')}`).join('\n');
    return `version: 1\nautomations:\n  - name: ${NAME}\n${head}    steps:\n${items}\n`;
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

/** A harness whose event automations have had their first look at an empty Inbox, which fires nothing. */
async function watching(options: StepsHarnessOptions): Promise<StepsHarness> {
    const h = await stepsHarness(options);
    await h.poll([]);
    return h;
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

        await h.poll([PR51, PR52]);
        expect(h.store.runs()[0]).toMatchObject({
            trigger: { item: { number: 52 } },
            status: 'queued',
            mode: 'auto',
            summary: 'Steps: review → publish: sprocket/catalog-portal#52 “Cache the catalog” by @alice.',
        });
        expect(h.notices).toHaveLength(1);
        // The pump checked both and started neither: nothing starts a steps run yet.
        expect(h.store.get(asked.id)?.status).toBe('queued');
        expect(h.world.launches).toEqual([]);
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
        expect(await h.service.trigger(WORKSPACE_ID, NAME)).toMatchObject({ status: 'queued', mode: 'auto', trigger: { by: 'person' } });
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
        expect(h.store.runs()[0]).toMatchObject({ trigger: { item: { number: 52 } }, status: 'queued', mode: 'notify', dryRun: true });

        // Only reported commands: nothing would start, so it never asks.
        const reports = await stepsHarness({ yaml: factory(`${DAILY_IN_API}    mode: notify\n`, '- run: git log -1') });
        expect(await reports.service.trigger(WORKSPACE_ID, NAME)).toMatchObject({ status: 'queued', mode: 'notify', dryRun: true });
        expect(await reports.service.trigger(WORKSPACE_ID, NAME, { sessionId: 's-9' })).toMatchObject({ status: 'queued' });
        expect(reports.notices).toEqual([]);

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
        const h = await stepsHarness({ yaml: DAILY });
        const asked = (await h.service.trigger(WORKSPACE_ID, NAME))!;
        const queued = await h.service.approve(asked.id);
        await h.flush();
        expect(h.store.get(queued.id)?.status).toBe('queued');

        await h.setYaml(DAILY.replace('Summarise what changed in api.', 'Summarise what changed in api this week.'));
        // It has not started, so its approval no longer covers what it would run. The next pump (a tick's) says so.
        await h.tick();
        expect(h.store.get(queued.id)).toMatchObject({ status: 'rejected', summary: 'Its automation changed since it was queued.' });
    });

    it('a review started by hand on the item is not done twice', async () => {
        const h = await watching({ yaml: TEMPLATE });
        h.store.accept(KEY, TEMPLATE_VERSION);
        h.advance(1000);
        h.world.workspace.sessions.push(byHand(PR51, h.now()));
        h.advance(1000);
        await h.poll([PR51]);
        const [rejected] = h.store.runs();
        expect(rejected).toMatchObject({ status: 'rejected', summary: 'Already started by hand: “PR 51”.', result: { kind: 'steps-run' } });
        // It never runs, so there is nothing to snapshot.
        expect(h.folder.readDefinition(WORKSPACE_ID, rejected.id)).toBeNull();

        // Nor while a run waits in line.
        await h.poll([PR51, PR52]);
        const [queued] = h.store.runs();
        expect(queued).toMatchObject({ trigger: { item: { number: 52 } }, status: 'queued' });
        h.advance(1000);
        h.world.workspace.sessions.push(byHand(PR52, h.now()));
        await h.tick();
        expect(h.store.get(queued.id)).toMatchObject({ status: 'rejected', summary: 'Already started by hand: “PR 52”.' });

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
        expect(failed).toMatchObject({ status: 'failed', finishedAt: h.now().toISOString(), result: { kind: 'steps-run' } });
        expect(failed.error).toMatch(/^Could not write its definition: \S.*[^.]\.$/);
        expect(h.notices).toMatchObject([{ title: `${NAME} could not start`, needsApproval: false, runId: failed.id }]);

        fs.rmSync(runsDir(h));
        expect(fs.existsSync(h.folder.runDir(WORKSPACE_ID, failed.id))).toBe(false);
        const next = (await h.service.trigger(WORKSPACE_ID, NAME))!;
        expect(next).toMatchObject({ status: 'needs-approval' });
        expect(next.id).not.toBe(failed.id);
        expect(h.folder.readDefinition(WORKSPACE_ID, next.id)).not.toBeNull();
    });

    it('a schedule keeps one steps run at a time', async () => {
        for (const yaml of [DAILY, COMMANDS_ONLY]) {
            const h = await stepsHarness({ yaml });
            h.store.accept(KEY, automationVersion(only(yaml)));
            h.advance(HOUR);
            await h.tick();
            const [first] = h.store.runs();
            expect(first).toMatchObject({ status: 'queued', trigger: { kind: 'cron' } });

            // The next occurrence, and a Run now, while it waits in line: that run is the answer.
            h.advance(DAY);
            await h.tick();
            expect(await h.service.trigger(WORKSPACE_ID, NAME)).toMatchObject({ id: first.id });
            expect(h.store.runs()).toHaveLength(1);

            // Nothing starts a steps run yet. As if it had: it holds its place while it runs.
            h.store.update(first.id, { status: 'running', startedAt: h.now().toISOString() });
            h.advance(DAY);
            await h.tick();
            expect(await h.service.trigger(WORKSPACE_ID, NAME)).toMatchObject({ id: first.id });
            expect(h.store.runs()).toHaveLength(1);

            // Once it ends, the next fire is a run of its own.
            h.store.update(first.id, { status: 'completed', finishedAt: h.now().toISOString() });
            const next = (await h.service.trigger(WORKSPACE_ID, NAME))!;
            expect(next).toMatchObject({ status: 'queued' });
            expect(next.id).not.toBe(first.id);
        }
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
        expect(h.store.get(run.id)?.status).toBe('rejected');
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
