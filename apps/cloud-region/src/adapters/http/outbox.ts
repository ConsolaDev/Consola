import {
  OUTBOX_ANSWER,
  OUTBOX_DELIVERY_MEDIA_TYPE,
  type OutboxMessage,
  type OutOfOrderAnswer,
} from '@consola/cloud-contract';
import { OpenAPIHono } from '@hono/zod-openapi';
import type { Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { createMiddleware } from 'hono/factory';
import type { DeliveryVerifier, WorkspaceCopies } from '../../application/ports.js';
import { type DeliveryAnswer, receiveDelivery } from '../../application/receiveDelivery.js';
import type { Region } from '../../domain/region.js';
import { postOutboxDelivery } from './contract.js';

/**
 * The most a delivery's body may hold. A message is ids, a role and a sequence, so its JWS is well
 * under a kilobyte; anything near this is no message, and is refused before it is read.
 */
export const MAX_DELIVERY_BYTES = 16 * 1024;

/** Whether a `Content-Type` names `OUTBOX_DELIVERY_MEDIA_TYPE`, whatever its parameters. */
export function isDeliveryMediaType(header: string | undefined): boolean {
  const type = header?.split(';')[0]?.trim().toLowerCase();
  return type === OUTBOX_DELIVERY_MEDIA_TYPE;
}

const about = (message: OutboxMessage) =>
  `outbox message ${message.sequence} of workspace ${message.workspaceId}`;

/** The line the cell logs for an answer, or null for one that needs none. Never the body. */
function lineFor(answer: DeliveryAnswer, region: Region): string | null {
  switch (answer.kind) {
    case 'applied':
    case 'keys-unavailable': // The verifier has said why.
      return null;
    case 'unsigned':
      return `The cell refused an outbox delivery: it is not signed by cloud-global (${answer.reason}).`;
    case 'unreadable':
      return `The cell refused an outbox delivery: its message does not read (${answer.reason}).`;
    case 'other-region':
      return `The cell refused ${about(answer.message)}: the workspace is in ${answer.message.region}, and this cell serves ${region}.`;
    case 'out-of-order':
      return `The cell refused ${about(answer.message)}: it applies ${answer.nextSequence} next.`;
    case 'database-unavailable':
      return `The cell could not apply ${about(answer.message)}: ${answer.reason}`;
  }
}

/**
 * `POST OUTBOX_DELIVERY_PATH` (`postOutboxDelivery` in the contract), where `cloud-global`'s
 * outbox delivers one message a request. It takes no cell token: a delivery is no person's
 * request, and its signature, checked with the cell token's key, is what says it is
 * `cloud-global`'s. So `createApp` mounts it before `requireCaller`, and only this method and
 * path: any other request to the path still needs a token.
 *
 * Before the use case checks the signature, the message, its region and its sequence, the route
 * refuses a body not sent as `OUTBOX_DELIVERY_MEDIA_TYPE` and one over `MAX_DELIVERY_BYTES`, each
 * as unreadable, without reading it. The contract declares the body as that media type, which the
 * contract's library neither checks nor gates, so these checks are the route's own. Every refusal
 * is logged through `report`, one line, never the body.
 */
export function outboxRoutes(deps: {
  region: Region;
  deliveries: DeliveryVerifier;
  workspaceCopies: WorkspaceCopies;
  report: (line: string) => void;
}): OpenAPIHono {
  const { region, deliveries, workspaceCopies, report } = deps;
  const refuseUnreadable = (c: Context, why: string) => {
    report(`The cell refused an outbox delivery: ${why}.`);
    return c.json({ error: 'unreadable' }, OUTBOX_ANSWER.unreadable);
  };

  const mediaType = createMiddleware(async (c, next) => {
    if (!isDeliveryMediaType(c.req.header('content-type'))) {
      return refuseUnreadable(c, `it was not sent as ${OUTBOX_DELIVERY_MEDIA_TYPE}`);
    }
    await next();
  });

  const size = bodyLimit({
    maxSize: MAX_DELIVERY_BYTES,
    onError: (c) => refuseUnreadable(c, `its body is over ${MAX_DELIVERY_BYTES} bytes`),
  });

  const routes = new OpenAPIHono();
  routes.openapi({ ...postOutboxDelivery, middleware: [mediaType, size] as const }, async (c) => {
    const answer = await receiveDelivery(
      { deliveries, workspaceCopies },
      region,
      await c.req.text(),
    );
    const line = lineFor(answer, region);
    if (line !== null) report(line);

    // The status and body of each answer, as `OUTBOX_ANSWER` has them.
    switch (answer.kind) {
      case 'applied':
        return c.json({ applied: true } as const, OUTBOX_ANSWER.applied);
      case 'unsigned':
        return c.json({ error: 'unsigned' } as const, OUTBOX_ANSWER.unsigned);
      case 'unreadable':
        return c.json({ error: 'unreadable' } as const, OUTBOX_ANSWER.unreadable);
      case 'other-region':
        // The region is this cell's, which its health route says anyway.
        return c.json({ error: 'otherRegion', region } as const, OUTBOX_ANSWER.otherRegion);
      case 'out-of-order': {
        // Exactly what the contract's reader takes: no other field.
        const body: OutOfOrderAnswer = { nextSequence: answer.nextSequence };
        return c.json(body, OUTBOX_ANSWER.outOfOrder);
      }
      case 'keys-unavailable':
      case 'database-unavailable':
        return c.json({ error: 'unavailable' } as const, OUTBOX_ANSWER.unavailable);
    }
  });
  return routes;
}
