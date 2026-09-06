# ADR 0037: init writes the first module and runs the first build

Status: accepted (2026-09-06)

## Context

A project started from nothing: the configuration, a module directory in the three-file shape (ADR 0033), a tsconfig that accepts `.ts` imports, the first build, the first migration.
The README described each piece, and no command did them.
The agents of the experiments started from a prepared project, so the first minute had never been run.

## Decision

`solarsql init <module> [dir]` writes `solarsql.config.ts`, `modules/<module>/module.ts`, `public.ts`, and `module.test.ts`, and `tsconfig.json` when there is none.
Then it runs the build and writes `migrations/0001_initial.sql` with the index, so the user sees the whole loop once.
The module name is the table name and the directory name, as typed, and must match `[a-z][a-z0-9_]*`.
The placeholder is the README's shape: a STRICT table with a primary key and a CHECK that becomes a type, a query catalog, a command with `returns`, and a command with an `assert`.
The test runs the module on node:sqlite through the migration files.
init never writes over a file: it refuses when any file it would write exists, and when `migrations/` exists, because its history is another project's.
It writes no Worker, no wrangler configuration, and no package.json.

## Why

The first command a user runs decides whether the shape reads as intended; a placeholder in the README's shape shows it before the user writes SQL.
The test in the module directory is the inner loop of ADR 0014, in the place the user will keep their own.
A Worker is wrangler's to write, and a project may have one already.
The tsconfig is written only when absent, because a project that has one has chosen its options; the README names the two that accept `.ts` imports.

## Consequences

- The proof is the packed package: the pack test runs init from `node_modules/.bin`, runs the module test, and type-checks what init wrote. In the repository "solarsql" does not resolve, so init has no in-repository run.
- A second module is added by hand: three files and one line in the configuration. init does not edit an existing configuration.
- The package's own tests run on Node 24 and 26; a `.ts` test file runs as an ES module when package.json says `"type": "module"` or names no type. init prints a note when it says `"commonjs"`.
