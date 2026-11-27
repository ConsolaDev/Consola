import type { SlackPosted } from '../domain/slack.js';
import { isInstalled } from '../domain/slackEvents.js';
import { runPageUrl, shouldPost, slackAnswerFor, slackStateOf } from '../domain/slackRequests.js';
import type { CloudSessionStore } from './ports.js';
import { botOf } from './slackBot.js';
import type { BotPorts } from './slackBot.js';
import { whatFailed } from './slackEvents.js';
import type { SlackAppStore, SlackRequestStore } from './slackPorts.js';

/*
 * Answering in the thread (CON-144). Consola, not the orchestrator, posts in a request's Slack
 * thread, and no Slack token or tool goes into the sandbox in release 1. As the request's session
 * moves, Consola says so in the thread once per state: the first time the run waits on a person,
 * when it finished, and when it stopped.
 */

/** What answering in a request's thread needs. */
export type SlackAnswerPorts = BotPorts & {
  apps: Pick<SlackAppStore, 'get' | 'markNeedsReinstall'>;
  requests: SlackRequestStore;
  /** The web app's address (`PUBLIC_URL`): where the run's page is. */
  publicUrl: string;
  /** Runs `task` once the change that called for it is done, so no writer of a session waits on Slack. */
  later: (task: () => Promise<void>) => void;
};

/**
 * Says in a request's Slack thread where its run stands now, if that is something to say and has
 * not been said (`slackStateOf`, `shouldPost`). What was said is moved first, by a compare-and-set
 * (`markPosted`), so each state is posted once, however many changes call for it at once: a post
 * that then fails is logged, and not tried again. A session with no Slack thread says nothing. A
 * Slack failure never changes the session or its run: the bot logs it with ids, and a dead token
 * marks the factory's app as needing adding to Slack again. Answers what was said, or null.
 */
export async function answerInThread(
  sessions: Pick<CloudSessionStore, 'find'>,
  ports: SlackAnswerPorts,
  sessionId: string,
): Promise<SlackPosted | null> {
  try {
    const thread = await ports.requests.ofSession(sessionId);
    if (thread === null) return null;
    const session = await sessions.find(sessionId);
    if (session === null) return null;
    const state = slackStateOf(session);
    if (state === null || !shouldPost(thread.posted, state)) return null;
    if (!(await ports.requests.markPosted(sessionId, thread.posted, state))) return null;

    const app = await ports.apps.get(thread.workspaceId, thread.factoryId);
    if (app === null || !isInstalled(app)) {
      ports.report(
        `Could not say in Slack that run ${sessionId} is ${state}: factory ${thread.factoryId} has no app in Slack now.`,
      );
      return null;
    }
    const bot = botOf(ports, app);
    if (bot === null) return null;
    const answer = slackAnswerFor(state, session, runPageUrl(ports.publicUrl, sessionId));
    const posted = await bot.post({
      channel: thread.channelId,
      threadTs: thread.threadTs,
      text: answer.text,
      ...(answer.blocks === undefined ? {} : { blocks: [...answer.blocks] }),
    });
    if (!posted) return null;
    ports.report(`Said in Slack that run ${sessionId} is ${state}.`);
    return state;
  } catch (error) {
    ports.report(`Could not answer in Slack for run ${sessionId}: ${whatFailed(error)}.`);
    return null;
  }
}

/**
 * The cloud session store, with each request from Slack answered in its thread: after every change
 * that lands (`update`'s compare-and-set won), `answerInThread` runs once the change is done
 * (`later`), so a runner's update, a person's stop or a start that failed never waits on Slack.
 * It sits beside `keepingRunsInStep`, and every writer of a session goes through both.
 */
export function answeringInSlack(
  sessions: CloudSessionStore,
  ports: SlackAnswerPorts,
): CloudSessionStore {
  return {
    ...sessions,
    async update(sessionId, expected, changes) {
      const won = await sessions.update(sessionId, expected, changes);
      if (won) {
        ports.later(async () => {
          await answerInThread(sessions, ports, sessionId);
        });
      }
      return won;
    },
  };
}
