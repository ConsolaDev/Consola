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
    // ---- Rules of the preset, with this repository's options ----

    // `typeof import('x')` types vitest's mocked originals and lets
    // shared/types.ts name an API without importing its module.
    'typescript/consistent-type-imports': ['error', { disallowTypeAnnotations: false }],
    // The code writes T[] for a simple type and Array<...> for a compound one.
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

    // ---- Off in Biome too (biome.jsonc), for the same reasons ----

    // Terminal code matches escape and control characters on purpose.
    'no-control-regex': 'off',
    // Its fix, Object.hasOwn, needs the ES2022 lib; the code already uses the
    // safe Object.prototype.hasOwnProperty.call form.
    'prefer-object-has-own': 'off',
    // style.noNonNullAssertion.
    'typescript/no-non-null-assertion': 'off',

    // ---- Rules of the preset that stay off here, each with its reason ----

    // It reports every member written in method syntax that is read off its
    // object: store actions, injected dependencies, option callbacks. None
    // of them uses `this`, and making each a property type changes nothing.
    'typescript/unbound-method': 'off',
    // Every finding is an apostrophe in JSX text, which renders as written.
    // Oxlint's rule takes no list of characters to keep, so it is off rather
    // than every apostrophe in the copy written as &apos;.
    'react/no-unescaped-entities': 'off',
    // Biome formats every file, so an unbraced body cannot hide behind
    // misleading indentation, which is what curly guards against; the code
    // writes one-line guards (`if (!x) return;`) by choice.
    curly: 'off',
    // `import * as path from 'node:path'` is how the code imports Node's
    // modules and zod; named imports would collide with locals such as `path`.
    'import/no-namespace': 'off',
    // The main process, the servers and the scripts log with console; there
    // is no logger to send it to instead.
    'no-console': 'off',
    // Every finding is a one-line arrow executor, `(resolve) =>
    // setTimeout(resolve, ms)`, whose value Promise ignores.
    'no-promise-executor-return': 'off',
    // Custom error classes and DOM elements are narrowed with instanceof,
    // and nothing else narrows them as precisely.
    '@nkzw/no-instanceof': 'off',
    // Biome's correctness.useExhaustiveDependencies warns on the same hooks
    // while each is reviewed: adding a dependency can loop an effect.
    'react/exhaustive-deps': 'warn',
    // React Compiler's rules hold components to what the compiler can
    // memoize; the apps do not run the compiler, and read refs and the clock
    // during render on purpose.
    'react/immutability': 'off',
    'react/purity': 'off',
    'react/refs': 'off',
    'react/set-state-in-effect': 'off',
    // Each finding needs a parse, not a mechanical edit (CON-115: "Parse
    // instead of asserting", https://linear.app/consola/issue/CON-115).
    'quality/no-chained-type-assertions': 'off',
    'typescript/no-unsafe-type-assertion': 'off',
    // `...(x ? { x } : {})` is how the code leaves a key out of a record it
    // writes to a file or sends over IPC, rather than writing it undefined.
    'quality/no-conditional-empty-object-spread': 'off',
    // A declared return type is the function's contract, and the code keeps
    // it even where inference would say more.
    'quality/no-known-value-widening': 'off',
    // Record<string, unknown> is how the code holds parsed JSON while it
    // narrows it.
    'quality/no-unsafe-dictionary-type': 'off',
    // A JSON transform (compact, redact) takes and gives unknown by nature.
    'quality/no-unknown-returns': 'off',
    // `object` is right for helpers that take any non-null value
    // (hasOwnProperty checks, JSON-RPC params).
    'quality/no-object-parameters': 'off',
    // .filter().map() reads plainer than flatMap or iterator helpers, which
    // the ES2020 packages do not have.
    'quality/no-array-filter-map': 'off',
    // Its fix renames to `error_` wherever `error` is taken, and the code
    // names a caught value for what it is (`thrown`, `caught`, `failure`).
    'unicorn/catch-error-name': 'off',
    // Helpers sit beside their one caller, most of them in a test's describe
    // block.
    'unicorn/consistent-function-scoping': 'off',
    // Terminal code writes escape sequences as \x1b, as every terminal
    // reference does.
    'unicorn/no-hex-escape': 'off',
    // Each copy snapshots a Map or Set that the loop body changes (deletes
    // from, unsubscribes); iterating the live one would skip entries.
    'unicorn/no-useless-spread': 'off',
    // Separate pushes keep each palette row, and the comment above it, apart.
    'unicorn/prefer-single-call': 'off',
    // A JSON round trip is meant: it drops undefined and turns Dates into
    // strings, as writing the value to a file does, and structuredClone
    // does not.
    'unicorn/prefer-structured-clone': 'off',
    // CommonJS (the desktop's main process, the .cjs scripts) has no
    // top-level await, and the renderer builds for ES2020.
    'unicorn/prefer-top-level-await': 'off',
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
      // Tests read back, as JSON, what the code under test wrote, and their
      // assertions are the check on it. The preset already lets a test pass
      // and read such a value; returning or calling it is allowed too, and in
      // the e2e suite's helpers alike.
      files: [
        '**/*.{test,spec,integration,e2e}.{ts,tsx,mts,cts}',
        '**/*.test-helpers.{ts,tsx}',
        '**/tests/**',
      ],
      rules: {
        'typescript/no-unsafe-argument': 'off',
        'typescript/no-unsafe-assignment': 'off',
        'typescript/no-unsafe-call': 'off',
        'typescript/no-unsafe-member-access': 'off',
        'typescript/no-unsafe-return': 'off',
      },
    },
    {
      // Its migrations read workspace files older builds wrote, typed `any`
      // on purpose (each marked), and shape them into today's records.
      files: ['apps/desktop/src/shared/workspace.ts'],
      rules: {
        'typescript/no-unsafe-argument': 'off',
        'typescript/no-unsafe-assignment': 'off',
        'typescript/no-unsafe-call': 'off',
        'typescript/no-unsafe-member-access': 'off',
        'typescript/no-unsafe-return': 'off',
      },
    },
    {
      // Test helpers are tests' code, so the preset's test relaxations,
      // which name only *.test.* files, apply to them too.
      files: ['**/*.test-helpers.{ts,tsx}'],
      rules: {
        'typescript/no-explicit-any': 'off',
        'typescript/only-throw-error': 'off',
      },
    },
    {
      // JavaScript has no type annotation to give a catch callback's value,
      // and its loosely inferred types read string arrays as `any` and
      // arrays as strings.
      files: ['**/*.{js,jsx,mjs,cjs}'],
      rules: {
        'typescript/no-misused-spread': 'off',
        // A CommonJS script loads its modules with require.
        'typescript/no-require-imports': 'off',
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
  ],
});
