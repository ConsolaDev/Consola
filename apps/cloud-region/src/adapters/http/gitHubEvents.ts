import {
  GITHUB_EVENT_ANSWER,
  GITHUB_EVENT_DELIVERY_MAX_BYTES,
  GITHUB_EVENT_DELIVERY_MEDIA_TYPE,
  type GitHubEventMessage,
} from '@consola/cloud-contract';
import { OpenAPIHono } from '@hono/zod-openapi';
import type { Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { createMiddleware } from 'hono/factory';
import type { DeliveryVerifier, GitHubEventStore, RunnerChannel } from '../../application/ports.js';
import {
  type GitHubEventAnswer,
  receiveGitHubEvent,
} from '../../application/receiveGitHubEvent.js';
import type { Region } from '../../domain/region.js';
import { postGitHubEventDelivery } from './contract.js';
import { hasMediaType } from './outbox.js';

const about = (event: GitHubEventMessage) =>
  `GitHub delivery ${event.deliveryId} (${event.event}) for workspace ${event.workspaceId}`;

/**
 * The line the cell logs for an answer, or null for one that needs none. Ids and names only,
 * never the payload: what a repository's event says stays in the table.
 */
function lineFor(answer: GitHubEventAnswer, region: Region): string | null {
  switch (answer.kind) {
    case 'recorded':
      return answer.runner?.kind === 'not-for-runners'
        ? `The cell recorded ${about(answer.event)} as not for runners: ${answer.runner.reason}.`
        : null;
    case 'keys-unavailable': // The verifier has said why.
      return null;
    case 'unsigned':
      return `The cell refused a GitHub event: it is not signed by cloud-global (${answer.reason}).`;
    case 'unreadable':
      return `The cell refused a GitHub event: its message does not read (${answer.reason}).`;
    case 'other-region':
      return `The cell refused ${about(answer.event)}: the workspace is in ${answer.event.region}, and this cell serves ${region}.`;
    case 'workspace-pending':
      return `The cell refused ${about(answer.event)}: it does not hold the workspace yet.`;
    case 'database-unavailable':
      return `The cell could not record ${about(answer.event)}: ${answer.reason}`;
  }
}

/**
 * `POST GITHUB_EVENT_DELIVERY_PATH` (`postGitHubEventDelivery` in the contract), where
 * `cloud-global` passes on one of GitHub's webhook events a request. Like the outbox's route, it
 * takes no cell token: no person sends it, and its signature, checked with the cell token's key
 * and `GITHUB_EVENT_TYPE`, is what says it is `cloud-global`'s. So `createApp` mounts it before
 * `requireCaller`, and only this method and path.
 *
 * Before the use case checks the signature, the event and its region, the route refuses a body
 * not sent as `GITHUB_EVENT_DELIVERY_MEDIA_TYPE` and one over `GITHUB_EVENT_DELIVERY_MAX_BYTES`,
 * each as unreadable, without reading it. Every refusal is logged through `report`, one line,
 * never the body.
 */
export function gitHubEventRoutes(deps: {
  region: Region;
  events: DeliveryVerifier;
  gitHubEvents: GitHubEventStore;
  runners: Pick<RunnerChannel, 'handEvent'>;
  report: (line: string) => void;
}): OpenAPIHono {
  const { region, events, gitHubEvents, runners, report } = deps;
  const refuseUnreadable = (c: Context, why: string) => {
    report(`The cell refused a GitHub event: ${why}.`);
    return c.json({ error: 'unreadable' }, GITHUB_EVENT_ANSWER.unreadable);
  };

  const mediaType = createMiddleware(async (c, next) => {
    if (!hasMediaType(c.req.header('content-type'), GITHUB_EVENT_DELIVERY_MEDIA_TYPE)) {
      return refuseUnreadable(c, `it was not sent as ${GITHUB_EVENT_DELIVERY_MEDIA_TYPE}`);
    }
    await next();
  });

  const size = bodyLimit({
    maxSize: GITHUB_EVENT_DELIVERY_MAX_BYTES,
    onError: (c) =>
      refuseUnreadable(c, `its body is over ${GITHUB_EVENT_DELIVERY_MAX_BYTES} bytes`),
  });

  const routes = new OpenAPIHono();
  routes.openapi(
    { ...postGitHubEventDelivery, middleware: [mediaType, size] as const },
    async (c) => {
      const answer = await receiveGitHubEvent(
        { events, gitHubEvents, runners },
        region,
        await c.req.text(),
      );
      const line = lineFor(answer, region);
      if (line !== null) report(line);

      // The status and body of each answer, as `GITHUB_EVENT_ANSWER` has them.
      switch (answer.kind) {
        case 'recorded':
          return answer.now
            ? c.json({ recorded: true } as const, GITHUB_EVENT_ANSWER.recorded)
            : c.json({ recorded: true } as const, GITHUB_EVENT_ANSWER.recordedBefore);
        case 'unsigned':
          return c.json({ error: 'unsigned' } as const, GITHUB_EVENT_ANSWER.unsigned);
        case 'unreadable':
          return c.json({ error: 'unreadable' } as const, GITHUB_EVENT_ANSWER.unreadable);
        case 'other-region':
          return c.json({ error: 'otherRegion', region } as const, GITHUB_EVENT_ANSWER.otherRegion);
        case 'workspace-pending':
          return c.json(
            { error: 'workspacePending' } as const,
            GITHUB_EVENT_ANSWER.workspacePending,
          );
        case 'keys-unavailable':
        case 'database-unavailable':
          return c.json({ error: 'unavailable' } as const, GITHUB_EVENT_ANSWER.unavailable);
      }
    },
  );
  return routes;
}
