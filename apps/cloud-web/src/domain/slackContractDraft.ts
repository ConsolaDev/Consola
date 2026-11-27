/**
 * A DRAFT of what a request from Slack adds to runs and cloud sessions (CON-144, lane C),
 * written by hand from the Linear design "Cloud · Design: Slack as a Connection (CON-144)",
 * "Starting a request", until `cloud-api`'s `openapi.json` declares it: a run's item may be the
 * Slack message it came from, and its session's origin the message's factory and thread.
 *
 * It is deleted once the contract has them: `pnpm --filter @consola/cloud-web api:generate`,
 * then `domain/runs.ts` and `domain/cloudSession.ts` take the API's own names, and nothing else
 * imports this file. Slack's own routes (the app, its credentials, links) are the contract's
 * already, in `apiContract.ts`.
 */
export interface components {
  schemas: {
    /** A Slack message a request came from: `RunItem` with `kind: 'slack'`. */
    SlackRunItem: {
      /** The message's permalink. */
      url: string;
      /** The message's first line. */
      title: string;
      kind: 'slack';
      repo: string | null;
      number: number | null;
    };
    /** What started an agent run that a Slack message asked for. */
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
