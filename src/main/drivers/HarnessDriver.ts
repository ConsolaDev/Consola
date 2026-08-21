import * as os from 'os';
import * as path from 'path';
import type {
    HarnessCapabilities,
    HarnessDriverId,
    HarnessLaunchFields,
    HarnessProbeResult,
    SessionNameResult,
} from '../../shared/types';

/**
 * What Consola needs to know about an agent CLI in order to drive it.
 *
 * Consola coordinates external CLIs rather than reimplementing them, so a
 * driver describes only how to *launch and inspect* one — never how its
 * conversation looks. Each method corresponds to something that genuinely
 * differs between CLIs: where the binary lives, how a session is named on the
 * command line, which environment variable redirects its profile, and how to
 * tell whether it is installed and signed in.
 */
export interface HarnessDriver {
    readonly id: HarnessDriverId;

    /**
     * Environment variable this CLI reads for its config/profile directory.
     *
     * Named per driver rather than assumed, so a second CLI with a differently
     * named variable is a new driver rather than a change to shared code.
     */
    readonly configDirEnvVar: string;

    /** Absolute path to the binary, or a bare name to let the spawn fail loudly. */
    resolveBinary(config: HarnessConfig): string;

    /** argv for an interactive session, including the harness's extra args. */
    buildSessionArgs(config: HarnessConfig, launch: SessionLaunch): string[];

    /** The ambient environment plus this harness's own variables. */
    composeEnv(config: HarnessConfig, baseEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv;

    /** Whether the binary is present and who it is authenticated as. */
    probeHealth(config: HarnessConfig): Promise<HarnessProbeResult>;

    /**
     * A display name for a session, read from this CLI's own transcripts.
     *
     * Optional: a driver whose transcript format Consola cannot read simply
     * omits it, and sessions keep whatever name they were given. Callers must
     * check for its absence rather than polling an answer that never comes.
     */
    getSessionDisplayName?(config: HarnessConfig, sessionId: string): SessionNameResult | null;

    /**
     * The commands, agents and models this CLI offers, asked of the CLI itself.
     *
     * Optional for the same reason as `getSessionDisplayName`: a CLI with no
     * way to enumerate its own features simply omits this, and the composer
     * goes without autocomplete rather than waiting on an answer that never
     * comes.
     *
     * Unlike the other methods here this one may reject. It talks to a separate
     * process over a pipe, so a missing binary, a hung child and unrecognised
     * output are all ordinary outcomes. `HarnessCapabilitiesCache` is the one
     * place that turns any driver's failure into the uniform shape the UI
     * renders, so drivers should throw rather than invent an empty result.
     */
    probeCapabilities?(config: HarnessConfig): Promise<HarnessCapabilities>;
}

/**
 * What fixes one session's argv, beyond the harness's own settings.
 *
 * An object rather than positional parameters: `buildSessionArgs` already took
 * three, and everything here is chosen per conversation and then frozen, so
 * the list grows as new session-scoped pins are added.
 */
export interface SessionLaunch {
    sessionId: string;
    /** Resume the existing conversation instead of starting one. */
    resume: boolean;
    /** Model selector to pin, when the session chose one. */
    model?: string;
}

/** A harness's launch settings, normalised for driver consumption. */
export interface HarnessConfig {
    /** Explicit binary path, when the harness pins one. */
    binaryPath?: string;
    /** Config directory for this driver's `configDirEnvVar`, when set. */
    configDir?: string;
    extraArgs: string[];
}

/**
 * Resolve a leading `~` against the current user's home directory.
 *
 * Harness paths are typed by hand, and `~/.claude-work` is how people write a
 * home-relative path. Nothing expands it downstream: a config directory becomes
 * an environment variable read by a spawned process, and env vars get no shell
 * expansion — `claude` would create a literal `~` directory under the session's
 * working directory and run against an empty profile. Expanding here, at the
 * single point where launch fields become driver input, covers every consumer
 * (session spawn, health probe, transcript lookup) and leaves the stored value
 * readable as the user wrote it.
 *
 * Only `~` alone and a leading `~/` are home references. `~someone/...` means
 * another user's home, which is not ours to guess, and a tilde anywhere else is
 * an ordinary character in a path name.
 */
function expandHome(target: string): string {
    if (target === '~') return os.homedir();
    if (target.startsWith('~/')) return path.join(os.homedir(), target.slice(2));
    return target;
}

/**
 * Normalise the optional fields that cross IPC into a driver-ready config.
 *
 * Empty strings are treated as absent so a cleared text field in the harness
 * form means "use the default" rather than "use the empty path".
 */
export function toHarnessConfig(fields: HarnessLaunchFields | undefined): HarnessConfig {
    const binaryPath = fields?.binaryOverride?.trim() || undefined;
    const configDir = fields?.configDirOverride?.trim() || undefined;
    return {
        binaryPath: binaryPath && expandHome(binaryPath),
        configDir: configDir && expandHome(configDir),
        extraArgs: fields?.extraArgs ?? [],
    };
}
