/// <reference types="node" />
import { readFileSync } from 'node:fs';
import openapiTS, { astToString } from 'openapi-typescript';
import { describe, expect, it } from 'vitest';

/**
 * The cell's contract is `cloud-region`'s `openapi.json`, read as a file: the web app imports
 * nothing from another app. `cellApiContract.ts` holds its types, generated here, so a change to
 * the cell that the web app has not followed fails this test, and then the typecheck wherever the
 * web app no longer fits it. Every region's cell runs the same code, so one contract serves all.
 */
const SPEC = new URL('../../../cloud-region/openapi.json', import.meta.url);

const HEADER = `/**
 * The types of the regional cell's API, generated from apps/cloud-region/openapi.json by
 * \`pnpm --filter @consola/cloud-web api:generate\`. Never edit this file by hand.
 */

`;

describe('cellApiContract.ts', () => {
  it("is the cell's openapi.json, as generated", async () => {
    const spec = JSON.parse(readFileSync(SPEC, 'utf8'));
    const types = astToString(await openapiTS(spec, { alphabetize: false }));
    await expect(`${HEADER}${types}`).toMatchFileSnapshot('./cellApiContract.ts');
  });
});
