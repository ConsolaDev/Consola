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
                /** @description The workspace's first team, which is never deleted (`first_team`), a team that owns a factory, which is not deleted while it does (`owns_factories`), or the cell does not hold the workspace yet. */
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
                            error: "owns_factories";
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
    "/api/factories": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** The caller's workspace's factories, as the caller sees them */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description The factories. */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["FactoryList"];
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
        /**
         * Make a blank factory, owned by a team
         * @description Its files are stored in the cell, and its first version holds none. Owners and admins may make one for any team, a member for a team they are in.
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
                    "application/json": components["schemas"]["NewFactory"];
                };
            };
            responses: {
                /** @description The factory made. */
                201: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["Factory"];
                    };
                };
                /** @description The rules refuse the name, or the body is not what the route takes. */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["InvalidFactory"] | {
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
                /** @description The workspace has no team with that id that the caller sees: none, or one a member is not in. */
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
                /** @description Another factory of the workspace has the name, in any case (`name_taken`), or the cell does not hold the workspace yet (`workspace_pending`). */
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
    "/api/factories/{factoryId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** A factory, with its latest version’s files */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    factoryId: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description The factory and its latest version. */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["FactoryWithFiles"];
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
                /** @description The workspace has no factory with that id that the caller sees: none, or one of a team a member is not in. */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {string} */
                            error: "factory_not_found";
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
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        /**
         * Rename a factory, or move it to another team
         * @description Whoever sees the factory may rename it. Moving it needs the caller to see the team it moves to as well: owners and admins any team, a member a team they are in. Its versions stay as they are.
         */
        patch: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    factoryId: string;
                };
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": components["schemas"]["FactoryChange"];
                };
            };
            responses: {
                /** @description The factory, changed. */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["Factory"];
                    };
                };
                /** @description The rules refuse the name, or the body is not what the route takes: neither a name nor a team is one. */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["InvalidFactory"] | {
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
                /** @description The caller sees no such factory (`factory_not_found`), or no such team to move it to (`team_not_found`): none, or one a member is not in. */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {string} */
                            error: "factory_not_found";
                        } | {
                            /** @enum {string} */
                            error: "team_not_found";
                        };
                    };
                };
                /** @description Another factory of the workspace has the name, in any case (`name_taken`), or the cell does not hold the workspace yet (`workspace_pending`). */
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
    "/api/factories/{factoryId}/versions/{version}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** One version of a factory's files, an earlier one or the latest */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    factoryId: string;
                    /** @description A version's number: 1 for the blank version a factory is made with. */
                    version: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description The version. */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["FactoryVersion"];
                    };
                };
                /** @description The version is not a number from 1. */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
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
                /** @description The caller sees no such factory (`factory_not_found`), or it has no version with that number (`version_not_found`). */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {string} */
                            error: "factory_not_found";
                        } | {
                            /** @enum {string} */
                            error: "version_not_found";
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
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/factories/{factoryId}/versions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Save a factory's files as its next version
         * @description The files must keep the factory schema (`packages/factory-spec`), and `baseVersion` must still be the latest version. Whoever sees the factory may save it.
         */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    factoryId: string;
                };
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": components["schemas"]["NewFactoryVersion"];
                };
            };
            responses: {
                /** @description The version saved. */
                201: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["SavedFactoryVersion"];
                    };
                };
                /** @description The files fail the factory schema (`invalid_files`), or the body is not what the route takes. */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["InvalidFiles"] | {
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
                /** @description The workspace has no factory with that id that the caller sees: none, or one of a team a member is not in. */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {string} */
                            error: "factory_not_found";
                        };
                    };
                };
                /** @description The factory has a newer version than the one the files were edited from (`version_moved`), or the cell does not hold the workspace yet. */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["VersionMoved"] | {
                            /** @enum {string} */
                            error: "workspace_pending";
                        };
                    };
                };
                /** @description The body is larger than any factory’s files can be. */
                413: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {string} */
                            error: "too_large";
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
    "/api/runs": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * The top-level runs the caller sees, newest first
         * @description A request is one run; the automation runs it started are not listed here but in its own answer. Filters combine; the values of one filter are alternatives.
         */
        get: {
            parameters: {
                query?: {
                    /** @description Only runs in one of these phases. Repeat it for several. */
                    phase?: components["schemas"]["Phase"][];
                    /** @description Only runs started one of these ways; "background runs" are `cron`, `event` and `poll`. */
                    trigger?: components["schemas"]["RunTrigger"][];
                    /** @description Only this factory's runs; one the caller does not see gives an empty page. */
                    factoryId?: string;
                    /** @description Only runs of the factories this team owns now. */
                    teamId?: string;
                    /** @description Only runs of this automation, and requests that started one, in every factory unless `factoryId` narrows it. */
                    automation?: string;
                    /** @description `true`: only runs the caller started. */
                    mine?: "true" | "false";
                    /** @description Text the title or the automation's name holds, in any case. */
                    q?: string;
                    /** @description The page before's `nextCursor`. */
                    cursor?: string;
                    limit?: number;
                };
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description A page of runs, the counts and what the filters offer. */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["RunList"];
                    };
                };
                /** @description A phase or trigger the cell does not know, a cursor it did not give, a `limit` out of range or a `q` too long. */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
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
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/runs/{runId}/approval": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Approve or dismiss a run that waits for approval
         * @description Anyone on the run's factory's owning team may answer, whatever their workspace role, and the first answer for a version is the one kept. The cell records it and does not change the run: its runner acts on it.
         */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    runId: string;
                };
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": components["schemas"]["ApprovalAnswer"];
                };
            };
            responses: {
                /** @description The answer is recorded. */
                201: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["RunApproval"];
                    };
                };
                /** @description The body is not what the route takes. */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
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
                /** @description The caller sees the run, but is not on its factory's owning team. */
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
                /** @description The workspace has no run with that id that the caller sees. */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {string} */
                            error: "run_not_found";
                        };
                    };
                };
                /** @description The run is not waiting for approval (`not_waiting`), this version was answered already (`already_answered`: the first answer stands), the version is not the run's (`version_moved`), or the cell does not hold the workspace yet (`workspace_pending`). */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {string} */
                            error: "not_waiting";
                        } | {
                            /** @enum {string} */
                            error: "already_answered";
                        } | {
                            /** @enum {string} */
                            error: "version_moved";
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
    "/api/runs/{runId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** One run: its steps, and a request’s facts and the runs it started */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    runId: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description The run. */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["RunDetail"];
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
                /** @description The workspace has no run with that id that the caller sees: none, or one of a factory of a team a member is not in. */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {string} */
                            error: "run_not_found";
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
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/cloud-sessions/options": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** What the workspace's runner offers a new session */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description What the connected runner offers. */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["CloudSessionOptions"];
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
                /** @description No runner is configured or connected for the workspace (`no_runner`). Or the cell cannot get cloud-global's keys just now, so it checks no token (`token_check_unavailable`). */
                503: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {string} */
                            error: "no_runner";
                        } | {
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
    "/api/cloud-sessions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** The caller's own cloud sessions in their workspace, newest first */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description The sessions. */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["CloudSession"][];
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
        /**
         * Start a cloud session on the workspace’s runner
         * @description Nothing is recorded or sent unless the connected runner offers both the repository and the harness. The session starts as `starting`; the runner moves it on.
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
                    "application/json": components["schemas"]["NewCloudSession"];
                };
            };
            responses: {
                /** @description The session, recorded and handed to the runner. */
                201: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["CloudSession"];
                    };
                };
                /** @description The runner does not offer the repository (`repository_not_offered`) or the harness (`harness_not_offered`), or the body is not exactly `{ repository, harness }`, each valid (`invalid_request`). */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {string} */
                            error: "repository_not_offered";
                        } | {
                            /** @enum {string} */
                            error: "harness_not_offered";
                        } | {
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
                /** @description No runner is configured or connected for the workspace (`no_runner`): nothing was recorded. Or the cell cannot get cloud-global's keys just now, so it checks no token (`token_check_unavailable`). */
                503: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {string} */
                            error: "no_runner";
                        } | {
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
    "/api/cloud-sessions/{sessionId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** One of the caller’s own cloud sessions */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    sessionId: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description The session. */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["CloudSession"];
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
                /** @description The caller has no such session: none, another person's or another workspace's, as if it did not exist. */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {string} */
                            error: "not_found";
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
    "/api/cloud-sessions/{sessionId}/stop": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Stop one of the caller’s own cloud sessions
         * @description The session ends at once, whether or not its runner is connected; the runner is told when it is. Stopping an ended session changes nothing.
         */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    sessionId: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description The session, ended: `stopped`, or the end it had already. */
                202: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["CloudSession"];
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
                /** @description The caller has no such session: none, another person's or another workspace's, as if it did not exist. */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {string} */
                            error: "not_found";
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
    "/api/cloud-sessions/{sessionId}/pass": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * A pass to one of the caller’s own running sessions
         * @description The pass lasts five minutes (the runner protocol's cap); ask for another when it runs out. No answer of the route is kept by a cache (`Cache-Control: no-store`) but the token check's.
         */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    sessionId: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description The pass, and the host it opens. */
                200: {
                    headers: {
                        /** @description Never kept by a cache. */
                        "Cache-Control"?: "no-store";
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["CloudSessionPass"];
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
                /** @description The caller has no such running session whose host has an address: none, one still starting or ended, another person's or another workspace's. */
                404: {
                    headers: {
                        /** @description Never kept by a cache. */
                        "Cache-Control"?: "no-store";
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {string} */
                            error: "not_found";
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
                /** @description The cell has no pass key, and so no runner (`no_runner`). Or the cell cannot get cloud-global's keys just now, so it checks no token (`token_check_unavailable`). */
                503: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {string} */
                            error: "no_runner";
                        } | {
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
        /** @description The factories the caller sees, by name: every factory for owners and admins, the factories of the teams they are in for a member. */
        FactoryList: {
            factories: components["schemas"]["Factory"][];
        };
        Factory: {
            id: string;
            name: string;
            /** @description The team that owns it. */
            teamId: string;
            source: components["schemas"]["FactorySource"];
            /** @description Its latest version's number: 1 until its files are first saved, and one more with each save. */
            latestVersion: number;
            /** @description When its latest version was saved, as an ISO 8601 time. */
            updatedAt: string;
        };
        /** @description Where the factory's files come from: `stored`, saved in the cell. A GitHub repository comes later. */
        FactorySource: {
            /** @enum {string} */
            kind: "stored";
        };
        /** @description Every problem with the name, at once. */
        InvalidFactory: {
            /** @enum {string} */
            error: "invalid_factory";
            problems: ("name_missing" | "name_too_long" | "name_invalid")[];
        };
        /** @description A name (trimmed, 1 to 64 characters, no control characters), unique in the workspace whatever its case, and the id of the team that owns it. */
        NewFactory: {
            name: string;
            teamId: string;
        };
        /** @description A factory, and its latest version with its files. */
        FactoryWithFiles: {
            factory: components["schemas"]["Factory"];
            version: components["schemas"]["FactoryVersion"];
        };
        /** @description One version of a factory's files, as saved. */
        FactoryVersion: {
            factoryId: string;
            version: number;
            /** @description When it was saved, as an ISO 8601 time. */
            savedAt: string;
            /** @description The global id of the person who saved it. */
            savedBy: string;
            /** @description Its files, by path. */
            files: components["schemas"]["FactoryFile"][];
        };
        FactoryFile: {
            /** @description Its path inside the factory's folder: `factory.yml`, `automations/<name>.yaml`, `agents/<name>.md`, `skills/<name>/…`. */
            path: string;
            /** @description Its text. */
            content: string;
        };
        /** @description What changes, at least one of the two: both at once is one change, made whole or not at all. Its files and where they come from are not changed here. */
        FactoryChange: {
            /** @description Its new name (trimmed, 1 to 64 characters, no control characters), unique in the workspace whatever its case. */
            name?: string;
            /** @description The id of the team that owns it from now on. */
            teamId?: string;
        };
        /** @description The version saved, and what to know about it. */
        SavedFactoryVersion: {
            version: components["schemas"]["FactoryVersion"];
            notices: components["schemas"]["FactoryNotice"][];
        };
        /** @description Something the factory schema says about the files that refuses nothing, such as a folder a later slice reads. */
        FactoryNotice: {
            message: string;
            file?: string;
            line?: number;
        };
        /** @description Files that fail the factory schema: every problem, each naming its file. Nothing is saved. */
        InvalidFiles: {
            /** @enum {string} */
            error: "invalid_files";
            issues: components["schemas"]["FactoryIssue"][];
        };
        /** @description A problem with the files, as the factory schema words it. */
        FactoryIssue: {
            message: string;
            /** @description The file the problem is in; absent for a problem with the set as a whole. */
            file?: string;
            /** @description Where in the file, as a dotted path into its document (`automations[0].mode`); empty for the whole file. */
            path: string;
            /** @description The line, from 1, when known. */
            line?: number;
            /** @description The automation the problem belongs to, when it has a name. */
            automation?: string;
            /** @description The file (or skill's folder) whose own problems this one only shows through: a step's agent, an agent's skill. */
            cause?: string;
        };
        /** @description The latest version is no longer `baseVersion`: someone saved since. Nothing is saved. */
        VersionMoved: {
            /** @enum {string} */
            error: "version_moved";
            latestVersion: number;
        };
        NewFactoryVersion: {
            /** @description The version the files were edited from, which must still be the latest: a save never undoes one it did not see. */
            baseVersion: number;
            /** @description Every file of the new version (at most 500, 8 MB in all): a file left out is not in it. */
            files: {
                path: string;
                content: string;
            }[];
        };
        /** @description Top-level runs (none a request started) the caller sees, newest first: every run for owners and admins, the runs of their teams’ factories for a member. */
        RunList: {
            runs: components["schemas"]["RunSummary"][];
            /** @description The next page's `cursor`; null on the last page. */
            nextCursor: string | null;
            counts: components["schemas"]["PhaseCounts"];
            /** @description What the filters offer, whatever the query's filters: the factories and teams the caller sees, by name, and the automations their runs ran, children's included. */
            facets: {
                factories: {
                    id: string;
                    name: string;
                    teamId: string;
                    latestVersion: number;
                }[];
                teams: {
                    id: string;
                    name: string;
                }[];
                automations: {
                    factoryId: string;
                    name: string;
                }[];
            };
        };
        RunSummary: {
            id: string;
            kind: components["schemas"]["RunKind"];
            /** @description A request: its item's title, else its text's first line; an automation run: its item's title, else its automation's name. At most 120 characters, on one line. */
            title: string;
            status: components["schemas"]["RunStatus"];
            phase: components["schemas"]["Phase"];
            /**
             * @description What a waiting run waits on; set exactly while it is `waiting`.
             * @enum {string|null}
             */
            waitingOn: "run" | "person" | null;
            /** @description Its factory, and the version of it the run executed. */
            factory: {
                id: string;
                name: string;
                version: number;
            };
            /** @description The team that owns the run's factory now. */
            teamId: string;
            /** @description The automation's name; null exactly for a request. */
            automation: string | null;
            /** @description The request that started it, on an automation run one did. */
            parentId: string | null;
            trigger: components["schemas"]["RunTrigger"];
            /** @description What the trigger was: the event's name (`pull_request.opened`), the cron schedule, or the poll's check. */
            triggerDetail: string | null;
            /** @description The global id of the person who started it, who may no longer be a member; null for a run no person started. */
            startedBy: string | null;
            item: components["schemas"]["RunItem"] | null;
            /** @description Which runner ran it: `cloud` for now. */
            runner: string;
            /** @description An automation run's steps; null for a request. */
            progress: {
                total: number;
                /** @description Steps that have ended. */
                done: number;
                /** @description The id of the first step running or waiting. */
                current: string | null;
            } | null;
            /** @description The automation runs a request started, by phase; null otherwise. */
            children: {
                total: number;
                active: number;
                needsYou: number;
                failed: number;
            } | null;
            /** @description One sentence once it ends. */
            summary: string | null;
            error: string | null;
            /** @description The CLI's estimate, in dollars; a request's counts its runs too. Null while none was reported. */
            costUsd: number | null;
            /** @description When it was made, as an ISO 8601 time. */
            createdAt: string;
            /** @description When it started working, as an ISO 8601 time. */
            startedAt: string | null;
            /** @description When it ended, as an ISO 8601 time. */
            finishedAt: string | null;
            /** @description When its runner last recorded it, as an ISO 8601 time. */
            updatedAt: string;
        };
        /**
         * @description A `request`, whose one step is its factory’s orchestrator, or an `automation` run, with steps.
         * @enum {string}
         */
        RunKind: "request" | "automation";
        /**
         * @description A run's status. The set only grows.
         * @enum {string}
         */
        RunStatus: "queued" | "running" | "needs-approval" | "completed" | "failed" | "rejected" | "waiting" | "expired" | "cancelled";
        /**
         * @description The cell's grouping of a run's status, which the list filters and counts by: `active` (queued, running, waiting on a run), `needs-you` (needs approval, waiting on a person, or a request at work one of whose runs needs someone), `completed`, `failed` (failed, expired) and `stopped` (cancelled, rejected).
         * @enum {string}
         */
        Phase: "active" | "needs-you" | "completed" | "failed" | "stopped";
        /**
         * @description How a run was started: a schedule (`cron`), an event, a poll, or someone’s act (`manual`). A run a request started is `manual`.
         * @enum {string}
         */
        RunTrigger: "cron" | "event" | "poll" | "manual";
        /** @description The pull request or issue a run is about. */
        RunItem: {
            /** @description Its page, an https address. */
            url: string;
            /** @description Written by its author: text, never markup. */
            title: string;
            /** @enum {string|null} */
            kind: "pr" | "issue" | null;
            /** @description `owner/name`, when known. */
            repo: string | null;
            number: number | null;
        };
        /** @description How many runs are in each phase. */
        PhaseCounts: {
            active: number;
            "needs-you": number;
            completed: number;
            failed: number;
            stopped: number;
        };
        /** @description A run's request to be approved: present while the run needs approval, and once answered. The cell records the answer; the run's runner acts on it. */
        RunApproval: {
            /** @description The version an answer applies to: the run's factory version. */
            version: number;
            /** @description Why it asks, in one plain sentence. */
            reason: string;
            /** @description Who may answer: anyone on the factory's owning team. */
            team: {
                id: string;
                name: string;
            };
            /** @description Whether the caller is on that team. */
            mayAnswer: boolean;
            /** @description What approving lets run, as the definition writes it: each command and each agent step. Empty for a request. */
            will: {
                commands: {
                    step: string;
                    command: string;
                }[];
                agents: {
                    step: string;
                    agent: string | null;
                    prompt: string | null;
                }[];
            };
            /** @description The answer for this version: the first one given. */
            answer: {
                /** @enum {string} */
                decision: "approved" | "dismissed";
                /** @description The global id of the person who answered. */
                by: string;
                /** @description When, as an ISO 8601 time. */
                at: string;
            } | null;
        };
        /** @description Approve or dismiss a run waiting for approval, at the version the caller was shown: the run's factory version. */
        ApprovalAnswer: {
            /** @enum {string} */
            decision: "approve" | "dismiss";
            version: number;
        };
        RunDetail: {
            run: components["schemas"]["RunSummary"];
            /** @description The request that started it, which whoever sees the run sees. */
            parent: {
                id: string;
                title: string;
            } | null;
            /** @description An automation run's steps, in file order; a request's one `orchestrator` step. */
            steps: components["schemas"]["StepSummary"][];
            /** @description A request's own facts; null for an automation run. */
            request: {
                /** @description The request as the person gave it. Untrusted (it may be a pasted ticket): show it as plain text only. */
                text: string;
                budget: {
                    usd: number;
                    runs: number;
                } | null;
                /** @description Its turns and its runs, as the engine sums them; runs it started. */
                spent: {
                    usd: number;
                    runs: number;
                };
                /** @description The orchestrator's open question: when it was asked, and its deadline. Its text is not in the cell. */
                question: {
                    at: string;
                    until: string;
                } | null;
            } | null;
            /** @description The automation runs a request started, in the order it started them. */
            children: components["schemas"]["RunSummary"][];
            /** @description The cloud session holding the orchestrator's conversation, once there is one. Always null for now. */
            conversation: {
                sessionId: string;
            } | null;
            source: components["schemas"]["RunSource"] | null;
            approval: components["schemas"]["RunApproval"] | null;
        };
        StepSummary: {
            /** @description The step's id in its automation, or `orchestrator`. */
            id: string;
            kind: components["schemas"]["StepKind"];
            status: components["schemas"]["StepStatus"];
            /** @description From 1: the nth time it ran in this run. */
            attempt: number;
            /** @description The agent file it names (`agents/<name>.md`), if any. */
            agent: string | null;
            model: string | null;
            startedAt: string | null;
            finishedAt: string | null;
            costUsd: number | null;
            error: string | null;
            /** @description Why it was skipped. */
            skipped: string | null;
            /** @description The latest execution's outputs, checked against their types. */
            outputs: {
                [key: string]: string | number | boolean;
            } | null;
            /** @description The documents it wrote; empty when none. */
            artifacts: {
                name: string;
                bytes: number;
            }[];
            /** @description An agent step's turns, summed over its latest attempt. */
            turn: {
                /** @description The turns it took. */
                turns: number | null;
                /** @description Its own cap, if any. */
                maxTurns: number | null;
                /** @description Tools a turn was refused, each once, in first-seen order. */
                deniedTools: string[];
            } | null;
            /** @description A command step's result; null for an agent step, or before it ran. */
            command: {
                exitCode: number | null;
                signal: string | null;
                stdoutBytes: number | null;
                stderrBytes: number | null;
                /** @description Whether its output was cut. */
                truncated: boolean;
            } | null;
            /** @description Its earlier attempts in this run, oldest first; empty when none. */
            previous: {
                attempt: number;
                status: components["schemas"]["StepStatus"];
                error: string | null;
                finishedAt: string | null;
                costUsd: number | null;
                turns: number | null;
            }[];
            /** @description Whether Consola reminded the agent to finish its step. */
            reminded: boolean;
            /** @description The end of what its latest attempt printed, as its runner last sent it: at most 16 KiB of each. Untrusted: show it as plain text. */
            output: {
                stdout: string;
                stderr: string;
                /** @description Whether more came before what is kept. */
                truncated: boolean;
            } | null;
            definition: components["schemas"]["StepDefinition"] | null;
        };
        /** @enum {string} */
        StepKind: "agent" | "run" | "orchestrator";
        /**
         * @description A step's status. The set only grows.
         * @enum {string}
         */
        StepStatus: "pending" | "queued" | "running" | "completed" | "failed" | "skipped" | "reported" | "not-run" | "waiting";
        /** @description What a step was asked, as its automation's file says at the factory version the run executed. */
        StepDefinition: {
            /** @enum {string} */
            kind: "agent" | "run";
            /** @description The prompt as written: a template, never rendered. */
            prompt: string | null;
            action: string | null;
            /** @description The agent it runs as (`agents/<name>.md`). */
            agent: string | null;
            /** @description The command, as written. */
            run: string | null;
            /** @description The command's environment, as written (templates). */
            env: {
                name: string;
                value: string;
            }[];
            /** @description Its condition, as written. */
            if: string | null;
            /** @description The outputs it declares, each type in words (`one of: a, b`). */
            outputs: {
                name: string;
                type: string;
            }[];
            /** @description The artifacts it declares. */
            artifacts: string[];
            maxTurns: number | null;
            /** @description A command's time limit. */
            timeoutMs: number | null;
            /** @description The file it is written in, in the factory. */
            file: string;
            /** @description The factory version it was read from. */
            version: number;
            /** @description The step's lines in its run's `source.text`; null when they are not known. */
            range: components["schemas"]["LineRange"] | null;
        };
        /** @description Lines of a file, from 1, both ends included. */
        LineRange: {
            start: number;
            end: number;
        };
        /** @description The file behind an automation run, at the factory version it executed, and the automation's own lines in it (`range`: the whole file for `automations/<name>.yaml`). Null for a request (its orchestrator has no file in the cell yet), and when that version does not define the automation. */
        RunSource: {
            /** @description The file the automation is written in: `automations/<name>.yaml`, or `factory.yml`. */
            path: string;
            /** @description The factory version the run executed. */
            version: number;
            /** @description The factory's latest version now. */
            latestVersion: number;
            /** @description The whole file, at that version. */
            text: string;
            range: components["schemas"]["LineRange"];
            trigger: {
                kind: components["schemas"]["RunTrigger"];
                /** @description The cron schedule, the event(s), or the poll's check, as written. */
                detail: string | null;
            };
            /** @enum {string} */
            mode: "auto" | "confirm" | "notify";
            /** @description Which items a run on demand takes; empty when none. */
            appliesTo: ("pr" | "issue")[];
        };
        /** @description What the workspace's connected runner offers: where a session can start, and with what. */
        CloudSessionOptions: {
            /** @description Each as `owner/name`. */
            repositories: string[];
            harnesses: ("claude" | "codex")[];
        };
        /** @description A person's cloud session: a sandbox the workspace's runner runs for them. */
        CloudSession: {
            id: string;
            workspaceId: string;
            /** @description The global id of the person who started it, the only one who sees it. */
            personId: string;
            /** @description The repository, as `owner/name`. */
            repository: string;
            /**
             * @description The agent CLI the session runs.
             * @enum {string}
             */
            harness: "claude" | "codex";
            /**
             * @description `starting` goes to `running` or `failed`, and `running` to `stopped` or `failed`; `stopped` and `failed` are ends.
             * @enum {string}
             */
            status: "starting" | "running" | "stopped" | "failed";
            title: string | null;
            /** @description The origin the session's host listens on, once the runner reported it. */
            hostUrl: string | null;
            /** @description The message the runner reported for a failure (its provider’s or its start script’s), shown as it came. A failed session has this or `errorCode`, never both. */
            error: string | null;
            /**
             * @description A failure the cell decided itself, which the web app words: the runner restarted, could not be reached, or failed without a message.
             * @enum {string|null}
             */
            errorCode: "runner_restarted" | "runner_unreachable" | "runner_failed" | null;
            /** @description The runner the start was handed to. */
            runnerId: string;
            /** @description When it was started, in epoch seconds. */
            createdAt: number;
            /** @description When it ended, in epoch seconds; null while it lives. */
            endedAt: number | null;
        };
        /** @description Exactly these two fields: a body naming anything else, a workspace above all, is refused. */
        NewCloudSession: {
            /** @description One the runner offers, as `owner/name`; its name may not start with a dot. */
            repository: string;
            /**
             * @description The agent CLI the session runs.
             * @enum {string}
             */
            harness: "claude" | "codex";
        };
        CloudSessionPass: {
            /** @description The session pass, a compact JWS signed with the cell's own key, which the session's host checks. */
            pass: string;
            /** @description The origin the session's host listens on. */
            hostUrl: string;
            /** @description When the pass expires, in epoch seconds: its `exp`. */
            expiresAt: number;
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
