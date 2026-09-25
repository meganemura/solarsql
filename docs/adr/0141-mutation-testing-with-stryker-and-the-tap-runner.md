# ADR 0141: mutation testing runs on StrykerJS with the tap runner

Status: accepted (2026-09-26)

## Context

Line coverage tells us a line ran, not that a test would catch a change to it.
Mutation testing changes the source in small ways and checks whether a test fails.
A surviving mutant marks a line a test does not actually guard.

The tests run `.ts` files directly with Node's own type stripping (AGENTS.md, Rules): the inner loop is synchronous and in-process.
A mutation testing tool needs a runner that can drive this suite without a rewrite.

## Decision

`@stryker-mutator/core` and `@stryker-mutator/tap-runner`, both 10.0.0, are exact-pinned dev dependencies.
`npm run test:mutation` runs `stryker run`.
CI does not run it: a full pass over `src/` takes about 9 to 10 hours.
Incremental mode keeps `reports/stryker-incremental.json`, and a later run tests only the mutants a change could affect.
`reports/` and `.stryker-tmp/` are gitignored.

The runner is `tap`.
Node's test runner writes TAP with `--test-reporter=tap`; the tap runner reads that output with a TAP parser.
No test file needs to change, and the tap runner does not depend on `node-tap`.

Runners considered and refused, counted by transitive dependencies in an empty project's lockfile and weekly npm downloads (measured 2026-09-26):

- Vitest 5.0.1: 62 dependencies, about 73.83 million weekly downloads. Gives per-test coverage and full incremental test location. Refused: it needs the tests rewritten, and it adds dependencies the current suite does not carry.
- Mocha 12.0.2: 25 dependencies, about 10.78 million weekly downloads. Gives per-test coverage. Refused for the same reason as Vitest. First choice if the suite ever moves off `node:test`.
- Jest 30.5.2: 316 dependencies. Refused: too many dependencies.
- Jasmine 7.0.0: 10 dependencies, about 1.30 million weekly downloads. Incremental mode can track only test names, not locations. Refused: the tests still need a rewrite to use it, for less benefit than Mocha or Vitest.

For scale: Stryker's own core carries 166 transitive dependencies; core with the tap runner carries 176. Most of the count comes from Stryker itself, not the runner choice.

The tap runner's cost: one test file is one test unit. A mutant's coverage is the whole file that covers it, not a single test case, and a static mutant (code that runs only while a file loads) cannot be told apart by coverage. Each test file runs in its own process. If the full run's time ever becomes unworkable, revisit the runner choice.

Three configuration decisions in `stryker.config.json`, recorded there as `_comment` fields:

1. `tsconfigFile` names a file that does not exist. TypeScript 7 has no JS API, and Stryker core calls `ts.parseConfigFileTextToJson` to rewrite the sandbox's tsconfig; without that function, startup fails. The project's tsconfig has no `extends` and no `references`, so the rewrite would change nothing anyway. Upstream tracks the fix as stryker-js issue #6111 and pull request #6231 (parse with `jsonc-parser` instead of importing `typescript`). Remove this setting once a release carries the fix. Refused alternative: install TypeScript 6 alongside TypeScript 7 under the `typescript` package name, the form TypeScript's own 7.0 announcement gives. `test/fixture-dir.ts` calls `node_modules/typescript/bin/tsc` by path, so that swap would silently run the stale-type check against TypeScript 6.
2. `disableTypeChecks` is scoped to `src/**/*.ts`. The default, `true`, adds `// @ts-nocheck` to every TypeScript file in the sandbox, including the example's committed generated files; the build's tests then saw those files as changed and failed.
3. `tap.testFiles` excludes `test/stale.test.ts`. That test checks the result of `tsc`. Instrumented `src` carries mutation-testing code and `// @ts-nocheck`, so its inferred types differ regardless of any mutant. `npm test` still runs this test on its own.

## Consequences

- The first run found 14,140 mutants across 28 files under `src/`. A dry run over 52 test files took 33 seconds.
- A run against `src/runtime/id.ts` found five surviving mutants. They showed four gaps in the tests: the random bits, the start value of the counter in a new millisecond, the counter's ceiling (`0xfff`), and the process's first call at time 0. Tests for these gaps brought the count of surviving mutants to zero.
- `npm audit` reports two more moderate advisories, through `@stryker-mutator/core`'s dependency on `typed-rest-client`, which depends on `qs`.
