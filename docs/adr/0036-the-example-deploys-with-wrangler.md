# ADR 0036: The example deploys with wrangler, and a remote test runs its steps

Status: accepted (2026-09-06)

## Context

The tests run the example on Miniflare's D1 and Durable Object, and on node:sqlite.
Production D1 is a service behind an HTTP API, with limits of its own, and a deployed Worker is the only way to reach it.
Nothing in the repository had run there.

## Decision

wrangler is a devDependency, pinned.
`example/wrangler.example.jsonc` is the template of the Worker's config: the D1 binding with its migrations directory, and the Durable Object binding with its SQLite class.
The copy, `example/wrangler.jsonc`, is gitignored, because it names one account's database.

`wrangler d1 migrations apply` takes the files of `example/migrations` as they are, in name order.
The Durable Object applies the same files with `migrate()` on its first request.

The Worker refuses a request without its `TOKEN` secret once the secret is set.
A `reset` step empties both stores through a `clear` command of each module.

`test/remote.test.ts` runs the steps of `test/example-steps.ts` against the Worker that `SOLARSQL_REMOTE_URL` names, on D1 and on the Durable Object.
Without the variable it is skipped, so `npm test` needs no account.

## Why

The steps are the ones the Miniflare test runs, from one shared file, so a difference between remote D1 and Miniflare shows as a failed assertion that names the step.
A deployed Worker answers anyone, and every step writes, so the Worker takes a token.
The ids of the steps are fixed, and the stores keep their rows between runs, so a run starts with a reset.

## What the first remote run found

`wrangler d1 migrations apply --remote` refused the first migration file with `incomplete input: SQLITE_ERROR`, while the same file applied on Miniflare, on a Durable Object, and on node:sqlite.
D1's HTTP API splits a request into statements on its own, and it keeps a trigger body whole only when the `BEGIN` that opens it is uppercase (workers-sdk issue 15314).
Measured on the remote database: `begin` and `Begin` fail, `BEGIN` passes, and the case of `END` makes no difference.
The migration writer now writes both keywords uppercase in every trigger, whatever the declaration wrote; the diff compares them case-insensitively, so nothing else changes.
A Worker's own D1 binding takes one statement per call and is not affected.

The second remote run applied a table rebuild: migration 0005 puts a CHECK on `customers.name`, and customers is referenced by orders, so the file opens with `pragma defer_foreign_keys = on`, drops the view, copies the rows, drops and renames the table, and creates the view again.
wrangler applied the file in one call; the schema after shows the CHECK and the recreated view, no `_solarsql_*` table remained, and the CHECK arrives as a value on both targets.
The tables were empty when it ran there, so the copy moved no row; the rows under a rebuild are checked on Miniflare's D1 in `test/d1-migration.test.ts` and by the migration property test.

## Consequences

- The remote test is opt-in, and one HTTPS round trip per step makes it slow. CI does not run it.
- The observe test is skipped on remote D1: the hook's events live in one isolate, and a deployed Worker runs several. A Durable Object is one instance, so the test runs there.
- A delete from a parent table reads the foreign key columns of its children, so the boundary check allows a module to read the foreign key columns of the tables that reference its own (ADR 0027, extended).
