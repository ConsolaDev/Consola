import type {
  FactoryPick,
  FactorySnapshot,
  GitHubEventAck,
  GitHubPermissions,
  Repository,
  RunRecordMessage,
} from '@consola/runner-protocol';
import type { AgentSteps, CommandSteps } from '../steps/ports.ts';

/**
 * What the automations ring says to its cell and asks of it. `adapters/cellLink.ts` speaks it over
 * the runner's socket; the tests, over a fake. Every rejection carries one sentence for a run's
 * page, never a secret.
 */
export interface CellLink {
  /**
   * Says `message` on the socket now, when it is open and greeted; false when it is not. Nothing
   * is queued: the ring says each open run's latest record again once the next socket is greeted
   * (`AutomationsRing.connected`).
   */
  send(message: RunRecordMessage | GitHubEventAck): boolean;
  /**
   * The workspace's factories, each at its latest saved version, or with `only` that one factory
   * at that version (none, when the cell holds no such version).
   */
  factories(only?: FactoryPick): Promise<readonly FactorySnapshot[]>;
  /** A GitHub token for one step of a run, or the cell's reason for giving none. */
  token(request: TokenRequest): Promise<TokenAnswer>;
}

export type TokenRequest = {
  readonly runId: string;
  readonly stepId: string;
  readonly repository: Repository;
  readonly permissions: GitHubPermissions;
};

/** A token is a secret: the ring never logs it, records it or puts it in a sentence. */
export type TokenAnswer =
  | { readonly ok: true; readonly token: string }
  | { readonly ok: false; readonly reason: string };

/** Everything the ring reaches the world through. */
export type RingPorts = {
  readonly link: CellLink;
  readonly agentSteps: AgentSteps;
  readonly commandSteps: CommandSteps;
  /** Now, as an ISO 8601 time to the millisecond with its offset (`Date#toISOString`). */
  readonly now: () => string;
  /** SHA-256 of `text`'s UTF-8, as 64 lowercase hex digits: what a run's id is derived through. */
  readonly digest: (text: string) => string;
  /** A line for the runner's log. Never a token. */
  readonly log: (line: string) => void;
};
