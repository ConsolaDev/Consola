import { GITHUB_PAYLOAD_MAX_BYTES } from '@consola/cloud-contract';
import type { OpenAPIHono } from '@hono/zod-openapi';
import { bodyLimit } from 'hono/body-limit';
import type {
  CellEvents,
  GitHubEventSigner,
  InstallationStore,
  WebhookSignatures,
} from '../../application/ports.js';
import { receiveGitHubWebhook, type WebhookOutcome } from '../../application/webhooks.js';
import { cellUrlVariable } from '../../config.js';
import { postGitHubWebhook } from './contract.js';

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
  const toCell =
    'passing' in outcome
      ? `workspace ${outcome.passing.workspaceId}'s cell (${outcome.passing.region})`
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
    case 'no-cell':
      return {
        level: 'warn',
        line: `Could not pass ${named} on to ${toCell}: ${cellUrlVariable(outcome.passing.region)} is not set.`,
      };
    case 'failed':
      return {
        level: 'warn',
        line: `Could not pass ${named} on to ${toCell}: ${outcome.error}.`,
      };
    case 'duplicate':
      return { level: 'info', line: `Refused ${named}: ${toCell} had it already.` };
    case 'delivered':
      return { level: 'info', line: `Passed ${named} on to ${toCell}.` };
  }
}

/**
 * `POST GITHUB_WEBHOOK_PATH` (`postGitHubWebhook` in the contract): the GitHub App's webhook URL.
 * GitHub calls it, with no session and no Origin header, so `createApp` registers it before the
 * origin check: its signature is what says the request is GitHub's, and a cookie plays no part.
 * The body is read as bytes, after a size check that refuses anything over GitHub's own cap
 * without reading it (413), and `receiveGitHubWebhook` checks the signature over those bytes
 * before anything else. Each outcome is logged in one line, and answered with its status.
 */
export function webhookRoutes(
  app: OpenAPIHono,
  deps: {
    /** Null when no webhook secret is set: every delivery is refused. */
    signatures: WebhookSignatures | null;
    installations: InstallationStore;
    signer: GitHubEventSigner;
    cells: CellEvents;
    log: WebhookLog;
  },
): void {
  const { signatures, installations, signer, cells, log } = deps;

  const size = bodyLimit({
    maxSize: GITHUB_PAYLOAD_MAX_BYTES,
    onError: (c) => {
      log.warn(`Refused a webhook delivery: its body is over ${GITHUB_PAYLOAD_MAX_BYTES} bytes.`);
      return c.json({ error: 'too_large' }, 413);
    },
  });

  app.openapi({ ...postGitHubWebhook, middleware: [size] as const }, async (c) => {
    const outcome = await receiveGitHubWebhook(
      { signatures, installations, signer, cells },
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
      case 'delivered':
        return c.json({ result: 'delivered' } as const, 200);
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
      case 'failed':
        return c.json({ error: 'cell_unavailable' } as const, 502);
      case 'not-configured':
        return c.json({ error: 'webhooks_not_configured' } as const, 503);
      case 'no-cell':
        return c.json({ error: 'cell_not_configured' } as const, 503);
    }
  });
}
