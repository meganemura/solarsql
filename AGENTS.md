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

The library is in `src/`: `index.ts` (the API), `d1.ts` and `durable.ts` (the adapters), `build/` (the CLI, the scanner, the engine facts, the type generator, the migration diff), and `runtime/plan.ts` (what the build and the adapters share).
The example project in `example/` is the one the tests run.

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
- Comments say why, not what. Each module starts with its responsibility and its boundary.
- `.claude-team/` holds task specs and reports. It is gitignored. Never reference it from committed content.
- The npm package `solarsql` is reserved at 0.0.0 with no code. Do not publish without the owner's explicit approval.

## Commands

- `npm test` runs every test with the Node test runner. Miniflare, `tsc` in a child process, and `npm pack` take part, and the run takes about three seconds.
- `npm run typecheck` runs `tsc --noEmit` over `src/`, `test/`, `example/`, and `spike/`.
- `npm run build` emits `dist/` from `src/`. Only the pack test needs it.
- `node src/build/cli.ts build example/solarsql.config.ts` builds the example from the source.
- `node spike/<file>.ts` runs one experiment and prints the measurements that `docs/v0-measurements.md` and `docs/v1-measurements.md` cite.

The `spike/` directory holds the experiments. They are evidence for the ADRs.
