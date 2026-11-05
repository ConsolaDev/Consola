import { z } from 'zod';
import type { PullRequestQuery, PullRequestState } from '../pullRequests';

/**
 * `owner/name`, nothing that could escape an API path: GitHub owners never
 * contain dots, and a repository name may, but is never `.` or `..`.
 */
const REPO_SLUG = /^[A-Za-z0-9-]+\/(?!\.\.?$)[A-Za-z0-9_.-]+$/;

/**
 * GitHub's REST pulls API, by number and by head branch.
 *
 * REST rather than `gh pr list --head`: its `head=<owner>:<branch>` filter is
 * exact, so a fork that happens to reuse a branch name can never answer for
 * ours. Responses are parsed strictly — the provider's wire format is not a
 * contract, and an unrecognised shape must fail the lookup rather than read
 * as "no PR", which cleanup would treat as nothing to do.
 */

const restPullSchema = z.object({
    number: z.number().int().positive(),
    state: z.enum(['open', 'closed']),
    merged_at: z.string().nullable(),
    html_url: z.string(),
    created_at: z.string(),
    head: z.object({ sha: z.string().min(7), ref: z.string() }),
});

/** The `gh api` endpoint answering one query. Throws on a query that could escape the path. */
export function pullsEndpoint(query: PullRequestQuery): string {
    if (!REPO_SLUG.test(query.repo)) throw new Error(`Not an owner/name repository: "${query.repo}".`);
    if ('number' in query) {
        if (!Number.isInteger(query.number) || query.number <= 0) {
            throw new Error(`Not a pull request number: ${query.number}.`);
        }
        return `repos/${query.repo}/pulls/${query.number}`;
    }
    if (!query.headBranch) throw new Error('A head branch is required.');
    const owner = query.repo.split('/')[0];
    const head = encodeURIComponent(`${owner}:${query.headBranch}`);
    return `repos/${query.repo}/pulls?state=all&per_page=20&head=${head}`;
}

/** Parse what `gh api <pullsEndpoint(query)>` printed. Throws on an unrecognised shape. */
export function parsePullsResponse(query: PullRequestQuery, stdout: string): PullRequestState[] {
    let payload: unknown;
    try {
        payload = JSON.parse(stdout);
    } catch {
        throw new Error('GitHub returned a pulls response that is not JSON.');
    }
    const raw = 'number' in query ? [payload] : payload;
    const parsed = z.array(restPullSchema).safeParse(raw);
    if (!parsed.success) throw new Error('GitHub returned a pulls response Consola does not recognise.');
    return parsed.data
        .map(
            (pull): PullRequestState => ({
                number: pull.number,
                status: pull.state === 'open' ? 'open' : pull.merged_at ? 'merged' : 'closed',
                headOid: pull.head.sha,
                headBranch: pull.head.ref,
                // GitHub keeps every PR's head here, merged, closed or with
                // its branch deleted.
                fetchRef: `pull/${pull.number}/head`,
                url: pull.html_url,
                createdAt: pull.created_at,
            })
        )
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
