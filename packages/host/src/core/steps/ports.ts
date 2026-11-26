import type { OutputType } from '@consola/factory-spec';
import type { Harness, Repository } from '@consola/runner-protocol';

/** Where a step works: a repository at one commit. */
export type StepCheckout = {
  readonly repository: Repository;
  /** The commit to check out: 40 lowercase hex characters. */
  readonly commit: string;
  /** The pull request it belongs to, when there is one: its head is fetched as `pull/<n>/head`. */
  readonly pullRequest: number | null;
  /** The pull request's base branch, when there is one: what its changes are read against. */
  readonly baseRef: string | null;
};

export type StepIdentity = {
  readonly runId: string;
  readonly stepId: string;
  /** From 1. */
  readonly attempt: number;
};

/** What an agent step's session may do. Stage 1 has `read-only` alone. */
export type StepPolicy = 'read-only';

export type StepDocument = { readonly name: string; readonly content: string };

export type OutputTail = {
  readonly stdout: string;
  readonly stderr: string;
  readonly truncated: boolean;
};

export type AgentStepRequest = StepIdentity & {
  readonly harness: Harness;
  readonly model: string | null;
  readonly checkout: StepCheckout | null;
  /** A token that can read the repository, for the clone. Never logged, never recorded. */
  readonly cloneToken: string | null;
  /** The step's whole first message, as the engine's step prompt builder wrote it. */
  readonly prompt: string;
  /** The message for the one reminder, given what is still missing. */
  readonly reminder: (missing: {
    readonly outputs: readonly string[];
    readonly artifacts: readonly string[];
  }) => string;
  /** The outputs the step declares, by name, as factory-spec types them. */
  readonly outputs: Readonly<Record<string, OutputType>>;
  /** The documents it must write before it ends (`handover` among them when required). */
  readonly requiredArtifacts: readonly string[];
  /** Every document name it may write. */
  readonly allowedArtifacts: readonly string[];
  /** The documents it may read (`reads:`), each by the name its prompt lists. */
  readonly readable: readonly StepDocument[];
  readonly policy: StepPolicy;
  readonly maxTurns: number | null;
  readonly timeoutMs: number;
};

export type AgentStepResult = {
  readonly status: 'completed' | 'failed';
  /** One sentence for a failed step. Never a secret. */
  readonly error: string | null;
  /** The outputs that passed their declared types; empty when none did. */
  readonly outputs: Readonly<Record<string, string | number | boolean>>;
  /** The documents it wrote. */
  readonly artifacts: readonly StepDocument[];
  readonly costUsd: number | null;
  readonly turns: number | null;
  /** The tools the policy refused, by name. */
  readonly deniedTools: readonly string[];
  readonly reminded: boolean;
  /** The end of what the session said, for the run's page. Untrusted text. */
  readonly output: OutputTail | null;
};

export interface AgentSteps {
  run(request: AgentStepRequest, signal: AbortSignal): Promise<AgentStepResult>;
}

export type CommandStepRequest = StepIdentity & {
  readonly checkout: StepCheckout | null;
  readonly cloneToken: string | null;
  /** The command, run by `bash -c` in the checkout (or in an empty folder when there is none). */
  readonly command: string;
  /** Plain variables: the step's `env:` and Consola's own (`CONSOLA_CHECKOUT_HEAD`, …). */
  readonly env: Readonly<Record<string, string>>;
  /** Variables whose values are secrets (a GitHub token): masked in everything that comes back. */
  readonly secretEnv: Readonly<Record<string, string>>;
  /** Files written before the command runs, each at `path`, relative to the attempt's folder. */
  readonly files: ReadonlyArray<{ readonly path: string; readonly content: string }>;
  /** Variables whose value is the absolute path, inside the sandbox, of one of `files`, by its `path`. */
  readonly fileEnv: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
};

export type CommandStepResult = {
  readonly exitCode: number | null;
  readonly signal: string | null;
  /** One sentence when the command could not be run at all (the sandbox, the clone). Never a secret. */
  readonly error: string | null;
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
  readonly output: OutputTail;
  /** The `key=value` lines it appended to `$CONSOLA_OUTPUT`, masked. */
  readonly outputs: Readonly<Record<string, string>>;
};

export interface CommandSteps {
  run(request: CommandStepRequest, signal: AbortSignal): Promise<CommandStepResult>;
}
