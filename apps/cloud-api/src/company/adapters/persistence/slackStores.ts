import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import type {
  LinkConfirmation,
  SlackAppStore,
  SlackEventStore,
  SlackLinkStore,
  SlackRequestStore,
} from '../../application/slackPorts.js';
import { linkRequestState } from '../../domain/slack.js';
import type {
  SlackLinkRequest,
  SlackPersonLink,
  SlackRequestThread,
  StoredSlackApp,
} from '../../domain/slack.js';
import type { Database } from './database.js';
import {
  slackApps,
  slackEvents,
  slackLinkRequests,
  slackPersonLinks,
  slackRequests,
} from './slackTables.js';
import { FOREIGN_KEY_VIOLATION, failedWith, UNIQUE_VIOLATION } from './sqlState.js';

type AppRow = typeof slackApps.$inferSelect;
type LinkRow = typeof slackPersonLinks.$inferSelect;
type RequestRow = typeof slackLinkRequests.$inferSelect;
type ThreadRow = typeof slackRequests.$inferSelect;

/** A row of `slack_app` as the domain holds it. The check constraint keeps the install whole. */
function appOf(row: AppRow): StoredSlackApp {
  const { appId, teamId, teamName, botUserId, installedBy, installedAt, botToken } = row;
  const installed =
    appId !== null &&
    teamId !== null &&
    teamName !== null &&
    botUserId !== null &&
    installedBy !== null &&
    installedAt !== null &&
    botToken !== null;
  return {
    workspaceId: row.workspaceId,
    factoryId: row.factoryId,
    clientId: row.clientId,
    handle: row.handle,
    configuredBy: row.configuredBy,
    configuredAt: row.configuredAt,
    install: installed ? { appId, teamId, teamName, botUserId, installedBy, installedAt } : null,
    needsReinstall: installed && row.needsReinstall,
    sealed: {
      clientSecret: row.clientSecret,
      signingSecret: row.signingSecret,
      botToken: installed ? botToken : null,
    },
  };
}

const linkOf = (row: LinkRow): SlackPersonLink => ({
  id: row.linkId,
  workspaceId: row.workspaceId,
  slackTeamId: row.slackTeamId,
  slackUserId: row.slackUserId,
  personId: row.personId,
  linkedAt: row.linkedAt,
});

const requestOf = (row: RequestRow): SlackLinkRequest => ({ ...row });

const threadOf = (row: ThreadRow): SlackRequestThread => ({ ...row });

/** The factory's app in the workspace. */
const theApp = (workspaceId: string, factoryId: string) =>
  and(eq(slackApps.workspaceId, workspaceId), eq(slackApps.factoryId, factoryId));

/**
 * Each factory's Slack app in `slack_app`. Saving credentials is one upsert: the install's
 * columns stay only while the client ID is the one already there, and a row of another workspace
 * is never changed. An install is a compare-and-set on the client ID it was made with.
 */
export function createSlackAppStore(db: Database): SlackAppStore {
  const one = async (where: ReturnType<typeof theApp>) => {
    const [row] = await db.select().from(slackApps).where(where).limit(1);
    return row ? appOf(row) : null;
  };

  return {
    get: (workspaceId, factoryId) => one(theApp(workspaceId, factoryId)),

    ofFactory: (factoryId) => one(eq(slackApps.factoryId, factoryId)),

    async ofWorkspace(workspaceId) {
      const rows = await db
        .select()
        .from(slackApps)
        .where(eq(slackApps.workspaceId, workspaceId))
        .orderBy(asc(slackApps.configuredAt), asc(slackApps.factoryId));
      return rows.map(appOf);
    },

    async saveCredentials(entry) {
      // The install stays only for the same app: another client ID is another app.
      const same = sql`${slackApps.clientId} = excluded.client_id`;
      const kept = <T>(column: T) => sql`case when ${same} then ${column} else null end`;
      try {
        const saved = await db
          .insert(slackApps)
          .values({
            workspaceId: entry.workspaceId,
            factoryId: entry.factoryId,
            clientId: entry.clientId,
            clientSecret: entry.clientSecret,
            signingSecret: entry.signingSecret,
            handle: entry.handle,
            configuredBy: entry.configuredBy,
            configuredAt: entry.at,
          })
          .onConflictDoUpdate({
            target: slackApps.factoryId,
            set: {
              clientId: sql`excluded.client_id`,
              clientSecret: sql`excluded.client_secret`,
              signingSecret: sql`excluded.signing_secret`,
              // An installed app keeps the handle Slack gave its bot.
              handle: sql`case when ${same} and ${slackApps.appId} is not null then ${slackApps.handle} else excluded.handle end`,
              configuredBy: sql`excluded.configured_by`,
              configuredAt: sql`excluded.configured_at`,
              appId: kept(slackApps.appId),
              teamId: kept(slackApps.teamId),
              teamName: kept(slackApps.teamName),
              botUserId: kept(slackApps.botUserId),
              botToken: kept(slackApps.botToken),
              installedBy: kept(slackApps.installedBy),
              installedAt: kept(slackApps.installedAt),
              needsReinstall: sql`${same} and ${slackApps.needsReinstall}`,
            },
            setWhere: eq(slackApps.workspaceId, entry.workspaceId),
          })
          .returning({ factoryId: slackApps.factoryId });
        return saved.length > 0 ? 'saved' : 'not-found';
      } catch (error) {
        // No such factory in the workspace.
        if (failedWith(error, FOREIGN_KEY_VIOLATION)) return 'not-found';
        throw error;
      }
    },

    async install(entry) {
      const { install } = entry;
      try {
        const updated = await db
          .update(slackApps)
          .set({
            appId: install.appId,
            teamId: install.teamId,
            teamName: install.teamName,
            botUserId: install.botUserId,
            botToken: entry.botToken,
            installedBy: install.installedBy,
            installedAt: install.installedAt,
            handle: entry.handle,
            needsReinstall: false,
          })
          .where(
            and(theApp(entry.workspaceId, entry.factoryId), eq(slackApps.clientId, entry.clientId)),
          )
          .returning({ factoryId: slackApps.factoryId });
        if (updated.length > 0) return 'installed';
      } catch (error) {
        if (failedWith(error, UNIQUE_VIOLATION)) return 'app-taken';
        throw error;
      }
      const held = await one(theApp(entry.workspaceId, entry.factoryId));
      return held ? 'credentials-changed' : 'not-found';
    },

    async markNeedsReinstall(ids) {
      const marked = await db
        .update(slackApps)
        .set({ needsReinstall: true })
        .where(and(theApp(ids.workspaceId, ids.factoryId), eq(slackApps.appId, ids.appId)))
        .returning({ factoryId: slackApps.factoryId });
      return marked.length > 0;
    },

    forget(workspaceId, factoryId) {
      return db.transaction(async (tx) => {
        const [row] = await tx.delete(slackApps).where(theApp(workspaceId, factoryId)).returning();
        if (!row) return null;
        await tx
          .delete(slackEvents)
          .where(
            and(eq(slackEvents.workspaceId, workspaceId), eq(slackEvents.factoryId, factoryId)),
          );
        await tx
          .delete(slackLinkRequests)
          .where(
            and(
              eq(slackLinkRequests.workspaceId, workspaceId),
              eq(slackLinkRequests.factoryId, factoryId),
            ),
          );
        await tx
          .delete(slackRequests)
          .where(
            and(eq(slackRequests.workspaceId, workspaceId), eq(slackRequests.factoryId, factoryId)),
          );
        return appOf(row);
      });
    },
  };
}

/**
 * The Slack accounts people linked (`slack_person_link`) and the one-time links sent to link
 * them (`slack_link_request`). Confirming holds the link's row (`for update`) while it links, so
 * a link is used once, even by two confirmations at the same moment.
 */
export function createSlackLinkStore(db: Database): SlackLinkStore {
  return {
    async createRequest(request) {
      await db.insert(slackLinkRequests).values({ ...request });
    },

    async findRequest(tokenHash) {
      const [row] = await db
        .select()
        .from(slackLinkRequests)
        .where(eq(slackLinkRequests.tokenHash, tokenHash))
        .limit(1);
      return row ? requestOf(row) : null;
    },

    confirm({ tokenHash, personId, at }) {
      return db.transaction(async (tx): Promise<LinkConfirmation> => {
        const [request] = await tx
          .select()
          .from(slackLinkRequests)
          .where(eq(slackLinkRequests.tokenHash, tokenHash))
          .for('update');
        if (!request) return { kind: 'not-found' };
        const state = linkRequestState(request, at);
        if (state !== 'open') return { kind: state };

        const user = and(
          eq(slackPersonLinks.workspaceId, request.workspaceId),
          eq(slackPersonLinks.slackTeamId, request.slackTeamId),
          eq(slackPersonLinks.slackUserId, request.slackUserId),
        );
        const [made] = await tx
          .insert(slackPersonLinks)
          .values({
            workspaceId: request.workspaceId,
            slackTeamId: request.slackTeamId,
            slackUserId: request.slackUserId,
            personId,
            linkedAt: at,
          })
          .onConflictDoNothing({
            target: [
              slackPersonLinks.workspaceId,
              slackPersonLinks.slackTeamId,
              slackPersonLinks.slackUserId,
            ],
          })
          .returning();
        let answer: LinkConfirmation;
        if (made) {
          answer = { kind: 'linked', link: linkOf(made) };
        } else {
          const [held] = await tx.select().from(slackPersonLinks).where(user).limit(1);
          if (!held || held.personId !== personId) return { kind: 'linked-to-another' };
          answer = { kind: 'already-linked', link: linkOf(held) };
        }
        await tx
          .update(slackLinkRequests)
          .set({ usedAt: at })
          .where(and(eq(slackLinkRequests.tokenHash, tokenHash), isNull(slackLinkRequests.usedAt)));
        return answer;
      });
    },

    async personOf(ids) {
      const [row] = await db
        .select({ personId: slackPersonLinks.personId })
        .from(slackPersonLinks)
        .where(
          and(
            eq(slackPersonLinks.workspaceId, ids.workspaceId),
            eq(slackPersonLinks.slackTeamId, ids.slackTeamId),
            eq(slackPersonLinks.slackUserId, ids.slackUserId),
          ),
        )
        .limit(1);
      return row?.personId ?? null;
    },

    async linksOf(workspaceId, personId) {
      const rows = await db
        .select()
        .from(slackPersonLinks)
        .where(
          and(
            eq(slackPersonLinks.workspaceId, workspaceId),
            eq(slackPersonLinks.personId, personId),
          ),
        )
        .orderBy(asc(slackPersonLinks.linkedAt), asc(slackPersonLinks.linkId));
      return rows.map(linkOf);
    },

    async unlink(ids) {
      const removed = await db
        .delete(slackPersonLinks)
        .where(
          and(
            eq(slackPersonLinks.linkId, ids.linkId),
            eq(slackPersonLinks.workspaceId, ids.workspaceId),
            eq(slackPersonLinks.personId, ids.personId),
          ),
        )
        .returning({ linkId: slackPersonLinks.linkId });
      return removed.length > 0;
    },
  };
}

/** Slack's events in `slack_event`, recorded once per factory and `event_id` (on conflict, nothing). */
export function createSlackEventStore(db: Database): SlackEventStore {
  return {
    async record(event) {
      const inserted = await db
        .insert(slackEvents)
        .values({
          workspaceId: event.workspaceId,
          factoryId: event.factoryId,
          eventId: event.eventId,
          receivedAt: event.at,
        })
        .onConflictDoNothing({ target: [slackEvents.factoryId, slackEvents.eventId] })
        .returning({ eventId: slackEvents.eventId });
      return inserted.length > 0 ? 'recorded' : 'recorded-before';
    },
  };
}

/** The threads requests were started from, in `slack_request`, one per cloud session. */
export function createSlackRequestStore(db: Database): SlackRequestStore {
  return {
    async record(thread) {
      await db.insert(slackRequests).values({ ...thread });
    },

    async ofSession(sessionId) {
      const [row] = await db
        .select()
        .from(slackRequests)
        .where(eq(slackRequests.sessionId, sessionId))
        .limit(1);
      return row ? threadOf(row) : null;
    },

    async inThread(ids) {
      const rows = await db
        .select()
        .from(slackRequests)
        .where(
          and(
            eq(slackRequests.factoryId, ids.factoryId),
            eq(slackRequests.channelId, ids.channelId),
            eq(slackRequests.threadTs, ids.threadTs),
          ),
        )
        .orderBy(asc(slackRequests.createdAt), asc(slackRequests.sessionId));
      return rows.map(threadOf);
    },

    async markPosted(sessionId, expected, posted) {
      const moved = await db
        .update(slackRequests)
        .set({ posted })
        .where(
          and(
            eq(slackRequests.sessionId, sessionId),
            expected === null ? isNull(slackRequests.posted) : eq(slackRequests.posted, expected),
          ),
        )
        .returning({ sessionId: slackRequests.sessionId });
      return moved.length > 0;
    },
  };
}

/** Slack's stores, on one Drizzle database. */
export function createSlackStores(db: Database): {
  apps: SlackAppStore;
  links: SlackLinkStore;
  events: SlackEventStore;
  requests: SlackRequestStore;
} {
  return {
    apps: createSlackAppStore(db),
    links: createSlackLinkStore(db),
    events: createSlackEventStore(db),
    requests: createSlackRequestStore(db),
  };
}
