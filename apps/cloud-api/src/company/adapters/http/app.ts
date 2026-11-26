import type { OpenAPIHono } from '@hono/zod-openapi';
import type {
  CloudSessionPorts,
  FactoryStore,
  MembershipReader,
  RunStore,
  TeamStore,
} from '../../application/ports.js';
import { requireCaller } from './caller.js';
import type { WhoIsAsking } from './caller.js';
import { cloudSessionRoutes } from './cloudSessions.js';
import {
  deleteTeam,
  deleteTeamMember,
  getCloudSession,
  getCloudSessionOptions,
  getFactory,
  getFactoryVersion,
  getRun,
  listCloudSessions,
  listFactories,
  listFactoryTemplates,
  listRuns,
  listTeams,
  patchFactory,
  patchTeam,
  postCloudSession,
  postCloudSessionPass,
  postCloudSessionStop,
  postFactory,
  postFactoryVersion,
  postRunApproval,
  postTeam,
  putTeamMember,
} from './contract.js';
import { factoryRoutes } from './factories.js';
import { runRoutes } from './runs.js';
import { teamRoutes } from './teams.js';

/** Every route of company's contract, in the order `registerCompanyRoutes` registers them. */
export const COMPANY_ROUTES = [
  listTeams,
  postTeam,
  patchTeam,
  deleteTeam,
  putTeamMember,
  deleteTeamMember,
  listFactories,
  postFactory,
  getFactory,
  patchFactory,
  getFactoryVersion,
  postFactoryVersion,
  listFactoryTemplates,
  listRuns,
  getRun,
  postRunApproval,
  getCloudSessionOptions,
  postCloudSession,
  listCloudSessions,
  getCloudSession,
  postCloudSessionStop,
  postCloudSessionPass,
];

/** What company's routes need: who is asking, their membership, and the use cases' ports. */
export type CompanyRouteDeps = {
  /** Who a request's session says is asking (accounts' `currentSession`). */
  whoIsAsking: WhoIsAsking;
  /** Accounts' `member`, read for each request's role and for a team's new member. */
  membership: MembershipReader;
  teams: TeamStore;
  factories: FactoryStore;
  runs: RunStore;
  cloudSessions: CloudSessionPorts;
};

/**
 * Company's HTTP API, on `app`: every route in `COMPANY_ROUTES`, each in the contract
 * (`contract.ts`), which TypeScript checks each answer against. Each route asks a use case and
 * maps its answer to a status and a body.
 *
 * Every route is behind the caller check (`requireCaller`, built once here), as its own
 * middleware and never `app.use`: a request is let on only for a member asking about the
 * workspace their session has active and their page shows, and the route gets the caller and
 * nothing else, so none takes a workspace or a person from the request. A path no route serves
 * is the app's to answer (404), whoever asks.
 *
 * What answers before a route (a body of the wrong shape, one that is not JSON, the origin check)
 * is the app's front door, and so are the health check, over every part's probe, and the
 * runner's socket (`adapters/runner`), which the composition mounts. A body is checked for its
 * shape after the caller, and before the route's use case.
 */
export function registerCompanyRoutes(app: OpenAPIHono, deps: CompanyRouteDeps): void {
  const { whoIsAsking, membership, teams, factories, runs, cloudSessions } = deps;
  const caller = requireCaller({ whoIsAsking, membership });

  teamRoutes(app, { caller, teams, membership });
  factoryRoutes(app, { caller, teams, factories });
  runRoutes(app, { caller, teams, factories, runs });
  cloudSessionRoutes(app, { caller, ports: cloudSessions });
}
