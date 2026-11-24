import { StartedByHandError } from '@consola/automation-engine';
import type { AgentLaunchRequest } from '@consola/automation-engine';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AgentGrants } from '../../shared/agentGrants';
import type { GitProviderId } from '../../shared/providers';
import type { HarnessDriverId } from '../../shared/types';
import type { WorkItemRef } from '../../shared/workItems';
import { sameWorkItem, workItemKey } from '../../shared/workItems';
import { launchFieldsFor } from '../../shared/harness';
import type { Harness } from '../../shared/harness';
import { generateSessionInstanceId } from '../../shared/workspace';
import type { Session, Workspace } from '../../shared/workspace';
import { getDriver, toHarnessConfig, toolPolicyProblem } from '../drivers';
import type { HarnessDriver } from '../drivers';
import type { CompileHost, McpServerReport } from '../drivers/HarnessDriver';
import type { GitProviderDriver } from '../providers/GitProviderDriver';
import {
  chainWorktreeStep,
  itemActionLaunchKey,
  readyGroup,
  scopeIdForPath,
} from '../providers/launchWorkItem';
import { withoutGitHooks } from '../gitHooks';
import type { LaunchSessionFields } from '../SessionLauncher';
import { agentHarnessRefusal, noAgentGrants, writeAgentsClaudeOnly } from './agentHarness';
import { sandboxSessionEnv } from './sandboxEnv';
import { toWorkItemRef } from './engineViews';

export { withoutGitHooks };

export interface AgentLaunchDeps {
  getWorkspace(id: string): Workspace | undefined;
  resolveDriver(id: GitProviderId): GitProviderDriver;
  resolveRepo(workspace: Workspace, repo: string): string | null;
  /** Where `ensureWorktree` puts an item's worktree. */
  worktreePathFor(workItem: WorkItemRef): string;
  ensureWorktree(clonePath: string, workItem: WorkItemRef, env: NodeJS.ProcessEnv): Promise<string>;
  /** Bring a clean existing PR worktree to the PR's head; false when it was left as is. */
  refreshWorktree(dir: string, workItem: WorkItemRef, env: NodeJS.ProcessEnv): Promise<boolean>;
  /** Whether `dir` must stay as it is: see `worktreeHeld`. */
  worktreeInUse(dir: string): boolean;
  composeEnv(driver: GitProviderDriver, accountLogin: string): Promise<NodeJS.ProcessEnv>;
  restoreGroup(workspaceId: string, groupId: string): void;
  launchSession(workspaceId: string, fields: LaunchSessionFields): Promise<Session>;
  /** Every harness record, archived and turned-off ones included: a step's agent names one by id. */
  harnesses(): readonly Harness[];
  /**
   * The harness's servers, as its CLI last said, waiting for an answer under
   * way (`McpServersCache.get`): what a launch compiles against (review M3).
   */
  serversForLaunch(harness: Harness | undefined): Promise<McpServerReport[]>;
  /** The driver for a harness's driver id; absent, `getDriver`. For tests. */
  driverFor?(id?: HarnessDriverId): HarnessDriver;
  /**
   * What a write agent compiles against at launch (`writeAgentHost`): the
   * platform, the deny list, the CLI version (waited for) and the person's
   * settings files. Absent: a write step is refused, never launched looser.
   */
  writeAgentHost?(harness: Harness | undefined): Promise<CompileHost>;
  /** The login environment, for what a write step's environment passes; absent, none is said. */
  loginEnv?(): NodeJS.ProcessEnv;
}

/** A write step's launch as it was made: the CLI version compiled for, and its `env:` names passed and missing. */
export type LaunchEnvironment = { cliVersion: string; passed: string[]; missing: string[] };

/** A launch refused in words: one final full stop, whether the words end in one or not. */
function didNotStart(words: string): Error {
  return new Error(`It did not start: ${words.replace(/\.$/, '')}.`);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type StepAgent = NonNullable<NonNullable<AgentLaunchRequest['step']>['agent']>;

/**
 * A step's agent compiled for its attempt's launch, from the snapshot's
 * requirements, the run's checkout kind and the harness's servers as its CLI
 * says now (waiting for an answer under way), with its skills staged into
 * the attempt's plugin dir from the run's copy; or a refusal in words, which
 * starts nothing. The harness's own reasons come first, as at apply.
 */
async function compileForLaunch(
  deps: AgentLaunchDeps,
  workspace: Workspace,
  step: NonNullable<AgentLaunchRequest['step']>,
  agent: StepAgent,
): Promise<{ grants: AgentGrants; environment?: LaunchEnvironment }> {
  const harness = deps
    .harnesses()
    .find((candidate) => candidate.id === (agent.harnessId ?? workspace.defaultHarnessId));
  const fields = launchFieldsFor(harness);
  const name = harness?.name ?? 'Claude';
  const tools = agent.tools ?? 'read-only';
  const writes = tools !== 'read-only';
  const driver = (deps.driverFor ?? getDriver)(fields.driverId);
  // A write agent needs a driver that holds it to its environment, whatever else it says.
  if (writes && (!driver.compileAgent || driver.agentRefusal !== undefined))
    throw didNotStart(writeAgentsClaudeOnly(name));
  const policy = toolPolicyProblem(fields, tools);
  if (policy) throw didNotStart(policy);
  if (!driver.compileAgent) throw didNotStart(noAgentGrants(name));
  // A write agent compiles against this machine, its CLI's version waited for (Call 14).
  let host: CompileHost | undefined;
  if (writes) {
    if (!deps.writeAgentHost) throw didNotStart(writeAgentsClaudeOnly(name));
    try {
      host = await deps.writeAgentHost(harness);
    } catch (error) {
      throw didNotStart(
        `Couldn't read what this machine holds a write agent to: ${messageOf(error)}`,
      );
    }
  }
  let servers: McpServerReport[] = [];
  if (agent.mcpServers.length > 0) {
    try {
      servers = await deps.serversForLaunch(harness);
    } catch (error) {
      throw didNotStart(`Couldn't ask ${name} which MCP servers it has: ${messageOf(error)}`);
    }
  }
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
    checkout: step.checkout,
    servers,
    ...(step.pluginDir !== undefined ? { pluginDir: step.pluginDir } : {}),
    ...(agent.skillHashes !== undefined ? { skillHashes: agent.skillHashes } : {}),
    ...(host ? { host } : {}),
    ...(step.checkoutPath !== undefined ? { checkoutPath: step.checkoutPath } : {}),
  });
  if (!compiled.ok) throw didNotStart(compiled.problem);
  // Never a write step on grants that do not hold its policy: refused, not launched looser.
  if (writes && compiled.grants.tools !== tools) throw didNotStart(writeAgentsClaudeOnly(name));
  if (agent.skills.length > 0) {
    if (!driver.stageSkills) throw didNotStart(noAgentGrants(name));
    if (agent.skillsDir === undefined)
      throw didNotStart('its skills have no copy in the run folder to build its plugin from');
    // The plugin is built, and every later launch checked, against these (review M1).
    if (agent.skillHashes === undefined)
      throw didNotStart('its skills have no hashes from its run to check its plugin against');
    try {
      await driver.stageSkills(compiled.grants, agent.skillsDir);
    } catch (error) {
      throw didNotStart(messageOf(error));
    }
  }
  if (!writes || !host || !agent.environment) return { grants: compiled.grants };
  return {
    grants: compiled.grants,
    environment: { cliVersion: host.cliVersion, ...passedOf(deps, agent.environment, step.cwd) },
  };
}

/**
 * Which of a write step's `env:` names its session gets (`passed`) and which
 * the person's environment lacks (`missing`): on `sandbox`, the allow-list's
 * own answer; on `host`, which are set (it has the whole environment).
 */
function passedOf(
  deps: AgentLaunchDeps,
  environment: NonNullable<StepAgent['environment']>,
  cwd: string,
): { passed: string[]; missing: string[] } {
  const login = deps.loginEnv?.() ?? {};
  if (environment.isolation === 'sandbox') {
    const { passed, missing } = sandboxSessionEnv(login, {}, environment.env, cwd);
    return { passed, missing };
  }
  return {
    passed: environment.env.filter((name) => login[name] !== undefined),
    missing: environment.env.filter((name) => login[name] === undefined),
  };
}

/**
 * Whether `session` was launched in `dir` with full tools. Claude then trusts
 * that folder for it, running or not, so nothing may move the folder to a
 * PR's newer head: its next launch would load the author's new hooks.
 */
export function launchedWithFullTools(
  session: Pick<Session, 'cwd' | 'toolPolicy'>,
  dir: string,
): boolean {
  // Any policy is not full tools: a write step's session included (slice 3-B).
  return session.cwd === dir && session.toolPolicy === undefined;
}

/**
 * Whether an item worktree must stay as it is, so nothing refreshes it.
 *
 * - A running session works in it, launched there or moved in since: its
 *   files must not move under it.
 * - A full-tools session was launched there, running or not. Claude trusts
 *   a folder per path, so moving a worktree it already trusts would load
 *   the PR author's newly pushed settings and hooks into that session's
 *   next launch with no trust prompt. A read-only session launches
 *   `--restricted`, which never loads them, so only a running one holds it.
 *
 * The worktree is one per item, so this is about every session on it, not
 * only the one about to run.
 */
export function worktreeHeld(
  sessions: readonly Session[],
  dir: string,
  isRunning: (session: Session) => boolean,
): boolean {
  return (
    sessions.some((session) => launchedWithFullTools(session, dir)) ||
    runningIn(sessions, dir, isRunning)
  );
}

/** Whether a running session works in `dir`, launched there or moved in since: its files must not move under it. */
export function runningIn(
  sessions: readonly Session[],
  dir: string,
  isRunning: (session: Session) => boolean,
): boolean {
  return sessions.some(
    (session) => (session.cwd === dir || session.agentCwd === dir) && isRunning(session),
  );
}

/**
 * A session the person started on `workItem` with the action `label` after
 * `since`: an automation's own sessions, and ones started before, do not
 * count. Checked under `itemActionLaunchKey`, the lock an Inbox click takes.
 */
export function findStartedByHand(
  sessions: readonly Session[],
  workItem: WorkItemRef,
  label: string,
  since: string,
): Session | undefined {
  const after = Date.parse(since);
  return sessions.find(
    (session) =>
      !session.automation &&
      sameWorkItem(session.workItem, workItem) &&
      session.workItemAction === label &&
      session.createdAt > after,
  );
}

/** Why an automation cannot work on an item whose repository no scope holds. */
export function missingCloneMessage(workItem: WorkItemRef): string {
  const what = workItem.type === 'pr' ? 'review its pull requests' : 'work on its issues';
  return `Clone ${workItem.repo} into one of this workspace’s scopes to ${what} automatically.`;
}

export type ItemWorktreeDeps = Pick<
  AgentLaunchDeps,
  | 'resolveDriver'
  | 'resolveRepo'
  | 'worktreePathFor'
  | 'ensureWorktree'
  | 'refreshWorktree'
  | 'worktreeInUse'
  | 'composeEnv'
>;

/**
 * The item's Consola worktree, made ready: the clone resolved among the
 * workspace's scopes, the worktree ensured under the per-item chain with git
 * hooks off, and, when `refreshExisting`, an existing one nothing holds
 * (`worktreeHeld`) brought to the PR's head, serialised with Inbox clicks.
 *
 * Refreshing is for read-only sessions only. Claude records folder trust per
 * path, so moving a worktree the person already trusted would load the PR
 * author's newly pushed settings and hooks into a full-tools session with no
 * trust prompt. A full-tools start uses the worktree exactly as it is, and a
 * read-only start leaves alone one a full-tools session was launched in.
 */
export async function prepareItemWorktree(
  deps: ItemWorktreeDeps,
  workspace: Workspace,
  workItem: WorkItemRef,
  options: { refreshExisting: boolean },
): Promise<{ cwd: string; scopeId: string }> {
  if (!workspace.provider) throw new Error('This workspace has no provider account bound.');
  const clonePath = deps.resolveRepo(workspace, workItem.repo);
  if (!clonePath)
    throw new Error(`Clone ${workItem.repo} into one of this workspace’s scopes first.`);
  const driver = deps.resolveDriver(workspace.provider.id);
  // Checking a PR out runs git hooks, and a repo whose hooks path lives in
  // its own tree (husky) would run the PR's — unattended, outside any
  // sandbox, for whoever got a review requested of this person.
  const env = withoutGitHooks(await deps.composeEnv(driver, workspace.provider.accountLogin));
  const existed = fs.existsSync(path.join(deps.worktreePathFor(workItem), '.git'));
  const cwd = await chainWorktreeStep(`${workspace.id}:${workItemKey(workItem)}`, async () => {
    const dir = await deps.ensureWorktree(clonePath, workItem, env);
    if (options.refreshExisting && existed && !deps.worktreeInUse(dir)) {
      // Best effort: a refresh that fails leaves the review on what is there.
      await deps
        .refreshWorktree(dir, workItem, env)
        .catch((error: unknown) =>
          console.error(`Could not bring ${dir} up to date; reviewing it as it is.`, error),
        );
    }
    return dir;
  });
  return { cwd, scopeId: scopeIdForPath(workspace, clonePath) };
}

/**
 * Start an automation's session: the steps of an Inbox click, but headless,
 * since there is no pane to mount — and read-only, whatever it runs.
 *
 * An item run resolves the item's repo among the workspace's scopes, runs in
 * the item's worktree (one per item, shared with Inbox launches, serialised
 * the same way), and lands in its action's group. A re-requested review
 * reads the PR as it is now: an existing worktree nobody is using is checked
 * out again when it is clean. A scheduled run starts in its scope's folder.
 * Either way the record carries where it came from, and its policy is fixed
 * for its lifetime.
 *
 * A step of a `steps:` run runs in the folder the engine prepared for it
 * (`request.step`): its item's automation checkout, or its scope's folder.
 * Nothing here prepares a worktree for it, and it looks for a review
 * started by hand only when the engine asks (`startedByHandSince`).
 */
export async function launchAgentRun(
  deps: AgentLaunchDeps,
  request: AgentLaunchRequest,
): Promise<Session & { environment?: LaunchEnvironment }> {
  const workspace = deps.getWorkspace(request.workspaceId);
  if (!workspace) throw new Error(`No workspace ${request.workspaceId}.`);
  const { step } = request;
  const agent = step?.agent;
  // Checked again here, not only when the factory applied: a harness edited
  // since must fail the step, never launch it on the ambient default.
  const refused =
    agent?.harnessId !== undefined ? agentHarnessRefusal(deps.harnesses(), agent.harnessId) : null;
  if (refused) throw new Error(`It did not start: ${refused}.`);
  // What its agent names is compiled now, at each attempt's launch, and rides
  // on the session's record into every launch of it; never dropped silently.
  // A write agent always compiles: its grants are what holds it to its environment.
  const compiled =
    step &&
    agent &&
    (agent.mcpServers.length > 0 || agent.skills.length > 0 || agent.tools !== undefined)
      ? await compileForLaunch(deps, workspace, step, agent)
      : undefined;
  const grants = compiled?.grants;
  const common = {
    workspaceId: workspace.id,
    instanceId: generateSessionInstanceId(workspace.id),
    // A step's agent runs on its own harness, with its model; any other run on the workspace's default.
    harnessId: agent?.harnessId ?? workspace.defaultHarnessId,
    ...(agent?.model !== undefined ? { model: agent.model } : {}),
    kind: 'interactive' as const,
    // A write agent's session writes (slice 3-B); every other run's is read-only.
    toolPolicy: agent?.tools ?? ('read-only' as const),
    automation: {
      name: request.run.automation,
      runId: request.run.id,
      ...(step ? { step: { id: step.id, attempt: step.attempt } } : {}),
    },
    // The step's cap, on the record like its tool policy: every unattended
    // launch of the session replays it.
    ...(step?.maxTurns !== undefined ? { maxTurns: step.maxTurns } : {}),
    // Its agent's grants, on the record the same way: fixed for the session's life.
    ...(grants !== undefined ? { grants } : {}),
    // What is left of the run's budget, for this first turn only: never on the record.
    ...(step?.maxBudgetUsd !== undefined ? { maxBudgetUsd: step.maxBudgetUsd } : {}),
    initialPrompt: request.prompt,
    // Nobody is watching: the first turn runs non-interactively, so
    // there is no composer to type into and no trust prompt to stall on.
    unattended: true,
  };

  if (!request.item) {
    if (step) {
      const session = await deps.launchSession(workspace.id, {
        ...common,
        name: step.name,
        scopeId: step.scopeId,
        cwd: step.cwd,
      });
      return compiled?.environment ? { ...session, environment: compiled.environment } : session;
    }
    const scope = workspace.scopes.find((candidate) => candidate.id === request.scopeId);
    if (!scope) throw new Error('Its scope is no longer in this workspace.');
    return deps.launchSession(workspace.id, {
      ...common,
      name: request.run.automation,
      scopeId: scope.id,
    });
  }

  const { title, label } = request.item;
  const workItem = toWorkItemRef(request.item.workItem);
  if (!step) {
    if (!workspace.provider) throw new Error('This workspace has no provider account bound.');
    // Checked here too, so an automation keeps its own wording: the shared
    // step's message is not about automatic runs.
    if (!deps.resolveRepo(workspace, workItem.repo)) throw new Error(missingCloneMessage(workItem));
  }
  const { startedByHandSince } = request.item;
  // The same lock an Inbox click on this item and action takes: whichever
  // comes second sees the other's session.
  return chainWorktreeStep(itemActionLaunchKey(workspace.id, workItem, label), async () => {
    if (startedByHandSince !== undefined) {
      const byHand = findStartedByHand(
        deps.getWorkspace(workspace.id)?.sessions ?? [],
        workItem,
        label,
        startedByHandSince,
      );
      if (byHand) throw new StartedByHandError(byHand.name);
    }
    // A step's folder is the engine's; a one-step run prepares the Inbox's worktree.
    const { cwd, scopeId } =
      step ??
      (await prepareItemWorktree(deps, workspace, workItem, {
        refreshExisting: true, // automations are read-only
      }));
    const groupId = readyGroup(deps, workspace, request.item!.groupId);
    const session = await deps.launchSession(workspace.id, {
      ...common,
      name: step?.name ?? title,
      scopeId,
      cwd,
      workItem,
      workItemAction: label,
      ...(groupId !== undefined ? { groupId } : {}),
    });
    return compiled?.environment ? { ...session, environment: compiled.environment } : session;
  });
}
