# AGENTS.md

Context for agents that work in this repository.

## What this is

solarsql is a typed SQL layer for SQLite on Cloudflare, for D1 and Durable Objects.
It is designed for a reader that starts from an empty context: a coding agent first, a human second.

The shape, in one paragraph.
A module owns its tables and shows other modules one public file.
The schema is SQLite DDL in a string literal.
Queries are SQL in string literals with named parameters, listed in a named catalog.
Commands are verbs on a noun, and a command is a plan: a list of statements and asserts that runs as one D1 batch or one Durable Object transaction.
Rows are plain values with no methods and no callbacks.
Types come from the real engine at build time, and a stale type fails to compile.

The library is in `src/`: `index.ts` (the API), `d1.ts`, `durable.ts`, and `node.ts` (the adapters; the third is for tests and scripts), `build/` (the CLI, the scanner, the engine facts, the type generator, the migration diff), `runtime/plan.ts` (what the build and the adapters share), `runtime/id.ts` (UUID v7), and `runtime/node-version.ts` (the Node floor check, ADR 0129).
A module is three files: `module.ts` (its tables, indexes, search tables, views, triggers, queries, and commands), `public.ts` (what other modules may import), and `solarsql.generated.ts` (written by the build).
The example project in `example/` is the one the tests run.

The usage documentation is the skill in `skills/solarsql/`: `SKILL.md` is the workflow, and `references/` holds the rules by task (schema, queries, commands, running, build, migrations, deploy). It is the master; the README is the door for a human and points into it. A rule is written once, in a reference.
The design records live in `docs/` as ADRs.
Read them before you change the shape.

## Visibility

This repository is intended for public release.
Write all committed text in English: code comments, docs, commit messages.
Do not reference private tools, private repositories, or internal working documents in committed content.
If you want to cite an internal document, write its substance in place instead.

## Rules

- Do not add dependencies without the owner's approval. Pin exact versions. Prefer language-official packages, then vendor packages, and avoid single-maintainer packages.
- Write tests with Hegel (`@hegeldev/hegel`, property-based) wherever a property exists: round trips, invariants, bounds, equivalence. Example-based tests cover exact output and command behavior.
- Keep the inner loop synchronous and in-process: `node:sqlite` for type checks and unit tests. Use Miniflare only in CI and in opt-in tests.
- Comments say why: the constraint, or the alternative that was refused. Each module starts with its responsibility and its boundary.
- `.claude-team/` holds task specs, reports, library comparisons, and their experiment artifacts. It is gitignored. Do not commit or reference its contents from committed content.
- A release follows `docs/releasing.md`. Approving the `publish` environment, and a change of the repository's visibility, are the owner's to run. The publish workflow runs `npm publish`; it does not read `NPM_TOKEN`.
- Rewriting git history, force-pushing, or otherwise mutating a remote or a published tag is the owner's to run. An existing instruction that authorizes such an action for one situation does not extend to a materially larger version of that action later (more refs, more history, or a scope the owner did not describe); name the concrete refs, commits, or tags it is about to change and any known downstream consumers (for example, published package registry metadata), and confirm that expanded scope with the owner, before running it.

## Commands

- `npm test` runs `vitest run --project unit`, the files directly under `test/`: node:sqlite with no workerd, though some of them start short-lived child processes (`tsc`, the CLI, and small fixture scripts); about 9 seconds. `npm run test:all` runs `vitest run`, all three projects: `unit` plus `test/slow/` (`cli.test.ts`, `cli-discovery.test.ts`, and `pack.test.ts`, which spawn `tsc`, `npm pack`, and the CLI as child processes; `rehearse-file.test.ts`, whose two tests go through `rehearse()`'s on-disk backup; `agent-battery.test.ts`, which runs the agent battery with its stub agent) and `test/miniflare/` (workerd); together about 130 seconds, though the two added directories vary with machine load. CI runs `npm run test:all`.
- `npm run typecheck` runs `tsc --noEmit` over `src/`, `test/`, `example/`, and `spike/`.
- `npm run archstrict` runs `archstrict check`. Seams are files: `scan`, `migrate` (the schema diff), `build` (the orchestrator), `typegen`, `cli`, and the adapters `index`, `d1`, `durable`, and `node`. `src/runtime` is the Workers contract (`plan`, `failure`, `id`, `node-version`, `node-limits`). Compiler layers run kernel, sql, typing, policy, build, command, cli. Adapters do not import the compiler. Every module is `strict`, and `archstrict.todo.json` is empty.
- Adapter and runtime imports of compiler types also fail the architecture check. Worker code rejects recognized Node builtin imports. ADR 0144 records the host tags and the unresolved `node:sqlite` limitation.
- `npx vitest run --project slow test/slow/architecture.test.ts` runs architecture positive controls through `archstrict simulate`, without writing source files.
- `.github/workflows/ci.yml` runs the tests, the typecheck, the module-boundary check (not on Windows, where archstrict 0.1.0 misreads paths), and the example's `build --check` on Node 24 and 26, on ubuntu, macOS, and Windows, and on each line's floor (24.20.0 and 26.7.0, ubuntu only), for every push and pull request to main.
- `.github/workflows/publish.yml` runs on a `v*` tag. The steps and the trusted-publisher settings are in `docs/releasing.md`.
- `npm run build` emits `dist/` from `src/`. Only the pack test needs it.
- `node src/build/cli.ts build example/solarsql.config.ts` builds the example from the source.
- `solarsql init <module>` starts a project; it needs the installed package, so `test/slow/pack.test.ts` is where it runs.
- `SOLARSQL_REMOTE_URL=<the Worker's URL> SOLARSQL_REMOTE_TOKEN=<its TOKEN secret> npx vitest run test/remote.test.ts` runs the example's steps against a deployed Worker, on remote D1 and on a Durable Object. `npm test` skips it. The README says how to deploy; the deploy steps set the TOKEN secret, and the Worker refuses a request without it. `example/wrangler.jsonc` is gitignored because it names one account's database.
- `node spike/<file>.ts` runs one experiment and prints the measurements that `docs/v0-measurements.md`, `docs/v1-measurements.md`, and `docs/v5-measurements.md` cite.
- `npm run test:mutation` runs StrykerJS across all of `src/`. Incremental mode keeps its result in `reports/`. A full run takes hours, so CI does not run it. The configuration's judgment calls are in ADR 0141.

The `spike/` directory holds the experiments. They are evidence for the ADRs.


<!-- ARCHSTRICT_START -->
## archstrict

In projects with an `archstrict.config.ts` (module-boundary/architecture linting), run `archstrict rules <path>` BEFORE creating a file or adding an import - it reports the module, tags, and constraints that would govern that path, even before it exists. Run `archstrict check` after editing to confirm.

The full rule reference (every rule's evidence/because/do shape, the config schema, the pre-edit query) is at `node_modules/archstrict/skills/archstrict/SKILL.md` when installed via npm - read it before configuring `archstrict.config.ts`, or when a violation's `do:` text alone isn't enough.

If there is no `archstrict.config.ts`, skip archstrict entirely - it may not be installed here.
<!-- ARCHSTRICT_END -->
