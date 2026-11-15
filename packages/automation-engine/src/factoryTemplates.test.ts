import { describe, expect, it } from 'vitest';
import { isStepsEntry, parseAutomationEntry, parseFactorySpec } from '@consola/factory-spec';
import { ASSIGNED_REVIEWS_NAME, assignedReviewsEntry, factoryTemplate, yamlName } from './factoryTemplates';

/**
 * What an editor's "toggle comment" does to a selection that is all comments:
 * removes one level from each line. Editors differ on the space after `#` —
 * VS Code takes it, Xcode leaves it — so both are exercised.
 */
function uncommentFrom(template: string, firstLine: string, marker: RegExp, lastLine?: string): string {
    const lines = template.split('\n');
    const start = lines.findIndex((line) => line.trim() === firstLine);
    expect(start).toBeGreaterThan(0);
    const end = lastLine === undefined ? lines.length : lines.findIndex((line) => line.trim() === lastLine);
    expect(end).toBeGreaterThan(start);
    return lines.map((line, index) => (index >= start && index < end ? line.replace(marker, '$1') : line)).join('\n');
}

/** A file's words as a person reads them: comment markers gone, lines joined. */
const prose = (text: string) =>
    text
        .split('\n')
        .map((line) => line.replace(/^\s*(#\s*)*/, ''))
        .join(' ')
        .replace(/\s+/g, ' ');

const TOGGLES = [
    ['removing "# " (VS Code)', /^(\s*)# ?/],
    ['removing only "#" (Xcode)', /^(\s*)#/],
] as const;

/**
 * The entry as the spec writes it (*Acceptance*, `### PR A:
 * review-assigned-prs`), byte for byte: the template ships it verbatim.
 */
const SPEC_ENTRY = String.raw`- name: review-assigned-prs
  on: { github: [pull_request.review_requested, pull_request.assigned] }
  filter: { authors_not: ["dependabot[bot]"] }
  mode: auto
  steps:
    - id: fresh
      run: |
        reviewed=$(gh api graphql -f url="$PR" -f query='
          query($url: URI!) { resource(url: $url) { ... on PullRequest {
            viewerLatestReview { commit { oid } } } } }' \
          --jq '.data.resource.viewerLatestReview.commit.oid // ""')
        if [ "$reviewed" = "$CONSOLA_CHECKOUT_HEAD" ]; then needed=false; else needed=true; fi
        echo "needed=$needed" >> "$CONSOLA_OUTPUT"
      env: { PR: "{{item.url}}" }
      outputs: { needed: boolean }
      dry_run: run
    - id: review
      if: steps.fresh.needed
      prompt: >-
        Review this pull request. Read it with Consola's work_item_context tool, and read the changed files
        in this folder where it helps. Write your review as your handover, in Markdown, addressed to the
        author and under 60,000 characters: what it changes, then each finding with its file and line.
        Then set verdict: approve if you would merge it as it is, request-changes if something must change
        first, comment otherwise.
      outputs:
        verdict: { enum: [approve, comment, request-changes] }
    - id: publish
      if: steps.fresh.needed
      run: |
        event=COMMENT
        if [ "$VERDICT" = "request-changes" ]; then event=REQUEST_CHANGES; fi
        gh api "repos/$REPO/pulls/$NUMBER/reviews" \
          -f commit_id="$CONSOLA_CHECKOUT_HEAD" -f event="$event" -F body=@"$BODY_FILE"
      env:
        REPO: "{{item.repo}}"
        NUMBER: "{{item.number}}"
        VERDICT: "{{steps.review.verdict}}"
        BODY_FILE: "{{steps.review.handover.file}}"`;

describe('assignedReviewsEntry', () => {
    it("the entry is the spec's, and loads as three steps", () => {
        expect(assignedReviewsEntry()).toBe(SPEC_ENTRY);

        const parsed = parseAutomationEntry(assignedReviewsEntry());
        if (!parsed.ok) throw new Error(parsed.issues.map((issue) => issue.message).join('; '));
        const { automation } = parsed;
        expect(automation).toMatchObject({
            name: ASSIGNED_REVIEWS_NAME,
            mode: 'auto',
            trigger: { kind: 'event', connection: 'github', events: ['pull_request.review_requested', 'pull_request.assigned'] },
            filter: { authors_not: ['dependabot[bot]'] },
        });
        if (!isStepsEntry(automation)) throw new Error('review-assigned-prs is a steps entry');
        expect(automation.steps.map((step) => [step.id, step.kind])).toEqual([
            ['fresh', 'run'],
            ['review', 'agent'],
            ['publish', 'run'],
        ]);
        const [fresh, review, publish] = automation.steps;
        // Only reads, so it runs in a dry run too; the rest waits on its answer.
        expect(fresh).toMatchObject({ kind: 'run', dryRun: 'run', outputs: { needed: { type: 'boolean' } }, env: { PR: '{{item.url}}' } });
        expect(review).toMatchObject({
            kind: 'agent',
            if: 'steps.fresh.needed',
            outputs: { verdict: { type: 'enum', values: ['approve', 'comment', 'request-changes'] } },
            // Publishing reads it, so the review must write one.
            handover: 'required',
        });
        expect(review.kind === 'agent' && review.prompt).toMatch(/work_item_context/);
        expect(publish).toMatchObject({
            kind: 'run',
            if: 'steps.fresh.needed',
            dryRun: 'report',
            env: { BODY_FILE: '{{steps.review.handover.file}}', VERDICT: '{{steps.review.verdict}}' },
        });
        // Pinned to the commit the run checked out, and never an approval (D1).
        expect(publish.kind === 'run' && publish.run).toContain('-f commit_id="$CONSOLA_CHECKOUT_HEAD"');
        expect(assignedReviewsEntry()).not.toContain('APPROVE');
        expect(assignedReviewsEntry()).not.toContain('gh pr review');
    });
});

describe('factoryTemplate', () => {
    it('the template writes it live or commented', () => {
        // Live: what the banner's Add writes when there is no file.
        const live = factoryTemplate({ reviewsLive: true });
        const loaded = parseFactorySpec(live);
        expect(loaded.issues).toEqual([]);
        expect(loaded.automations.map((automation) => automation.name)).toEqual([ASSIGNED_REVIEWS_NAME]);
        expect(live).toContain(assignedReviewsEntry().replace(/^/gm, '  '));

        // Commented: what "Open file" writes, whatever the workspace has. Nothing runs.
        const commented = factoryTemplate({ reviewsLive: false });
        expect(parseFactorySpec(commented)).toEqual({ automations: [], issues: [] });
        expect(commented).toContain('# Connect a GitHub account, then uncomment this.');
        const uncommented = parseFactorySpec(
            uncommentFrom(commented, '# - name: review-assigned-prs', TOGGLES[0][1], '# - name: clean-up-stale-sessions')
        );
        expect(uncommented.issues).toEqual([]);
        expect(uncommented.automations).toHaveLength(1);
        // The same entry, a few lines further down.
        expect({ ...uncommented.automations[0], line: 0 }).toEqual({ ...loaded.automations[0], line: 0 });

        // Both say what it does before it does it.
        for (const text of [live, commented].map(prose)) {
            expect(text).toMatch(/asks for your review or is assigned to you/);
            expect(text).toMatch(/read-only agent reviews it in a checkout of its own/);
            expect(text).toMatch(/posts the review on GitHub as you/);
            expect(text).toMatch(/as a comment or a request for changes, never an approval/);
            expect(text).toMatch(/skips a commit it already reviewed/);
            expect(text).toMatch(/"auto" asks you once first, with every command shown/);
        }
    });

    it.each(TOGGLES)('turns its examples on when they are all uncommented by %s', (_label, marker) => {
        const without = parseFactorySpec(uncommentFrom(factoryTemplate({ reviewsLive: false }), '# - name: review-assigned-prs', marker));
        expect(without.issues).toEqual([]);
        expect(without.automations.map((automation) => automation.name)).toEqual([ASSIGNED_REVIEWS_NAME, 'clean-up-stale-sessions']);
    });

    it('turns the cleanup example on beside the live entry when "# " is removed', () => {
        // Removing only "#" leaves it one column right of the live entry, and
        // no layout lines up under both editors once an entry is live.
        const live = parseFactorySpec(
            uncommentFrom(factoryTemplate({ reviewsLive: true }), '# - name: clean-up-stale-sessions', TOGGLES[0][1])
        );
        expect(live.issues).toEqual([]);
        expect(live.automations.map((automation) => automation.name)).toEqual([ASSIGNED_REVIEWS_NAME, 'clean-up-stale-sessions']);
    });

    it('a name that needs quoting round-trips', () => {
        for (const name of ['Review: deep', 'Review #2', '"Quoted"', 'Re-view_2', 'true']) {
            const result = parseFactorySpec(
                `version: 1\nautomations:\n  - name: digest\n    on: { cron: "0 9 * * *" }\n    run: { prompt: hi }\n    scope: ${yamlName(name)}\n`
            );
            expect(result.issues).toEqual([]);
            expect(result.automations[0].scope).toBe(name);
        }
        // A plain name stays plain.
        expect(yamlName('Review code')).toBe('Review code');
    });
});
