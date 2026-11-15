import { z } from 'zod/v3';
import type { EventTrigger, ExprValue, ItemFieldTable, RunItem } from '@consola/factory-spec';
import { fenceUntrusted, READ_ONLY_NOTE, UNWATCHED_NOTE, type ItemSource, type SourceItem } from './sources/itemSource';
import { fillActionPlaceholders } from './support';
import type { InboxItemView, ItemRef } from './views';

/**
 * The connection event contract, and the one connection that implements it.
 *
 * A connection reports a list of items per view; an event is a named change
 * in that list between two successful polls. Locally the only rule is
 * `entered(view)` — an item present now and absent last time — so an event
 * that cannot be said as a change between two polls is simply not offered,
 * and therefore cannot be written. An automation listing several events
 * watches their union: the set is every item in any of their views, and
 * `seenRecord` decides which members fire. Filters are named fields each
 * connection declares, never free-form expressions, and placeholders
 * likewise.
 *
 * Event names are the provider's own webhook names, so a file means the same
 * thing on a cloud runner that receives real webhooks. A personal file has
 * one person, so `review_requested` is a request of *them*: the cloud runner
 * applies the same reviewer.
 *
 * Jira, Linear, Slack and manifest-defined connections plug in here as more
 * entries; nothing else in the runner names GitHub.
 */

/**
 * An automation's events, resolved against its filter: everything the runner
 * needs from them. The Inbox's item source: its per-item pieces (header,
 * fence, fields, prompt) are its connection's, shared with a run on a chosen
 * work item (`workItemSource`).
 */
export interface EventSource extends ItemSource {
    connection: string;
    events: string[];
    /** The trigger in words, for the panel: "When a pull request asks for your review or is assigned to you". */
    describe: string;
    /** The item type its items are, for an action's `appliesTo`; `itemTypes` is the same one, alone. */
    itemType: 'pr' | 'issue';
    /** Whether an item is in any listed event's view: the set the seen record keeps. */
    inSet(item: InboxItemView): boolean;
    /** Whether the automation's filter lets an item in the set fire. */
    passesFilter(item: InboxItemView): boolean;
    /** The listed events whose views hold the item, in the order the file lists them. */
    eventsOf(item: InboxItemView): string[];
    /** Stable key for the seen record. */
    keyOf(item: InboxItemView): string;
    /** "acme/api#123 “Title” by @alice" — for previews and notifications; the title is the author's. */
    describeItem(item: InboxItemView): string;
    /** An Inbox item as firing passes it around. No revision: a seen record from before revisions has none. */
    toSourceItem(item: InboxItemView, passes: boolean): SourceItem;
    /** The connection's item fields, for `stepItemFieldProblems` and rendering. */
    itemFields: ItemFieldTable;
}

/** The prompt a scheduled automation's session starts with: no item, so it says where it runs. */
export function scheduledPrompt(body: string, automation: string, scopeName: string): string {
    return `This session was started on a schedule by the automation "${automation}", in ${scopeName}. ${READ_ONLY_NOTE} ${UNWATCHED_NOTE}\n\n${body.trim()}`;
}

export type EventSourceResolution = { ok: true; source: EventSource } | { ok: false; problem: string };

interface EventDefinition {
    /** What the item does, after "When a pull request": "asks for your review". */
    phrase: string;
    itemType: 'pr' | 'issue';
    /** The view: which items are in the list at all. */
    inView(item: InboxItemView): boolean;
    /** Why an item left the view, mid-sentence: "it no longer asks for your review". */
    goneClause: string;
}

/** Each field's description is what `connectionCatalog` tells an agent writing a filter. */
const GITHUB_FILTER = z
    .object({
        repos: z
            .array(z.string().min(1))
            .optional()
            .describe('Only items in these repositories: globs on owner/name, where * stays within one segment (my-org/*).'),
        authors: z.array(z.string().min(1)).optional().describe('Only items opened by these GitHub logins.'),
        authors_not: z
            .array(z.string().min(1))
            .optional()
            .describe('Leave out items opened by these GitHub logins, e.g. "dependabot[bot]".'),
        // A draft asking for review is rare and usually premature.
        drafts: z.boolean().default(false).describe('Whether draft pull requests fire too. Default: false.'),
    })
    .strict();

type GitHubFilter = z.infer<typeof GITHUB_FILTER>;

const GITHUB_EVENTS: Record<string, EventDefinition> = {
    // GitHub removes a reviewer from the requested list once they review, so
    // the PR leaves the view; a re-request adds it back and fires again —
    // one review per request.
    'pull_request.review_requested': {
        phrase: 'asks for your review',
        itemType: 'pr',
        inView: (item) =>
            item.workItem.type === 'pr' && item.state === 'open' && item.roles.includes('review-requested-direct'),
        goneClause: 'it no longer asks for your review',
    },
    // Assigned to review it, in teams that assign rather than request. Your
    // own PR assigned to yourself is bookkeeping, not a request.
    'pull_request.assigned': {
        phrase: 'is assigned to you',
        itemType: 'pr',
        inView: (item) =>
            item.workItem.type === 'pr' &&
            item.state === 'open' &&
            item.roles.includes('assignee') &&
            !item.roles.includes('author'),
        goneClause: 'you are no longer assigned to it',
    },
};

const ITEM_NOUN: Record<EventDefinition['itemType'], string> = { pr: 'pull request', issue: 'issue' };

function capitalise(text: string): string {
    return text.charAt(0).toUpperCase() + text.slice(1);
}

function globToRegExp(glob: string): RegExp {
    const pattern = glob
        .split('')
        .map((char) => (char === '*' ? '[^/]*' : char === '?' ? '[^/]' : char.replace(/[.+^${}()|[\]\\]/g, '\\$&')))
        .join('');
    return new RegExp(`^${pattern}$`, 'i');
}

function githubMatcher(filter: GitHubFilter): (item: InboxItemView) => boolean {
    const repos = filter.repos?.map(globToRegExp);
    const lower = (logins?: string[]) => logins && new Set(logins.map((login) => login.toLowerCase()));
    const authors = lower(filter.authors);
    const authorsNot = lower(filter.authors_not);
    return (item) => {
        if (item.isDraft && !filter.drafts) return false;
        if (repos && !repos.some((pattern) => pattern.test(item.workItem.repo))) return false;
        const author = item.author.toLowerCase();
        if (authors && !authors.has(author)) return false;
        if (authorsNot?.has(author)) return false;
        return true;
    };
}

const CONNECTIONS: Record<
    string,
    {
        events: Record<string, EventDefinition>;
        filter: z.AnyZodObject;
        resolve: typeof resolveGitHub;
        workItemSource: typeof githubWorkItemSource;
    }
> = {
    github: { events: GITHUB_EVENTS, filter: GITHUB_FILTER, resolve: resolveGitHub, workItemSource: githubWorkItemSource },
};

/** One connection as an agent writing an `on:` and a `filter:` needs to know it. */
export interface ConnectionCatalogEntry {
    id: string;
    events: Array<{ name: string; when: string; itemType: 'pr' | 'issue' }>;
    filter: Array<{ field: string; means: string }>;
}

/** Every connection, its events and its filter fields: what an event trigger may name. */
export function connectionCatalog(): ConnectionCatalogEntry[] {
    return Object.entries(CONNECTIONS).map(([id, connection]) => ({
        id,
        events: Object.entries(connection.events).map(([name, definition]) => ({
            name,
            when: `a ${ITEM_NOUN[definition.itemType]} ${definition.phrase}`,
            itemType: definition.itemType,
        })),
        filter: Object.entries(connection.filter.shape).map(([field, schema]) => ({
            field,
            means: (schema as z.ZodTypeAny).description ?? '',
        })),
    }));
}

function resolveGitHub(
    trigger: EventTrigger,
    definitions: EventDefinition[],
    rawFilter: Record<string, unknown> | undefined
): EventSourceResolution {
    const parsed = GITHUB_FILTER.safeParse(rawFilter ?? {});
    if (!parsed.success) {
        const issue = parsed.error.issues[0];
        const where = issue.path.length > 0 ? `${issue.path.join('.')}: ` : '';
        return { ok: false, problem: `filter: ${where}${issue.message}` };
    }
    const passesFilter = githubMatcher(parsed.data);
    const { itemType } = definitions[0];
    const eventsOf = (item: InboxItemView) => trigger.events.filter((_, index) => definitions[index].inView(item));
    const keyOf = (item: InboxItemView) => item.key;
    return {
        ok: true,
        source: {
            ...GITHUB_ITEMS,
            connection: trigger.connection,
            events: trigger.events,
            describe: `When a ${ITEM_NOUN[itemType]} ${definitions.map((definition) => definition.phrase).join(' or ')}`,
            itemType,
            itemTypes: [itemType],
            inSet: (item) => definitions.some((definition) => definition.inView(item)),
            passesFilter,
            eventsOf,
            keyOf,
            describeItem: (item) => `${item.workItem.repo}#${item.workItem.number} “${item.title}” by @${item.author}`,
            toSourceItem: (item, passes) => ({
                key: keyOf(item),
                passes,
                title: item.title,
                url: item.url,
                author: item.author,
                workItem: item.workItem,
                inbox: item,
            }),
            goneReason: `${capitalise(definitions.map((definition) => definition.goneClause).join(', and '))}.`,
        },
    };
}

/**
 * GitHub's items on demand: a run on a work item a person (or an agent)
 * picked, whether or not it is in the Inbox. Its header, fence and fields are
 * an event run's, so the run behaves as an Inbox item's run does.
 */
function githubWorkItemSource(connection: string, types: Array<'pr' | 'issue'>): ItemSource {
    return {
        ...GITHUB_ITEMS,
        connection,
        itemTypes: [...types],
        describe: 'On demand',
        // A run on demand has no set to leave, so nothing ever says this; a source says it all the same.
        goneReason: 'It is no longer one of this automation’s items.',
    };
}

/** A connection's work items as a source of their own, for a run on a chosen one; null for a connection that does not exist. */
export function workItemSource(connection: string, types: Array<'pr' | 'issue'>): ItemSource | null {
    return own(CONNECTIONS, connection) ? CONNECTIONS[connection].workItemSource(connection, types) : null;
}

/**
 * The connection a run on demand takes its work items from when its entry
 * names none: the one connection there is. With a second, an entry's
 * `applies_to` would need to say whose items it means.
 */
export function soleWorkItemConnection(): string | undefined {
    const ids = Object.keys(CONNECTIONS);
    return ids.length === 1 ? ids[0] : undefined;
}

/** Every connection gives the first five as trusted; a title and an author are written by someone else. */
const GITHUB_ITEM_FIELDS: ItemFieldTable = {
    key: { type: { kind: 'string' }, trusted: true },
    url: { type: { kind: 'string' }, trusted: true },
    repo: { type: { kind: 'string' }, trusted: true },
    number: { type: { kind: 'number' }, trusted: true },
    type: { type: { kind: 'string', enum: { values: ['pr', 'issue'], owner: 'type of the item' } }, trusted: true },
    title: { type: { kind: 'string' }, trusted: false },
    author: { type: { kind: 'string' }, trusted: false },
};

const own = (object: object, key: string) => Object.prototype.hasOwnProperty.call(object, key);

function githubItemValue(item: RunItem, field: string): ExprValue | undefined {
    if (!own(GITHUB_ITEM_FIELDS, field) || !own(item, field)) return undefined;
    return (item as unknown as Record<string, ExprValue | undefined>)[field];
}

const githubNoun = (item: RunItem) => (item.type === 'pr' ? 'pull request' : 'issue');

function describeGitHubItem(item: RunItem): string {
    return `${githubNoun(item)} #${item.number} in ${item.repo} (${item.url})`;
}

function fenceGitHubItem(item: RunItem): string {
    return fenceUntrusted(
        { title: item.title, author: item.author ?? '' },
        `The title and author below, and the ${githubNoun(item)}’s description, comments and code,`
    );
}

/** Every GitHub item is a work item; one without would be the runner's mistake, never the file's. */
function workItemOf(item: SourceItem): ItemRef {
    if (!item.workItem) throw new Error(`A GitHub item names a work item; ${item.key} does not.`);
    return item.workItem;
}

/** An item as the run record keeps it. */
function githubRunItem(item: SourceItem): RunItem {
    const { repo, number, type } = workItemOf(item);
    return { key: item.key, url: item.url, title: item.title, repo, number, type, ...(item.author !== undefined ? { author: item.author } : {}) };
}

function githubLabel(item: SourceItem): string {
    const { repo, number } = workItemOf(item);
    return `${repo}#${number} “${item.title}”${item.author !== undefined ? ` by @${item.author}` : ''}`;
}

function renderGitHubPrompt(body: string, item: SourceItem, automation: string): string {
    const runItem = githubRunItem(item);
    const noun = githubNoun(runItem);
    const view = `Consola’s work_item_context tool, which returns the ${noun}’s description, comments${
        runItem.type === 'pr' ? ', files and diff' : ''
    }`;
    const header =
        `This session was started by the automation "${automation}" for ${describeGitHubItem(runItem)}, ` +
        `in a dedicated git worktree for it. ${READ_ONLY_NOTE} Start with ${view}. ${UNWATCHED_NOTE}`;
    // The title is the author's: the body points at it, the fence holds it.
    const job = fillActionPlaceholders(body, { workItem: workItemOf(item), title: 'the title quoted below', url: item.url }).trim();
    return `${header}\n\n${job}\n\n${fenceGitHubItem(runItem)}`;
}

/** GitHub's per-item pieces: what its event source and its work-item source share. */
const GITHUB_ITEMS = {
    itemsHaveRepo: true,
    label: githubLabel,
    runItem: githubRunItem,
    describeItemHeader: describeGitHubItem,
    fenceItem: fenceGitHubItem,
    itemFields: GITHUB_ITEM_FIELDS,
    itemValue: githubItemValue,
    renderPrompt: renderGitHubPrompt,
} satisfies Partial<ItemSource>;

/**
 * An automation's event trigger and filter, resolved — or the reason they
 * cannot be, naming every event that does not exist and the ones that do,
 * for the entry's `problem`.
 */
export function resolveEventSource(trigger: EventTrigger, filter?: Record<string, unknown>): EventSourceResolution {
    const connection = CONNECTIONS[trigger.connection];
    if (!connection) {
        return {
            ok: false,
            problem: `there is no connection named "${trigger.connection}" yet; the ones that exist are: ${Object.keys(CONNECTIONS).join(', ')}`,
        };
    }
    const unknown = trigger.events.filter((event) => !Object.prototype.hasOwnProperty.call(connection.events, event));
    if (unknown.length > 0) {
        const named = unknown.map((event) => `"${event}"`).join(' or ');
        return {
            ok: false,
            problem:
                `${trigger.connection} has no ${unknown.length === 1 ? 'event' : 'events'} ${named} Consola can see locally; ` +
                `the ones it has: ${Object.keys(connection.events).join(', ')}`,
        };
    }
    const params = Object.keys(trigger.params);
    if (params.length > 0) {
        const verb = trigger.events.length === 1 ? 'takes' : 'take';
        return {
            ok: false,
            problem: `${trigger.events.join(' and ')} ${verb} no parameters; remove ${params.map((key) => `\`${key}\``).join(', ')} from \`on\``,
        };
    }
    return connection.resolve(
        trigger,
        trigger.events.map((event) => connection.events[event]),
        filter
    );
}
