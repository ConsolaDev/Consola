import { describe, expect, it } from 'vitest';
import { automationVersion, parseFactorySpec, stableStringify } from '@consola/factory-spec';
import { REVIEW_BODY, stepsHarness, WORKSPACE_ID, type StepsHarnessOptions } from './steps/steps.test-helpers';

const NAME = 'review-assigned-prs';
const KEY = `${WORKSPACE_ID} ${NAME}`;

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
        expect(h.service.list(WORKSPACE_ID)[0].asksFirst).toBeUndefined();
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
