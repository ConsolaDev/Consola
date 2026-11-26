/// <reference types="node" />
import { readFileSync } from 'node:fs';
import openapiTS, { astToString } from 'openapi-typescript';
import { describe, expect, it } from 'vitest';

/**
 * The API's contract is `cloud-api`'s `openapi.json`, read as a file: the web app imports
 * nothing from another app. `apiContract.ts` holds its types, generated here, so a change to
 * the API that the web app has not followed fails this test, and then the typecheck wherever
 * the web app no longer fits it.
 */
const SPEC = new URL('../../../cloud-api/openapi.json', import.meta.url);

const HEADER = `/**
 * The types of Consola Cloud's API, generated from apps/cloud-api/openapi.json by
 * \`pnpm --filter @consola/cloud-web api:generate\`. Never edit this file by hand.
 */

`;

describe('apiContract.ts', () => {
  it("is cloud-api's openapi.json, as generated", async () => {
    const spec = JSON.parse(readFileSync(SPEC, 'utf8'));
    const types = astToString(await openapiTS(spec, { alphabetize: false }));
    await expect(`${HEADER}${types}`).toMatchFileSnapshot('./apiContract.ts');
  });
});
