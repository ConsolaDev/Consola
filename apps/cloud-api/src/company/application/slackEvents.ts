import { isInstalled, readSlackEnvelope } from '../domain/slackEvents.js';
import type { InstalledSlackApp, SlackEventCallback } from '../domain/slackEvents.js';
import type { SignedSlackRequest, SlackSignatures } from './slackEventPorts.js';
import type { SecretSealer, SlackAppStore, SlackEventStore } from './slackPorts.js';
import type { Clock, FactoryStore } from './ports.js';

/*
 * Slack's events for a factory's app (CON-144, "Events in"). Slack sends each factory's events to
 * the factory's own address, signed with its app's signing secret. Each event is checked, recorded
 * once by its id and answered at once, since Slack wants an answer within three seconds; what it
 * asks for is handled after the answer.
 */

/** One request to a factory's events address, as it arrived. */
export type SlackEventRequest = SignedSlackRequest & {
  /** The factory the address names: anyone's words until the signature checks. */
  factoryId: string;
};

/** What becomes of one request, in the order it is checked. Ids only: never a body or a secret. */
export type SlackEventOutcome =
  /** No factory has the id the address names. */
  | { kind: 'unknown-factory' }
  /**
   * Slack's check of the URL, answered with its challenge: `checked` once the factory's app has a
   * signing secret, unchecked before, when answering it changes nothing.
   */
  | { kind: 'challenge'; factoryId: string; challenge: string; checked: boolean }
  /** The factory's app has no signing secret yet: only Slack's check of the URL is answered. */
  | { kind: 'not-set-up'; factoryId: string }
  /** Not Slack's signature, or too old. Nothing else was read. */
  | { kind: 'bad-signature'; factoryId: string; why: 'stale' | 'mismatch' }
  /** Signed, but not what Slack sends. `reason` names what. */
  | { kind: 'invalid'; factoryId: string; reason: string }
  /** Something Slack sends that Consola does not take (`app_rate_limited`, say). */
  | { kind: 'ignored'; factoryId: string; type: string }
  /** An event for an app not added to a Slack workspace yet. */
  | { kind: 'not-installed'; factoryId: string }
  /** An event that names another app or Slack workspace than the factory's. */
  | { kind: 'wrong-app'; factoryId: string; eventId: string }
  /** The factory had this event already: Slack sent it again. Nothing changed. */
  | { kind: 'duplicate'; factoryId: string; eventId: string; eventType: string }
  /** Recorded now, and handed on to be handled after the answer. */
  | { kind: 'accepted'; factoryId: string; eventId: string; eventType: string }
  /**
   * The database did not answer, or the factory's signing secret does not open with this
   * server's key. `reason` is what failed, never a query or a secret. Slack sends it again.
   */
  | { kind: 'unavailable'; factoryId: string | null; reason: string };

/** What receiving Slack's events needs. */
export type SlackEventPorts = {
  apps: Pick<SlackAppStore, 'ofFactory'>;
  factories: Pick<FactoryStore, 'workspaceOf'>;
  events: SlackEventStore;
  sealer: SecretSealer;
  signatures: SlackSignatures;
  clock: Clock;
  /** Runs `task` after the answer is sent: Slack wants one within three seconds. */
  later: (task: () => Promise<void>) => void;
  /** Handles an event once it is recorded, after the answer (`handleSlackEvent`). */
  handle: (app: InstalledSlackApp, callback: SlackEventCallback) => Promise<void>;
};

const UTF8 = new TextDecoder('utf-8', { fatal: true });

/** The body as JSON, or undefined when it is not. */
function parse(body: Uint8Array): unknown {
  try {
    return JSON.parse(UTF8.decode(body));
  } catch {
    return undefined;
  }
}

/** The innermost cause's first line: what failed, without the query that failed. */
export function whatFailed(error: unknown): string {
  let current = error;
  for (
    let depth = 0;
    current instanceof Error && current.cause !== undefined && depth < 5;
    depth++
  ) {
    current = current.cause;
  }
  const line = current instanceof Error ? current.message.split('\n')[0]?.trim() : undefined;
  return line || 'an unexpected error';
}

/**
 * Receives one request to a factory's events address, in this order:
 *
 * 1. the factory exists, and its Slack app with it;
 * 2. with no app, so no signing secret stored yet, only Slack's check of the URL
 *    (`url_verification`) is answered, unchecked: echoing its challenge changes nothing;
 * 3. the signature, under the app's signing secret, before anything else is read;
 * 4. the body, as Slack writes one;
 * 5. Slack's check of the URL, answered;
 * 6. an event (`event_callback`) must name the app and the Slack workspace it was added to;
 * 7. it is recorded once by its `event_id`, so one Slack sends again changes nothing;
 * 8. it is accepted at once, and handled after the answer (`later`).
 *
 * A database that does not answer, or a secret this server cannot open, is `unavailable`, never
 * thrown: Slack sends the event again.
 */
export async function receiveSlackEvent(
  ports: SlackEventPorts,
  sent: SlackEventRequest,
): Promise<SlackEventOutcome> {
  let app: Awaited<ReturnType<SlackAppStore['ofFactory']>>;
  let workspaceId: string | null = null;
  try {
    app = await ports.apps.ofFactory(sent.factoryId);
    if (app === null) workspaceId = await ports.factories.workspaceOf(sent.factoryId);
  } catch (error) {
    return { kind: 'unavailable', factoryId: null, reason: whatFailed(error) };
  }
  if (app === null && workspaceId === null) return { kind: 'unknown-factory' };
  const { factoryId } = sent;

  if (app === null) {
    const read = readSlackEnvelope(parse(sent.body));
    if (read.ok && read.envelope.kind === 'url_verification') {
      return { kind: 'challenge', factoryId, challenge: read.envelope.challenge, checked: false };
    }
    return { kind: 'not-set-up', factoryId };
  }

  const secret = ports.sealer.open(app.sealed.signingSecret);
  if (secret === null) {
    return {
      kind: 'unavailable',
      factoryId,
      reason: "its signing secret does not open with this server's CONNECTION_SECRETS_KEY",
    };
  }
  const now = ports.clock.nowSeconds();
  const check = ports.signatures.verify(secret, sent, now);
  if (check !== 'valid') return { kind: 'bad-signature', factoryId, why: check };

  const read = readSlackEnvelope(parse(sent.body));
  if (!read.ok) return { kind: 'invalid', factoryId, reason: read.reason };
  const { envelope } = read;
  if (envelope.kind === 'url_verification') {
    return { kind: 'challenge', factoryId, challenge: envelope.challenge, checked: true };
  }
  if (envelope.kind === 'other') return { kind: 'ignored', factoryId, type: envelope.type };

  const { callback } = envelope;
  if (!isInstalled(app)) return { kind: 'not-installed', factoryId };
  if (callback.apiAppId !== app.install.appId || callback.teamId !== app.install.teamId) {
    return { kind: 'wrong-app', factoryId, eventId: callback.eventId };
  }

  let recorded: Awaited<ReturnType<SlackEventStore['record']>>;
  try {
    recorded = await ports.events.record({
      workspaceId: app.workspaceId,
      factoryId,
      eventId: callback.eventId,
      at: new Date(now * 1000),
    });
  } catch (error) {
    return { kind: 'unavailable', factoryId, reason: whatFailed(error) };
  }
  const named = { factoryId, eventId: callback.eventId, eventType: callback.eventType };
  if (recorded === 'recorded-before') return { kind: 'duplicate', ...named };

  const installed = app;
  ports.later(() => ports.handle(installed, callback));
  return { kind: 'accepted', ...named };
}
