/**
 * The types of Consola Cloud's API, generated from apps/cloud-api/openapi.json by
 * `pnpm --filter @consola/cloud-web api:generate`. Never edit this file by hand.
 */

export interface paths {
    "/api/me": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Who is signed in */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description The person and their active workspace. */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["Me"];
                    };
                };
                /** @description Nobody is signed in. */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {string} */
                            error: "signed_out";
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
    "/api/me/workspace": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        /** Make one of my workspaces active */
        put: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": components["schemas"]["ActiveWorkspace"];
                };
            };
            responses: {
                /** @description The workspace now active. */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["MyWorkspace"];
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
                /** @description Nobody is signed in. */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {string} */
                            error: "signed_out";
                        };
                    };
                };
                /** @description The change did not come from the web app. */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {string} */
                            error: "bad_origin";
                        };
                    };
                };
                /** @description No workspace of the person’s has that id, whether or not one exists. */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {string} */
                            error: "workspace_not_found";
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
            };
        };
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/me/workspace/icon": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        /**
         * Set or clear my active workspace's icon
         * @description Only an owner or an admin of the workspace may. It changes the icon alone, never the workspace’s name, slug or region.
         */
        put: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": components["schemas"]["WorkspaceIconChange"];
                };
            };
            responses: {
                /** @description The workspace, wearing the icon it was given. */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["MyWorkspace"];
                    };
                };
                /** @description The icon is not one of the set, or the body is not what the route takes. */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {string} */
                            error: "icon_unknown";
                        } | {
                            /** @enum {string} */
                            error: "invalid_request";
                        };
                    };
                };
                /** @description Nobody is signed in. */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {string} */
                            error: "signed_out";
                        };
                    };
                };
                /** @description The person is not in the workspace, is a member who may not change it, or the change did not come from the web app. */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {string} */
                            error: "not_a_member";
                        } | {
                            /** @enum {string} */
                            error: "not_allowed";
                        } | {
                            /** @enum {string} */
                            error: "bad_origin";
                        };
                    };
                };
                /** @description The session has no active workspace. */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {string} */
                            error: "no_active_workspace";
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
            };
        };
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/me/workspace/members": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * My active workspace's members, in the order they joined
         * @description Every member of the workspace may list them. A person is named by the id the rest of the API knows them by (`id`), so the web app can put a name to the ids other answers hold.
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
                /** @description The members, with their roles. */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            members: components["schemas"]["WorkspaceMember"][];
                        };
                    };
                };
                /** @description Nobody is signed in. */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {string} */
                            error: "signed_out";
                        };
                    };
                };
                /** @description The person is not in the workspace their session names, any more or ever. */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {string} */
                            error: "not_a_member";
                        };
                    };
                };
                /** @description The session has no active workspace. */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {string} */
                            error: "no_active_workspace";
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
    "/api/workspaces": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** My workspaces, in the order I joined them */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description The person’s workspaces. */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            workspaces: components["schemas"]["MyWorkspace"][];
                        };
                    };
                };
                /** @description Nobody is signed in. */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {string} */
                            error: "signed_out";
                        };
                    };
                };
            };
        };
        put?: never;
        /** Make a workspace, owned by me and active in my session */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": components["schemas"]["NewWorkspace"];
                };
            };
            responses: {
                /** @description The workspace made, with the person as its owner. */
                201: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["MyWorkspace"];
                    };
                };
                /** @description The rules refuse the workspace, or the body is not JSON. */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["InvalidWorkspace"] | {
                            /** @enum {string} */
                            error: "invalid_request";
                        };
                    };
                };
                /** @description Nobody is signed in. */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {string} */
                            error: "signed_out";
                        };
                    };
                };
                /** @description The change did not come from the web app. */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {string} */
                            error: "bad_origin";
                        };
                    };
                };
                /** @description A workspace has that slug. */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {string} */
                            error: "slug_taken";
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
            };
        };
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
                /** @description No `x-consola-workspace` header: the request does not say which workspace its page shows. */
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
                /** @description No session: the person is signed out. */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {string} */
                            error: "signed_out";
                        };
                    };
                };
                /** @description The person is not a member of the workspace their session has active, or no longer. */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {string} */
                            error: "not_a_member";
                        };
                    };
                };
                /** @description The session has no workspace active (`no_active_workspace`), or another than the page shows (`workspace_switched`): another tab switched it. Loading the page again is the fix. */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {string} */
                            error: "no_active_workspace";
                        } | {
                            /** @enum {string} */
                            error: "workspace_switched";
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
                /** @description The rules refuse the name, or the body is not what the route takes. Or (`invalid_request`): No `x-consola-workspace` header: the request does not say which workspace its page shows. */
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
                /** @description No session: the person is signed out. */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {string} */
                            error: "signed_out";
                        };
                    };
                };
                /** @description The caller’s role does not manage teams (`not_allowed`). Or: The person is not a member of the workspace their session has active, or no longer (`not_a_member`), or the change did not come from the web app (`bad_origin`). */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {string} */
                            error: "not_allowed";
                        } | {
                            /** @enum {string} */
                            error: "not_a_member";
                        } | {
                            /** @enum {string} */
                            error: "bad_origin";
                        };
                    };
                };
                /** @description Another team of the workspace has the name, in any case (`name_taken`). Or: The session has no workspace active (`no_active_workspace`), or another than the page shows (`workspace_switched`): another tab switched it. Loading the page again is the fix. */
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
                            error: "no_active_workspace";
                        } | {
                            /** @enum {string} */
                            error: "workspace_switched";
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
                /** @description No `x-consola-workspace` header: the request does not say which workspace its page shows. */
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
                /** @description No session: the person is signed out. */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {string} */
                            error: "signed_out";
                        };
                    };
                };
                /** @description The caller’s role does not manage teams (`not_allowed`). Or: The person is not a member of the workspace their session has active, or no longer (`not_a_member`), or the change did not come from the web app (`bad_origin`). */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {string} */
                            error: "not_allowed";
                        } | {
                            /** @enum {string} */
                            error: "not_a_member";
                        } | {
                            /** @enum {string} */
                            error: "bad_origin";
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
                /** @description The workspace's first team, which is never deleted (`first_team`), or a team that owns a factory, which is not deleted while it does (`owns_factories`). Or: The session has no workspace active (`no_active_workspace`), or another than the page shows (`workspace_switched`): another tab switched it. Loading the page again is the fix. */
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
                            error: "no_active_workspace";
                        } | {
                            /** @enum {string} */
                            error: "workspace_switched";
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
                /** @description The rules refuse the name, or the body is not what the route takes. Or (`invalid_request`): No `x-consola-workspace` header: the request does not say which workspace its page shows. */
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
                /** @description No session: the person is signed out. */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {string} */
                            error: "signed_out";
                        };
                    };
                };
                /** @description The caller’s role does not manage teams (`not_allowed`). Or: The person is not a member of the workspace their session has active, or no longer (`not_a_member`), or the change did not come from the web app (`bad_origin`). */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {string} */
                            error: "not_allowed";
                        } | {
                            /** @enum {string} */
                            error: "not_a_member";
                        } | {
                            /** @enum {string} */
                            error: "bad_origin";
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
                /** @description Another team of the workspace has the name, in any case (`name_taken`). Or: The session has no workspace active (`no_active_workspace`), or another than the page shows (`workspace_switched`): another tab switched it. Loading the page again is the fix. */
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
                            error: "no_active_workspace";
                        } | {
                            /** @enum {string} */
                            error: "workspace_switched";
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
                    /** @description The person's id. */
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
                /** @description No `x-consola-workspace` header: the request does not say which workspace its page shows. */
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
                /** @description No session: the person is signed out. */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {string} */
                            error: "signed_out";
                        };
                    };
                };
                /** @description The caller’s role does not manage teams (`not_allowed`). Or: The person is not a member of the workspace their session has active, or no longer (`not_a_member`), or the change did not come from the web app (`bad_origin`). */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {string} */
                            error: "not_allowed";
                        } | {
                            /** @enum {string} */
                            error: "not_a_member";
                        } | {
                            /** @enum {string} */
                            error: "bad_origin";
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
                /** @description The person is not a member of the workspace (`not_a_workspace_member`). Or: The session has no workspace active (`no_active_workspace`), or another than the page shows (`workspace_switched`): another tab switched it. Loading the page again is the fix. */
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
                            error: "no_active_workspace";
                        } | {
                            /** @enum {string} */
                            error: "workspace_switched";
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
                    /** @description The person's id. */
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
                /** @description No `x-consola-workspace` header: the request does not say which workspace its page shows. */
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
                /** @description No session: the person is signed out. */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {string} */
                            error: "signed_out";
                        };
                    };
                };
                /** @description The caller’s role does not manage teams (`not_allowed`). Or: The person is not a member of the workspace their session has active, or no longer (`not_a_member`), or the change did not come from the web app (`bad_origin`). */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {string} */
                            error: "not_allowed";
                        } | {
                            /** @enum {string} */
                            error: "not_a_member";
                        } | {
                            /** @enum {string} */
                            error: "bad_origin";
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
                /** @description The session has no workspace active (`no_active_workspace`), or another than the page shows (`workspace_switched`): another tab switched it. Loading the page again is the fix. */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {string} */
                            error: "no_active_workspace";
                        } | {
                            /** @enum {string} */
                            error: "workspace_switched";
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
                /** @description No `x-consola-workspace` header: the request does not say which workspace its page shows. */
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
                /** @description No session: the person is signed out. */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {string} */
                            error: "signed_out";
                        };
                    };
                };
                /** @description The person is not a member of the workspace their session has active, or no longer. */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {string} */
                            error: "not_a_member";
                        };
                    };
                };
                /** @description The session has no workspace active (`no_active_workspace`), or another than the page shows (`workspace_switched`): another tab switched it. Loading the page again is the fix. */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {string} */
                            error: "no_active_workspace";
                        } | {
                            /** @enum {string} */
                            error: "workspace_switched";
                        };
                    };
                };
            };
        };
        put?: never;
        /**
         * Make a blank factory, owned by a team
         * @description Its files are stored in Consola, and its first version holds none. Owners and admins may make one for any team, a member for a team they are in.
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
                /** @description The rules refuse the name, or the body is not what the route takes. Or (`invalid_request`): No `x-consola-workspace` header: the request does not say which workspace its page shows. */
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
                /** @description No session: the person is signed out. */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {string} */
                            error: "signed_out";
                        };
                    };
                };
                /** @description The person is not a member of the workspace their session has active, or no longer (`not_a_member`), or the change did not come from the web app (`bad_origin`). */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {string} */
                            error: "not_a_member";
                        } | {
                            /** @enum {string} */
                            error: "bad_origin";
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
                /** @description Another factory of the workspace has the name, in any case (`name_taken`). Or: The session has no workspace active (`no_active_workspace`), or another than the page shows (`workspace_switched`): another tab switched it. Loading the page again is the fix. */
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
                            error: "no_active_workspace";
                        } | {
                            /** @enum {string} */
                            error: "workspace_switched";
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
                /** @description No `x-consola-workspace` header: the request does not say which workspace its page shows. */
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
                /** @description No session: the person is signed out. */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {string} */
                            error: "signed_out";
                        };
                    };
                };
                /** @description The person is not a member of the workspace their session has active, or no longer. */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {string} */
                            error: "not_a_member";
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
                /** @description The session has no workspace active (`no_active_workspace`), or another than the page shows (`workspace_switched`): another tab switched it. Loading the page again is the fix. */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {string} */
                            error: "no_active_workspace";
                        } | {
                            /** @enum {string} */
                            error: "workspace_switched";
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
                /** @description The rules refuse the name, or the body is not what the route takes: neither a name nor a team is one. Or (`invalid_request`): No `x-consola-workspace` header: the request does not say which workspace its page shows. */
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
                /** @description No session: the person is signed out. */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {string} */
                            error: "signed_out";
                        };
                    };
                };
                /** @description The person is not a member of the workspace their session has active, or no longer (`not_a_member`), or the change did not come from the web app (`bad_origin`). */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {string} */
                            error: "not_a_member";
                        } | {
                            /** @enum {string} */
                            error: "bad_origin";
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
                /** @description Another factory of the workspace has the name, in any case (`name_taken`). Or: The session has no workspace active (`no_active_workspace`), or another than the page shows (`workspace_switched`): another tab switched it. Loading the page again is the fix. */
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
                            error: "no_active_workspace";
                        } | {
                            /** @enum {string} */
                            error: "workspace_switched";
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
                /** @description The version is not a number from 1. Or (`invalid_request`): No `x-consola-workspace` header: the request does not say which workspace its page shows. */
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
                /** @description No session: the person is signed out. */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {string} */
                            error: "signed_out";
                        };
                    };
                };
                /** @description The person is not a member of the workspace their session has active, or no longer. */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {string} */
                            error: "not_a_member";
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
                /** @description The session has no workspace active (`no_active_workspace`), or another than the page shows (`workspace_switched`): another tab switched it. Loading the page again is the fix. */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {string} */
                            error: "no_active_workspace";
                        } | {
                            /** @enum {string} */
                            error: "workspace_switched";
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
                /** @description The files fail the factory schema (`invalid_files`), or the body is not what the route takes. Or (`invalid_request`): No `x-consola-workspace` header: the request does not say which workspace its page shows. */
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
                /** @description No session: the person is signed out. */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {string} */
                            error: "signed_out";
                        };
                    };
                };
                /** @description The person is not a member of the workspace their session has active, or no longer (`not_a_member`), or the change did not come from the web app (`bad_origin`). */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {string} */
                            error: "not_a_member";
                        } | {
                            /** @enum {string} */
                            error: "bad_origin";
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
                /** @description The factory has a newer version than the one the files were edited from (`version_moved`). Or: The session has no workspace active (`no_active_workspace`), or another than the page shows (`workspace_switched`): another tab switched it. Loading the page again is the fix. */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["VersionMoved"] | {
                            /** @enum {string} */
                            error: "no_active_workspace";
                        } | {
                            /** @enum {string} */
                            error: "workspace_switched";
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
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/factory-templates": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * The ready-made factory files a person can start from
         * @description The same for every workspace. A template’s files reach a factory only through `POST /api/factories/{factoryId}/versions`, which checks them as any other files.
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
                /** @description The templates. */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["FactoryTemplate"][];
                    };
                };
                /** @description No `x-consola-workspace` header: the request does not say which workspace its page shows. */
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
                /** @description No session: the person is signed out. */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {string} */
                            error: "signed_out";
                        };
                    };
                };
                /** @description The person is not a member of the workspace their session has active, or no longer. */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {string} */
                            error: "not_a_member";
                        };
                    };
                };
                /** @description The session has no workspace active (`no_active_workspace`), or another than the page shows (`workspace_switched`): another tab switched it. Loading the page again is the fix. */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {string} */
                            error: "no_active_workspace";
                        } | {
                            /** @enum {string} */
                            error: "workspace_switched";
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
                /** @description A phase or trigger Consola does not know, a cursor it did not give, a `limit` out of range or a `q` too long. Or (`invalid_request`): No `x-consola-workspace` header: the request does not say which workspace its page shows. */
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
                /** @description No session: the person is signed out. */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {string} */
                            error: "signed_out";
                        };
                    };
                };
                /** @description The person is not a member of the workspace their session has active, or no longer. */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {string} */
                            error: "not_a_member";
                        };
                    };
                };
                /** @description The session has no workspace active (`no_active_workspace`), or another than the page shows (`workspace_switched`): another tab switched it. Loading the page again is the fix. */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {string} */
                            error: "no_active_workspace";
                        } | {
                            /** @enum {string} */
                            error: "workspace_switched";
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
         * @description Anyone on the run's factory's owning team may answer, whatever their workspace role, and the first answer for a version is the one kept. Consola records it and does not change the run: its runner acts on it.
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
                /** @description The body is not what the route takes. Or (`invalid_request`): No `x-consola-workspace` header: the request does not say which workspace its page shows. */
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
                /** @description No session: the person is signed out. */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {string} */
                            error: "signed_out";
                        };
                    };
                };
                /** @description The caller sees the run, but is not on its factory's owning team (`not_allowed`). Or: The person is not a member of the workspace their session has active, or no longer (`not_a_member`), or the change did not come from the web app (`bad_origin`). */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {string} */
                            error: "not_allowed";
                        } | {
                            /** @enum {string} */
                            error: "not_a_member";
                        } | {
                            /** @enum {string} */
                            error: "bad_origin";
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
                /** @description The run is not waiting for approval (`not_waiting`), this version was answered already (`already_answered`: the first answer stands), or the version is not the run's (`version_moved`). Or: The session has no workspace active (`no_active_workspace`), or another than the page shows (`workspace_switched`): another tab switched it. Loading the page again is the fix. */
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
                            error: "no_active_workspace";
                        } | {
                            /** @enum {string} */
                            error: "workspace_switched";
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
                /** @description No `x-consola-workspace` header: the request does not say which workspace its page shows. */
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
                /** @description No session: the person is signed out. */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {string} */
                            error: "signed_out";
                        };
                    };
                };
                /** @description The person is not a member of the workspace their session has active, or no longer. */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {string} */
                            error: "not_a_member";
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
                /** @description The session has no workspace active (`no_active_workspace`), or another than the page shows (`workspace_switched`): another tab switched it. Loading the page again is the fix. */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {string} */
                            error: "no_active_workspace";
                        } | {
                            /** @enum {string} */
                            error: "workspace_switched";
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
                /** @description No `x-consola-workspace` header: the request does not say which workspace its page shows. */
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
                /** @description No session: the person is signed out. */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {string} */
                            error: "signed_out";
                        };
                    };
                };
                /** @description The person is not a member of the workspace their session has active, or no longer. */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {string} */
                            error: "not_a_member";
                        };
                    };
                };
                /** @description The session has no workspace active (`no_active_workspace`), or another than the page shows (`workspace_switched`): another tab switched it. Loading the page again is the fix. */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {string} */
                            error: "no_active_workspace";
                        } | {
                            /** @enum {string} */
                            error: "workspace_switched";
                        };
                    };
                };
                /** @description No runner is configured or connected for the workspace (`no_runner`). */
                503: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {string} */
                            error: "no_runner";
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
        /**
         * The caller's own cloud sessions, newest first (an agent run is listed with the runs)
         * @description A person's session is theirs alone; an agent run, which an automation started, is seen by every member of the workspace.
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
                /** @description The sessions. */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["CloudSession"][];
                    };
                };
                /** @description No `x-consola-workspace` header: the request does not say which workspace its page shows. */
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
                /** @description No session: the person is signed out. */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {string} */
                            error: "signed_out";
                        };
                    };
                };
                /** @description The person is not a member of the workspace their session has active, or no longer. */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {string} */
                            error: "not_a_member";
                        };
                    };
                };
                /** @description The session has no workspace active (`no_active_workspace`), or another than the page shows (`workspace_switched`): another tab switched it. Loading the page again is the fix. */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {string} */
                            error: "no_active_workspace";
                        } | {
                            /** @enum {string} */
                            error: "workspace_switched";
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
                /** @description The runner does not offer the repository (`repository_not_offered`) or the harness (`harness_not_offered`), or the body is not exactly `{ repository, harness }`, each valid (`invalid_request`). Or (`invalid_request`): No `x-consola-workspace` header: the request does not say which workspace its page shows. */
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
                /** @description No session: the person is signed out. */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {string} */
                            error: "signed_out";
                        };
                    };
                };
                /** @description The person is not a member of the workspace their session has active, or no longer (`not_a_member`), or the change did not come from the web app (`bad_origin`). */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {string} */
                            error: "not_a_member";
                        } | {
                            /** @enum {string} */
                            error: "bad_origin";
                        };
                    };
                };
                /** @description The session has no workspace active (`no_active_workspace`), or another than the page shows (`workspace_switched`): another tab switched it. Loading the page again is the fix. */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {string} */
                            error: "no_active_workspace";
                        } | {
                            /** @enum {string} */
                            error: "workspace_switched";
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
                /** @description No runner is configured or connected for the workspace (`no_runner`): nothing was recorded. */
                503: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {string} */
                            error: "no_runner";
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
        /** One of the caller’s own cloud sessions, or one of the workspace’s agent runs */
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
                /** @description No `x-consola-workspace` header: the request does not say which workspace its page shows. */
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
                /** @description No session: the person is signed out. */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {string} */
                            error: "signed_out";
                        };
                    };
                };
                /** @description The person is not a member of the workspace their session has active, or no longer. */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {string} */
                            error: "not_a_member";
                        };
                    };
                };
                /** @description The caller sees no such session: none, another person's or another workspace's, as if it did not exist. */
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
                /** @description The session has no workspace active (`no_active_workspace`), or another than the page shows (`workspace_switched`): another tab switched it. Loading the page again is the fix. */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {string} */
                            error: "no_active_workspace";
                        } | {
                            /** @enum {string} */
                            error: "workspace_switched";
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
         * Stop one of the caller’s own cloud sessions, or one of the workspace’s agent runs
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
                /** @description No `x-consola-workspace` header: the request does not say which workspace its page shows. */
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
                /** @description No session: the person is signed out. */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {string} */
                            error: "signed_out";
                        };
                    };
                };
                /** @description The person is not a member of the workspace their session has active, or no longer (`not_a_member`), or the change did not come from the web app (`bad_origin`). */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {string} */
                            error: "not_a_member";
                        } | {
                            /** @enum {string} */
                            error: "bad_origin";
                        };
                    };
                };
                /** @description The caller sees no such session: none, another person's or another workspace's, as if it did not exist. */
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
                /** @description The session has no workspace active (`no_active_workspace`), or another than the page shows (`workspace_switched`): another tab switched it. Loading the page again is the fix. */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {string} */
                            error: "no_active_workspace";
                        } | {
                            /** @enum {string} */
                            error: "workspace_switched";
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
         * A pass to a running session the caller sees: their own, or an agent run of the workspace
         * @description The pass lasts five minutes (the runner protocol's cap); ask for another when it runs out. No answer of the route is kept by a cache (`Cache-Control: no-store`) but the refusals before it runs: `requireCaller`'s and the origin check's.
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
                /** @description No `x-consola-workspace` header: the request does not say which workspace its page shows. */
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
                /** @description No session: the person is signed out. */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {string} */
                            error: "signed_out";
                        };
                    };
                };
                /** @description The person is not a member of the workspace their session has active, or no longer (`not_a_member`), or the change did not come from the web app (`bad_origin`). */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {string} */
                            error: "not_a_member";
                        } | {
                            /** @enum {string} */
                            error: "bad_origin";
                        };
                    };
                };
                /** @description The caller sees no such running session whose host has an address: none, one still starting or ended, another person's or another workspace's. */
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
                /** @description The session has no workspace active (`no_active_workspace`), or another than the page shows (`workspace_switched`): another tab switched it. Loading the page again is the fix. */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {string} */
                            error: "no_active_workspace";
                        } | {
                            /** @enum {string} */
                            error: "workspace_switched";
                        };
                    };
                };
                /** @description Consola has no pass key here, and so no runner (`no_runner`). */
                503: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {string} */
                            error: "no_runner";
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
    "/api/connections": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * What my session's active workspace is connected to
         * @description Any member may read it; `canManage` says whether they may change it. Takes `x-consola-workspace`.
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
                /** @description The workspace’s connections. */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["Connections"];
                    };
                };
                /** @description No `x-consola-workspace` header: the request does not say which workspace its page shows. */
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
                /** @description No session: the person is signed out. */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {string} */
                            error: "signed_out";
                        };
                    };
                };
                /** @description The person is not a member of the workspace their session has active, or no longer. */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {string} */
                            error: "not_a_member";
                        };
                    };
                };
                /** @description The session has no workspace active (`no_active_workspace`), or another than the page shows (`workspace_switched`): another tab switched it. Loading the page again is the fix. */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {string} */
                            error: "no_active_workspace";
                        } | {
                            /** @enum {string} */
                            error: "workspace_switched";
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
    "/api/connections/github/install": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Start connecting GitHub to my active workspace
         * @description The addresses on GitHub a Connect goes to, each carrying one state signed for this person in this session. Only an owner or admin may. No cache keeps the answer (`Cache-Control: no-store`).
         */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Where to send the person. */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["GitHubInstallAddress"];
                    };
                };
                /** @description No `x-consola-workspace` header: the request does not say which workspace its page shows. */
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
                /** @description No session: the person is signed out. */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {string} */
                            error: "signed_out";
                        };
                    };
                };
                /** @description The person is not a member of the workspace their session has active (`not_a_member`), is not an owner or admin of it (`not_allowed`), or the request did not come from the web app (`bad_origin`). */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {string} */
                            error: "not_a_member";
                        } | {
                            /** @enum {string} */
                            error: "not_allowed";
                        } | {
                            /** @enum {string} */
                            error: "bad_origin";
                        };
                    };
                };
                /** @description The session has no workspace active (`no_active_workspace`), or another than the page shows (`workspace_switched`): another tab switched it. Loading the page again is the fix. */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {string} */
                            error: "no_active_workspace";
                        } | {
                            /** @enum {string} */
                            error: "workspace_switched";
                        };
                    };
                };
                /** @description This server has no GitHub App settings. */
                503: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {string} */
                            error: "github_not_configured";
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
    "/api/github/callback": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Where GitHub sends a person back after signing in or installing the app
         * @description The GitHub App’s callback URL, reached by a browser redirect from GitHub with `state`, `code`, `installation_id`, `setup_action` or `error`. It never answers JSON. Back from installing the app (an `installation_id`), it records the installation. Back from signing in (no `installation_id`), it asks GitHub for the installations the person administers that this workspace does not hold: with one no workspace holds, the page offers them (`choose`, with a signed `choice`); with only ones other workspaces hold, the page says so (`taken_elsewhere`, with a signed `choice` naming them); with none, the person goes on to install the app. Otherwise it redirects to the web app’s Settings, on its Connections page, with how the Connect ended in `?github=`: one of `choose`, `taken_elsewhere`, `connected`, `already_connected`, `requested`, `cancelled`, `bad_state`, `expired`, `not_allowed`, `code_refused`, `not_installer`, `not_account_admin`, `taken`, `invalid`, `unavailable`, `not_configured`, `signed_out`.
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
                /** @description To `<PUBLIC_URL>/?github=<result>#/settings/connections`, with `&choice=<a signed choice>` when the result is `choose` or `taken_elsewhere`; or on to the app’s install page on GitHub, with a fresh state, when the person signed in and administers no installation this workspace does not hold already. */
                302: {
                    headers: {
                        location: string;
                        [name: string]: unknown;
                    };
                    content?: never;
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
    "/api/connections/github/choice": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * The installations I may choose to connect, once GitHub sent me back from signing in
         * @description Reads a signed choice: the installations of the app on accounts the person administers, which no workspace held when GitHub sent them back. Only for the session that signed in, within a few minutes, in the workspace the Connect was for, and for an owner or admin. Takes `x-consola-workspace`.
         */
        get: {
            parameters: {
                query: {
                    /** @description The signed choice the callback sent the page back with (`&choice=`). */
                    choice: string;
                };
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description The candidates, in the order GitHub listed them. */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["GitHubChoice"];
                    };
                };
                /** @description No choice (`invalid_request`), or one that is not this session’s: not one Consola signed, or another session’s, another person’s above all (`bad_choice`). Or: No `x-consola-workspace` header: the request does not say which workspace its page shows. */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {string} */
                            error: "invalid_request";
                        } | {
                            /** @enum {string} */
                            error: "bad_choice";
                        };
                    };
                };
                /** @description No session: the person is signed out. */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {string} */
                            error: "signed_out";
                        };
                    };
                };
                /** @description The person is not a member of the workspace their session has active (`not_a_member`), or not an owner or admin of it (`not_allowed`). */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {string} */
                            error: "not_a_member";
                        } | {
                            /** @enum {string} */
                            error: "not_allowed";
                        };
                    };
                };
                /** @description The choice was made for another workspace than the session has active now (`choice_for_another_workspace`). Or: The session has no workspace active (`no_active_workspace`), or another than the page shows (`workspace_switched`): another tab switched it. Loading the page again is the fix. */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {string} */
                            error: "choice_for_another_workspace";
                        } | {
                            /** @enum {string} */
                            error: "no_active_workspace";
                        } | {
                            /** @enum {string} */
                            error: "workspace_switched";
                        };
                    };
                };
                /** @description The choice’s few minutes are over: connecting again makes a new one. */
                410: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {string} */
                            error: "choice_expired";
                        };
                    };
                };
            };
        };
        put?: never;
        /**
         * Connect the installation I chose to my active workspace
         * @description Connects one of a signed choice’s candidates, as a fresh install connects one. Everything that can change is checked again, in order: the choice (this session’s, in time, for this workspace), that the installation is one of its candidates, that the person is still an owner or admin, and that no other workspace holds it.
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
                    "application/json": {
                        /** @description The signed choice, as the page read it. */
                        choice: string;
                        /** @description The installation chosen, by its id on GitHub: one of the choice’s. */
                        installationId: number;
                    };
                };
            };
            responses: {
                /** @description The installation is the workspace’s. */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["GitHubChoiceConnected"];
                    };
                };
                /** @description No choice or installation id (`invalid_request`), a choice that is not this session’s (`bad_choice`), or an installation it does not offer (`not_a_candidate`). Or: No `x-consola-workspace` header: the request does not say which workspace its page shows. */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {string} */
                            error: "invalid_request";
                        } | {
                            /** @enum {string} */
                            error: "bad_choice";
                        } | {
                            /** @enum {string} */
                            error: "not_a_candidate";
                        };
                    };
                };
                /** @description No session: the person is signed out. */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {string} */
                            error: "signed_out";
                        };
                    };
                };
                /** @description The person is not a member of the workspace their session has active (`not_a_member`), is not an owner or admin of it (`not_allowed`), or the request did not come from the web app (`bad_origin`). */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {string} */
                            error: "not_a_member";
                        } | {
                            /** @enum {string} */
                            error: "not_allowed";
                        } | {
                            /** @enum {string} */
                            error: "bad_origin";
                        };
                    };
                };
                /** @description The choice was made for another workspace than the session has active now (`choice_for_another_workspace`), or another workspace holds the installation (`installation_taken`). Or: The session has no workspace active (`no_active_workspace`), or another than the page shows (`workspace_switched`): another tab switched it. Loading the page again is the fix. */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {string} */
                            error: "choice_for_another_workspace";
                        } | {
                            /** @enum {string} */
                            error: "installation_taken";
                        } | {
                            /** @enum {string} */
                            error: "no_active_workspace";
                        } | {
                            /** @enum {string} */
                            error: "workspace_switched";
                        };
                    };
                };
                /** @description The choice’s few minutes are over: connecting again makes a new one. */
                410: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {string} */
                            error: "choice_expired";
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
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/connections/github/installations/{installationId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /**
         * Disconnect a GitHub installation from my active workspace
         * @description Removes the workspace’s record. The app stays installed on GitHub until someone uninstalls it there (`settingsUrl`). Only an owner or admin may.
         */
        delete: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description The installation’s id on GitHub, a positive whole number. */
                    installationId: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Disconnected. */
                204: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description No `x-consola-workspace` header, or the id is not a GitHub id. */
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
                /** @description No session: the person is signed out. */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {string} */
                            error: "signed_out";
                        };
                    };
                };
                /** @description The person is not a member of the workspace their session has active (`not_a_member`), is not an owner or admin of it (`not_allowed`), or the request did not come from the web app (`bad_origin`). */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {string} */
                            error: "not_a_member";
                        } | {
                            /** @enum {string} */
                            error: "not_allowed";
                        } | {
                            /** @enum {string} */
                            error: "bad_origin";
                        };
                    };
                };
                /** @description The workspace holds no installation with that id, whether or not another does. */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {string} */
                            error: "installation_not_found";
                        };
                    };
                };
                /** @description The session has no workspace active (`no_active_workspace`), or another than the page shows (`workspace_switched`): another tab switched it. Loading the page again is the fix. */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {string} */
                            error: "no_active_workspace";
                        } | {
                            /** @enum {string} */
                            error: "workspace_switched";
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
    "/api/github/webhooks": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Receive one of the GitHub App’s webhook deliveries
         * @description The GitHub App’s webhook URL. GitHub calls it, with no session and no Origin, so it is outside the origin check. The body is GitHub’s event payload as JSON, read as raw bytes and checked against `X-Hub-Signature-256` (HMAC-SHA256 under the app’s webhook secret, compared in constant time) before anything else is read; `X-GitHub-Event` names the event and `X-GitHub-Delivery` is GitHub’s id of the delivery, which it keeps when it sends a delivery again. The event is recorded for the workspace that holds its installation, once per delivery id, and an event recorded now starts the agent runs its factories’ teams fire.
         */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Answered. */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["GitHubWebhookPong"];
                    };
                };
                /** @description Recorded. */
                201: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["GitHubWebhookRecorded"];
                    };
                };
                /** @description Signed, but a header or the body is not what GitHub sends. */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {string} */
                            error: "invalid_delivery";
                        };
                    };
                };
                /** @description No `X-Hub-Signature-256`, or not GitHub’s signature over this body. */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {string} */
                            error: "bad_signature";
                        };
                    };
                };
                /** @description The workspace had this delivery already: sent again, or replayed. Nothing changed. */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {string} */
                            error: "duplicate_delivery";
                        };
                    };
                };
                /** @description Over the 26214400 bytes (25 MB) GitHub puts in a delivery at most. */
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
                /** @description Dropped: the event came through an installation no workspace holds, or through none. */
                422: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {string} */
                            error: "unknown_installation";
                        } | {
                            /** @enum {string} */
                            error: "no_installation";
                        };
                    };
                };
                /** @description This server has no webhook secret (`GITHUB_WEBHOOK_SECRET`, `webhooks_not_configured`), or its database did not answer (`unavailable`): GitHub’s Redeliver sends it again. */
                503: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {string} */
                            error: "webhooks_not_configured";
                        } | {
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
    "/api/health": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Whether the service can reach its database
         * @description Needs no session: it says nothing a person or a workspace holds.
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
}
export type webhooks = Record<string, never>;
export interface components {
    schemas: {
        /**
         * @description How a Connect ended, as the callback names it in the web app’s `?github=`.
         * @enum {string}
         */
        GitHubCallbackResult: "choose" | "taken_elsewhere" | "connected" | "already_connected" | "requested" | "cancelled" | "bad_state" | "expired" | "not_allowed" | "code_refused" | "not_installer" | "not_account_admin" | "taken" | "invalid" | "unavailable" | "not_configured" | "signed_out";
        /** @description Who is signed in, and their session’s active workspace. */
        Me: {
            user: components["schemas"]["Person"];
            workspace: components["schemas"]["MyWorkspace"] | null;
        };
        Person: {
            id: string;
            name: string;
            email: string;
            image: string | null;
        };
        /** @description A workspace as one of its members sees it. */
        MyWorkspace: {
            id: string;
            name: string;
            slug: string;
            /** @enum {string} */
            region: "eu" | "us";
            /** @enum {string} */
            role: "owner" | "admin" | "member";
            /** @description The icon the workspace wears, by the desktop app’s ids; null for none, which shows its initial. */
            icon: ("layout" | "briefcase" | "home" | "code" | "terminal" | "rocket" | "flask" | "lightbulb" | "palette" | "book" | "graduation-cap" | "globe" | "heart" | "star" | "zap" | "coffee" | "music" | "gamepad" | "camera" | "compass" | "mountain" | "leaf" | "sun" | "moon" | "emoji-rocket" | "emoji-sparkles" | "emoji-lightning" | "emoji-fire" | "emoji-target" | "emoji-brain" | "emoji-bulb" | "emoji-tools" | "emoji-laptop" | "emoji-robot" | "emoji-flask" | "emoji-palette" | "emoji-books" | "emoji-note" | "emoji-briefcase" | "emoji-house" | "emoji-coffee" | "emoji-seedling" | "emoji-tree" | "emoji-mountain" | "emoji-ocean" | "emoji-sun" | "emoji-moon" | "emoji-globe" | "emoji-star" | "emoji-heart" | "emoji-music" | "emoji-gamepad" | "emoji-cat" | "emoji-dog" | "emoji-fox" | "emoji-unicorn") | null;
            /** @description Whether the person may change how the workspace looks (an owner or admin). */
            canManage: boolean;
        };
        ActiveWorkspace: {
            workspaceId: string;
        };
        /** @description An icon from the desktop app’s set, or null to take the icon off. */
        WorkspaceIconChange: {
            icon: string | null;
        };
        /** @description A member of a workspace, as its other members see them. */
        WorkspaceMember: {
            id: string;
            name: string;
            email: string;
            image: string | null;
            /** @enum {string} */
            role: "owner" | "admin" | "member";
        };
        /** @description Every problem, in the order the rules name them. */
        InvalidWorkspace: {
            /** @enum {string} */
            error: "invalid_workspace";
            problems: ("name_missing" | "name_too_long" | "slug_invalid")[];
        };
        /** @description A name (trimmed, at most 64 characters) and a slug of lowercase letters and digits with single dashes between (at most 48). The workspace is made in the deployment’s region, which no request names. */
        NewWorkspace: {
            name: string;
            slug: string;
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
            /** @description Its members’ ids, in the order they joined it: only people who are members of the workspace now. */
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
        /** @description Where the factory's files come from: `stored`, saved in Consola. A GitHub repository comes later. */
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
            /** @description The id of the person who saved it. */
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
        /** @description Ready-made factory files a person can start from, such as an agent team. */
        FactoryTemplate: {
            /** @description The template’s id, such as `code-review-team`. */
            id: string;
            name: string;
            description: string;
            /** @description Its files, by path inside a factory's folder, to merge into a factory through the ordinary save. */
            files: components["schemas"]["FactoryFile"][];
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
            /** @description The id of the person who started it, who may no longer be a member; null for a run no person started. */
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
         * @description Consola's grouping of a run's status, which the list filters and counts by: `active` (queued, running, waiting on a run), `needs-you` (needs approval, waiting on a person, or a request at work one of whose runs needs someone), `completed`, `failed` (failed, expired) and `stopped` (cancelled, rejected).
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
        /** @description A run's request to be approved: present while the run needs approval, and once answered. Consola records the answer; the run's runner acts on it. */
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
                /** @description The id of the person who answered. */
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
                /** @description The orchestrator's open question: when it was asked, and its deadline. Its text is not in Consola. */
                question: {
                    at: string;
                    until: string;
                } | null;
            } | null;
            /** @description The automation runs a request started, in the order it started them. */
            children: components["schemas"]["RunSummary"][];
            /** @description The cloud session holding a request's conversation with its orchestrator, once there is one: an agent run's. Null for an automation run. */
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
        /** @description The file behind an automation run, at the factory version it executed, and the automation's own lines in it (`range`: the whole file for `automations/<name>.yaml`). Null for a request (its orchestrator has no file in Consola yet), and when that version does not define the automation. */
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
        /** @description A cloud session: a sandbox the workspace's runner runs for a person, or an agent run an automation started, which nobody types into. */
        CloudSession: {
            id: string;
            workspaceId: string;
            /** @description The id of the person who started it, the only one who sees it; null for an agent run, which every member of the workspace sees. */
            personId: string | null;
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
            /** @description What the runner named it; for an agent run, Consola's own title (`<automation> · <owner/name>#<number> <title>`), which the runner never replaces. */
            title: string | null;
            /** @description The origin the session's host listens on, once the runner reported it. */
            hostUrl: string | null;
            /** @description The message the runner reported for a failure (its provider’s or its start script’s), shown as it came. A failed session has this or `errorCode`, never both. */
            error: string | null;
            /**
             * @description A failure Consola decided itself, which the web app words: the runner restarted, could not be reached, or failed without a message; for an agent run, also no runner connected (`runner_unavailable`), its repository or harness not offered, or a start Consola could not compose (`agent_run_invalid`).
             * @enum {string|null}
             */
            errorCode: "runner_restarted" | "runner_unreachable" | "runner_failed" | "runner_unavailable" | "repository_not_offered" | "harness_not_offered" | "agent_run_invalid" | null;
            /** @description The runner the start was handed to; null for an agent run no runner took, which ended as it was recorded. */
            runnerId: string | null;
            /** @description When it was started, in epoch seconds. */
            createdAt: number;
            /** @description When it ended, in epoch seconds; null while it lives. */
            endedAt: number | null;
            /** @description What started an agent run; null for a person's session. */
            origin: components["schemas"]["CloudSessionOrigin"] | null;
            /** @description The runner's last report of an agent run; null until it sent one. */
            agentRun: components["schemas"]["AgentRunReport"] | null;
        };
        /** @description What started an agent run: an automation of a factory's agent team, on an item. */
        CloudSessionOrigin: {
            /** @enum {string} */
            kind: "automation";
            factoryId: string;
            factoryName: string;
            /** @description The automation that fired, by name. */
            automation: string;
            /** @description The agent that takes the first turn: the automation's, by default the orchestrator. */
            agent: string;
            /** @description The GitHub pull request the event was about. */
            item: {
                /** @enum {string} */
                kind: "pull_request";
                /** @description As `owner/name`. */
                repository: string;
                number: number;
                url: string;
                title: string;
                /** @description The commit the run checks out. */
                headSha: string;
            };
        };
        /** @description The runner's last report of an agent run, as it sent it. */
        AgentRunReport: {
            /** @enum {string} */
            state: "working" | "waiting" | "done" | "failed";
            /** @description The first agent's last message, as the runner reported it. */
            summary?: string;
            /** @description The agents the first agent dispatched. */
            agents?: {
                /** @description The dispatched agent's conversation. */
                id: string;
                /** @description Its name in the factory. */
                agent: string;
                /** @enum {string} */
                status: "working" | "done" | "failed";
                summary?: string;
            }[];
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
            /** @description The session pass, a compact JWS signed with Consola's own pass key, which the session's host checks. */
            pass: string;
            /** @description The origin the session's host listens on. */
            hostUrl: string;
            /** @description When the pass expires, in epoch seconds: its `exp`. */
            expiresAt: number;
        };
        /** @description What the workspace is connected to. */
        Connections: {
            /** @description Whether the person may connect and disconnect: an owner or admin. */
            canManage: boolean;
            github: {
                /** @description Whether this server has the GitHub App’s settings. */
                configured: boolean;
                installations: components["schemas"]["GitHubConnection"][];
            };
        };
        /** @description A GitHub App installation the workspace holds. */
        GitHubConnection: {
            id: number;
            account: components["schemas"]["GitHubAccount"];
            /** Format: date-time */
            connectedAt: string;
            /** @description Where on GitHub its repositories are chosen, and it is uninstalled. */
            settingsUrl: string;
            repositories: components["schemas"]["GitHubRepositories"];
        };
        /** @description The GitHub account, an organisation or a person, the app is installed on. */
        GitHubAccount: {
            id: number;
            login: string;
            /** @enum {string} */
            type: "Organization" | "User";
        };
        /** @description What GitHub says the installation covers now: its repositories, `gone` when GitHub no longer has the installation (uninstalled or suspended there), or `unavailable` when GitHub did not say. Asked of GitHub each time, never stored. */
        GitHubRepositories: {
            /** @enum {string} */
            kind: "listed";
            repositories: components["schemas"]["GitHubRepository"][];
        } | {
            /** @enum {string} */
            kind: "gone";
        } | {
            /** @enum {string} */
            kind: "unavailable";
        };
        GitHubRepository: {
            id: number;
            fullName: string;
            private: boolean;
            url: string;
        };
        GitHubInstallAddress: {
            /** @description Where a Connect starts: GitHub’s sign-in authorization for the app, from which GitHub always sends the person back, so an installation they already have can be connected. */
            url: string;
            /** @description The app’s install page on GitHub, to install it on another account. GitHub sends the person back from it only after a new installation. */
            installUrl: string;
        };
        /** @description What the person may choose to connect. */
        GitHubChoice: {
            candidates: components["schemas"]["GitHubInstallCandidate"][];
        };
        /** @description An installation of the app on an account the person administers, which this workspace does not hold. */
        GitHubInstallCandidate: {
            id: number;
            account: components["schemas"]["GitHubAccount"];
            /** @description Whether another Consola workspace holds it (never which), so it is shown and not offered. */
            heldElsewhere: boolean;
        };
        /** @description Connected now, or the workspace held it already. */
        GitHubChoiceConnected: {
            /** @enum {string} */
            result: "connected" | "already_connected";
        };
        /** @description GitHub’s ping, as a webhook is set up: recorded for no workspace. */
        GitHubWebhookPong: {
            /** @enum {string} */
            result: "pong";
        };
        /** @description The event is recorded for the workspace that holds its installation. */
        GitHubWebhookRecorded: {
            /** @enum {string} */
            result: "recorded";
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
