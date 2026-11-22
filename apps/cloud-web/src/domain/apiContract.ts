/**
 * The types of cloud-global's API, generated from apps/cloud-global/openapi.json by
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
                /** @description A workspace in some region has that slug. */
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
    "/api/cell-token": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Mint a token for my session's active workspace
         * @description Nothing in the request names the workspace or the role: both are read from the database as the token is minted. No cache keeps the answer (`Cache-Control: no-store`).
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
                /** @description The token, and when it stops being valid. */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["CellToken"];
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
                /** @description The person is not in the workspace their session names, or the request did not come from the web app. */
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
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/cell-token/keys": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * The public keys a cell checks cell tokens with
         * @description A JSON Web Key Set (RFC 7517). Reading it needs no sign-in.
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
                /** @description The key set. */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["CellTokenKeySet"];
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
    "/api/connections": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * What my session's active workspace is connected to
         * @description Any member may read it; `canManage` says whether they may change it.
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
                /** @description The person is not in the workspace their session names. */
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
         * @description The address on GitHub that installs the app, carrying a state signed for this session. Only an owner or admin may. No cache keeps the answer (`Cache-Control: no-store`).
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
                /** @description The person is not in the workspace, is not an owner or admin of it, or the request did not come from the web app. */
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
         * Where GitHub sends a person back after installing the app
         * @description The GitHub App’s callback URL, reached by a browser redirect from GitHub with `state`, `code`, `installation_id`, `setup_action` or `error`. It never answers JSON: it always redirects to the web app’s Settings, on its Connections page, with how the Connect ended in `?github=`: one of `connected`, `already_connected`, `requested`, `cancelled`, `bad_state`, `expired`, `not_allowed`, `code_refused`, `not_installer`, `not_account_admin`, `taken`, `invalid`, `unavailable`, `not_configured`, `signed_out`.
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
                /** @description To `<PUBLIC_URL>/?github=<result>#/settings/connections`. */
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
                /** @description The id is not a GitHub id. */
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
                /** @description The person is not in the workspace, is not an owner or admin of it, or the request did not come from the web app. */
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
        /** Whether the service can reach its database */
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
        };
        ActiveWorkspace: {
            workspaceId: string;
        };
        /** @description Every problem, in the order the rules name them. */
        InvalidWorkspace: {
            /** @enum {string} */
            error: "invalid_workspace";
            problems: ("name_missing" | "name_too_long" | "slug_invalid" | "region_unknown")[];
        };
        /** @description A name (trimmed, at most 64 characters), a slug of lowercase letters and digits with single dashes between (at most 48) and a region. */
        NewWorkspace: {
            name: string;
            slug: string;
            /** @enum {string} */
            region: "eu" | "us";
        };
        /** @description The token the session's active workspace's cell trusts, for minutes. */
        CellToken: {
            token: string;
            /** @description In whole seconds since the epoch. */
            expiresAt: number;
        };
        CellTokenKeySet: {
            keys: components["schemas"]["CellTokenPublicKey"][];
        };
        CellTokenPublicKey: {
            /** @enum {string} */
            kty: "OKP";
            /** @enum {string} */
            crv: "Ed25519";
            x: string;
            kid: string;
            /** @enum {string} */
            alg: "EdDSA";
            /** @enum {string} */
            use: "sig";
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
            url: string;
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
