import type {
  AgentHarnessAnswer,
  AgentHarnessQuery,
  EntryAgentsView,
} from '@consola/automation-engine';
import { launchFieldsFor, type Harness } from '../../shared/harness';
import type { HarnessDriverId } from '../../shared/types';
import { getDriver, type HarnessDriver, stepTurnProblem, toolPolicyProblem } from '../drivers';
import { toHarnessConfig } from '../drivers/HarnessDriver';
import type { HarnessCapabilitiesCache } from '../HarnessCapabilitiesCache';
import type { McpServersCache, ServersAnswer } from './mcpServersCache';

/** Why an agent naming servers or skills cannot run on a harness whose driver compiles none. */
export function noAgentGrants(harnessName: string): string {
  return `${harnessName} can't give an agent MCP servers or skills.`;
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
 * (`serverWarnings`). Nothing is asked or compiled for an agent the harness
 * already refuses.
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
  const problem = toolPolicyProblem(fields, 'read-only');
  const answer: AgentHarnessAnswer = {
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
  if (refusal === null && driver.agentRefusal !== undefined) {
    return {
      ...answer,
      agentProblem: problem ? `${problem} ${driver.agentRefusal}` : driver.agentRefusal,
    };
  }
  // A harness it cannot run on at all is the answer (review M4).
  if (refusal !== null || problem !== null || !named) return answer;
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
      tools: 'read-only',
      mcpServers: agent.mcpServers.map((server) => ({
        name: server.name,
        ...(server.tools ? { tools: [...server.tools] } : {}),
      })),
      skills: [...agent.skills],
    },
    checkout: agent.checkout,
    servers: reported,
  });
  if (compiled.ok) return { ...answer, serverWarnings: compiled.warnings };
  const lacking = agent.mcpServers
    .map((server) => server.name)
    .filter((wanted) => !reported.some((server) => server.name === wanted));
  if (lacking.length > 0) input.missingServers?.(harness, lacking);
  return { ...answer, serversProblem: compiled.problem };
}
