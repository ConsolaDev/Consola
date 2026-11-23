import createClient, { type Client } from 'openapi-fetch';
import type { CellRefusal } from '../domain/cell';
import type { paths } from '../domain/cellApiContract';
import type { WorkspaceMember } from '../domain/teams';
import { type Api, createApi } from './api';

/*
 * The workspace's regional cell, as every service that reads it reaches it (`teams.ts`,
 * `runs.ts`). The page reaches a region's cell at `/cell/<region>` on its own origin, which the
 * dev server proxies to it (`vite.config.ts`). The cell takes no cookie: every call carries a
 * cell token `cloud-global` mints for the session's active workspace (`POST /api/cell-token`),
 * as `Authorization: Bearer`.
 *
 * The token names the workspace it is for, and a call goes ahead only when that is the workspace
 * the page shows: another tab can switch the session's workspace, and a token for that one would
 * read and change its data under this one's name (`switched`). A token is kept until shortly
 * before it expires, and one the cell refuses is minted again once, for a clock out of step.
 *
 * Only a 401 from `cloud-global` means signed out; anything the calls do not expect, a cell that
 * does not answer included, is `unavailable`.
 */

/** What a client sends its requests with, as `api.ts` names it. */
export type Send = (request: Request) => Promise<Response>;

/** A client of a cell's API, typed by its contract, sending one token. */
export type CellApi = Client<paths>;

/** Where the page reaches a region's cell: `origin` is empty in the page, absolute in a test. */
export function cellBaseUrl(region: string, origin = ''): string {
  return `${origin}/cell/${region}`;
}

/** A client of the cell at `baseUrl`, sending `token` with every request. */
export function createCellApi(options: { token: string; baseUrl: string; fetch?: Send }): CellApi {
  const client = createClient<paths>({ baseUrl: options.baseUrl, fetch: options.fetch });
  client.use({
    onRequest({ request }) {
      request.headers.set('authorization', `Bearer ${options.token}`);
      return request;
    },
  });
  return client;
}

/** A token is minted again this long before it expires, so none expires on its way. */
const EARLY_SECONDS = 30;

type Grant = { token: string; expiresAt: number; workspaceId: string; region: string };

const UNAVAILABLE = { kind: 'unavailable' } as const;
const SWITCHED = { kind: 'switched' } as const;

/** The `error` code of an answer's body, if it has one. */
export function codeOf(body: unknown): unknown {
  return typeof body === 'object' && body !== null && 'error' in body ? body.error : undefined;
}

/** What a service is built with: `cloud-global`'s client, the cell's `fetch` and an origin in a test. */
export type CellDeps = {
  api?: Api;
  cellFetch?: Send;
  cellOrigin?: string;
  nowSeconds?: () => number;
};

export type CellAccess = {
  /**
   * Runs `call` on the workspace's cell with a token for it. A token the cell refuses (401) is
   * minted again once; refused again, the cell is not one this page can use.
   */
  onCell<Answer extends { response: Response }>(
    workspaceId: string,
    call: (cell: CellApi) => Promise<Answer>,
  ): Promise<Answer | CellRefusal>;
  /** The workspace's members from `cloud-global`, or why they could not be had. */
  membersOf(): Promise<WorkspaceMember[] | CellRefusal>;
};

/** A way to the workspace's cell, holding the token it last minted. */
export function createCellAccess(deps: CellDeps = {}): CellAccess {
  const api = deps.api ?? createApi();
  const nowSeconds = deps.nowSeconds ?? (() => Math.floor(Date.now() / 1000));
  let grant: Grant | null = null;

  /** A token for `workspaceId`, kept or minted, or why there is none. */
  async function grantFor(workspaceId: string): Promise<Grant | CellRefusal> {
    if (
      grant &&
      grant.workspaceId === workspaceId &&
      grant.expiresAt - EARLY_SECONDS > nowSeconds()
    ) {
      return grant;
    }
    grant = null;
    const { data, error, response } = await api.POST('/api/cell-token');
    if (response.status === 401) return { kind: 'signed-out' };
    if (response.status === 200 && data) {
      if (data.workspaceId !== workspaceId) return SWITCHED;
      grant = data;
      return data;
    }
    // The session has no workspace open, or one the person has left: not the page's any more.
    const code = codeOf(error);
    if (code === 'no_active_workspace' || code === 'not_a_member') return SWITCHED;
    return UNAVAILABLE;
  }

  return {
    async onCell(workspaceId, call) {
      for (let attempt = 0; attempt < 2; attempt++) {
        const granted = await grantFor(workspaceId);
        if ('kind' in granted) return granted;
        const cell = createCellApi({
          token: granted.token,
          baseUrl: cellBaseUrl(granted.region, deps.cellOrigin),
          fetch: deps.cellFetch,
        });
        const answer = await call(cell);
        if (answer.response.status !== 401) return answer;
        grant = null;
      }
      return UNAVAILABLE;
    },

    async membersOf() {
      const { data, error, response } = await api.GET('/api/me/workspace/members');
      if (response.status === 401) return { kind: 'signed-out' };
      if (response.status === 200 && Array.isArray(data?.members)) return data.members;
      const code = codeOf(error);
      if (code === 'no_active_workspace' || code === 'not_a_member') return SWITCHED;
      return UNAVAILABLE;
    },
  };
}
