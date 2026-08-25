import type { GitProviderId } from '../../shared/providers';
import { getLoginEnv } from '../LoginEnvironment';
import type { GitProviderDriver } from './GitProviderDriver';
import { GitHubDriver } from './github/GitHubDriver';

/**
 * The git hosting providers Consola can act on.
 *
 * Supporting another provider means adding its driver here and nothing
 * else: the inbox, launch, clone, worktree and terminal layers all go
 * through `getProviderDriver`.
 */
const DRIVERS: Record<GitProviderId, GitProviderDriver> = {
    github: new GitHubDriver(),
};

/**
 * The driver for an id. Throws on an unknown one.
 *
 * Deliberately not the harness registry's fall-back: a session persisted by
 * a newer build with a provider this build lacks must not quietly fetch
 * from and push to GitHub instead. Every live call site — token borrow,
 * inbox refresh, launch, clone, repo resolution — already wraps this in the
 * degrade path it has for the provider CLI failing.
 */
export function getProviderDriver(id: GitProviderId): GitProviderDriver {
    const driver = DRIVERS[id];
    if (!driver) throw new Error(`Unknown git provider "${id}".`);
    return driver;
}

/**
 * A copy of `env` with the token layered on under the driver's variable, or
 * a plain copy when there is no token (or nowhere to put it).
 *
 * Always a copy: the base environment is shared (getLoginEnv caches it), and
 * mutating it would leak one workspace's token into every other spawn.
 */
export function layerProviderToken(
    env: NodeJS.ProcessEnv,
    tokenEnvVar: string | null,
    token: string | null
): NodeJS.ProcessEnv {
    return tokenEnvVar && token ? { ...env, [tokenEnvVar]: token } : { ...env };
}

/**
 * Login env plus this account's token — composed here and only here, so a
 * token never crosses IPC and never lands in a renderer-bound payload.
 * Rejects when the token cannot be borrowed; the caller labels the failure.
 */
export async function composeProviderEnv(
    driver: GitProviderDriver,
    accountLogin: string
): Promise<NodeJS.ProcessEnv> {
    return layerProviderToken(getLoginEnv(), driver.tokenEnvVar, await driver.token(accountLogin));
}

export type { GitProviderDriver } from './GitProviderDriver';
