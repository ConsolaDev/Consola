/** The automation that reviews pull requests asking for the person's review or assigned to them. */
export const ASSIGNED_REVIEWS_NAME = 'review-assigned-prs';

/**
 * A name — an action's, a scope's — as a YAML string: bare when it reads the
 * same bare, quoted otherwise. `true`, `null` and their kin are words YAML
 * reads as something else, so they are quoted too.
 */
export function yamlName(name: string): string {
    const plain = /^[A-Za-z][A-Za-z0-9 _-]*$/.test(name) && !/^(true|false|null)$/i.test(name) && name === name.trim();
    return plain ? name : JSON.stringify(name);
}

/**
 * `review-assigned-prs` as one list item: the entry the banner's Add and the
 * Templates tab write. It needs no action — its prompt is inline, since it
 * has to ask for a review addressed to the author.
 *
 * `fresh` asks GitHub whether the bound account's latest review is already
 * on the commit the run checked out, and skips the rest when it is. `review`
 * is a read-only session: no token, no shell; it sets a verdict and writes
 * the review as its handover. `publish` is the only step that acts, a command
 * run as the bound account, posting through the reviews API with `commit_id`
 * pinned to that checkout. It maps `request-changes` to REQUEST_CHANGES and
 * everything else, `approve` included, to COMMENT: a shipped review never
 * approves (decision 7). The spec's entry, verbatim.
 */
export function assignedReviewsEntry(): string {
    return ASSIGNED_REVIEWS_ENTRY;
}

const ASSIGNED_REVIEWS_ENTRY = String.raw`- name: review-assigned-prs
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

/** The automation that reviews again each pull request the person reviewed, once it has new commits. */
export const RE_REVIEW_NAME = 're-review-on-new-commits';

/**
 * `re-review-on-new-commits` as one list item: a poll that asks GitHub which
 * of the pull requests the person reviewed have commits their latest review
 * does not cover, then three steps as `review-assigned-prs` has them. The
 * review reads the last one through `previous` and is posted pinned to the
 * commit the run checked out, a comment or a request for changes, never an
 * approval (decision 7). The spec's entry, verbatim.
 */
export function reReviewEntry(): string {
    return RE_REVIEW_ENTRY;
}

const RE_REVIEW_ENTRY = String.raw`- name: re-review-on-new-commits
  on:
    poll:
      every: 30m
      run: |
        gh api graphql -f query='
          query { search(type: ISSUE, first: 50,
              query: "is:pr is:open reviewed-by:@me -author:@me -review-requested:@me archived:false") {
            nodes { ... on PullRequest { url title headRefOid viewerLatestReview { commit { oid } } } } } }' \
          --jq '[.data.search.nodes[] | select(.viewerLatestReview.commit.oid != .headRefOid) | {url, title, head: .headRefOid}]'
      item: { github: .url }
      changed: .head
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
        gh api "repos/$REPO/pulls/$NUMBER/reviews" \
          -f commit_id="$CONSOLA_CHECKOUT_HEAD" -f event="$event" -F body=@"$BODY_FILE"
      env:
        REPO: "{{item.repo}}"
        NUMBER: "{{item.number}}"
        VERDICT: "{{steps.review.verdict}}"
        BODY_FILE: "{{steps.review.handover.file}}"`;

const indent = (text: string, prefix: string) =>
    text
        .split('\n')
        .map((line) => `${prefix}${line}`)
        .join('\n');

/**
 * A file with no automations yet: what saving an entry starts from when there
 * is none, so nothing the person did not ask for is added beside it.
 */
export const EMPTY_FACTORY_FILE = `# This workspace's automations, run by Consola while it is open.
# Each one acts only on this workspace.
# Modes: auto | confirm (the default: you approve each run) | notify (report only).
# Sessions an automation starts are read-only: they read and report, and never
# run the code they look at or act on GitHub as you. An automation's commands
# run as you (your logins, the bound GitHub account).
# To turn an example on, uncomment its lines.
version: 1
automations:
`;

/** What review-assigned-prs does, said where a person reading the file meets it. */
const ASSIGNED_REVIEWS_DESCRIPTION = [
    'When a pull request asks for your review or is assigned to you, a',
    'read-only agent reviews it in a checkout of its own, and Consola posts the',
    'review on GitHub as you, as a comment or a request for changes, never an',
    'approval. It skips a commit it already reviewed. "auto" asks you once',
    'first, with every command shown.',
].join('\n');

/**
 * Under the commented entry's name. True whether or not the workspace is bound — "Open
 * file" writes it either way — and it stays in the file after the banner's Add
 * appends a live copy, so it warns off turning this one on as well.
 */
const TURN_ON_HINT = 'Needs a GitHub account. Turn it on here by uncommenting it, or with Add on the Automations page — not both.';

const CLEANUP_EXAMPLE = `  # - name: clean-up-stale-sessions
  #   # Every morning, remove sessions whose pull request was merged or closed,
  #   # with their Consola worktrees and branches. Anything with unsaved or
  #   # unpushed work is kept. Starts as "confirm": you approve each run.
  #   on: { cron: "0 9 * * *" }
  #   run: { tool: consola#cleanup_stale_sessions, with: { pr_states: [merged, closed] } }
  #   mode: confirm
`;

/**
 * A new factory.yml with review-assigned-prs in it. Live only when the person
 * asked for it — the banner's Add (`reviewsLive: true`). "Open file" writes it
 * commented out, whatever the workspace has (decision 11): Consola never
 * creates an automation the person did not ask for.
 *
 * A commented example's description is commented one level deeper than the
 * example, inside the entry. Turning it on means selecting it and toggling
 * the comment, which strips one level from every line: prose at the same
 * level as the YAML would become YAML, and the file would stop loading.
 */
export function factoryTemplate(options: { reviewsLive: boolean }): string {
    const [name, ...rest] = assignedReviewsEntry().split('\n');
    const review = options.reviewsLive
        ? `${indent(ASSIGNED_REVIEWS_DESCRIPTION, '  # ')}\n${indent(assignedReviewsEntry(), '  ')}\n`
        : `${indent([name, `  # ${TURN_ON_HINT}`, indent(ASSIGNED_REVIEWS_DESCRIPTION, '  # '), ...rest].join('\n'), '  # ')}\n`;
    return `${EMPTY_FACTORY_FILE}${review}${CLEANUP_EXAMPLE}`;
}
