# AGENTS.md

Context for agents that work in this repository.

## What this is

solarsql is a typed SQL layer for SQLite on Cloudflare, for D1 and Durable Objects.
It is designed for a reader that starts from an empty context: a coding agent first, a human second.

The shape, in one paragraph.
A module owns its tables and shows other modules one public file.
The schema is SQLite DDL in a tagged template.
Queries are SQL in tagged templates, listed in a named catalog.
Commands are verbs on a noun, and a command is a plan: a list of statements and asserts that runs as one D1 batch or one Durable Object transaction.
Rows are plain values with no methods and no callbacks.
Types come from the real engine at build time, and a stale type fails to compile.

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

- `npm test` runs every test with the Node test runner. Three suites start Miniflare, and the run takes about 1.5 seconds.
- `npm run typecheck` runs `tsc --noEmit` over `spike/` and `test/`.
- `node spike/<file>.ts` runs one experiment and prints the measurements that `docs/v0-measurements.md` cites.

The `spike/` directory holds the v0 experiments. They are evidence for the ADRs. The library code starts in a later version.
