// Oxlint owns JavaScript and TypeScript linting; Biome formats, lints CSS
// and owns accessibility, and turns off its rules that Oxlint runs as the same
// rule (biome.jsonc), so each check runs in one tool. Oxlint runs Cloudflare's
// preset (@cloudflare/oxlint-config), whose type-aware rules read the real
// types through `tsrs`. They need the
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
    // Braces whenever a body is not on its condition's line: the body Biome
    // wraps onto the next line is where a second statement could later look
    // as if it were inside. One-line guards (`if (!x) return;`) stay.
    curly: ['error', 'multi-line'],
    // console.error, warn and info are how the main process, the servers and
    // the engine report; a console.log or debug left in app code is caught.
    // Programs whose output is the console are exempt below.
    'no-console': ['error', { allow: ['error', 'warn', 'info'] }],
    // `error`, or a name that says what was caught; never `e` or `err`.
    'unicorn/catch-error-name': [
      'error',
      { ignore: ['^(cause|caught|failing|failure|reason|settling|thrown|timeout)$'] },
    ],
    // A nested function declaration that captures nothing moves out. Local
    // arrow helpers stay beside their one caller, the code's way of writing
    // them.
    'unicorn/consistent-function-scoping': ['error', { checkArrowFunctions: false }],

    // ---- Right for this code, with a backlog: they warn until it is cleared ----
    // CI runs Oxlint with --quiet, as it runs Biome: a warning shows in the
    // editor, where it points at the line being changed.

    // Biome's correctness.useExhaustiveDependencies warns on the same hooks
    // while each is reviewed: adding a dependency can loop an effect.
    'react/exhaustive-deps': 'warn',
    // The Rules of React, from React's own hooks plugin, which recommends them
    // with or without the React Compiler. Each finding needs its component
    // changed by hand (CON-137: "Clear the Rules of React warnings",
    // https://linear.app/consola/issue/CON-137).
    'react/immutability': 'warn',
    'react/purity': 'warn',
    'react/refs': 'warn',
    'react/set-state-in-effect': 'warn',
    // Each finding needs a parse, not a mechanical edit (CON-115: "Parse
    // instead of asserting", https://linear.app/consola/issue/CON-115). Off
    // in tests, whose fakes are built with assertions on purpose.
    'quality/no-chained-type-assertions': 'warn',
    'typescript/no-unsafe-type-assertion': 'warn',
    // No slop: all of nkzw's quality plugin is on. These six warn until
    // every finding is fixed, then become errors (CON-138: "No slop: turn on
    // all six of nkzw's quality rules",
    // https://linear.app/consola/issue/CON-138).
    'quality/no-array-filter-map': 'warn',
    'quality/no-conditional-empty-object-spread': 'warn',
    'quality/no-known-value-widening': 'warn',
    'quality/no-object-parameters': 'warn',
    'quality/no-unknown-returns': 'warn',
    'quality/no-unsafe-dictionary-type': 'warn',

    // ---- Off here, each with its reason ----

    // Accessibility is Biome's (biome.jsonc's a11y group, where both are
    // errors), so each finding is reported once.
    'jsx-a11y/alt-text': 'off',
    'react/button-has-type': 'off',

    // Terminal input parsing, and the sanitizers that strip control
    // characters from untrusted text (oneLine, a step's output, secrets),
    // match them on purpose. Off in Biome too.
    'no-control-regex': 'off',
    // A namespace import is how each library the code uses is meant to be
    // imported: Node's modules, Effect's and t3code's service modules, Radix
    // primitives, drizzle's schema files, node-pty, esbuild. Even with those
    // left out, what it flags is that same style.
    'import/no-namespace': 'off',
    // Every finding returns what an executor's own call gives back (a one-line
    // arrow over setTimeout, once or listen, or an early `return resolve()`),
    // which Promise ignores. None returns a value meant as the promise's
    // result, the bug the rule is for.
    'no-promise-executor-return': 'off',
    // It already allows classes named ...Error or ...Exception. What it
    // flags is DOM nodes and events, typed arrays and jose's error classes,
    // which nothing narrows as plainly as instanceof.
    '@nkzw/no-instanceof': 'off',
    // Every finding is a control character (ESC, BEL, DEL, NUL, Ctrl+C) in
    // terminal, PTY or sanitizing code, written as \x1b as terminal
    // references write it.
    'unicorn/no-hex-escape': 'off',
    // What it flags is a copy before a loop, which is a snapshot: a listener
    // the loop calls may subscribe another, which a live Set would then call
    // in the same pass (Node's EventEmitter copies its listeners for the same
    // reason). The code copies every such loop rather than judging which
    // bodies can add. Its one other finding, terminalStore's
    // `...{ status }`, keeps TypeScript (TS2783) from calling the property
    // always overwritten by the spread after it.
    'unicorn/no-useless-spread': 'off',
    // It is not type-aware: it reports any object's push(), and its fix
    // merges the calls. A ring buffer, a turn reader and a stderr tail have a
    // push of their own, whose tests push in separate calls on purpose (a
    // secret split across chunks); merged, three of them no longer compiled.
    'unicorn/prefer-single-call': 'off',
    // It reports every member written in method syntax that is read off its
    // object: store actions, injected dependencies, option callbacks. Each was
    // checked: none uses `this`, so none can lose it.
    'typescript/unbound-method': 'off',
    // Every finding is an apostrophe in JSX text, which renders as written.
    // Oxlint's rule takes no list of characters to keep, so it is off rather
    // than every apostrophe in the copy written as &apos;.
    'react/no-unescaped-entities': 'off',
  },
  overrides: [
    {
      // These packages type-check against the ES2020 library, which has no
      // Array#at, String#replaceAll, Error cause or Object.hasOwn.
      files: [
        'apps/desktop/**',
        'apps/website/**',
        'packages/automation-engine/**',
        'packages/factory-spec/**',
      ],
      rules: {
        'preserve-caught-error': 'off',
        'prefer-object-has-own': 'off',
        'unicorn/prefer-at': 'off',
        'unicorn/prefer-string-replace-all': 'off',
      },
    },
    {
      // Cloudflare's preset narrows instead of asserting with `!`. These
      // packages still assert in about 200 places, which Biome allowed, so it
      // warns here until each is narrowed (CON-115); everywhere else it is an
      // error.
      files: [
        'apps/desktop/**',
        'apps/website/**',
        'packages/automation-engine/**',
        'packages/factory-spec/**',
      ],
      rules: { 'typescript/no-non-null-assertion': 'warn' },
    },
    {
      // CommonJS has no top-level await: the desktop's main process and
      // preload, the CommonJS packages and the .cjs scripts.
      files: [
        '**/*.cjs',
        'apps/desktop/src/main/**',
        'apps/desktop/src/preload/**',
        'packages/automation-engine/**',
        'packages/factory-spec/**',
        'packages/sandbox/**',
      ],
      rules: { 'unicorn/prefer-top-level-await': 'off' },
    },
    {
      // Programs whose output is the console: scripts, tools, CI's scripts,
      // the fake CLIs tests run, and the servers' and seed's start-up lines.
      files: [
        '**/scripts/**',
        'tools/**',
        '.github/scripts/**',
        '**/tests/fixtures/**',
        'apps/cloud-api/src/main.ts',
        'apps/cloud-api/src/seed.ts',
        'apps/desktop/test-pty.js',
      ],
      rules: { 'no-console': 'off' },
    },
    {
      // Tests read back, as JSON, what the code under test wrote, and their
      // assertions are the check on it. The preset already lets a test pass
      // and read such a value; returning or calling it is allowed too, and in
      // the e2e suite's helpers alike. A test builds its fakes with
      // assertions, keeps its helpers in its describe block, and round-trips
      // values through JSON to get what a file or the wire would give, and
      // (as the preset has it for *.test.* files) may assert with `!`.
      files: [
        '**/*.{test,spec,integration,e2e}.{ts,tsx,mts,cts,js,mjs,cjs}',
        '**/*.test-helpers.{ts,tsx}',
        '**/tests/**',
      ],
      rules: {
        'quality/no-chained-type-assertions': 'off',
        'typescript/no-non-null-assertion': 'off',
        'typescript/no-unsafe-type-assertion': 'off',
        'unicorn/consistent-function-scoping': 'off',
        'unicorn/prefer-structured-clone': 'off',
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
