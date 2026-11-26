/**
 * An agent team: Warp's software-factory layout, an alternative to the steps design.
 *
 * Triggers live in automation files; each automation hands its event to one agent (by default
 * the team's orchestrator, the "foreman"), which dispatches the other agents and is the only
 * one that speaks for the factory.
 */

/** One file of a factory, by its path relative to the factory's folder. */
export type TeamFile = { readonly path: string; readonly content: string };

/** A problem with one file of the team, by its factory-relative path. */
export type TeamIssue = { readonly file: string; readonly message: string };

export type AgentType =
  | 'CUSTOM'
  | 'FOREMAN'
  | 'TRIAGE'
  | 'SPEC'
  | 'IMPLEMENT'
  | 'REVIEW'
  | 'VERIFY';

export type TeamAgent = {
  name: string;
  description: string;
  agentType: AgentType;
  /** Passed through as written. */
  model?: string;
  harness?: 'claude' | 'codex';
  /**
   * Who may dispatch this agent. Absent: only the foreman may dispatch a non-foreman agent, and
   * nobody a foreman. `[]`: nobody. A list: only those agents.
   */
  spawnableBy?: string[];
  /** Its `agent.md` body, without the blank lines around it. */
  instructions: string;
};

/** A plain list is `in` ("is one of"); `not_in` excludes. An empty list restricts nothing. */
export type ListFilter = { in?: string[]; not_in?: string[] };

export type TeamTriggerFilter = {
  /** `owner/name`, compared without case. */
  repos?: ListFilter;
  base_branches?: ListFilter;
  /** `in`: the pull request has at least one of them; `not_in`: none of them. */
  labels?: ListFilter;
  authors?: ListFilter;
  /** `all` (the default) skips an event whose author is a bot; `self` reads as `none` for now. */
  skip_bots?: 'all' | 'self' | 'none';
};

export type TeamTrigger = { provider: string; event: string; filter: TeamTriggerFilter };

export type TeamAutomation = {
  name: string;
  enabled: boolean;
  /** The agent that takes the first turn. */
  agent: string;
  triggers: TeamTrigger[];
  /** Its `automation.md` body, without the blank lines around it: the starting prompt. */
  prompt: string;
};

export type TeamSkill = {
  name: string;
  description: string;
  /** Every file of `skills/<name>/`, with its factory-relative path (`skills/code-review/SKILL.md`). */
  files: TeamFile[];
};

export type AgentTeam = {
  agents: TeamAgent[];
  automations: TeamAutomation[];
  skills: TeamSkill[];
  foreman?: TeamAgent;
};

/** The facts of a GitHub `pull_request` webhook event that matching and prompts read. */
export type PullRequestEvent = {
  /** The webhook's `action`: opened, synchronize, reopened, ready_for_review, labeled, review_requested, closed. */
  action: string;
  merged?: boolean;
  /** `owner/name`. */
  repository: string;
  number: number;
  /** The pull request's html url. */
  url: string;
  title: string;
  author: string;
  authorIsBot?: boolean;
  draft: boolean;
  headSha: string;
  headRef: string;
  baseRef: string;
  labels: string[];
};

export type AgentRunPlan = {
  /** Who takes the first turn. */
  agent: string;
  /** Its whole first message. */
  prompt: string;
  model?: string;
  /** Who it may dispatch, each with its composed standing preamble. */
  agents: Array<{ name: string; description: string; instructions: string; model?: string }>;
  /** Every skill file and every `agents/<name>/agent.md`, by factory-relative path. */
  files: TeamFile[];
};

/** Where a run's sandbox holds things, and the run's id. */
export type AgentRunPlaces = { factoryDir: string; repositoryDir: string; runId: string };
