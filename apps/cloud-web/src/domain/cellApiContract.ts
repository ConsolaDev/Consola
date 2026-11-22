/**
 * The types of the regional cell's API, generated from apps/cloud-region/openapi.json by
 * `pnpm --filter @consola/cloud-web api:generate`. Never edit this file by hand.
 */

export interface paths {
    "/api/health": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Whether the cell can reach its database, and which region it serves
         * @description Needs no token: it says nothing a workspace holds.
         */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description It can. */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {boolean} */
                            ok: true;
                            /** @enum {string} */
                            region: "eu" | "us";
                        };
                    };
                };
                /** @description It cannot. */
                503: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {boolean} */
                            ok: false;
                            /** @enum {string} */
                            region: "eu" | "us";
                        };
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/outbox": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Deliver one of cloud-global's outbox messages
         * @description Only cloud-global calls it. The body is the message, signed as a compact JWS with the cell token’s key (`packages/cloud-contract`, "Delivering a message"), so it takes no token.
         */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/jose": string;
                };
            };
            responses: {
                /** @description The cell has the message: applied now, or before. */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {boolean} */
                            applied: true;
                        };
                    };
                };
                /** @description Not sent as a signed message, over the size a message can be, or not a message the contract reads. */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {string} */
                            error: "unreadable";
                        };
                    };
                };
                /** @description Not signed by cloud-global. */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {string} */
                            error: "unsigned";
                        };
                    };
                };
                /** @description Messages before this one are missing: the sequence of the workspace's message the cell applies next. */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            nextSequence: number;
                        };
                    };
                };
                /** @description A message about a workspace in another region. */
                421: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {string} */
                            error: "otherRegion";
                            /** @enum {string} */
                            region: "eu" | "us";
                        };
                    };
                };
                /** @description The cell cannot get cloud-global's keys or its database. */
                503: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {string} */
                            error: "unavailable";
                        };
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/github/events": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Deliver one of GitHub’s webhook events, passed on by cloud-global
         * @description Only cloud-global calls it, for a workspace whose GitHub installation the event came through. The body is the event, signed as a compact JWS with the cell token’s key (`packages/cloud-contract`, "Passing on a GitHub event"), so it takes no token. The cell records each delivery once, by GitHub’s id of it.
         */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/jose": string;
                };
            };
            responses: {
                /** @description The cell had recorded the event before: a delivery sent again, which changed nothing. */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {boolean} */
                            recorded: true;
                        };
                    };
                };
                /** @description The cell recorded the event now. */
                201: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {boolean} */
                            recorded: true;
                        };
                    };
                };
                /** @description Not sent as a signed event, over the size an event can be, or not an event the contract reads. */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {string} */
                            error: "unreadable";
                        };
                    };
                };
                /** @description Not signed by cloud-global as an event. */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {string} */
                            error: "unsigned";
                        };
                    };
                };
                /** @description The cell does not hold the workspace yet: cloud-global has not delivered its creation. */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {string} */
                            error: "workspacePending";
                        };
                    };
                };
                /** @description An event for a workspace in another region. */
                421: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {string} */
                            error: "otherRegion";
                            /** @enum {string} */
                            region: "eu" | "us";
                        };
                    };
                };
                /** @description The cell cannot get cloud-global's keys or its database. */
                503: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {string} */
                            error: "unavailable";
                        };
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/me": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Who is asking, as this cell sees them */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description The caller. */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["Caller"];
                    };
                };
                /** @description No bearer token (`token_required`), or one the cell does not accept (`invalid_token`): malformed, forged, expired, or signed by a key cloud-global does not publish. A new token is the fix. */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {string} */
                            error: "token_required";
                        } | {
                            /** @enum {string} */
                            error: "invalid_token";
                        };
                    };
                };
                /** @description A good token for a workspace in another region: the cell that answered names its own. The workspace's own cell is the fix. */
                421: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {string} */
                            error: "wrong_region";
                            /** @enum {string} */
                            region: "eu" | "us";
                        };
                    };
                };
                /** @description The cell cannot get cloud-global's keys just now, so it checks no token. */
                503: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {string} */
                            error: "token_check_unavailable";
                        };
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/teams": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** The caller's workspace's teams, as the caller sees them */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description The teams. */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["TeamList"];
                    };
                };
                /** @description No bearer token (`token_required`), or one the cell does not accept (`invalid_token`): malformed, forged, expired, or signed by a key cloud-global does not publish. A new token is the fix. */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {string} */
                            error: "token_required";
                        } | {
                            /** @enum {string} */
                            error: "invalid_token";
                        };
                    };
                };
                /** @description The cell does not hold the workspace yet: cloud-global has not delivered its creation. Asking again later helps. */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {string} */
                            error: "workspace_pending";
                        };
                    };
                };
                /** @description A good token for a workspace in another region: the cell that answered names its own. The workspace's own cell is the fix. */
                421: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {string} */
                            error: "wrong_region";
                            /** @enum {string} */
                            region: "eu" | "us";
                        };
                    };
                };
                /** @description The cell cannot get cloud-global's keys just now, so it checks no token. */
                503: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {string} */
                            error: "token_check_unavailable";
                        };
                    };
                };
            };
        };
        put?: never;
        /** Make a team, with nobody in it */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": components["schemas"]["TeamName"];
                };
            };
            responses: {
                /** @description The team made. */
                201: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["Team"];
                    };
                };
                /** @description The rules refuse the name, or the body is not what the route takes. */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["InvalidTeam"] | {
                            /** @enum {string} */
                            error: "invalid_request";
                        };
                    };
                };
                /** @description No bearer token (`token_required`), or one the cell does not accept (`invalid_token`): malformed, forged, expired, or signed by a key cloud-global does not publish. A new token is the fix. */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {string} */
                            error: "token_required";
                        } | {
                            /** @enum {string} */
                            error: "invalid_token";
                        };
                    };
                };
                /** @description The caller’s role does not manage teams. */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {string} */
                            error: "not_allowed";
                        };
                    };
                };
                /** @description Another team of the workspace has the name, in any case (`name_taken`), or the cell does not hold the workspace yet (`workspace_pending`). */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {string} */
                            error: "name_taken";
                        } | {
                            /** @enum {string} */
                            error: "workspace_pending";
                        };
                    };
                };
                /** @description The body is not JSON (`Content-Type: application/json`). */
                415: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {string} */
                            error: "unsupported_media_type";
                        };
                    };
                };
                /** @description A good token for a workspace in another region: the cell that answered names its own. The workspace's own cell is the fix. */
                421: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {string} */
                            error: "wrong_region";
                            /** @enum {string} */
                            region: "eu" | "us";
                        };
                    };
                };
                /** @description The cell cannot get cloud-global's keys just now, so it checks no token. */
                503: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {string} */
                            error: "token_check_unavailable";
                        };
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/teams/{teamId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /** Delete a team, and every place in it */
        delete: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    teamId: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description The team is gone. */
                204: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description No bearer token (`token_required`), or one the cell does not accept (`invalid_token`): malformed, forged, expired, or signed by a key cloud-global does not publish. A new token is the fix. */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {string} */
                            error: "token_required";
                        } | {
                            /** @enum {string} */
                            error: "invalid_token";
                        };
                    };
                };
                /** @description The caller’s role does not manage teams. */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {string} */
                            error: "not_allowed";
                        };
                    };
                };
                /** @description The workspace has no team with that id, whether or not another workspace does. */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {string} */
                            error: "team_not_found";
                        };
                    };
                };
                /** @description The workspace's first team, which is never deleted (`first_team`), or the cell does not hold the workspace yet. */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {string} */
                            error: "first_team";
                        } | {
                            /** @enum {string} */
                            error: "workspace_pending";
                        };
                    };
                };
                /** @description A good token for a workspace in another region: the cell that answered names its own. The workspace's own cell is the fix. */
                421: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {string} */
                            error: "wrong_region";
                            /** @enum {string} */
                            region: "eu" | "us";
                        };
                    };
                };
                /** @description The cell cannot get cloud-global's keys just now, so it checks no token. */
                503: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {string} */
                            error: "token_check_unavailable";
                        };
                    };
                };
            };
        };
        options?: never;
        head?: never;
        /** Rename a team, the first one included */
        patch: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    teamId: string;
                };
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": components["schemas"]["TeamName"];
                };
            };
            responses: {
                /** @description The team, renamed. */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["Team"];
                    };
                };
                /** @description The rules refuse the name, or the body is not what the route takes. */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["InvalidTeam"] | {
                            /** @enum {string} */
                            error: "invalid_request";
                        };
                    };
                };
                /** @description No bearer token (`token_required`), or one the cell does not accept (`invalid_token`): malformed, forged, expired, or signed by a key cloud-global does not publish. A new token is the fix. */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {string} */
                            error: "token_required";
                        } | {
                            /** @enum {string} */
                            error: "invalid_token";
                        };
                    };
                };
                /** @description The caller’s role does not manage teams. */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {string} */
                            error: "not_allowed";
                        };
                    };
                };
                /** @description The workspace has no team with that id, whether or not another workspace does. */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {string} */
                            error: "team_not_found";
                        };
                    };
                };
                /** @description Another team of the workspace has the name, in any case, or the cell does not hold the workspace yet. */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {string} */
                            error: "name_taken";
                        } | {
                            /** @enum {string} */
                            error: "workspace_pending";
                        };
                    };
                };
                /** @description The body is not JSON (`Content-Type: application/json`). */
                415: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {string} */
                            error: "unsupported_media_type";
                        };
                    };
                };
                /** @description A good token for a workspace in another region: the cell that answered names its own. The workspace's own cell is the fix. */
                421: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {string} */
                            error: "wrong_region";
                            /** @enum {string} */
                            region: "eu" | "us";
                        };
                    };
                };
                /** @description The cell cannot get cloud-global's keys just now, so it checks no token. */
                503: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {string} */
                            error: "token_check_unavailable";
                        };
                    };
                };
            };
        };
        trace?: never;
    };
    "/api/teams/{teamId}/members/{personId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        /**
         * Make a member of the workspace a member of a team
         * @description Someone already in the team stays as they are.
         */
        put: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    teamId: string;
                    /** @description The person's global id. */
                    personId: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description The team, with the person in it. */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["Team"];
                    };
                };
                /** @description No bearer token (`token_required`), or one the cell does not accept (`invalid_token`): malformed, forged, expired, or signed by a key cloud-global does not publish. A new token is the fix. */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {string} */
                            error: "token_required";
                        } | {
                            /** @enum {string} */
                            error: "invalid_token";
                        };
                    };
                };
                /** @description The caller’s role does not manage teams. */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {string} */
                            error: "not_allowed";
                        };
                    };
                };
                /** @description The workspace has no team with that id, whether or not another workspace does. */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {string} */
                            error: "team_not_found";
                        };
                    };
                };
                /** @description The person is not a member of the workspace (`not_a_workspace_member`), or the cell does not hold the workspace yet. */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {string} */
                            error: "not_a_workspace_member";
                        } | {
                            /** @enum {string} */
                            error: "workspace_pending";
                        };
                    };
                };
                /** @description A good token for a workspace in another region: the cell that answered names its own. The workspace's own cell is the fix. */
                421: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {string} */
                            error: "wrong_region";
                            /** @enum {string} */
                            region: "eu" | "us";
                        };
                    };
                };
                /** @description The cell cannot get cloud-global's keys just now, so it checks no token. */
                503: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {string} */
                            error: "token_check_unavailable";
                        };
                    };
                };
            };
        };
        post?: never;
        /**
         * Take a person out of a team
         * @description Someone not in the team changes nothing.
         */
        delete: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    teamId: string;
                    /** @description The person's global id. */
                    personId: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description The team, without the person. */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["Team"];
                    };
                };
                /** @description No bearer token (`token_required`), or one the cell does not accept (`invalid_token`): malformed, forged, expired, or signed by a key cloud-global does not publish. A new token is the fix. */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {string} */
                            error: "token_required";
                        } | {
                            /** @enum {string} */
                            error: "invalid_token";
                        };
                    };
                };
                /** @description The caller’s role does not manage teams. */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {string} */
                            error: "not_allowed";
                        };
                    };
                };
                /** @description The workspace has no team with that id, whether or not another workspace does. */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {string} */
                            error: "team_not_found";
                        };
                    };
                };
                /** @description The cell does not hold the workspace yet: cloud-global has not delivered its creation. Asking again later helps. */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {string} */
                            error: "workspace_pending";
                        };
                    };
                };
                /** @description A good token for a workspace in another region: the cell that answered names its own. The workspace's own cell is the fix. */
                421: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {string} */
                            error: "wrong_region";
                            /** @enum {string} */
                            region: "eu" | "us";
                        };
                    };
                };
                /** @description The cell cannot get cloud-global's keys just now, so it checks no token. */
                503: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {string} */
                            error: "token_check_unavailable";
                        };
                    };
                };
            };
        };
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
}
export type webhooks = Record<string, never>;
export interface components {
    schemas: {
        /** @description Who is asking, as their checked cell token says. */
        Caller: {
            personId: string;
            workspaceId: string;
            /** @enum {string} */
            role: "owner" | "admin" | "member";
            /** @enum {string} */
            region: "eu" | "us";
        };
        /** @description The teams the caller sees: every team for owners and admins, the ones they are in for a member. */
        TeamList: {
            teams: components["schemas"]["Team"][];
            /** @description Whether the caller may make, rename and delete teams, and choose their members. */
            canManage: boolean;
        };
        Team: {
            id: string;
            name: string;
            /** @description Whether it is the workspace's first team, which every new member joins and which is never deleted. */
            first: boolean;
            /** @description Its members’ global ids, in the order they joined it. */
            memberIds: string[];
        };
        /** @description Every problem with the name, at once. */
        InvalidTeam: {
            /** @enum {string} */
            error: "invalid_team";
            problems: ("name_missing" | "name_too_long" | "name_invalid")[];
        };
        /** @description A name (trimmed, 1 to 64 characters, no control characters), unique in the workspace whatever its case. */
        TeamName: {
            name: string;
        };
    };
    responses: never;
    parameters: never;
    requestBodies: never;
    headers: never;
    pathItems: never;
}
export type $defs = Record<string, never>;
export type operations = Record<string, never>;
