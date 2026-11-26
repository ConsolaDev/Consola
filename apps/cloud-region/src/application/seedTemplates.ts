import { checkFactoryFiles } from '../domain/factory.js';
import type { FactoryFile } from '../domain/factory.js';
import { CODE_REVIEW_TEAM_TEMPLATE } from '../domain/factoryTemplates.js';
import type { FactoryStore, TeamStore } from './ports.js';

/** What seeding the code review team did in one workspace. */
export type TemplateSeed =
  | { kind: 'created' | 'updated' | 'unchanged'; factoryId: string; version: number }
  /** A factory of that name belongs to another team than the first: it is someone's, left alone. */
  | { kind: 'taken'; factoryId: string }
  | 'workspace-pending';

/** Whether two sets of files hold the same paths with the same texts. */
function sameFiles(a: readonly FactoryFile[], b: readonly FactoryFile[]): boolean {
  const key = (files: readonly FactoryFile[]) =>
    JSON.stringify(
      [...files].sort((x, y) => (x.path < y.path ? -1 : 1)).map((f) => [f.path, f.content]),
    );
  return key(a) === key(b);
}

/**
 * Installs the code review team in a workspace the cell holds, for the demo seed: a factory named
 * after the template (`Code review team`) on the workspace's first team, whose latest files are
 * exactly the template's. It is made when missing, and a new version is saved only when its
 * latest files differ, the way the `Demo · <team>` factories are refreshed. The files go through
 * `checkFactoryFiles` first, as any save does, so a template the cell would refuse throws here.
 */
export async function seedCodeReviewTeam(
  ports: { teams: TeamStore; factories: FactoryStore },
  workspaceId: string,
): Promise<TemplateSeed> {
  const { teams, factories } = ports;
  if (!(await teams.holdsWorkspace(workspaceId))) return 'workspace-pending';
  const template = CODE_REVIEW_TEAM_TEMPLATE;
  const check = checkFactoryFiles(template.files);
  if (!check.ok) {
    throw new Error(`The ${template.name} template does not save: ${JSON.stringify(check.issues)}`);
  }
  const first = (await teams.list(workspaceId)).find((team) => team.first);
  if (!first) throw new Error(`Workspace ${workspaceId} has no first team.`);
  const savedBy = first.memberIds[0] ?? 'demo-seed';

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
