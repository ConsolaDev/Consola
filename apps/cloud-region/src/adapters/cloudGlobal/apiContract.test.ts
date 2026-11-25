import { readFileSync } from 'node:fs';
import openapiTS, { astToString } from 'openapi-typescript';
import { describe, expect, it } from 'vitest';

/**
 * `cloud-global`'s contract is its `openapi.json`, read as a file: the cell imports nothing from
 * another app. `apiContract.ts` holds its types, generated here, so a change to `cloud-global`
 * the cell has not followed fails this test, and then the typecheck wherever the cell's client no
 * longer fits it (`pnpm --filter @consola/cloud-region api:generate` rewrites it).
 */
const SPEC = new URL('../../../../cloud-global/openapi.json', import.meta.url);

const HEADER = `/**
 * The types of cloud-global's API, generated from apps/cloud-global/openapi.json by
 * \`pnpm --filter @consola/cloud-region api:generate\`. Never edit this file by hand.
 */

`;

describe('apiContract.ts', () => {
  it("is cloud-global's openapi.json, as generated", async () => {
    const spec = JSON.parse(readFileSync(SPEC, 'utf8'));
    const types = astToString(await openapiTS(spec, { alphabetize: false }));
    await expect(`${HEADER}${types}`).toMatchFileSnapshot('./apiContract.ts');
  });
});
