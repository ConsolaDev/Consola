// What the use cases need from the world outside, each implemented by an adapter.

import type {
  GitHubEventMessage,
  GitHubTokenRequest,
  WorkspaceRole,
} from '@consola/cloud-contract';
import type { Harness, PassClaims, Repository, RunDecision } from '@consola/runner-protocol';
import type { CloudSession, CloudSessionStatus, RunnerIdentity } from '../domain/cloudSession.js';
import type { Factory, FactoryChange, FactoryFile, FactoryVersion } from '../domain/factory.js';
import type { EventRepository, HandOver, HeldEvent } from '../domain/gitHubEvent.js';
import type {
  CheckedRun,
  Phase,
  PhaseCounts,
  RequestFacts,
  RunCursor,
  RunSummary,
  RunTrigger,
  RunWrite,
  StepRecord,
} from '../domain/run.js';
import type { ApprovalDecision, RunAnswer } from '../domain/runApproval.js';
import type { MintRefusal } from '../domain/stepToken.js';
import type { Team } from '../domain/team.js';
import type { CopyChange } from '../domain/workspaceCopy.js';

export type HealthProbe = {
  /** Whether the database answers a query, never throwing when it does not. */
  databaseAnswers(): Promise<boolean>;
};

/** What checking a token's signature found. */
export type SignatureCheck =
  /** Signed by one of `cloud-global`'s keys, for a cell, and in date: its claims, still unread. */
  | { kind: 'verified'; payload: unknown }
  /** Not a token `cloud-global` signed for a cell, or no longer in date. */
  | { kind: 'invalid' }
  /** `cloud-global`'s keys could not be had, so no token can be checked. */
  | { kind: 'keys-unavailable' };

export type TokenVerifier = {
  /**
   * Checks a cell token at `nowSeconds` (whole seconds since the epoch): its signature with
   * `cloud-global`'s public keys, allowing `CELL_TOKEN_ALGORITHM` alone, and its audience and
   * times as the contract has them. It never throws, and never lets a token through when the keys
   * cannot be had.
   */
  verify(token: string, nowSeconds: number): Promise<SignatureCheck>;
};

export type Clock = {
  /** The time now, in whole seconds since the epoch. */
  nowSeconds(): number;
};

/** What checking the signature of a delivery from `cloud-global` (a message, an event) found. */
export type DeliveryCheck =
  /** Signed by one of `cloud-global`'s keys, with the verifier's `typ`: its payload, unread. */
  | { kind: 'verified'; payload: Uint8Array }
  /** Not a delivery `cloud-global` signed. `reason` says why, for the log, never the body. */
  | { kind: 'unsigned'; reason: string }
  /** `cloud-global`'s keys could not be had, so no delivery can be checked. */
  | { kind: 'keys-unavailable' };

export type DeliveryVerifier = {
  /**
   * Checks a delivery's body, a compact JWS, with `cloud-global`'s public keys: the key its
   * header names by `kid`, `CELL_TOKEN_ALGORITHM` alone, and the one `typ` the verifier takes
   * (`OUTBOX_MESSAGE_TYPE` for the outbox, `GITHUB_EVENT_TYPE` for GitHub's events). It never
   * throws, and never lets a delivery through when the keys cannot be had.
   */
  verify(delivery: string): Promise<DeliveryCheck>;
};

/** One message, ready to apply to its workspace's copy. */
export type CopyStep = {
  workspaceId: string;
  /** The message's sequence, which becomes the copy's last applied. */
  sequence: number;
  /** The copy's last applied sequence the step was decided against: null when it held nothing. */
  after: number | null;
  change: CopyChange;
};

/** The cell's copy of each workspace and its members, kept from `cloud-global`'s outbox. */
export type WorkspaceCopies = {
  /**
   * The sequence of the last message applied to the workspace's copy, or null when the cell
   * holds nothing of it. Throws when the database does not answer.
   */
  lastApplied(workspaceId: string): Promise<number | null>;
  /**
   * In one transaction, makes the step's change and moves the copy's last applied sequence from
   * `after` to `sequence`, but only if it still is `after` (null: the copy holds nothing of the
   * workspace yet). When it is not, another delivery applied a message first, and the answer is
   * `moved`, with nothing changed. Throws when the database does not answer.
   */
  applyAfter(step: CopyStep): Promise<'applied' | 'moved'>;
};

/** What the cell keeps beside an event, read from its payload (`domain/gitHubEvent.ts`). */
export type EventReading = {
  /** What becomes of it for the workspace's runner. */
  handOver: HandOver;
  /** The repository it happened in, when its payload names one. */
  repository: EventRepository | null;
};

/** The held events a runner's hello sends again, and how many more it leaves held. */
export type HeldEvents = {
  events: HeldEvent[];
  /** Held events whose kept facts the protocol no longer reads, by delivery id: none is sent. */
  unreadable: string[];
  left: number;
};

/**
 * The GitHub events `cloud-global` passed on, each kept for its workspace. Every call is scoped
 * by the workspace's id, and throws when the database does not answer.
 */
export type GitHubEventStore = {
  /**
   * Records the event for its workspace, with what was read of it, unless the cell already has
   * one with its delivery id there (`recorded-before`, and nothing changes) or holds nothing of
   * the workspace yet (`workspace-pending`, its `workspace.created` not applied).
   */
  record(
    event: GitHubEventMessage,
    reading: EventReading,
  ): Promise<'recorded' | 'recorded-before' | 'workspace-pending'>;
  /**
   * Marks the workspace's held event as acknowledged by its runner. `not-held` for one the
   * workspace does not hold as held (acknowledged before, never handed, or unknown).
   */
  acknowledge(workspaceId: string, deliveryId: string): Promise<'acknowledged' | 'not-held'>;
  /**
   * The workspace's held events received after `sinceSeconds` (seconds since the epoch): the
   * newest `limit` of them, oldest first, and how many held events of the workspace that leaves
   * out, older ones included.
   */
  held(workspaceId: string, sinceSeconds: number, limit: number): Promise<HeldEvents>;
  /**
   * The installation and GitHub's id of a repository, by its name in any case, from the newest
   * event the workspace recorded in it; null when it recorded none there.
   */
  repositoryOf(
    workspaceId: string,
    repository: string,
  ): Promise<{ installationId: number; repositoryId: number } | null>;
};

/**
 * A workspace's teams. Every call is scoped by the workspace's id, and a team of another
 * workspace is one the store does not have (`not-found`). Every call throws when the database
 * does not answer.
 */
export type TeamStore = {
  /** Whether the cell holds the workspace's copy yet: whether its `workspace.created` is applied. */
  holdsWorkspace(workspaceId: string): Promise<boolean>;
  /** The person's role in the workspace as the cell's copy holds it, or null when not a member. */
  roleInCopy(workspaceId: string, personId: string): Promise<WorkspaceRole | null>;
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
   * Makes the person a member of the team, if they are a member of the workspace in the cell's
   * copy (`not-a-member` when not). A person already in it stays as they are.
   */
  addMember(
    workspaceId: string,
    teamId: string,
    personId: string,
  ): Promise<Team | 'not-found' | 'not-a-member'>;
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
  /** Started by this person, by global id; null: by anyone or nothing. */
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
  /**
   * The record is the run's first (waiting for approval, never started) and the workspace holds
   * the run moved on from it (`movesBackwards`): a run never moves backwards, so nothing changed.
   */
  | 'moved-on'
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
};

/**
 * A workspace's runs, as its runners record them (`domain/run.ts`). Every call is scoped by the
 * workspace's id, and a run of another workspace is one the store does not have. Every call
 * throws when the database does not answer.
 */
export type RunStore = {
  /**
   * Stores a checked run, or replaces the workspace's record of it unless that one is newer
   * (`stale`) or the run would move backwards (`moved-on`: a first record over a run that moved
   * on). A request's stored phase rolls up its children's (`requestPhase`), and recording a
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
  /**
   * One run as the cell stores it, the record a runner sent (`RunWrite`, the protocol's
   * `RunRecord`), or null when the workspace has none with that id.
   */
  recordOf(workspaceId: string, runId: string): Promise<RunWrite | null>;
  /**
   * The workspace's runs that wait for approval (`needs-approval`) and have an answer for the
   * version they run, the earliest answered first, at most `limit`, each with its record.
   */
  answeredWaiting(
    workspaceId: string,
    limit: number,
  ): Promise<Array<{ run: RunWrite; answer: RunAnswer }>>;
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

/** What the cell asks a runner to start, in the cell's terms (the socket adds the pass key). */
export type SessionStartRequest = {
  sessionId: string;
  workspaceId: string;
  repository: Repository;
  harness: Harness;
};

/** The runner that serves a workspace, as the use cases see it. */
export type RunnerChannel = {
  /** What the workspace's connected runner offers, or null when none is connected. */
  connected(workspaceId: string): Offer | null;
  /** Hands a start to the runner. Rejects when it cannot be delivered. */
  startSession(runnerId: string, request: SessionStartRequest): Promise<void>;
  /** Hands a stop to the runner. Rejects when it cannot be delivered. */
  stopSession(runnerId: string, sessionId: string): Promise<void>;
  /**
   * Hands a GitHub event to the workspace's runner, if one that runs automations is connected
   * and its hello judged: true when it went out, false otherwise, never a throw. The event stays
   * held until the runner acknowledges it, so one that did not go out goes with the runner's
   * next hello.
   */
  handEvent(workspaceId: string, event: HeldEvent): boolean;
  /**
   * Passes a person's answer to a run on to the workspace's runner (`run.answered`), as
   * `handEvent` hands an event: true when it went out. One that did not goes with the runner's
   * next hello, which every run still waiting with an answer is passed on to.
   */
  passAnswer(workspaceId: string, answer: PassedAnswer): boolean;
};

/** A person's answer to a run, as the runner is told it: the run as stored, and the answer. */
export type PassedAnswer = { run: RunWrite; decision: RunDecision; personId: string };

/** What a use case may change on a row; a key left out stays. */
export type CloudSessionChanges = Partial<
  Pick<CloudSession, 'status' | 'title' | 'hostUrl' | 'error' | 'errorCode' | 'endedAt'>
>;

/** The cell's record of its cloud sessions. Every method throws when the database does not answer. */
export type CloudSessionStore = {
  insert(session: CloudSession): Promise<void>;
  /** One session by id, whoever's. For the runner's updates, never for a person's request. */
  find(sessionId: string): Promise<CloudSession | null>;
  /** The session if it is `personId`'s own in `workspaceId`, else null. */
  findOwn(workspaceId: string, personId: string, sessionId: string): Promise<CloudSession | null>;
  /** The person's sessions in the workspace, newest first. */
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

/**
 * Signs a request for a GitHub token with the cell's own key (`CELL_PRIVATE_KEY`), whose public
 * half `cloud-global` holds for the cell's region (`CELL_PUBLIC_KEY_<REGION>`).
 */
export type GitHubTokenRequestSigner = {
  /** The request as a compact JWS: EdDSA, the key's `kid`, `typ` `GITHUB_TOKEN_REQUEST_TYPE`. */
  sign(request: GitHubTokenRequest): Promise<string>;
};

/** What `cloud-global` answered a signed request for a GitHub token with. */
export type GitHubTokenMint =
  | {
      kind: 'minted';
      /** A secret: never logged, never stored, never in an error. */
      token: string;
      /** In whole seconds since the epoch. */
      expiresAt: number;
      repositories: Array<{ id: number; fullName: string }>;
      /** As GitHub granted them, by GitHub's names. */
      permissions: Record<string, string>;
    }
  | { kind: 'refused'; refusal: Exclude<MintRefusal, 'unavailable'> }
  /** No answer, a server's failure, or an answer the contract does not hold. */
  | { kind: 'unavailable' };

/** `cloud-global`'s `POST /api/github/tokens`, as the cell calls it. */
export type GitHubTokenMinter = {
  /** Asks for a token with a signed request. Never throws, and never holds the token in a reason. */
  mint(signedRequest: string): Promise<GitHubTokenMint>;
};

/** What asking `cloud-global` for a token needs: both, or the cell asks for none. */
export type GitHubTokenAsking = { signer: GitHubTokenRequestSigner; minter: GitHubTokenMinter };

export type Ids = {
  /** A new unguessable id. */
  newId(): string;
};

/**
 * Signs session passes with the cell's own key (`PASS_PRIVATE_KEY`), whose public half each
 * session's host is handed in `session.start`.
 */
export type PassSigner = {
  /** The pass for `claims`: a compact JWS, EdDSA, with `typ` `PASS_TYPE`. */
  sign(claims: PassClaims): Promise<string>;
};

/** Everything the cloud session use cases need. */
export type CloudSessionPorts = {
  sessions: CloudSessionStore;
  runners: RunnerChannel;
  ids: Ids;
  clock: Clock;
  /** Null when the cell has no pass key: then it has no runner either, and issues no pass. */
  passes: PassSigner | null;
};

/** What a runner's messages need: the sessions, and the time. */
export type RunnerUpdatePorts = Pick<CloudSessionPorts, 'sessions' | 'clock'>;

/** What a runner's messages for automations need (`application/runnerAutomations.ts`). */
export type AutomationPorts = {
  gitHubEvents: GitHubEventStore;
  runs: RunStore;
  factories: FactoryStore;
  clock: Clock;
  /** Null when the cell has no key to sign a request with: then it gives no GitHub token. */
  gitHubTokens: GitHubTokenAsking | null;
};

/** Everything the runner's socket hands its use cases. */
export type RunnerPorts = RunnerUpdatePorts & AutomationPorts;
