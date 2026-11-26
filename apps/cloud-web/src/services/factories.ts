import { isFactoryNameProblem } from '../domain/factories';
import type {
  FactoriesState,
  Factory,
  FactoryChange,
  FactoryRead,
  FactorySave,
  FactoryTemplate,
  FactoryVersion,
  TemplatesAnswer,
} from '../domain/factories';
import type { FactoryIssue } from '../domain/factoryProblems';
import type { Api, ApiOptions } from './api';
import { codeOf, UNAVAILABLE, workspaceCalls } from './workspaceCalls';
import type { Refusal } from './workspaceCalls';

/*
 * A workspace's factories, from the API, for the workspace the page shows (`workspaceCalls.ts`:
 * the header, and the caller's refusals every route shares). The API decides who sees which
 * factory, so the list is shown exactly as it comes, and the teams beside it are the API's list
 * for the person too: they name each factory's team, and they are the teams a factory may be
 * made for or moved to.
 *
 * Every call answers in domain types. Anything a call does not expect, an API that does not
 * answer included, is `unavailable`.
 */

/** Whether `value` has a factory's shape, as far as the page reads one. */
function isFactory(value: unknown): value is Factory {
  if (typeof value !== 'object' || value === null) return false;
  const { id, name, teamId, source } = value as Record<string, unknown>;
  return (
    typeof id === 'string' &&
    typeof name === 'string' &&
    typeof teamId === 'string' &&
    typeof source === 'object' &&
    source !== null
  );
}

/** Whether `value` has an issue's shape, as far as the page reads one. */
function isIssue(value: unknown): value is FactoryIssue {
  if (typeof value !== 'object' || value === null) return false;
  const { message, file, line, cause } = value as Record<string, unknown>;
  return (
    typeof message === 'string' &&
    (file === undefined || typeof file === 'string') &&
    (line === undefined || typeof line === 'number') &&
    (cause === undefined || typeof cause === 'string')
  );
}

/** Whether `value` has a version's shape, its files included, as far as the page reads one. */
function isVersion(value: unknown): value is FactoryVersion {
  if (typeof value !== 'object' || value === null) return false;
  const { version, savedAt, files } = value as Record<string, unknown>;
  return (
    typeof version === 'number' &&
    typeof savedAt === 'string' &&
    Array.isArray(files) &&
    files.every(
      (file) =>
        typeof file === 'object' &&
        file !== null &&
        typeof (file as Record<string, unknown>).path === 'string' &&
        typeof (file as Record<string, unknown>).content === 'string',
    )
  );
}

/** Whether `value` has a template's shape, its files included, as far as the page reads one. */
function isTemplate(value: unknown): value is FactoryTemplate {
  if (typeof value !== 'object' || value === null) return false;
  const { id, name, description, files } = value as Record<string, unknown>;
  return (
    typeof id === 'string' &&
    typeof name === 'string' &&
    typeof description === 'string' &&
    Array.isArray(files) &&
    files.every(
      (file) =>
        typeof file === 'object' &&
        file !== null &&
        typeof (file as Record<string, unknown>).path === 'string' &&
        typeof (file as Record<string, unknown>).content === 'string',
    )
  );
}

export type FactoriesService = {
  /** The factories the person sees in `workspace`, and the teams the API lists for them. */
  loadFactories(workspace: { id: string }): Promise<FactoriesState>;
  /** One factory the person sees, with its latest version's files. */
  loadFactory(workspace: { id: string }, factoryId: string): Promise<FactoryRead>;
  /** Makes a blank factory, its files stored by Consola, owned by `teamId`. */
  createFactory(
    workspace: { id: string },
    factory: { name: string; teamId: string },
  ): Promise<FactoryChange>;
  renameFactory(workspace: { id: string }, factoryId: string, name: string): Promise<FactoryChange>;
  /** Gives the factory to another team, which owns it from then on. */
  moveFactory(workspace: { id: string }, factoryId: string, teamId: string): Promise<FactoryChange>;
  /**
   * Saves `files`, every file of the factory, as its next version, made from `baseVersion`: the
   * API stores it only while that is still the latest, and only if the files keep the schema.
   */
  saveFactory(
    workspace: { id: string },
    factoryId: string,
    save: { baseVersion: number; files: ReadonlyArray<{ path: string; content: string }> },
  ): Promise<FactorySave>;
  /** The ready-made files a person can add to a factory (the same for every workspace). */
  loadTemplates(workspace: { id: string }): Promise<TemplatesAnswer>;
};

/** What a change's answer comes to, for the statuses every change shares. */
function changeOf(
  answer: { data?: unknown; error?: unknown; response: Response } | Refusal,
): FactoryChange {
  if ('kind' in answer) return answer;
  const { status } = answer.response;
  const code = codeOf(answer.error);
  if ((status === 200 || status === 201) && isFactory(answer.data)) {
    return { kind: 'changed', factory: answer.data };
  }
  if (status === 400 && code === 'invalid_factory') {
    const problems = (answer.error as { problems?: unknown }).problems;
    return {
      kind: 'invalid',
      problems: Array.isArray(problems) ? problems.filter(isFactoryNameProblem) : [],
    };
  }
  if (status === 404 && code === 'team_not_found') return { kind: 'team-not-found' };
  if (status === 404 && code === 'factory_not_found') return { kind: 'factory-not-found' };
  if (status === 409 && code === 'name_taken') return { kind: 'name-taken' };
  return UNAVAILABLE;
}

/**
 * The factories service. The page uses `factoriesService`; a test builds its own with the API's
 * `fetch` stood in for, and an origin to resolve its address against.
 */
export function createFactoriesService(options: ApiOptions = {}): FactoriesService {
  const onWorkspace = workspaceCalls(options);

  /** Runs a change for the workspace, answering how it went, and never throwing. */
  async function change(
    workspaceId: string,
    call: (api: Api) => Promise<{ data?: unknown; error?: unknown; response: Response }>,
  ): Promise<FactoryChange> {
    try {
      return changeOf(await onWorkspace(workspaceId, call));
    } catch {
      return UNAVAILABLE;
    }
  }

  return {
    async loadFactories(workspace) {
      try {
        const [factories, teams] = await Promise.all([
          onWorkspace(workspace.id, (api) => api.GET('/api/factories')),
          onWorkspace(workspace.id, (api) => api.GET('/api/teams')),
        ]);
        if ('kind' in factories) return factories;
        if ('kind' in teams) return teams;
        const listed = factories.data?.factories;
        const seenTeams = teams.data?.teams;
        if (
          factories.response.status === 200 &&
          teams.response.status === 200 &&
          Array.isArray(listed) &&
          listed.every(isFactory) &&
          Array.isArray(seenTeams)
        ) {
          return { kind: 'listed', factories: listed, teams: seenTeams };
        }
        return UNAVAILABLE;
      } catch {
        return UNAVAILABLE;
      }
    },

    async loadFactory(workspace, factoryId) {
      try {
        const answer = await onWorkspace(workspace.id, (api) =>
          api.GET('/api/factories/{factoryId}', { params: { path: { factoryId } } }),
        );
        if ('kind' in answer) return answer;
        const { data, error, response } = answer;
        if (response.status === 200 && isFactory(data?.factory) && isVersion(data?.version)) {
          return { kind: 'found', factory: data.factory, version: data.version };
        }
        const code = codeOf(error);
        if (response.status === 404 && code === 'factory_not_found') return { kind: 'not-found' };
        return UNAVAILABLE;
      } catch {
        return UNAVAILABLE;
      }
    },

    createFactory(workspace, factory) {
      return change(workspace.id, (api) => api.POST('/api/factories', { body: factory }));
    },

    renameFactory(workspace, factoryId, name) {
      return change(workspace.id, (api) =>
        api.PATCH('/api/factories/{factoryId}', {
          params: { path: { factoryId } },
          body: { name },
        }),
      );
    },

    moveFactory(workspace, factoryId, teamId) {
      return change(workspace.id, (api) =>
        api.PATCH('/api/factories/{factoryId}', {
          params: { path: { factoryId } },
          body: { teamId },
        }),
      );
    },

    async saveFactory(workspace, factoryId, { baseVersion, files }) {
      try {
        const answer = await onWorkspace(workspace.id, (api) =>
          api.POST('/api/factories/{factoryId}/versions', {
            params: { path: { factoryId } },
            body: { baseVersion, files: files.map(({ path, content }) => ({ path, content })) },
          }),
        );
        if ('kind' in answer) return answer;
        const { data, error, response } = answer;
        const { status } = response;
        const code = codeOf(error);
        if (status === 201 && isVersion(data?.version)) {
          return { kind: 'saved', version: data.version };
        }
        if (status === 400 && code === 'invalid_files') {
          const issues = (error as { issues?: unknown }).issues;
          if (Array.isArray(issues) && issues.every(isIssue)) return { kind: 'invalid', issues };
        }
        if (status === 409 && code === 'version_moved') {
          const latestVersion = (error as { latestVersion?: unknown }).latestVersion;
          if (typeof latestVersion === 'number') return { kind: 'version-moved', latestVersion };
        }
        if (status === 404 && code === 'factory_not_found') return { kind: 'not-found' };
        if (status === 413) return { kind: 'too-large' };
        return UNAVAILABLE;
      } catch {
        return UNAVAILABLE;
      }
    },

    async loadTemplates(workspace) {
      try {
        const answer = await onWorkspace(workspace.id, (api) => api.GET('/api/factory-templates'));
        if ('kind' in answer) return answer;
        const { data, response } = answer;
        if (response.status === 200 && Array.isArray(data) && data.every(isTemplate)) {
          return { kind: 'listed', templates: data };
        }
        return UNAVAILABLE;
      } catch {
        return UNAVAILABLE;
      }
    },
  };
}

/** The page's factories service. */
export const factoriesService = createFactoriesService();
