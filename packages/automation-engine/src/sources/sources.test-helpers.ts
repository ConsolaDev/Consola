import * as path from 'path';
import type { RunRecord } from '@consola/factory-spec';
import { itemKey } from '../inboxItems.test-helpers';
import type { WorkItemPort } from '../ports';
import { stepsHarness, WORKSPACE_ID, type FakeCommand, type StepsHarness, type StepsHarnessOptions, type StepsWorld } from '../steps/steps.test-helpers';
import type { ItemRef, ItemTarget } from '../views';

/*
 * The harness every sources test runs through: PR A's steps harness, over a
 * host that also reads work item URLs. Its `WorkItemPort` is a fake that knows
 * GitHub's two URL shapes and nothing else, keys a work item as the desktop
 * does (`github:sprocket/catalog-portal:pr:51`), and holds a repository as
 * cloned while `world.clonedRepos` names it. A task that adds to it adds to
 * `SourcesWorld` and the helpers below; earlier tests keep working as written.
 */

export { WORKSPACE_ID };

export const RE_REVIEW_NAME = 're-review-on-new-commits';

/** The command the spec's template checks with, exactly as its `run: |` block reads. */
export const RE_REVIEW_COMMAND = `gh api graphql -f query='
  query { search(type: ISSUE, first: 50,
      query: "is:pr is:open reviewed-by:@me -author:@me -review-requested:@me archived:false") {
    nodes { ... on PullRequest { url title headRefOid viewerLatestReview { commit { oid } } } } } }' \\
  --jq '[.data.search.nodes[] | select(.viewerLatestReview.commit.oid != .headRefOid) | {url, title, head: .headRefOid}]'
`;

const indented = (text: string, by: string) =>
    text
        .trimEnd()
        .split('\n')
        .map((line) => `${by}${line}`)
        .join('\n');

/** The spec's template (*Acceptance › PR B*): one `- name:` list item, at column 0. */
export const RE_REVIEW_ENTRY = `- name: ${RE_REVIEW_NAME}
  on:
    poll:
      every: 30m
      run: |
${indented(RE_REVIEW_COMMAND, '        ')}
      item: { github: .url }
      changed: .head
  mode: auto
  steps:
    - id: fresh
      run: |
        reviewed=$(gh api graphql -f url="$PR" -f query='
          query($url: URI!) { resource(url: $url) { ... on PullRequest {
            viewerLatestReview { commit { oid } } } } }' \\
          --jq '.data.resource.viewerLatestReview.commit.oid // ""')
        if [ "$reviewed" = "$CONSOLA_CHECKOUT_HEAD" ]; then needed=false; else needed=true; fi
        echo "needed=$needed" >> "$CONSOLA_OUTPUT"
      env: { PR: "{{item.url}}" }
      outputs: { needed: boolean }
      dry_run: run
    - id: review
      if: steps.fresh.needed
      prompt: >-
        This pull request has new commits since you last reviewed it. If there is an earlier review
        (previous.review.handover), read it first and check whether each of its points was addressed.
        Read the pull request with Consola's work_item_context tool, and the changed files in this folder
        where it helps. Write your review as your handover, in Markdown, addressed to the author and under
        60,000 characters: what was addressed, what was not, and anything new, each with its file and line.
        Then set verdict: approve if you would merge it as it is, request-changes if something must change
        first, comment otherwise.
      reads: [previous.review.handover]
      outputs:
        verdict: { enum: [approve, comment, request-changes] }
    - id: publish
      if: steps.fresh.needed
      run: |
        event=COMMENT
        if [ "$VERDICT" = "request-changes" ]; then event=REQUEST_CHANGES; fi
        gh api "repos/$REPO/pulls/$NUMBER/reviews" \\
          -f commit_id="$CONSOLA_CHECKOUT_HEAD" -f event="$event" -F body=@"$BODY_FILE"
      env:
        REPO: "{{item.repo}}"
        NUMBER: "{{item.number}}"
        VERDICT: "{{steps.review.verdict}}"
        BODY_FILE: "{{steps.review.handover.file}}"
`;

/** ws-1's factory.yml holding these `- name:` list items, each written at column 0. */
export function factoryWith(...entries: string[]): string {
    return `version: 1\nautomations:\n${entries.map((entry) => `${indented(entry, '  ')}\n`).join('')}`;
}

export interface SourcesHarnessOptions extends Omit<StepsHarnessOptions, 'workItems'> {
    /** Repositories cloned into one of ws-1's scopes, as `inWorkspace` answers. Default: sprocket/catalog-portal. */
    clonedRepos?: string[];
}

/** PR A's world, plus the host's work items. Edit the sets, then `service.syncWorkspaces()` where resolving depends on them. */
export interface SourcesWorld extends StepsWorld {
    /** The fake host's `WorkItemPort`, which the service was given. */
    workItems: WorkItemPort;
    /** Connections whose work item URLs the host reads, as `canParseUrls` answers. Default: github. */
    urlConnections: Set<string>;
    /** Repositories cloned into one of ws-1's scopes, compared ignoring case. */
    clonedRepos: Set<string>;
}

export interface SourcesHarness extends Omit<StepsHarness, 'world' | 'relaunch'> {
    world: SourcesWorld;
    /** Make ws-1's factory.yml hold this one `- name:` entry (default: the spec's template) and reload it. */
    setPoll(entry?: string): Promise<void>;
    /** Quit, then start a new service over the same state, history, run folder, files, clock and world. */
    relaunch(): Promise<SourcesHarness>;
    /** Quit, replace ws-1's factory.yml while nothing watches it, then start a new service: an edit made while Consola was closed. */
    relaunchWith(yaml: string): Promise<SourcesHarness>;
    /**
     * One run of ws-1's poll entry `name` (default: the spec's template) on
     * #51, as its checks make one: the due checks end finding nothing (the
     * first after Allow records what is there), then a Check now finds
     * `PR_51_ROW`. The entry must be allowed: one that is not never checks.
     */
    fire(name?: string): Promise<RunRecord>;
    /** What every check prints from now on, as its stdout: these objects, as a JSON array. Until set, none (`[]`). */
    pollOutput(items: object[]): void;
    /**
     * Run the due checks to completion: a tick, then every check command
     * still running ends at exit 0, printing `pollOutput`'s items, and so
     * does each one their ending let start. A check a test ended itself is
     * left as it is.
     */
    check(): Promise<void>;
    /** A Check now on `name` (default: the spec's template) that prints `items`, run to completion with every other due check. */
    checkSees(items: object[], name?: string): Promise<void>;
    /**
     * Run on…: a person's run of `name` (default: the spec's template) on
     * `target`, or an agent's with `actor`, then whatever it set going. The
     * run as it stands once that settled, copied: later changes do not reach
     * it. A refusal rejects, as the click's does.
     */
    runOn(target: ItemTarget, name?: string, actor?: { sessionId?: string }): Promise<RunRecord>;
}

/** sprocket/catalog-portal#51, as a poll with `item: { github: .url }` reads it. */
export const PR_51 = { repo: 'sprocket/catalog-portal', number: 51, type: 'pr' as const };
export const PR_51_URL = 'https://github.com/sprocket/catalog-portal/pull/51';
/** #51's work item key, as the host keys it: the key of its seen record's member, its runs' item, and `previous`. */
export const PR_51_KEY = itemKey({ provider: 'github', ...PR_51 });
/** What the template's check prints for #51: its URL, title and head. */
export const PR_51_ROW = { url: PR_51_URL, title: 'Fix the cart total', head: 'a' };

const GITHUB_WORK_ITEM_URL = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/(pull|issues)\/([1-9][0-9]*)$/;

/** GitHub's URL rule, as the desktop's driver has it: exactly a pull request's or an issue's page. */
function fakeWorkItems(world: () => Pick<SourcesWorld, 'urlConnections' | 'clonedRepos'>): WorkItemPort {
    return {
        canParseUrls: (connection) => world().urlConnections.has(connection),
        parseUrl(connection, url): ItemRef | null {
            if (connection !== 'github' || !world().urlConnections.has(connection)) return null;
            const match = GITHUB_WORK_ITEM_URL.exec(url);
            if (!match) return null;
            const [, owner, name, kind, number] = match;
            return { provider: 'github', repo: `${owner}/${name}`, type: kind === 'pull' ? 'pr' : 'issue', number: Number(number) };
        },
        keyOf: itemKey,
        urlOf: (ref) => `https://github.com/${ref.repo}/${ref.type === 'pr' ? 'pull' : 'issues'}/${ref.number}`,
        inWorkspace: (_workspaceId, ref) => [...world().clonedRepos].some((repo) => repo.toLowerCase() === ref.repo.toLowerCase()),
    };
}

/** A started service over Sprocket whose host reads GitHub URLs. Call it inside a test, as `stepsHarness`. */
export async function sourcesHarness(options: SourcesHarnessOptions = {}): Promise<SourcesHarness> {
    const { clonedRepos = ['sprocket/catalog-portal'], ...rest } = options;
    // The fake reads the world it belongs to, which exists only once the steps harness made it; until then, these.
    let sets: Pick<SourcesWorld, 'urlConnections' | 'clonedRepos'> = { urlConnections: new Set(['github']), clonedRepos: new Set(clonedRepos) };
    const workItems = fakeWorkItems(() => sets);
    const base = await stepsHarness({ ...rest, workItems });
    const world: SourcesWorld = Object.assign(base.world, sets, { workItems });
    sets = world;
    // Kept across relaunches, as the world is.
    let printed = '[]';
    const checksDir = path.join(base.folder.workspaceDir(WORKSPACE_ID), 'checks');
    const isCheck = (command: FakeCommand) => path.dirname(path.dirname(command.spec.stdoutPath)) === checksDir;

    const checkAll = async (harness: StepsHarness) => {
        await harness.tick();
        // Ending one frees the lane for another that is due: that one ends too.
        for (let round = 0; round < 20; round++) {
            const running = world.commands.filter((command) => isCheck(command) && !command.ended);
            if (running.length === 0) return;
            for (const command of running) await command.end({ stdout: printed });
        }
        throw new Error('Checks kept starting: a check() never settled.');
    };
    const checkSees = async (harness: StepsHarness, items: object[], name: string) => {
        printed = JSON.stringify(items);
        // Check now: refused for an entry not allowed, as a person's click is.
        await harness.service.trigger(WORKSPACE_ID, name);
        await checkAll(harness);
    };

    const wrap = (harness: StepsHarness): SourcesHarness => ({
        ...harness,
        world,
        async setPoll(entry = RE_REVIEW_ENTRY) {
            await harness.setYaml(factoryWith(entry));
        },
        async relaunch() {
            return wrap(await harness.relaunch());
        },
        async relaunchWith(yaml) {
            harness.service.shutdown();
            // A service that quit reads no file: this only changes what the next one loads.
            await harness.setYaml(yaml);
            return wrap(await harness.relaunch());
        },
        async fire(name = RE_REVIEW_NAME) {
            const before = new Set(harness.store.runs().map((run) => run.id));
            printed = '[]';
            await checkAll(harness);
            await checkSees(harness, [PR_51_ROW], name);
            const run = harness.store.runs().find((candidate) => !before.has(candidate.id) && candidate.automationId === name);
            if (!run) throw new Error(`A check of ${name} that found #51 made no run.`);
            return harness.store.get(run.id)!;
        },
        pollOutput(items) {
            printed = JSON.stringify(items);
        },
        check: () => checkAll(harness),
        checkSees: (items, name = RE_REVIEW_NAME) => checkSees(harness, items, name),
        async runOn(target, name = RE_REVIEW_NAME, actor = {}) {
            const run = await harness.service.trigger(WORKSPACE_ID, name, actor, target);
            await harness.flush();
            if (!run) throw new Error(`Run on… ${name} made no run.`);
            return structuredClone(harness.store.get(run.id)!);
        },
    });
    return wrap(base);
}
