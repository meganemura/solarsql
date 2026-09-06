# ADR 0032: A node:sqlite adapter for tests and scripts

Status: accepted (2026-09-06). Extends ADR 0003 and ADR 0014.

## Context

ADR 0014 puts the user's inner loop on node:sqlite: `tsc`, the build checks, and unit tests, in one process, in seconds.
The build already runs there.
A module's queries and commands did not: the two adapters were D1 and a Durable Object, and a test of a module needed Miniflare.

## Decision

The package exports `solarsql/node`.
`node(db)` takes a `DatabaseSync` and returns the same `Database` as the other adapters.
`migrate(db, files)` applies the migration files the way the Durable Object adapter does.

The adapter is a shim.
It gives a `DatabaseSync` the shape of a Durable Object's storage (`sql.exec` and `transactionSync`), and the Durable Object adapter does the rest.
node:sqlite binds a named parameter by name only, so the shim matches the values the adapters pass by position to the names in the order they first appear, which is the order the build numbered them in.

## Why

node:sqlite and workerd carry the same SQLite, so a test on node:sqlite tests the SQL that runs in production.
The constraint messages and the guard trigger's raise are the same text on all three engines, so failures as values need no third parser.
A user's module test runs in milliseconds, with no runtime to start.

## Consequences

- The adapter is for Node. A Worker imports `solarsql/d1` or `solarsql/durable`.
- Miniflare stays the check of the D1 batch and of the Durable Object transaction, in the library's own tests.
- A behavior that differs between node:sqlite and D1 is a bug of the library, to be caught by its Miniflare tests.
