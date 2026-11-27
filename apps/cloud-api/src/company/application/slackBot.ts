import { isDeadTokenError } from '../domain/slack.js';
import type { InstalledSlackApp } from '../domain/slackEvents.js';
import type {
  SecretSealer,
  SlackAnswer,
  SlackApi,
  SlackAppStore,
  SlackBlock,
} from './slackPorts.js';

/*
 * A factory's bot, speaking in Slack with its own token. Every call is best effort: one Slack
 * refuses or does not answer is logged with ids, and never changes a session or a run. A token
 * Slack says is dead marks the factory's app as needing to be added to Slack again.
 */

/** What speaking as a factory's bot needs. */
export type BotPorts = {
  slack: SlackApi;
  apps: Pick<SlackAppStore, 'markNeedsReinstall'>;
  sealer: SecretSealer;
  /** Hears each call that failed, one line of ids and Slack's code, never a token or a text. */
  report: (line: string) => void;
};

/** A factory's bot, with its token opened. Each call answers what Slack said, or null. */
export type Bot = {
  /** Posts what everyone in the channel sees, in a thread when one is named. */
  post(message: {
    channel: string;
    threadTs?: string;
    text: string;
    blocks?: SlackBlock[];
  }): Promise<boolean>;
  /** Posts what only `user` sees (`chat.postEphemeral`), in a thread when one is named. */
  whisper(message: {
    channel: string;
    user: string;
    threadTs?: string;
    text: string;
  }): Promise<boolean>;
  /** Reacts to a message with the emoji `name` (`eyes`). */
  react(message: { channel: string; ts: string; name: string }): Promise<boolean>;
  /** A message's permalink. */
  permalink(message: { channel: string; ts: string }): Promise<string | null>;
};

/**
 * The factory's bot, or null when it cannot speak: its app needs adding to Slack again, or its
 * token does not open with this server's key. Either is logged.
 */
export function botOf(ports: BotPorts, app: InstalledSlackApp): Bot | null {
  const about = `factory ${app.factoryId}`;
  if (app.needsReinstall) {
    ports.report(`The bot of ${about} cannot speak: its app needs adding to Slack again.`);
    return null;
  }
  const token = app.sealed.botToken === null ? null : ports.sealer.open(app.sealed.botToken);
  if (token === null) {
    ports.report(
      `The bot of ${about} cannot speak: its token does not open with this server's CONNECTION_SECRETS_KEY.`,
    );
    return null;
  }

  async function said<T>(method: string, call: () => Promise<SlackAnswer<T>>): Promise<T | null> {
    let answer: SlackAnswer<T>;
    try {
      answer = await call();
    } catch {
      answer = { ok: false, error: { kind: 'unavailable', reason: 'the call threw' } };
    }
    if (answer.ok) return answer.value;
    const { error } = answer;
    if (error.kind === 'unavailable') {
      ports.report(`Slack did not answer ${method} for ${about}: ${error.reason}.`);
      return null;
    }
    if (!isDeadTokenError(error.code)) {
      ports.report(`Slack refused ${method} for ${about}: ${error.code}.`);
      return null;
    }
    ports.report(
      `Slack refused the bot token of ${about} on ${method} (${error.code}): its app needs adding to Slack again.`,
    );
    try {
      await ports.apps.markNeedsReinstall({
        workspaceId: app.workspaceId,
        factoryId: app.factoryId,
        appId: app.install.appId,
      });
    } catch {
      ports.report(`The app of ${about} could not be marked as needing adding to Slack again.`);
    }
    return null;
  }

  return {
    async post(message) {
      const posted = await said('chat.postMessage', () => ports.slack.postMessage(token, message));
      return posted !== null;
    },
    async whisper(message) {
      const posted = await said('chat.postEphemeral', () =>
        ports.slack.postEphemeral(token, message),
      );
      return posted !== null;
    },
    async react({ channel, ts, name }) {
      const reacted = await said('reactions.add', async (): Promise<SlackAnswer<true>> => {
        const answer = await ports.slack.addReaction(token, { channel, timestamp: ts, name });
        if (answer.ok) return { ok: true, value: true };
        // Reacting twice is no failure: the reaction is there.
        const { error } = answer;
        return error.kind === 'refused' && error.code === 'already_reacted'
          ? { ok: true, value: true }
          : answer;
      });
      return reacted !== null;
    },
    async permalink({ channel, ts }) {
      const found = await said('chat.getPermalink', () =>
        ports.slack.getPermalink(token, { channel, messageTs: ts }),
      );
      return found?.permalink ?? null;
    },
  };
}
