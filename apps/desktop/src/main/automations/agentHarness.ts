import type { AgentHarnessAnswer, AgentHarnessQuery } from '@consola/automation-engine';
import { launchFieldsFor, type Harness } from '../../shared/harness';
import { getDriver, stepTurnProblem, toolPolicyProblem } from '../drivers';
import { toHarnessConfig } from '../drivers/HarnessDriver';
import type { HarnessCapabilitiesCache } from '../HarnessCapabilitiesCache';

/**
 * Why an agent that names MCP servers or skills cannot run yet: no driver
 * compiles them in this build, so the host refuses rather than launch the
 * step without what its agent requires (contract 9).
 */
export const SERVERS_AND_SKILLS_LATER = 'Servers and skills for agents arrive with the next update';

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
 * What the engine's `agentHarness` port answers.
 *
 * With no agent, for the workspace's default harness (none: the built-in
 * Claude): `problem`, why it cannot run a read-only session at all, which
 * refuses every agent entry; `stepProblem`, why its steps' reporting turns
 * would not launch as Consola compiles them, which refuses every steps entry
 * with an agent step.
 *
 * For an agent, the same of the harness it runs on (its `harness:`, else the
 * default), with `--model` among the flags its extra arguments may not set
 * when the agent sets a model, and two more: `agentProblem`, why it cannot
 * run there at all (the harness unknown, archived or turned off, or, in this
 * build, any server or skill it names), and `warning`, a model the harness's
 * cached capabilities do not list, which never blocks.
 */
export function agentHarnessView(input: {
  harnesses: readonly Harness[];
  defaultHarnessId: string | undefined;
  agent?: AgentHarnessQuery;
  modelsOf?(harness: Harness | undefined): readonly string[] | undefined;
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
  return {
    name,
    problem: toolPolicyProblem(fields, 'read-only'),
    stepProblem: stepTurnProblem(fields, { model: agent.model !== undefined }),
    agentProblem: refusal ?? (named ? SERVERS_AND_SKILLS_LATER : null),
    warning:
      models && agent.model !== undefined && !models.includes(agent.model)
        ? `\`${agent.model}\` is not among the models ${name} lists; \`--model\` also takes a model's full name, and a step on a model the CLI does not have fails.`
        : null,
  };
}
