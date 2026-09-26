# ADR 0141: mutation testing runs on StrykerJS with the vitest runner

Status: accepted (2026-09-26)

## Context

Line coverage tells us a line ran, not that a test would catch a change to it.
Mutation testing changes the source in small ways and checks whether a test fails.
A surviving mutant marks a line a test does not actually guard.

The tests once ran `.ts` files directly with Node's own type stripping, one file per test unit.
Under that shape, the tap runner could drive the suite without a rewrite: each mutant's coverage was the whole file that covered it, and each test file ran in its own process.
The tests now run on Vitest.
Vitest gives Stryker per-test coverage and per-test location, so a mutant can run only the tests that actually cover it.

## Decision

The suite runs on Vitest.
`vitest.config.ts` declares three projects: `unit` (`test/*.test.ts`), `slow` (`test/slow/*.test.ts`), and `miniflare` (`test/miniflare/*.test.ts`).
`npm test` runs `vitest run --project unit`.
`npm run test:all` runs `vitest run`, all three projects.
`testTimeout` and `hookTimeout` are 600 seconds: node:test had no default timeout, and several tests (a build of the example, a workerd start, a packed install) run past Vitest's 5-second default by design.

`experimental.viteModuleRunner` is `false`: the tests and the build run as plain Node with type stripping, through Node's own import.
Three problems with the module runner drove this choice: a module namespace lists exports in declared order instead of sorted order, a missing import's error carries no `url`, and a module that failed to load stays failed after the build writes the file it lacked.

Vitest is pinned to 4.1.11, exact.
Stryker's own vitest runner, 10.0.0, fails on Vitest 5: it could not select a single test inside a `describe` block (stryker-js issue #6210; fixes #6214 and #6220 are unreleased).
A full run under Vitest 5 reported 1,356 survived mutants, and 0 tests ran for them, though the same tests pass on their own.
Pinning Vitest to 4.1.11 fixed this: one file that had shown 58 killed and 105 survived under Vitest 5 showed 145 killed and 18 survived under 4.1.11.
Move the pin to Vitest 5 once a release carries the fix.

`@stryker-mutator/core` and `@stryker-mutator/vitest-runner`, both 10.0.0, are exact-pinned dev dependencies.
`@stryker-mutator/tap-runner` is removed.
`npm run test:mutation` runs `stryker run`.
The `agent` reporter from `stryker-agent-reporter` 0.1.0 (a Stryker plugin by the same author) writes `reports/mutation/agent.jsonl` for a coding agent: each survivor with a stable key, a patch, its covering test files, and a command to rerun it. It also writes `agent.partial.jsonl` while the run goes.
The dependency rule asks for a version published 7 or more days ago; this package is excluded, as the author's own package, published from its own repository through npm trusted publishing with provenance.
CI does not run it: a full pass over `src/` takes hours.
Incremental mode keeps `reports/stryker-incremental.json`, and a later run tests only the mutants a change could affect.
`reports/` and `.stryker-tmp/` are gitignored.

Stryker's own vitest run selects tests through a separate config file, `vitest.mutation.config.ts`: `test/*.test.ts`, minus `test/stale.test.ts`.
`test/slow/` and `test/miniflare/` run code in a child process or in workerd, where Stryker cannot see which mutant the code reached, so they are left out.
`test/stale.test.ts` checks the result of `tsc`; Stryker's instrumented `src` carries `@ts-nocheck` and code that changes the inferred types, so this test fails with no mutant active.
`npm test` still runs it on its own.

Three configuration decisions in `stryker.config.json`, recorded there as `_comment` fields:

1. `tsconfigFile` names a file that does not exist. TypeScript 7 has no JS API, and Stryker core calls `ts.parseConfigFileTextToJson` to rewrite the sandbox's tsconfig; without that function, startup fails. The project's tsconfig has no `extends` and no `references`, so the rewrite would change nothing anyway. Upstream tracks the fix as stryker-js issue #6111 and pull request #6231 (parse with `jsonc-parser` instead of importing `typescript`). Remove this setting once a release carries the fix. Refused alternative: install TypeScript 6 alongside TypeScript 7 under the `typescript` package name, the form TypeScript's own 7.0 announcement gives. `test/fixture-dir.ts` calls `node_modules/typescript/bin/tsc` by path, so that swap would silently run the stale-type check against TypeScript 6.
2. `disableTypeChecks` is scoped to `src/**/*.ts`. The default, `true`, adds `// @ts-nocheck` to every TypeScript file in the sandbox, including the example's committed generated files; the build's tests then saw those files as changed and failed.
3. `vitest.configFile` names `vitest.mutation.config.ts`, the file that selects the tests this run uses.

## Rejected alternatives

The tap runner, used first.
It treated one test file as one test unit.
A mutant's coverage was the whole file that covered it, so a static mutant (code that runs only while a file loads) shared that same coarse coverage.
When the runner stopped a test process at its timeout, a fixture that waited for its parent's kill kept running; 145 such processes piled up within 20 minutes.
A limit on the fixture's own wait fixed this.
The move to the vitest runner replaced this cost with per-test coverage, at the price of moving the whole suite from node:test to Vitest.

Vitest 5: the runner cannot select a single test inside a `describe` block on it (stryker-js #6210); revisit once the fix ships.

Runners compared by transitive dependencies in an empty project's lockfile and weekly npm downloads (measured 2026-09-26), the basis for the move to Vitest:

- Vitest, chosen (counted at 5.0.1; the suite pins 4.1.11 until the runner supports Vitest 5): 62 dependencies, about 73.83 million weekly downloads. Gives per-test coverage and full incremental test location.
- Mocha 12.0.2: 25 dependencies, about 10.78 million weekly downloads. Gives per-test coverage.
- Jest 30.5.2: 316 dependencies. Refused: too many dependencies.
- Jasmine 7.0.0: 10 dependencies, about 1.30 million weekly downloads. Incremental mode can track only test names, not locations.

For scale: Stryker's own core carries 166 transitive dependencies; core with the tap runner carried 176. Most of the count comes from Stryker itself, not the runner choice.
Vitest's own transitive dependencies (62) are the cost this ADR accepts, in exchange for per-test coverage and speed.
A full vitest-runner run over `src/` (14,140 mutants) took 147 minutes on Vitest 5 and 222 minutes on Vitest 4.1.11.
The 222-minute run shared the machine with other work.
The tap runner's own estimate over the same set was about 9 to 10 hours.
A one-file, 32-mutant run took 3 seconds under tap and 6 seconds under vitest.

## Consequences

- A full run under Vitest 4.1.11 (2026-09-26) found 14,140 mutants across `src/`. The four files with the most timeouts (`scan.ts`, `typegen.ts`, `facts.ts`, `migration.ts`) were then run again on an otherwise idle machine. The result: 8,591 killed, 2,035 timeout, 1,829 survived, 1,685 no coverage, 8 unverified, a mutation score of 75.15%.
- The timeout count barely moved on the idle rerun (2,037 to 2,035), so most timeouts are real detections: a mutated loop condition in the SQL scanner and the type generator runs until Stryker stops it.
- A run against `src/runtime/id.ts` found five surviving mutants. They showed four gaps in the tests: the random bits, the start value of the counter in a new millisecond, the counter's ceiling (`0xfff`), and the process's first call at time 0. Tests for these gaps brought the count of surviving mutants to zero.
- A run against `src/runtime/failure.ts` found surviving mutants in `failureClass`'s `||` conditions: each existing test message satisfied every operand, so no test told one operand apart from another. New tests isolate `sql_syntax_error`'s "sql error: near" text alone, `sqlite_busy`'s `SQLITE_BUSY` text alone, and a `D1_ERROR` prefix with zero whitespace before the reset-wrapper text.
- `npm audit` reports two more moderate advisories, through `@stryker-mutator/core`'s dependency on `typed-rest-client`, which depends on `qs`.
