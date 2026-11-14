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

/** `review-assigned-prs` running `action`, as one list item: the entry "Add" appends. */
export function assignedReviewsEntry(action: string): string {
    return [
        `- name: ${ASSIGNED_REVIEWS_NAME}`,
        '  on: { github: [pull_request.review_requested, pull_request.assigned] }',
        '  filter: { authors_not: ["dependabot[bot]"] }',
        `  run: { action: ${yamlName(action)} }`,
        '  mode: auto',
    ].join('\n');
}

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
# run the code they look at or act on GitHub as you.
# To turn an example on, uncomment its lines.
version: 1
automations:
`;

/** What review-assigned-prs does, said where a person reading the file meets it. */
function describeAssignedReviews(what: string): string {
    return [
        'When a pull request asks for your review or is assigned to you, run',
        `${what} on it, read-only, in its own worktree, so the findings are`,
        'waiting when you sit down. Only requests from now on count, and each pull',
        'request is reviewed once. "auto" asks you once, before the first review.',
    ].join('\n');
}

const CLEANUP_EXAMPLE = `  # - name: clean-up-stale-sessions
  #   # Every morning, remove sessions whose pull request was merged or closed,
  #   # with their Consola worktrees and branches. Anything with unsaved or
  #   # unpushed work is kept. Starts as "confirm": you approve each run.
  #   on: { cron: "0 9 * * *" }
  #   run: { tool: consola#cleanup_stale_sessions, with: { pr_states: [merged, closed] } }
  #   mode: confirm
`;

/**
 * Written by "Open file" (and "Add") when there is no file yet. With a pull
 * request action, automatic reviews are on: the entry is live, in `auto`,
 * which still asks once before the first review. Without one there is
 * nothing to run, so the entry is commented out with a line saying what to
 * add first.
 *
 * A commented example's description is commented one level deeper than the
 * example, inside the entry. Turning it on means selecting it and toggling
 * the comment, which strips one level from every line: prose at the same
 * level as the YAML would become YAML, and the file would stop loading.
 */
export function factoryTemplate(prAction: string | null): string {
    const review = prAction
        ? `${indent(describeAssignedReviews(`your ${prAction} action`), '  # ')}\n${indent(assignedReviewsEntry(prAction), '  ')}\n`
        : `${indent(
              [
                  assignedReviewsEntry('Review').split('\n')[0],
                  '  # Add an action for pull requests in Settings › Actions, then uncomment this and name it under run.',
                  indent(describeAssignedReviews('that action'), '  # '),
                  ...assignedReviewsEntry('Review').split('\n').slice(1),
              ].join('\n'),
              '  # '
          )}\n`;
    return `${EMPTY_FACTORY_FILE}${review}${CLEANUP_EXAMPLE}`;
}
