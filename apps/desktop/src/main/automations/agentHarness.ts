import type {
  AgentHarnessAnswer,
  AgentHarnessQuery,
  EntryAgentsView,
} from '@consola/automation-engine';
import { launchFieldsFor } from '../../shared/harness';
import type { Harness } from '../../shared/harness';
import type { HarnessDriverId } from '../../shared/types';
import { getDriver, stepTurnProblem, toolPolicyProblem } from '../drivers';
import type { HarnessDriver } from '../drivers';
import { denyReadList } from '../drivers/claudeWriteAgent';
import type { HarnessVersions } from '../drivers/harnessVersions';
import { UNKNOWN_CLI_VERSION } from '../drivers/harnessVersions';
import { toHarnessConfig } from '../drivers/HarnessDriver';
import type { CompileHost } from '../drivers/HarnessDriver';
import type { HarnessCapabilitiesCache } from '../HarnessCapabilitiesCache';
import type { McpServersCache, ServersAnswer } from './mcpServersCache';

/** Why an agent naming servers or skills cannot run on a harness whose driver compiles none. */
export function noAgentGrants(harnessName: string): string {
  return `${harnessName} can't give an agent MCP servers or skills.`;
}

/** Why a write agent cannot run on a harness whose driver does not compile one (slice 3-B). */
export function writeAgentsClaudeOnly(harnessName: string): string {
  return `Write agents run on Claude only for now: ${harnessName} can't hold a write agent to its environment.`;
}

/** Claude's managed settings, which `--settings` cannot override (plan Call 24). */
export const MANAGED_SETTINGS = '/Library/Application Support/ClaudeCode/managed-settings.json';

/** What a write agent's host is read from (plan Call 14): the machine, and the person's files. */
export interface WriteAgentHostDeps {
  /** Every harness record, archived ones included: each one's profile is denied. */
  harnesses(): readonly Harness[];
  platform: string;
  home: string;
  /** Electron's `userData`, whichever of its ` Dev`/` Test` siblings this run uses. */
  userData: string;
  /** `CONSOLA_FACTORY_DIR`, else `~/.consola/workspaces`. */
  factoryRoot: string;
  /** The login environment: a harness that pins nothing runs on its profile variable. */
  loginEnv(): NodeJS.ProcessEnv;
  versions: Pick<HarnessVersions, 'get' | 'peek'>;
  /** A settings file's text, null when it is not there; throws when it cannot be read. */
  readSettings(file: string): string | null;
  /** The driver for a harness's driver id; absent, `getDriver`. For tests. */
  driverFor?(id?: HarnessDriverId): HarnessDriver;
}

/**
 * The host a write agent on `harness` compiles against, with the CLI
 * version given: this platform; the deny list (Call 21) over every
 * harness record's effective profile and this one's; and the two settings
 * files Call 24 reads, this harness's effective `settings.json` first. A
 * file that cannot be read is said so, which refuses `sandbox`.
 */
export function writeAgentHostWith(
  deps: WriteAgentHostDeps,
  harness: Harness | undefined,
  cliVersion: string,
): CompileHost {
  const driverFor = deps.driverFor ?? getDriver;
  const env = deps.loginEnv();
  const profileOf = (record: Harness | undefined) => {
    const fields = launchFieldsFor(record);
    return driverFor(fields.driverId).profileDir(toHarnessConfig(fields), env);
  };
  const own = profileOf(harness);
  const files = [`${own}/settings.json`, MANAGED_SETTINGS];
  return {
    platform: deps.platform,
    denyRead: denyReadList({
      home: deps.home,
      userData: deps.userData,
      factoryRoot: deps.factoryRoot,
      profiles: [own, ...deps.harnesses().map(profileOf)],
    }),
    cliVersion,
    settingsFiles: files.map((file) => {
      try {
        return { path: file, text: deps.readSettings(file) };
      } catch (error) {
        return {
          path: file,
          text: null,
          unreadable: error instanceof Error ? error.message : String(error),
        };
      }
    }),
  };
}

/** `writeAgentHostWith` at launch: the CLI version asked of the harness, waited for. */
export async function writeAgentHost(
  deps: WriteAgentHostDeps,
  harness: Harness | undefined,
): Promise<CompileHost> {
  return writeAgentHostWith(deps, harness, await deps.versions.get(launchFieldsFor(harness)));
}

/**
 * `writeAgentHostWith` at apply, which never waits: the version already
 * read, else `unknown`. Applying keeps no grants, so the version decides
 * nothing there; a launch compiles again with the version it asks for.
 */
export function writeAgentHostNow(
  deps: WriteAgentHostDeps,
  harness: Harness | undefined,
): CompileHost {
  return writeAgentHostWith(
    deps,
    harness,
    deps.versions.peek(launchFieldsFor(harness)) ?? UNKNOWN_CLI_VERSION,
  );
}

/**
 * Why an agent cannot run on the harness it names: unknown, archived or
 * turned off, in the words the person sees; null when it can be used. One
 * rule for the check when the factory applies and the launch after it.
 */
export function agentHarnessRefusal(
  harnesses: readonly Harness[],
  harnessId: string,
): string | null {
  const harness = harnesses.find((candidate) => candidate.id === harnessId);
  if (!harness)
    return `\`${harnessId}\` is not one of Consola's harnesses: add it in Settings › Harnesses, or change \`harness:\``;
  if (harness.archived)
    return `\`${harnessId}\` is archived: change \`harness:\` to a harness in use`;
  if (!harness.enabled)
    return `\`${harnessId}\` is turned off: turn it on in Settings › Harnesses, or change \`harness:\``;
  return null;
}

/**
 * The models a harness's settled capabilities answer lists, each by the
 * selector it takes and the model it resolves to; undefined when no answer
 * has settled, or the harness cannot describe itself. It only reads the
 * cache: applying a factory never starts a probe, which would run the
 * person's SessionStart hooks.
 */
export function cachedModels(
  cache: Pick<HarnessCapabilitiesCache, 'peek'>,
  harness: Harness | undefined,
): readonly string[] | undefined {
  const fields = launchFieldsFor(harness);
  const answer = cache.peek(getDriver(fields.driverId), toHarnessConfig(fields));
  if (!answer?.supported) return undefined;
  return answer.models.flatMap((model) => [model.value, model.resolvedModel]);
}

/**
 * What an agent writing automations is told of each harness: 2-B's four
 * fields, then `servers`, the names from a settled answer only. It can read
 * nothing but `peek`, so describing capabilities never starts a probe
 * (review G5).
 */
export function harnessesWithServers(
  harnesses: readonly Harness[],
  cache: Pick<McpServersCache, 'peek'>,
): Array<{ id: string; name: string; enabled: boolean; archived: boolean; servers?: string[] }> {
  return harnesses.map((harness) => {
    const fields = launchFieldsFor(harness);
    const answer = cache.peek(getDriver(fields.driverId), toHarnessConfig(fields));
    return {
      id: harness.id,
      name: harness.name,
      enabled: harness.enabled,
      archived: harness.archived,
      ...(answer?.state === 'settled'
        ? { servers: answer.servers.map((server) => server.name) }
        : {}),
    };
  });
}

/**
 * The Allow card's agents with each whole server's `knownTools`: the tools
 * its agent's harness's CLI last listed for it (review S2). A narrowed
 * server is shown by its own tools and never asked about; a server
 * `toolsOf` knows nothing of gains no key.
 */
export function withKnownTools(
  view: EntryAgentsView,
  toolsOf: (harnessId: string | undefined, server: string) => readonly string[] | undefined,
): EntryAgentsView {
  return {
    ...view,
    agents: view.agents.map((agent) => ({
      ...agent,
      mcpServers: agent.mcpServers.map((server) => {
        if (server.tools !== undefined) return server;
        const known = toolsOf(agent.harnessId, server.name);
        return known !== undefined ? { ...server, knownTools: [...known] } : server;
      }),
    })),
  };
}

/**
 * `withKnownTools`' answer from the servers cache: the tools a settled answer
 * lists for a server, on the agent's harness (else the workspace's
 * default); undefined for a harness not there, an answer not settled, or a
 * server it lacks or lists without tools. Only `peek`: opening a card
 * starts nothing.
 */
export function settledServerTools(
  cache: Pick<McpServersCache, 'peek'>,
  harnesses: readonly Harness[],
  defaultHarnessId: string | undefined,
): (harnessId: string | undefined, server: string) => readonly string[] | undefined {
  return (harnessId, server) => {
    const id = harnessId ?? defaultHarnessId;
    const harness = harnesses.find((candidate) => candidate.id === id);
    if (harnessId !== undefined && !harness) return undefined;
    const fields = launchFieldsFor(harness);
    const answer = cache.peek(getDriver(fields.driverId), toHarnessConfig(fields));
    if (answer?.state !== 'settled') return undefined;
    return answer.servers.find((candidate) => candidate.name === server)?.tools;
  };
}

/**
 * What the engine's `agentHarness` port answers.
 *
 * With no agent, for the workspace's default harness (none: the built-in
 * Claude): `problem`, why it cannot run a read-only session at all, which
 * refuses every agent entry; `stepProblem`, why its steps' reporting turns
 * would not launch as Consola compiles them, which refuses every steps entry
 * with an agent step.
 *
 * For an agent, the same of the harness it runs on (its `harness:`, else the
 * default), with `--model` (when the agent sets a model) and the flags that
 * load servers (when it names any) among those its extra arguments may not
 * set, and more: `agentProblem`, why it cannot run there at all (the harness
 * unknown, archived or turned off; a driver that runs no agent steps, in its
 * own words; one that compiles no servers or skills, for an agent naming
 * them); `warning`, a model the harness's cached capabilities do not list,
 * which never blocks; and, for an agent naming servers, what its CLI says of
 * them: a probe under way (`serversPending`), one that failed
 * (`serversUnknown`), or the driver's compile against the answer, a refusal
 * (`serversProblem`, its missing names asked about once more) or warnings
 * (`serverWarnings`) with each whole server's tools as that answer lists
 * them (`knownTools`, which a run's definition keeps for its approval card).
 * Nothing is asked or compiled for an agent the harness already refuses.
 */
export function agentHarnessView(input: {
  harnesses: readonly Harness[];
  defaultHarnessId: string | undefined;
  agent?: AgentHarnessQuery;
  modelsOf?(harness: Harness | undefined): readonly string[] | undefined;
  /** The harness's servers as its CLI said, starting a probe when there is no answer: `McpServersCache.ask`. */
  serversNow?(harness: Harness | undefined): ServersAnswer;
  /** An agent names servers that answer lacks: `McpServersCache.missing`. */
  missingServers?(harness: Harness | undefined, names: readonly string[]): void;
  /** The driver for a harness's driver id; absent, `getDriver`. For tests. */
  driverFor?(id?: HarnessDriverId): HarnessDriver;
  /** What a write agent compiles against (`writeAgentHostNow`); absent, a write agent is refused. */
  host?(harness: Harness | undefined): CompileHost;
  /**
   * The Claude version the harness runs, when already known
   * (`HarnessVersions.peek`): a write agent's answer carries it, for the
   * approval card's "this Mac runs" (slice 3-B Task 21).
   */
  cliVersion?(harness: Harness | undefined): string | undefined;
}): AgentHarnessAnswer {
  const { harnesses, defaultHarnessId, agent, modelsOf } = input;
  const byId = (id: string | undefined) => harnesses.find((candidate) => candidate.id === id);
  if (!agent) {
    const harness = byId(defaultHarnessId);
    const fields = launchFieldsFor(harness);
    return {
      name: harness?.name ?? 'Claude',
      problem: toolPolicyProblem(fields, 'read-only'),
      stepProblem: stepTurnProblem(fields),
    };
  }
  const refusal =
    agent.harnessId !== undefined ? agentHarnessRefusal(harnesses, agent.harnessId) : null;
  const named = agent.mcpServers.length > 0 || agent.skills.length > 0;
  const harness = byId(agent.harnessId ?? defaultHarnessId);
  if (agent.harnessId !== undefined && !harness) {
    // Nothing to check of a harness that is not there.
    return {
      name: agent.harnessId,
      problem: null,
      stepProblem: null,
      agentProblem: refusal,
      warning: null,
    };
  }
  const fields = launchFieldsFor(harness);
  const name = harness?.name ?? 'Claude';
  const models = agent.model !== undefined ? modelsOf?.(harness) : undefined;
  const driver = (input.driverFor ?? getDriver)(fields.driverId);
  const tools = agent.tools ?? 'read-only';
  const writes = tools !== 'read-only';
  const problem = toolPolicyProblem(fields, tools);
  const version = writes ? input.cliVersion?.(harness) : undefined;
  const answer: AgentHarnessAnswer = {
    ...(version !== undefined && version !== UNKNOWN_CLI_VERSION ? { cliVersion: version } : {}),
    name,
    problem,
    stepProblem: stepTurnProblem(fields, {
      model: agent.model !== undefined,
      servers: agent.mcpServers.length > 0,
    }),
    agentProblem: refusal,
    warning:
      models && agent.model !== undefined && !models.includes(agent.model)
        ? `\`${agent.model}\` is not among the models ${name} lists; \`--model\` also takes a model's full name, and a step on a model the CLI does not have fails.`
        : null,
  };
  // A write agent needs a driver that holds it to its environment, whatever else it says.
  if (refusal === null && writes && (!driver.compileAgent || driver.agentRefusal !== undefined))
    return { ...answer, agentProblem: writeAgentsClaudeOnly(name) };
  if (refusal === null && driver.agentRefusal !== undefined) {
    return {
      ...answer,
      agentProblem: problem ? `${problem} ${driver.agentRefusal}` : driver.agentRefusal,
    };
  }
  // A harness it cannot run on at all is the answer (review M4).
  if (refusal !== null || problem !== null || (!named && !writes)) return answer;
  if (!driver.compileAgent) return { ...answer, agentProblem: noAgentGrants(name) };
  let servers: ServersAnswer = { state: 'settled', servers: [] };
  if (agent.mcpServers.length > 0) {
    servers = input.serversNow?.(harness) ?? {
      state: 'failed',
      error: 'its CLI is not asked here.',
    };
    if (servers.state === 'pending') {
      return {
        ...answer,
        serversPending: `Asking ${name} which MCP servers it has; this applies once it answers.`,
      };
    }
    if (servers.state === 'failed') {
      return {
        ...answer,
        serversUnknown: `Couldn't ask ${name} which MCP servers it has: ${servers.error}`,
      };
    }
  }
  const reported = servers.servers;
  const compiled = driver.compileAgent({
    config: toHarnessConfig(fields),
    harnessName: name,
    agent: {
      tools,
      mcpServers: agent.mcpServers.map((server) => ({
        name: server.name,
        ...(server.tools ? { tools: [...server.tools] } : {}),
      })),
      skills: [...agent.skills],
      ...(agent.environment ? { environment: agent.environment } : {}),
    },
    checkout: agent.checkout,
    servers: reported,
    ...(writes && input.host ? { host: input.host(harness) } : {}),
  });
  if (compiled.ok && writes && compiled.grants.tools !== tools)
    return { ...answer, agentProblem: writeAgentsClaudeOnly(name) };
  // The agent itself refused (a write agent's checkout, machine or settings): its harness's line.
  if (!compiled.ok && compiled.about === 'agent')
    return { ...answer, agentProblem: compiled.problem };
  if (compiled.ok) {
    // Each whole server's tools as this answer lists them: what a run's definition keeps for its approval card (review S1).
    const knownTools: Record<string, string[]> = {};
    for (const server of agent.mcpServers) {
      if (server.tools !== undefined) continue;
      const tools = reported.find((candidate) => candidate.name === server.name)?.tools;
      if (tools !== undefined) knownTools[server.name] = [...tools];
    }
    return {
      ...answer,
      serverWarnings: compiled.warnings,
      ...(Object.keys(knownTools).length > 0 ? { knownTools } : {}),
    };
  }
  const lacking = agent.mcpServers
    .map((server) => server.name)
    .filter((wanted) => !reported.some((server) => server.name === wanted));
  if (lacking.length > 0) input.missingServers?.(harness, lacking);
  return { ...answer, serversProblem: compiled.problem };
}
