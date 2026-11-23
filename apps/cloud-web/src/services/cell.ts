import createClient, { type Client } from 'openapi-fetch';
import type { paths } from '../domain/cellApiContract';
import type { CellRefusal } from '../domain/cell';
import { type Api, createApi } from './api';

/*
 * The way to a workspace's regional cell, which every service of the cell's (teams, factories)
 * shares. The page reaches a region's cell at `/cell/<region>` on its own origin, which the dev
 * server proxies to it (`vite.config.ts`). The cell takes no cookie: every call carries a cell
 * token `cloud-global` mints for the session's active workspace (`POST /api/cell-token`), as
 * `Authorization: Bearer`.
 *
 * The token names the workspace it is for, and a call goes ahead only when that is the workspace
 * the page shows: another tab can switch the session's workspace, and a token for that one would
 * read and change its teams and factories under this one's name (`switched`). A token is kept
 * until shortly before it expires, and one the cell refuses is minted again once, for a clock out
 * of step. Calls made at once share one mint.
 *
 * Only a 401 from `cloud-global` means signed out; a cell that does not answer is `unavailable`.
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

/** Why a call never reached the cell, or came to nothing the page can use: the domain's, which every page of a cell says the same way. */
export type { CellRefusal };

export const UNAVAILABLE = { kind: 'unavailable' } as const;
export const SWITCHED = { kind: 'switched' } as const;
export const PENDING = { kind: 'pending' } as const;
export const SIGNED_OUT = { kind: 'signed-out' } as const;

/** The `error` code of an answer's body, if it has one. */
export function codeOf(body: unknown): unknown {
  return typeof body === 'object' && body !== null && 'error' in body ? body.error : undefined;
}

/** What a service of the cell is built with: a test stands in for each. */
export type CellDeps = {
  /** `cloud-global`'s client, which mints the token. */
  api?: Api;
  /** What the cell's client sends with. */
  cellFetch?: Send;
  /** The origin the cell's address resolves against: empty in the page. */
  cellOrigin?: string;
  nowSeconds?: () => number;
};

export type CellSession = {
  /** `cloud-global`'s client, for the calls a service makes there beside the cell's. */
  api: Api;
  /**
   * Runs `call` on the workspace's cell with a token for it. A token the cell refuses (401) is
   * minted again once; refused again, the cell is not one this page can use.
   */
  onCell<Answer extends { response: Response }>(
    workspaceId: string,
    call: (cell: CellApi) => Promise<Answer>,
  ): Promise<Answer | CellRefusal>;
};

/** A token is minted again this long before it expires, so none expires on its way. */
const EARLY_SECONDS = 30;

type Grant = { token: string; expiresAt: number; workspaceId: string; region: string };

/** A way to the cell, holding the token it last minted. */
export function createCellSession(deps: CellDeps = {}): CellSession {
  const api = deps.api ?? createApi();
  const nowSeconds = deps.nowSeconds ?? (() => Math.floor(Date.now() / 1000));
  let grant: Grant | null = null;
  // A mint under way, which calls for the same workspace made meanwhile wait for rather than
  // minting their own.
  let minting: { workspaceId: string; answer: Promise<Grant | CellRefusal> } | null = null;

  async function mint(workspaceId: string): Promise<Grant | CellRefusal> {
    const { data, error, response } = await api.POST('/api/cell-token');
    if (response.status === 401) return SIGNED_OUT;
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
    if (minting?.workspaceId !== workspaceId) {
      const started = {
        workspaceId,
        answer: mint(workspaceId).finally(() => {
          if (minting === started) minting = null;
        }),
      };
      minting = started;
    }
    return minting.answer;
  }

  return {
    api,
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
  };
}

/** The page's way to its cell, which every service of the cell's shares, and so its token. */
export const pageCellSession = createCellSession();
