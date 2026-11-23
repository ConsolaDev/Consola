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
    };
    responses: never;
    parameters: never;
    requestBodies: never;
    headers: never;
    pathItems: never;
}
export type $defs = Record<string, never>;
export type operations = Record<string, never>;
