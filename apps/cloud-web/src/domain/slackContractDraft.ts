/**
 * A DRAFT of the Slack routes' contract, written by hand from the Linear design "Cloud · Design:
 * Slack as a Connection (CON-144)", "Routes", until `cloud-api`'s `openapi.json` declares them.
 * It is shaped as `openapi-typescript` writes `apiContract.ts`, so the Slack service is typed by
 * it as every other service is by the real one.
 *
 * It is deleted once the contract lands: `pnpm --filter @consola/cloud-web api:generate`, then
 * every import of this file moves to `apiContract.ts`, with the names the API chose. Nothing but
 * `domain/slack.ts`, `domain/runs.ts`, `domain/cloudSession.ts` and `services/slack.ts` imports
 * it.
 */

type Json<Body> = { headers: { [name: string]: unknown }; content: { 'application/json': Body } };
type Empty = { headers: { [name: string]: unknown }; content?: never };
type Refused = Json<{ error: string }>;
type InPath<Path> = { query?: never; header?: never; path: Path; cookie?: never };
type NoParameters = { query?: never; header?: never; path?: never; cookie?: never };
export interface paths {
  '/api/factories/{factoryId}/slack': {
    parameters: InPath<{ factoryId: string }>;
    get: {
      parameters: InPath<{ factoryId: string }>;
      requestBody?: never;
      responses: {
        200: Json<components['schemas']['SlackApp']>;
        400: Refused;
        401: Refused;
        403: Refused;
        404: Refused;
        409: Refused;
        503: Refused;
      };
    };
    delete: {
      parameters: InPath<{ factoryId: string }>;
      requestBody?: never;
      responses: {
        204: Empty;
        400: Refused;
        401: Refused;
        403: Refused;
        404: Refused;
        409: Refused;
        503: Refused;
      };
    };
  };
  '/api/factories/{factoryId}/slack/credentials': {
    parameters: InPath<{ factoryId: string }>;
    put: {
      parameters: InPath<{ factoryId: string }>;
      requestBody: { content: { 'application/json': components['schemas']['SlackCredentials'] } };
      responses: {
        200: Json<components['schemas']['SlackApp']>;
        400: Json<{ error: string; problems?: string[] }>;
        401: Refused;
        403: Refused;
        404: Refused;
        409: Refused;
        503: Refused;
      };
    };
  };
  '/api/factories/{factoryId}/slack/install': {
    parameters: InPath<{ factoryId: string }>;
    post: {
      parameters: InPath<{ factoryId: string }>;
      requestBody?: never;
      responses: {
        200: Json<{ url: string }>;
        400: Refused;
        401: Refused;
        403: Refused;
        404: Refused;
        409: Refused;
        503: Refused;
      };
    };
  };
  '/api/slack/links': {
    parameters: NoParameters;
    get: {
      parameters: NoParameters;
      requestBody?: never;
      responses: {
        200: Json<{ links: Array<components['schemas']['SlackLink']> }>;
        400: Refused;
        401: Refused;
        403: Refused;
        409: Refused;
        503: Refused;
      };
    };
  };
  '/api/slack/links/{linkId}': {
    parameters: InPath<{ linkId: string }>;
    delete: {
      parameters: InPath<{ linkId: string }>;
      requestBody?: never;
      responses: {
        204: Empty;
        400: Refused;
        401: Refused;
        403: Refused;
        404: Refused;
        409: Refused;
        503: Refused;
      };
    };
  };
  '/api/slack/links/{token}': {
    parameters: InPath<{ token: string }>;
    get: {
      parameters: InPath<{ token: string }>;
      requestBody?: never;
      responses: {
        200: Json<components['schemas']['SlackLinkRequest']>;
        401: Refused;
        404: Refused;
        410: Refused;
        503: Refused;
      };
    };
    post: {
      parameters: InPath<{ token: string }>;
      requestBody?: never;
      responses: {
        201: Json<components['schemas']['SlackLink']>;
        400: Refused;
        401: Refused;
        403: Refused;
        404: Refused;
        409: Refused;
        410: Refused;
        503: Refused;
      };
    };
  };
}

export interface components {
  schemas: {
    /**
     * Where a factory's Slack app stands: none yet (`not_set_up`), its credentials pasted and
     * waiting for "Add to Slack" (`awaiting_install`), installed, or installed with a token Slack
     * no longer accepts (`needs_reinstall`).
     */
    SlackAppState: 'not_set_up' | 'awaiting_install' | 'installed' | 'needs_reinstall';
    /** A factory's Slack app, as its settings show it. Never a secret. */
    SlackApp: {
      state: components['schemas']['SlackAppState'];
      /** Whether the caller may set it up, change or remove it: an owner or an admin. */
      canManage: boolean;
      /** The bot's handle, without its `@`: the factory's name as a slug. */
      handle: string;
      /** Slack's id of the app, once its credentials are pasted. */
      appId: string | null;
      /** The Slack workspace it is installed in, once it is. */
      team: { id: string; name: string } | null;
      /** The app's manifest, as the create-app link carries it. */
      manifest: Record<string, unknown>;
      /** Slack's "create an app from a manifest" page, with the manifest filled in. */
      createAppUrl: string;
      /** When it was installed, as an ISO 8601 time. */
      installedAt: string | null;
    };
    /** What a person pastes from Basic Information › App Credentials. */
    SlackCredentials: { clientId: string; clientSecret: string; signingSecret: string };
    /** What a one-time link page shows before the person confirms it. */
    SlackLinkRequest: {
      /** The Consola workspace the link links into. */
      workspace: { id: string; name: string };
      /** The Slack workspace and the Slack account the link is for. */
      slackTeam: { id: string; name: string | null };
      slackUser: { id: string; name: string | null };
      /** The factory whose bot sent the link, when it is still there. */
      factory: { id: string; name: string; handle: string } | null;
      /** When the link stops working, as an ISO 8601 time. */
      expiresAt: string;
    };
    /** One of the caller's Slack accounts, linked to them in the active workspace. */
    SlackLink: {
      id: string;
      slackTeam: { id: string; name: string | null };
      slackUserId: string;
      /** When it was linked, as an ISO 8601 time. */
      linkedAt: string;
    };
    /** A Slack message a request came from: `RunItem` with `kind: 'slack'` (lane C). */
    SlackRunItem: {
      url: string;
      title: string;
      kind: 'slack';
      repo: string | null;
      number: number | null;
    };
    /** What started an agent run that a Slack message asked for (lane C). */
    SlackSessionOrigin: {
      kind: 'slack';
      factoryId: string;
      factoryName: string;
      agent: string;
      message: {
        teamId: string;
        channelId: string;
        threadTs: string;
        messageTs: string;
        permalink: string;
      };
    };
  };
}
