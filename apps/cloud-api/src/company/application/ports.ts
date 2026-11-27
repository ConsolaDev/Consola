// What the use cases need from the world outside, each implemented by an adapter.

import type { WorkspaceRole } from '../../shared/workspaceRole.js';
import type { AgentRun, FollowUp, Harness, PassClaims, Repository } from '@consola/runner-protocol';
import type { CloudSession, CloudSessionStatus, RunnerIdentity } from '../domain/cloudSession.js';
import type { Factory, FactoryChange, FactoryFile, FactoryVersion } from '../domain/factory.js';
import type {
  CheckedRun,
  Phase,
  PhaseCounts,
  RequestFacts,
  RunCursor,
  RunSummary,
  RunTrigger,
  StepRecord,
} from '../domain/run.js';
import type { ApprovalDecision, RunAnswer } from '../domain/runApproval.js';
import type { Team } from '../domain/team.js';

export type HealthProbe = {
  /** Whether the database answers a query, never throwing when it does not. */
  databaseAnswers(): Promise<boolean>;
};

/**
 * Who belongs to which workspace, as accounts' `member` holds it now. Accounts implements it and
 * the composition hands it in, so company code reads membership through it alone, by ids.
 */
export interface MembershipReader {
  /** The person's role in the workspace, or null when they are not a member of it. */
  roleOf(personId: string, workspaceId: string): Promise<WorkspaceRole | null>;
  /** The ids of the workspace's members, in the order they joined it. */
  memberIds(workspaceId: string): Promise<readonly string[]>;
  /** The id of every workspace there is, for the demo seed. */
  workspaceIds(): Promise<readonly string[]>;
}

export type Clock = {
  /** The time now, in whole seconds since the epoch. */
  nowSeconds(): number;
};

/**
 * A workspace's teams. Every call is scoped by the workspace's id, and a team of another
 * workspace is one the store does not have (`not-found`). Every call throws when the database
 * does not answer.
 */
export type TeamStore = {
  /** The workspace's teams: its first team first, then the others by name, whatever their case. */
  list(workspaceId: string): Promise<Team[]>;
  /** Makes a team with no members. `name-taken` when another team has the name, in any case. */
  create(workspaceId: string, name: string): Promise<Team | 'name-taken'>;
  rename(
    workspaceId: string,
    teamId: string,
    name: string,
  ): Promise<Team | 'not-found' | 'name-taken'>;
  /**
   * Deletes a team and every place in it, unless it is the first team or owns a factory, which
   * stay.
   */
  remove(
    workspaceId: string,
    teamId: string,
  ): Promise<'removed' | 'not-found' | 'first-team' | 'owns-factories'>;
  /**
   * Makes the person a member of the team. A person already in it stays as they are. Whether they
   * are a member of the workspace is the use case's to ask first (`MembershipReader`).
   */
  addMember(workspaceId: string, teamId: string, personId: string): Promise<Team | 'not-found'>;
  /** Takes the person out of the team. Someone not in it changes nothing. */
  removeMember(workspaceId: string, teamId: string, personId: string): Promise<Team | 'not-found'>;
};

/** What saving a factory's files found. */
export type FactorySave =
  | { kind: 'saved'; version: FactoryVersion }
  | { kind: 'not-found' }
  /** The factory's latest version is no longer the one the files were saved from. */
  | { kind: 'moved'; latestVersion: number };

/**
 * A workspace's factories and the versions of their files. Every call is scoped by the
 * workspace's id, and a factory of another workspace is one the store does not have. Every call
 * throws when the database does not answer.
 */
export type FactoryStore = {
  /** The workspace's factories, by name whatever its case. */
  list(workspaceId: string): Promise<Factory[]>;
  /** One factory, or null when the workspace has no factory with that id. */
  get(workspaceId: string, factoryId: string): Promise<Factory | null>;
  /**
   * Makes a factory owned by the team, its files stored here, with a first version that holds no
   * files, saved by `personId`. `name-taken` when another factory of the workspace has the name,
   * in any case; `team-not-found` when the workspace has no such team.
   */
  create(
    workspaceId: string,
    input: { name: string; teamId: string; personId: string },
  ): Promise<Factory | 'name-taken' | 'team-not-found'>;
  /**
   * Renames the factory, moves it to another team of the workspace, or both, in one statement:
   * all of it or none. What `change` leaves out stays; its versions stay as they are.
   * `not-found` when the workspace has no such factory, `name-taken` when another of its
   * factories has the name, in any case, and `team-not-found` when it has no such team. A team
   * being deleted at the same moment is one or the other: the move finds it gone, or the delete
   * finds it owns the factory.
   */
  change(
    workspaceId: string,
    factoryId: string,
    change: FactoryChange,
  ): Promise<Factory | 'not-found' | 'name-taken' | 'team-not-found'>;
  /** One version of a factory's files, its files by path, or null when there is no such version. */
  version(workspaceId: string, factoryId: string, version: number): Promise<FactoryVersion | null>;
  /**
   * Saves `files` as the factory's next version, saved by `personId`, if its latest version is
   * still `baseVersion`: a compare-and-set, so of two saves from one version only the first
   * lands, and the other is `moved`, with nothing changed.
   */
  save(
    workspaceId: string,
    factoryId: string,
    input: { baseVersion: number; files: readonly FactoryFile[]; personId: string },
  ): Promise<FactorySave>;
};

/**
 * Which of a workspace's top-level runs the list reads. Only runs of `factoryIds` are ever read:
 * the use case names the factories the caller sees, narrowed by the query's factory and team.
 */
export type RunFilter = {
  readonly factoryIds: readonly string[];
  /** Started one of these ways; empty: any way. */
  readonly triggers: readonly RunTrigger[];
  /** Automation runs of this name, and requests that started one; null: any. */
  readonly automation: string | null;
  /** Started by this person, by id; null: by anyone or nothing. */
  readonly startedBy: string | null;
  /** Held by the title or the automation's name, in any case; null: no such filter. */
  readonly q: string | null;
};

/** One page of the list: runs newest first, and where the next page starts, if there is one. */
export type RunPage = { runs: RunSummary[]; next: RunCursor | null };

/** What recording a run found. */
export type RunRecording =
  | 'recorded'
  /** The workspace holds a newer record of the run (a later `updatedAt`): nothing changed. */
  | 'stale'
  /** The workspace has no such factory, or the factory no such version. */
  | 'factory-not-found'
  /** The run names a parent the workspace does not hold as a request of the same factory. */
  | 'parent-not-found'
  /** The run is held already with another factory, kind or parent, which never change. */
  | 'identity-changed';

/** One run, with what its page shows beside it. */
export type RunFound = {
  run: RunSummary;
  /** The request that started it: always of the same factory, so seen whenever the run is. */
  parent: { id: string; title: string } | null;
  /** As recorded: what each step was asked is the use case's to read. */
  steps: StepRecord[];
  request: (RequestFacts & { text: string }) | null;
  /** A request's runs, in the order it started them. */
  children: RunSummary[];
  /** The cloud session holding a request's conversation with its orchestrator, by id. */
  conversation: string | null;
};

/**
 * A workspace's runs, as its runners record them (`domain/run.ts`). Every call is scoped by the
 * workspace's id, and a run of another workspace is one the store does not have. Every call
 * throws when the database does not answer.
 */
export type RunStore = {
  /**
   * Stores a checked run, or replaces the workspace's record of it unless that one is newer
   * (`stale`). A request's stored phase rolls up its children's (`requestPhase`), and recording a
   * child rolls its request's up again, in the same transaction.
   */
  record(workspaceId: string, run: CheckedRun): Promise<RunRecording>;
  /** A page of top-level runs in one of `phases` (empty: any), newest first, after `after`. */
  list(
    workspaceId: string,
    filter: RunFilter,
    page: { phases: readonly Phase[]; after: RunCursor | null; limit: number },
  ): Promise<RunPage>;
  /** How many top-level runs the filter keeps, in each phase. */
  count(workspaceId: string, filter: RunFilter): Promise<PhaseCounts>;
  /** The automations the factories' runs ran, children's included: distinct, by name. */
  automations(
    workspaceId: string,
    factoryIds: readonly string[],
  ): Promise<Array<{ factoryId: string; name: string }>>;
  /** One run, or null when the workspace has none with that id. */
  get(workspaceId: string, runId: string): Promise<RunFound | null>;
  /** The answer given to a run's request to be approved at `version`, or null while none was. */
  answerOf(workspaceId: string, runId: string, version: number): Promise<RunAnswer | null>;
  /**
   * Records `personId`'s answer to a run's request to be approved at `version`, unless that
   * version has one: the first answer stands (`already-answered`), and nothing changes. The run
   * itself is not changed. `not-found` when the workspace has no such run.
   */
  answer(
    workspaceId: string,
    runId: string,
    answer: { version: number; decision: ApprovalDecision; personId: string },
  ): Promise<RunAnswer | 'already-answered' | 'not-found'>;
};

export type { RunnerIdentity };

/** What a connected runner offers a workspace: where it can start a session, and with what. */
export type Offer = {
  runnerId: string;
  repositories: Repository[];
  harnesses: Harness[];
};

/** What the app asks a runner to start, in the app's terms (the socket adds the pass key). */
export type SessionStartRequest = {
  sessionId: string;
  workspaceId: string;
  repository: Repository;
  harness: Harness;
  /** For an agent run: its first agent, prompt, agents, files and checkout. */
  agentRun?: AgentRun;
};

/** The runner that serves a workspace, as the use cases see it. */
export type RunnerChannel = {
  /** What the workspace's connected runner offers, or null when none is connected. */
  connected(workspaceId: string): Offer | null;
  /** Hands a start to the runner. Rejects when it cannot be delivered. */
  startSession(runnerId: string, request: SessionStartRequest): Promise<void>;
  /** Hands a stop to the runner. Rejects when it cannot be delivered. */
  stopSession(runnerId: string, sessionId: string): Promise<void>;
};

/** What a use case may change on a row; a key left out stays. */
export type CloudSessionChanges = Partial<
  Pick<
    CloudSession,
    'status' | 'title' | 'hostUrl' | 'error' | 'errorCode' | 'endedAt' | 'agentRun'
  >
>;

/** The app's record of its cloud sessions. Every method throws when the database does not answer. */
export type CloudSessionStore = {
  insert(session: CloudSession): Promise<void>;
  /**
   * One session by id, whoever's. For the runner's updates and the app's own follow-ups (which
   * check the workspace), never for a person's request.
   */
  find(sessionId: string): Promise<CloudSession | null>;
  /**
   * The session if `personId` sees it in `workspaceId` (`isSeenBy`): their own, or one of the
   * workspace's agent runs. Else null.
   */
  findSeen(workspaceId: string, personId: string, sessionId: string): Promise<CloudSession | null>;
  /**
   * The person's own sessions in the workspace, newest first. An agent run is not one: it is a
   * run's conversation, listed with the runs (`agentRunRecord`), though `findSeen` finds it.
   */
  listOwn(workspaceId: string, personId: string): Promise<CloudSession[]>;
  /** The runner's sessions in its workspace that have not ended: `starting` or `running`. */
  listLive(runner: RunnerIdentity): Promise<CloudSession[]>;
  /**
   * Applies `changes` only if the row still has the status `expected`: a compare-and-set, so a
   * late update never overwrites an end. True when it applied.
   */
  update(
    sessionId: string,
    expected: CloudSessionStatus,
    changes: CloudSessionChanges,
  ): Promise<boolean>;
};

export type Ids = {
  /** A new unguessable id. */
  newId(): string;
};

/**
 * Signs session passes with the app's own key (`PASS_PRIVATE_KEY`), whose public half each
 * session's host is handed in `session.start`.
 */
export type PassSigner = {
  /** The pass for `claims`: a compact JWS, EdDSA, with `typ` `PASS_TYPE`. */
  sign(claims: PassClaims): Promise<string>;
};

/**
 * What a session's host said of a follow-up: `delivered` now, or `already-delivered` (the same
 * follow-up, before); `not-ready` while its run's first message is not yet sent; `not-here` when
 * the host at that address takes no follow-up for the session (it refused the pass, or runs no
 * agent run); `not-allowed` when the address is not one the deployment calls
 * (`hostAddressAllowed`), and nothing was sent; `failed` when it could not be reached in time, or
 * answered anything else.
 */
export type HostFollowUpAnswer =
  | 'delivered'
  | 'already-delivered'
  | 'not-ready'
  | 'not-here'
  | 'not-allowed'
  | 'failed';

/** How the app reaches a running session's host, at the address its runner reported. */
export type HostChannel = {
  /**
   * Sends a follow-up with a pass for its author to the session's host, if its address is one the
   * deployment calls. Never throws: a failure is `failed`.
   */
  sendFollowUp(
    session: { id: string; hostUrl: string },
    pass: string,
    followUp: FollowUp,
  ): Promise<HostFollowUpAnswer>;
};

/** Everything the cloud session use cases need. */
export type CloudSessionPorts = {
  sessions: CloudSessionStore;
  runners: RunnerChannel;
  ids: Ids;
  clock: Clock;
  /** Null when the app has no pass key: then it has no runner either, and issues no pass. */
  passes: PassSigner | null;
  /** The sessions' hosts, for a follow-up to a running agent run (`sendFollowUp`). */
  hosts: HostChannel;
};

/** What sending a follow-up needs: the sessions, the time, a pass for its author, and the host. */
export type FollowUpPorts = Pick<CloudSessionPorts, 'sessions' | 'clock' | 'passes' | 'hosts'>;

/** What a runner's messages need: the sessions, and the time. */
export type RunnerUpdatePorts = Pick<CloudSessionPorts, 'sessions' | 'clock'>;

/**
 * What starting agent runs needs: the workspace's factories, to find their teams, and what a
 * session's start needs. `report` hears why a run failed to start or an event started nothing,
 * one line each, never what the event says beyond ids and names.
 */
export type AgentRunPorts = Pick<CloudSessionPorts, 'sessions' | 'runners' | 'ids' | 'clock'> & {
  factories: FactoryStore;
  /** Where each agent run's run is recorded, as a request of the Runs pages. */
  runs: RunStore;
  report: (line: string) => void;
};
