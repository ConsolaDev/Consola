import assert from 'node:assert/strict';
import { test } from 'node:test';
import { allows, NOT_SHIPPED, refusals } from './check-licenses.mjs';

test('permissive and GPL-3.0-compatible licences are allowed', () => {
  for (const license of ['MIT', 'Apache-2.0', 'BSD-3-Clause', 'MPL-2.0', 'GPL-3.0-only', 'ISC']) {
    assert.equal(allows(license), true, license);
  }
});

test('GPL-2.0-only, an unknown licence and a missing one are refused', () => {
  for (const license of ['GPL-2.0-only', 'GPL-2.0', 'SSPL-1.0', 'Unknown', 'UNLICENSED', '']) {
    assert.equal(allows(license), false, license);
  }
});

test('an OR passes when one alternative does, an AND only when every part does', () => {
  assert.equal(allows('(MIT OR CC0-1.0)'), true);
  assert.equal(allows('GPL-2.0-only OR MIT'), true);
  assert.equal(allows('(Apache-2.0 AND MIT)'), true);
  assert.equal(allows('MIT AND GPL-2.0-only'), false);
});

test('identifiers match without regard to case, as SPDX matches them', () => {
  assert.equal(allows('apache-2.0'), true);
  assert.equal(allows('mit OR gpl-2.0-only'), true);
  assert.equal(allows('gpl-2.0-only'), false);
});

test('a trailing + reads as "or later"', () => {
  assert.equal(allows('GPL-2.0+'), true);
  assert.equal(allows('LGPL-2.1+'), true);
});

test('refusals lists each refused package with its licence', () => {
  const report = {
    MIT: [{ name: 'fine', versions: ['1.0.0'] }],
    'GPL-2.0-only': [{ name: 'copyleft', versions: ['2.0.0', '2.1.0'] }],
    Unknown: [{ name: 'unlabelled', versions: ['0.1.0'] }],
  };
  assert.deepEqual(refusals(report), [
    { name: 'copyleft', versions: ['2.0.0', '2.1.0'], license: 'GPL-2.0-only' },
    { name: 'unlabelled', versions: ['0.1.0'], license: 'Unknown' },
  ]);
});

test('a package that is never shipped is not refused, and says why', () => {
  const report = {
    Unknown: [
      { name: '@cursor/sdk', versions: ['1.4.2'] },
      { name: 'unlabelled', versions: ['0.1.0'] },
    ],
  };
  assert.deepEqual(refusals(report), [
    { name: 'unlabelled', versions: ['0.1.0'], license: 'Unknown' },
  ]);
  for (const [name, reason] of Object.entries(NOT_SHIPPED)) {
    assert.ok(reason.length > 0, name);
  }
});
