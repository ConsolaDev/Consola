import type { OpenAPIHono } from '@hono/zod-openapi';
import { bodyLimit } from 'hono/body-limit';
import type {
  GitHubApp,
  GitHubEventStore,
  InstallationStore,
  WebhookSignatures,
} from '../../application/gitHubPorts.js';
import type { AgentRunPorts } from '../../application/ports.js';
import { receiveGitHubWebhook } from '../../application/webhooks.js';
import type { WebhookOutcome } from '../../application/webhooks.js';
import { GITHUB_PAYLOAD_MAX_BYTES } from '../../domain/webhooks.js';
import { postGitHubWebhook } from './gitHubContract.js';

/** Where the webhook route logs: ids, names and statuses, never a body, a signature or a key. */
export type WebhookLog = Pick<Console, 'info' | 'warn'>;

/**
 * The line logged for an outcome, and how loud. A delivery's id and event name are logged only
 * once its signature has checked: before that they are anyone's words.
 */
export function webhookLine(outcome: WebhookOutcome): { level: 'info' | 'warn'; line: string } {
  const named =
    'delivery' in outcome
      ? `GitHub delivery ${outcome.delivery.deliveryId} (${outcome.delivery.event})`
      : '';
  const forWorkspace =
    'holding' in outcome
      ? `workspace ${outcome.holding.workspaceId} (installation ${outcome.holding.installationId})`
      : '';
  switch (outcome.kind) {
    case 'not-configured':
      return {
        level: 'warn',
        line: 'Refused a webhook delivery: GITHUB_WEBHOOK_SECRET is not set.',
      };
    case 'bad-signature':
      return {
        level: 'warn',
        line: "Refused a webhook delivery: it is not signed with the GitHub App's webhook secret.",
      };
    case 'invalid':
      return { level: 'warn', line: `Refused a signed GitHub delivery: ${outcome.reason}.` };
    case 'ping':
      return { level: 'info', line: `Answered ${named}.` };
    case 'no-installation':
      return { level: 'info', line: `Dropped ${named}: it came through no installation.` };
    case 'unknown-installation':
      return {
        level: 'warn',
        line: `Dropped ${named}: no workspace holds installation ${outcome.installationId}.`,
      };
    case 'unavailable':
      return {
        level: 'warn',
        line: `Could not record ${named}: the database did not answer (${outcome.reason}).`,
      };
    case 'duplicate':
      return { level: 'info', line: `Refused ${named}: ${forWorkspace} had it already.` };
    case 'recorded':
      return { level: 'info', line: `Recorded ${named} for ${forWorkspace}.` };
  }
}

/** What the webhook route needs. */
export type WebhookRouteDeps = {
  /** Null when no webhook secret is set: every delivery is refused. */
  signatures: WebhookSignatures | null;
  installations: InstallationStore;
  events: GitHubEventStore;
  /** What starting an event's agent runs needs; left out, an event starts none. */
  agentRuns?: AgentRunPorts;
  /** The GitHub App, which forgets an installation GitHub says changed; null when not configured. */
  github?: Pick<GitHubApp, 'forgetInstallation'> | null;
  log: WebhookLog;
};

/**
 * `POST GITHUB_WEBHOOK_PATH` (`postGitHubWebhook` in the contract): the GitHub App's webhook URL.
 * GitHub calls it, with no session and no Origin header, so the composition exempts it from the
 * origin check: its signature is what says the request is GitHub's, and a cookie plays no part.
 * The body is read as bytes, after a size check that refuses anything over GitHub's own cap
 * without reading it (413), and `receiveGitHubWebhook` checks the signature over those bytes
 * before anything else. Each outcome is logged in one line, and answered with its status.
 */
export function webhookRoutes(app: OpenAPIHono, deps: WebhookRouteDeps): void {
  const { signatures, installations, events, agentRuns, github, log } = deps;

  const size = bodyLimit({
    maxSize: GITHUB_PAYLOAD_MAX_BYTES,
    onError: (c) => {
      log.warn(`Refused a webhook delivery: its body is over ${GITHUB_PAYLOAD_MAX_BYTES} bytes.`);
      return c.json({ error: 'too_large' }, 413);
    },
  });

  app.openapi({ ...postGitHubWebhook, middleware: [size] as const }, async (c) => {
    const outcome = await receiveGitHubWebhook(
      { signatures, installations, events, agentRuns, github },
      {
        body: new Uint8Array(await c.req.arrayBuffer()),
        signature: c.req.header('x-hub-signature-256'),
        event: c.req.header('x-github-event'),
        deliveryId: c.req.header('x-github-delivery'),
      },
    );
    const { level, line } = webhookLine(outcome);
    log[level](line);

    switch (outcome.kind) {
      case 'recorded':
        return c.json({ result: 'recorded' } as const, 201);
      case 'ping':
        return c.json({ result: 'pong' } as const, 200);
      case 'invalid':
        return c.json({ error: 'invalid_delivery' } as const, 400);
      case 'bad-signature':
        return c.json({ error: 'bad_signature' } as const, 401);
      case 'duplicate':
        return c.json({ error: 'duplicate_delivery' } as const, 409);
      case 'unknown-installation':
        return c.json({ error: 'unknown_installation' } as const, 422);
      case 'no-installation':
        return c.json({ error: 'no_installation' } as const, 422);
      case 'not-configured':
        return c.json({ error: 'webhooks_not_configured' } as const, 503);
      case 'unavailable':
        return c.json({ error: 'unavailable' } as const, 503);
    }
  });
}
