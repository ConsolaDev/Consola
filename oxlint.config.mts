// Oxlint runs beside Biome: Biome formats, lints CSS and keeps its own rules;
// Oxlint adds Cloudflare's preset (@cloudflare/oxlint-config), whose
// type-aware rules read the real types through `tsrs`. They need the
// workspace packages' `dist/` types, so `pnpm lint:oxlint` builds those first:
// without them every import from a workspace package reads as `any`.
import cloudflare from '@cloudflare/oxlint-config';
import { defineConfig } from 'oxlint';

export default defineConfig({
  extends: [cloudflare],
  env: cloudflare.env,
  ignorePatterns: [
    ...cloudflare.ignorePatterns,
    // The same files Biome leaves alone (biome.jsonc), for the same reasons.
    '**/dist/**',
    '**/release/**',
    '.claude/**',
    '.worktrees/**',
    'apps/desktop/tests/fixtures/stub-gh/**',
    // Copied from t3code; kept byte for byte (vendor/t3code/UPSTREAM.md).
    'vendor/**',
    'packages/agent-ui/src/t3/**',
    // Generated and compared byte for byte.
    'apps/cloud-web/src/domain/apiContract.ts',
    'apps/cloud-web/src/domain/cellApiContract.ts',
  ],
  rules: {
    // Terminal code matches escape and control characters on purpose.
    'no-control-regex': 'off',
    // Its fix, Object.hasOwn, needs the ES2022 lib; the code already uses the
    // safe Object.prototype.hasOwnProperty.call form.
    'prefer-object-has-own': 'off',
    // Off in Biome too (style.noNonNullAssertion).
    'typescript/no-non-null-assertion': 'off',
    // `typeof import('x')` types vitest's mocked originals and lets
    // shared/types.ts name an API without importing its module.
    'typescript/consistent-type-imports': ['error', { disallowTypeAnnotations: false }],
    'typescript/array-type': ['error', { default: 'array-simple' }],
    // `x != null` is the code's one test for null or undefined (as in nkzw's
    // base config and Biome's noDoubleEquals).
    eqeqeq: ['error', 'always', { null: 'ignore' }],
    // A timer or session declared before the closure that clears it, and
    // assigned once after, has to stay `let`.
    'prefer-const': ['error', { ignoreReadBeforeAssign: true }],
    // nkzw's settings, plus rest siblings: `const { a, ...rest } = x` names
    // `a` to leave it out of `rest` (Biome's noUnusedVariables allows it too).
    'no-unused-vars': [
      'error',
      {
        args: 'none',
        fix: { imports: 'safe-fix', variables: 'off' },
        ignoreRestSiblings: true,
        varsIgnorePattern: '^_',
      },
    ],
    // A name's length is counted in code points, by the cell and the page
    // alike, so a string spread into an array is meant.
    'typescript/no-misused-spread': ['error', { allow: ['string'] }],
    // Sorting strings by code unit is the order meant: stable whatever the
    // locale.
    'typescript/require-array-sort-compare': ['error', { ignoreStringArrays: true }],
    // node:test's test() and describe() return a promise the runner awaits.
    'typescript/no-floating-promises': [
      'error',
      {
        allowForKnownSafeCalls: [
          { from: 'package', name: ['describe', 'it', 'suite', 'test'], package: 'node:test' },
        ],
      },
    ],
  },
  overrides: [
    {
      // These packages type-check against the ES2020 library, which has no
      // Array#at, String#replaceAll or Error cause.
      files: [
        'apps/desktop/**',
        'apps/website/**',
        'packages/automation-engine/**',
        'packages/factory-spec/**',
      ],
      rules: {
        'preserve-caught-error': 'off',
        'unicorn/prefer-at': 'off',
        'unicorn/prefer-string-replace-all': 'off',
      },
    },
    {
      // Test helpers are tests' code: the preset's test relaxations apply.
      files: ['**/*.test-helpers.{ts,tsx}'],
      rules: {
        'typescript/no-explicit-any': 'off',
        'typescript/no-non-null-assertion': 'off',
        'typescript/no-unsafe-argument': 'off',
        'typescript/no-unsafe-assignment': 'off',
        'typescript/no-unsafe-member-access': 'off',
        'typescript/only-throw-error': 'off',
        'typescript/unbound-method': 'off',
      },
    },
    {
      // JavaScript has no type annotation to give a catch callback's value,
      // and its loosely inferred types read string arrays as \`any\` and
      // arrays as strings.
      files: ['**/*.{js,jsx,mjs,cjs}'],
      rules: {
        'typescript/no-misused-spread': 'off',
        'typescript/require-array-sort-compare': 'off',
        'typescript/use-unknown-in-catch-callback-variable': 'off',
      },
    },
    {
      // No React here: a callback these files name `use` is not React's hook.
      files: ['packages/host/**', 'packages/sandbox/**', 'apps/desktop/tests/fixtures/**'],
      rules: { 'react/rules-of-hooks': 'off' },
    },
    {
      // Playwright requires the fixtures argument to be destructured.
      files: ['**/tests/e2e/**'],
      rules: { 'no-empty-pattern': 'off' },
    },
    {
      // TEMPORARY: the rules that failed when the preset was adopted, with
      // their counts then. Each is either fixed and removed from this list,
      // or moved to `rules` above with the reason it stays off. An override,
      // so it also beats the preset's own overrides that turn rules back on.
      // A rule that existing eslint-disable comments name warns instead, so
      // those comments still count as used.
      files: ['**/*'],
      rules: {
        '@nkzw/no-instanceof': 'off', // 72
        curly: 'off', // 8161
        'import/no-namespace': 'off', // 855
        'no-console': 'off', // 211
        'no-promise-executor-return': 'off', // 186
        'quality/no-array-filter-map': 'off', // 33
        'quality/no-chained-type-assertions': 'off', // 302
        'quality/no-conditional-empty-object-spread': 'off', // 716
        'quality/no-known-value-widening': 'off', // 402
        'quality/no-object-parameters': 'off', // 31
        'quality/no-unknown-returns': 'off', // 70
        'quality/no-unsafe-dictionary-type': 'off', // 300
        'react/exhaustive-deps': 'warn', // 17
        'react/immutability': 'off', // 4
        'react/no-unescaped-entities': 'off', // 11
        'react/purity': 'off', // 7
        'react/refs': 'off', // 80
        'react/set-state-in-effect': 'off', // 42
        'typescript/no-require-imports': 'off', // 35
        'typescript/no-unsafe-argument': 'off', // 12
        'typescript/no-unsafe-assignment': 'off', // 82
        'typescript/no-unsafe-call': 'off', // 42
        'typescript/no-unsafe-member-access': 'off', // 118
        'typescript/no-unsafe-return': 'off', // 79
        'typescript/no-unsafe-type-assertion': 'off', // 1157
        'typescript/unbound-method': 'off', // 69
        'unicorn/catch-error-name': 'off', // 73
        'unicorn/consistent-function-scoping': 'off', // 763
        'unicorn/no-hex-escape': 'off', // 313
        'unicorn/no-useless-spread': 'off', // 52
        'unicorn/prefer-single-call': 'off', // 16
        'unicorn/prefer-structured-clone': 'off', // 22
        'unicorn/prefer-top-level-await': 'off', // 11
      },
    },
  ],
});
