#!/usr/bin/env node
/*
 * A provisional `apps/cloud-api/openapi.json`, made from `cloud-global`'s and the regional
 * cell's while the one app (`@consola/cloud-api`, CON-143) is being built, so the web app can
 * move onto one client before the API generates its own. It is thrown away once the API's own
 * `openapi.test.ts` writes the real file (the plan's Task 7 deletes this script).
 *
 *   node apps/cloud-web/scripts/provisional-openapi.mjs
 *
 * What it does to the two files:
 * - the union of their paths, less the routes that only connected the two apps
 *   (`REMOVED`) and the cell's own health check (cloud-global's stands for both);
 * - their components merged, refusing a name both define differently, less those only the
 *   routes left out used;
 * - on every company route (the cell's, and `/api/connections…`), the cell token's answers
 *   (401 `token_required`/`invalid_token`, 421 `wrong_region`, 503 `token_check_unavailable`)
 *   and every 409 `workspace_pending` replaced by the caller's five: 401 `signed_out`,
 *   400 `invalid_request` (no `x-consola-workspace`), 409 `no_active_workspace` and
 *   `workspace_switched`, 403 `not_a_member`; a change also answers 403 `bad_origin`;
 * - `POST /api/workspaces` takes `{ name, slug }`, and its problems lose `region_unknown`;
 * - the webhook loses its `cell_*` answers and gains 503 `unavailable`, and 201 for an
 *   event recorded.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const APPS = new URL('../../', import.meta.url);
const GLOBAL = new URL('cloud-global/openapi.json', APPS);
const CELL = new URL('cloud-region/openapi.json', APPS);
const OUT = new URL('cloud-api/openapi.json', APPS);

/** Routes that only connected `cloud-global` and the cell, gone with the split. */
const REMOVED = new Set([
  'POST /api/cell-token',
  'GET /api/cell-token/keys',
  'POST /api/github/tokens',
  'POST /api/outbox',
  'POST /api/github/events',
]);

const CHANGES = new Set(['post', 'put', 'patch', 'delete']);

const read = (url) => JSON.parse(readFileSync(url, 'utf8'));
const global = read(GLOBAL);
const cell = read(CELL);

const errorBody = (code) => ({
  type: 'object',
  properties: { error: { type: 'string', enum: [code] } },
  required: ['error'],
  additionalProperties: false,
});

/** The schema's variants: an `anyOf`'s members, or the schema alone. */
const variantsOf = (schema) => (schema?.anyOf ? [...schema.anyOf] : schema ? [schema] : []);

/** The one error code a variant answers with, if it is a plain error body. */
const codeOf = (variant) => {
  const codes = variant?.properties?.error?.enum;
  return Array.isArray(codes) && codes.length === 1 ? codes[0] : undefined;
};

const schemaOf = (response) => response?.content?.['application/json']?.schema;

/** A response holding `variants`, or none when there are none. */
function responseOf(description, variants) {
  if (variants.length === 0) return undefined;
  const schema = variants.length === 1 ? variants[0] : { anyOf: variants };
  return { description, content: { 'application/json': { schema } } };
}

/** Drops the variants whose code `drop` names; a status left with none goes. */
function dropCodes(responses, status, drop) {
  const response = responses[status];
  if (!response) return;
  const kept = variantsOf(schemaOf(response)).filter((variant) => !drop.has(codeOf(variant)));
  const next = responseOf(response.description, kept);
  if (next) responses[status] = next;
  else delete responses[status];
}

/** Adds an error body per `[code, sentence]` to `status`, keeping what it already answers. */
function addCodes(responses, status, codes) {
  const response = responses[status];
  const variants = variantsOf(schemaOf(response));
  const known = new Set(variants.map(codeOf));
  const added = codes.filter(([code]) => !known.has(code));
  if (added.length === 0) return;
  const said = [response?.description, ...added.map(([, sentence]) => sentence)]
    .filter(Boolean)
    .join(' ');
  responses[status] = responseOf(said, [...variants, ...added.map(([code]) => errorBody(code))]);
}

/** The order the API lists a route's statuses in: by number. */
function sortStatuses(responses) {
  return Object.fromEntries(Object.entries(responses).sort(([a], [b]) => Number(a) - Number(b)));
}

/** A company route's answers, with the caller's in place of the cell token's. */
function asCompanyRoute(method, operation) {
  const responses = { ...operation.responses };
  delete responses['401'];
  delete responses['421'];
  dropCodes(responses, '503', new Set(['token_check_unavailable']));
  if (responses['503']) {
    responses['503'].description = responses['503'].description.replace(
      / Or the cell cannot get cloud-global's keys just now, so it checks no token \(`token_check_unavailable`\)\./,
      '',
    );
  }
  dropCodes(responses, '409', new Set(['workspace_pending']));
  if (responses['409']) {
    responses['409'].description = responses['409'].description
      .replace(/,? or the cell does not hold the workspace yet( \(`workspace_pending`\))?/, '')
      .replace(/^The cell does not hold the workspace yet[^.]*\.\s*/, '');
  }
  addCodes(responses, '401', [['signed_out', 'Nobody is signed in.']]);
  const noHeader = 'The request names no workspace (`x-consola-workspace`).';
  addCodes(responses, '400', [['invalid_request', noHeader]]);
  if (!responses['400'].description.includes('x-consola-workspace')) {
    responses['400'].description += ` Or ${noHeader.charAt(0).toLowerCase()}${noHeader.slice(1)}`;
  }
  addCodes(responses, '409', [
    ['no_active_workspace', 'The session has no active workspace (`no_active_workspace`).'],
    [
      'workspace_switched',
      'The session’s active workspace is not the one the request names (`workspace_switched`): another tab switched it. Nothing changed.',
    ],
  ]);
  addCodes(responses, '403', [
    ['not_a_member', 'The person is not a member of the workspace (`not_a_member`).'],
  ]);
  if (CHANGES.has(method)) {
    addCodes(responses, '403', [
      ['bad_origin', 'The change did not come from the web app (`bad_origin`).'],
    ]);
  }
  return { ...operation, responses: sortStatuses(responses) };
}

const paths = {};
/** The operations left out, whose components go unless a kept route uses them too. */
const dropped = [];
for (const [source, spec] of [
  ['global', global],
  ['cell', cell],
]) {
  for (const [path, operations] of Object.entries(spec.paths)) {
    for (const [method, operation] of Object.entries(operations)) {
      const route = `${method.toUpperCase()} ${path}`;
      // The cell's own `GET /api/me` and health check: cloud-global's cover both.
      if (
        REMOVED.has(route) ||
        (source === 'cell' && (path === '/api/me' || path === '/api/health'))
      ) {
        dropped.push(operation);
        continue;
      }
      if (paths[path]?.[method]) throw new Error(`${route} is in both files`);
      const company = source === 'cell' || path.startsWith('/api/connections');
      paths[path] = {
        ...paths[path],
        [method]: company ? asCompanyRoute(method, operation) : operation,
      };
    }
  }
}

// `POST /api/workspaces` takes no region: every workspace takes the deployment's.
const schemas = { ...global.components.schemas };
for (const [name, schema] of Object.entries(cell.components.schemas)) {
  if (schemas[name] && JSON.stringify(schemas[name]) !== JSON.stringify(schema)) {
    throw new Error(`${name} is defined in both files, differently: rename one`);
  }
  schemas[name] = schema;
}
const newWorkspace = structuredClone(schemas.NewWorkspace);
delete newWorkspace.properties.region;
newWorkspace.required = newWorkspace.required.filter((key) => key !== 'region');
newWorkspace.description = newWorkspace.description.replace(
  ' and a region.',
  '. Its region is the deployment’s.',
);
schemas.NewWorkspace = newWorkspace;
const invalid = structuredClone(schemas.InvalidWorkspace);
invalid.properties.problems.items.enum = invalid.properties.problems.items.enum.filter(
  (problem) => problem !== 'region_unknown',
);
schemas.InvalidWorkspace = invalid;

// The webhook records the event itself: no cell to tell.
const webhook = paths['/api/github/webhooks'].post;
webhook.responses = { ...webhook.responses };
delete webhook.responses['502'];
dropCodes(webhook.responses, '503', new Set(['cell_not_configured']));
webhook.responses['503'].description =
  'This server has no webhook secret (`GITHUB_WEBHOOK_SECRET`).';
addCodes(webhook.responses, '503', [
  ['unavailable', 'The database does not answer (`unavailable`).'],
]);
webhook.responses['409'].description =
  'This delivery was recorded already: sent again, or replayed. Nothing changed.';
webhook.responses['201'] = { ...webhook.responses['200'], description: 'Recorded.' };
webhook.responses['200'] = { ...webhook.responses['200'], description: 'A ping, received.' };
webhook.responses = sortStatuses(webhook.responses);

/** Every component a value refers to, followed through the components it names. */
function reachable(roots) {
  const seen = new Set();
  const visit = (value) => {
    if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === 'object') {
      const ref = value.$ref;
      if (typeof ref === 'string' && ref.startsWith('#/components/schemas/')) {
        const name = ref.slice('#/components/schemas/'.length);
        if (!seen.has(name)) {
          seen.add(name);
          visit(schemas[name]);
        }
      }
      Object.values(value).forEach(visit);
    }
  };
  visit(roots);
  return seen;
}
const used = reachable(paths);
const gone = new Set([...reachable(dropped)].filter((name) => !used.has(name)));

const merged = {
  openapi: global.openapi,
  info: {
    title: 'Consola Cloud API',
    version: '0',
    description:
      "Consola Cloud's one API: who is signed in, their workspaces, and what each holds (teams, factories, runs, cloud sessions, connections). A company route reads the workspace from the session and takes `x-consola-workspace`, the workspace the page shows, as a guard. Sign-in itself is Better Auth's, under /api/auth, and is not described here.",
  },
  components: {
    schemas: Object.fromEntries(Object.entries(schemas).filter(([name]) => !gone.has(name))),
    parameters: {},
  },
  paths,
  webhooks: {},
};

mkdirSync(dirname(OUT.pathname), { recursive: true });
writeFileSync(OUT, `${JSON.stringify(merged, null, 2)}\n`);
console.log(`Wrote ${OUT.pathname}: ${Object.keys(paths).length} paths.`);
