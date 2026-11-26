import { agentRunRecord } from '../domain/agentRun.js';
import type { CloudSession } from '../domain/cloudSession.js';
import { checkFactoryFiles } from '../domain/factory.js';
import type { FactoryFile } from '../domain/factory.js';
import { CODE_REVIEW_TEAM_TEMPLATE } from '../domain/factoryTemplates.js';
import type {
  CloudSessionStore,
  FactoryStore,
  MembershipReader,
  RunStore,
  TeamStore,
} from './ports.js';
import { recordRun } from './runs.js';

/** What seeding the code review team did in one workspace. */
export type TemplateSeed =
  | { kind: 'created' | 'updated' | 'unchanged'; factoryId: string; version: number }
  /** A factory of that name belongs to another team than the first: it is someone's, left alone. */
  | { kind: 'taken'; factoryId: string };

/** Whether two sets of files hold the same paths with the same texts. */
function sameFiles(a: readonly FactoryFile[], b: readonly FactoryFile[]): boolean {
  const key = (files: readonly FactoryFile[]) =>
    JSON.stringify(
      [...files].sort((x, y) => (x.path < y.path ? -1 : 1)).map((f) => [f.path, f.content]),
    );
  return key(a) === key(b);
}

/**
 * Installs the code review team in a workspace, for the demo seed: a factory named after the
 * template (`Code review team`) on the workspace's first team, whose latest files are exactly the
 * template's, saved by the workspace's first member (its owner, as `membership` lists them). It is made when missing, and a new version is saved only when its
 * latest files differ, the way the `Demo · <team>` factories are refreshed. The files go through
 * `checkFactoryFiles` first, as any save does, so a template the cell would refuse throws here.
 */
export async function seedCodeReviewTeam(
  ports: { teams: TeamStore; factories: FactoryStore; membership: MembershipReader },
  workspaceId: string,
): Promise<TemplateSeed> {
  const { teams, factories, membership } = ports;
  const template = CODE_REVIEW_TEAM_TEMPLATE;
  const check = checkFactoryFiles(template.files);
  if (!check.ok) {
    throw new Error(`The ${template.name} template does not save: ${JSON.stringify(check.issues)}`);
  }
  const first = (await teams.list(workspaceId)).find((team) => team.first);
  if (!first) throw new Error(`Workspace ${workspaceId} has no first team.`);
  const savedBy = (await membership.memberIds(workspaceId))[0] ?? 'demo-seed';

  let kind: 'created' | 'updated' | 'unchanged' = 'unchanged';
  let factory = (await factories.list(workspaceId)).find(
    (f) => f.name.toLowerCase() === template.name.toLowerCase(),
  );
  if (!factory) {
    const made = await factories.create(workspaceId, {
      name: template.name,
      teamId: first.id,
      personId: savedBy,
    });
    if (typeof made === 'string') throw new Error(`The factory was not made: ${made}`);
    factory = made;
    kind = 'created';
  }
  if (factory.teamId !== first.id) return { kind: 'taken', factoryId: factory.id };

  const latest = await factories.version(workspaceId, factory.id, factory.latestVersion);
  if (!latest || !sameFiles(latest.files, template.files)) {
    const saved = await factories.save(workspaceId, factory.id, {
      baseVersion: factory.latestVersion,
      files: template.files,
      personId: savedBy,
    });
    if (saved.kind !== 'saved') {
      throw new Error(`The template's files were not saved: ${saved.kind}`);
    }
    return {
      kind: kind === 'created' ? 'created' : 'updated',
      factoryId: factory.id,
      version: saved.version.version,
    };
  }
  return { kind, factoryId: factory.id, version: factory.latestVersion };
}

/** The demo agent run's orchestrator sent its review and finished: what its report says. */
const DEMO_AGENT_RUN_REPORT = {
  state: 'done',
  summary:
    'Posted a comment review on sprocket/catalog-portal#7 with two findings.\n\nThe review agent found a rounding error in the euro totals and a missing test for an empty basket. Both are in the review for the author to address.',
  agents: [
    {
      id: 'demo-review-thread',
      agent: 'review',
      status: 'done',
      summary:
        'Two findings: totals round each line before summing (off by a cent on large baskets), and no test covers an empty basket.',
    },
  ],
} as const;

/**
 * A finished agent run of the code review team, for the demo seed, so a run's page shows one
 * before any runner has run one: a cloud session that ended after its orchestrator reported, and its run
 * (`agentRunRecord`), a request in Runs whose conversation is that session. Its ids are fixed per
 * workspace (`demo-agent-run-<workspace>`), so seeding again changes nothing; a session already
 * there is left as it is.
 */
export async function seedDemoAgentRun(
  ports: { sessions: CloudSessionStore; runs: RunStore },
  workspaceId: string,
  factory: { id: string; name: string; version: number },
  nowMs: number,
): Promise<'created' | 'unchanged'> {
  const id = `demo-agent-run-${workspaceId}`;
  if (await ports.sessions.find(id)) return 'unchanged';
  const startedAt = Math.floor(nowMs / 1000) - 26 * 60;
  const session: CloudSession = {
    id,
    workspaceId,
    personId: null,
    repository: 'sprocket/catalog-portal',
    harness: 'claude',
    status: 'stopped',
    title: 'review-pull-requests · sprocket/catalog-portal#7 Price the catalog in euros',
    hostUrl: null,
    error: null,
    errorCode: null,
    runnerId: 'demo-runner',
    createdAt: startedAt,
    endedAt: startedAt + 14 * 60,
    origin: {
      kind: 'automation',
      factoryId: factory.id,
      factoryName: factory.name,
      automation: 'review-pull-requests',
      agent: 'orchestrator',
      item: {
        kind: 'pull_request',
        repository: 'sprocket/catalog-portal',
        number: 7,
        url: 'https://github.com/sprocket/catalog-portal/pull/7',
        title: 'Price the catalog in euros',
        headSha: 'a'.repeat(40),
      },
    },
    agentRun: {
      ...DEMO_AGENT_RUN_REPORT,
      agents: DEMO_AGENT_RUN_REPORT.agents.map((agent) => ({ ...agent })),
    },
  };
  await ports.sessions.insert(session);
  const record = agentRunRecord(
    session,
    {
      factoryVersion: factory.version,
      text: 'A pull request needs a review: sprocket/catalog-portal#7, "Price the catalog in euros", opened by octocat. Enter your procedure at the review step.',
      createdAt: new Date(startedAt * 1000).toISOString(),
    },
    new Date(nowMs).toISOString(),
  );
  if (record === null) throw new Error('The demo agent run has no origin.');
  const answer = await recordRun(ports.runs, workspaceId, record);
  if (answer.kind !== 'recorded') {
    throw new Error(`The demo agent run's run was not recorded: ${JSON.stringify(answer)}`);
  }
  return 'created';
}
