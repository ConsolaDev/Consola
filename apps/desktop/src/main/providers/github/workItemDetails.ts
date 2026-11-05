import { z } from 'zod/v3';
import type { WorkItemRef } from '../../../shared/workItems';
import type { WorkItemDetails } from '../GitProviderDriver';

/**
 * `gh pr view` / `gh issue view` with `--json`, read into WorkItemDetails.
 *
 * Strict where it matters and lenient where GitHub is: a missing title or
 * URL means this is not the reply we asked for, while a deleted author
 * (`author: null`, a "ghost") or an empty body is ordinary.
 */

const PR_FIELDS = 'title,body,author,state,url,comments,baseRefName,headRefName,files';
const ISSUE_FIELDS = 'title,body,author,state,url,comments';

/** argv for the JSON view of an item, always naming its repo — never whatever the cwd resolves to. */
export function viewArgs(ref: WorkItemRef): string[] {
    const noun = ref.type === 'pr' ? 'pr' : 'issue';
    return [noun, 'view', String(ref.number), '--repo', ref.repo, '--json', ref.type === 'pr' ? PR_FIELDS : ISSUE_FIELDS];
}

export function diffArgs(ref: WorkItemRef): string[] {
    return ['pr', 'diff', String(ref.number), '--repo', ref.repo];
}

const login = z
    .object({ login: z.string() })
    .nullish()
    .transform((author) => author?.login ?? 'ghost');

const viewSchema = z.object({
    title: z.string(),
    body: z.string().nullish().transform((body) => body ?? ''),
    author: login,
    state: z.string(),
    url: z.string().url(),
    comments: z
        .array(z.object({ author: login, body: z.string().nullish().transform((body) => body ?? '') }))
        .default([]),
    baseRefName: z.string().optional(),
    headRefName: z.string().optional(),
    files: z.array(z.object({ path: z.string(), additions: z.number(), deletions: z.number() })).optional(),
});

/** Throws on a reply that is not an item: an empty description would read as "nothing to review". */
export function parseWorkItemDetails(stdout: string, diff?: string): WorkItemDetails {
    const parsed = viewSchema.safeParse(JSON.parse(stdout));
    if (!parsed.success) throw new Error(`Unrecognised reply from gh: ${parsed.error.issues[0]?.message ?? 'invalid'}.`);
    const view = parsed.data;
    return {
        title: view.title,
        body: view.body,
        author: view.author,
        state: view.state.toLowerCase(),
        url: view.url,
        comments: view.comments,
        ...(view.baseRefName ? { baseRef: view.baseRefName } : {}),
        ...(view.headRefName ? { headRef: view.headRefName } : {}),
        ...(view.files ? { files: view.files } : {}),
        ...(diff !== undefined ? { diff } : {}),
    };
}
