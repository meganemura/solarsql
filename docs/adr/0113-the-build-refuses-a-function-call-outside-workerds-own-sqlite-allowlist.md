# ADR 0113: The build refuses a function call outside workerd's own SQLite allowlist

Status: accepted (2026-09-16)

## Context

`Typer.analyze()` (`src/build/typegen.ts`) validates a query or a command plan item by preparing it against `Engine.prepare()` (`src/build/facts.ts`), a thin wrapper over `node:sqlite`. `node:sqlite` places no restriction on which SQL function a statement may call.

D1 and a Durable Object's own storage both run on workerd's SQLite, which restricts function calls through its own authorizer: a call to a function outside a fixed allowlist is refused at prepare, with `not authorized to use function: <name>`. `like`, `glob`, `match`, `->`, and `->>` are allowlist entries too — workerd's authorizer reports an operator's underlying function the same way it reports an ordinary function call.

This let a query build and typecheck cleanly, and generate a typed contract, while still failing on every call on both real deploy targets. `select cast(sqlite_version() as text) as v` is one example: it types as `{ v: string | null }` today, and fails identically on D1 and on a Durable Object's storage with `not authorized to use function: sqlite_version`.

## Decision

`Engine.prepare()` sets a `setAuthorizer()` callback for the duration of that one `db.prepare()` call only, denying an `SQLITE_FUNCTION` action whose name is not in a local copy of workerd's own allowlist, then clears the authorizer in a `finally` block — the same temporary-authorizer shape `Engine.accesses()` already uses for its own table-access read.

The allowlist is copied, unchanged, from `cloudflare/workerd`'s `ALLOWED_SQLITE_FUNCTIONS` array (`src/workerd/util/sqlite.c++`, commit `c240f0e`, lines 380-543), including every operator-form entry (`like`, `glob`, `match`, `->`, `->>`). Five names that array itself comments out — `sqlite_compileoption_get`, `sqlite_compileoption_used`, `sqlite_offset`, `sqlite_source_id`, `sqlite_version` — are left out here too, with workerd's own reason carried into the copy's comment: they "query SQLite internals and build details in a way we'd prefer not to reveal."

The comparison lowercases both sides before the lookup. workerd's own switch case (same file, around lines 1307-1321) does the same, with a comment noting that SQLite's documented convention for comparing identifiers is `sqlite3_stricmp`, and that workerd instead lowercases once per prepare to avoid scanning the allowlist per comparison. Matching that behavior, rather than an exact-case comparison, is what makes the local check refuse exactly what the real deploy targets refuse.

### Why a call-scoped authorizer, not a connection-level one

`Engine.prepare()` has exactly two callers: `Typer.analyze()` (`typegen.ts`) and the JSON-aggregate detached-subquery path (also `typegen.ts`). Both already wrap their `engine.prepare()` call in a `try`/`catch` that turns a `node:sqlite` exception into a `BuildError`, so scoping the authorizer to `Engine.prepare()` reaches every query and every command plan item through the existing error path, with no new one.

A connection-level authorizer, set once for the `Engine`'s whole lifetime, was rejected. It would also reach two places that call `this.db.prepare(...)` directly, bypassing `Engine.prepare()`: the build's own internal diagnostic `select sqlite_version()` calls (`analyze.ts` and `build.ts`), which must keep working. It would also reach every `CREATE TABLE`/`CREATE TRIGGER`/`CREATE VIEW` statement the `Engine` constructor runs to build the schema, widening the check to DDL and trigger bodies — a scope this decision does not cover (see below).

## Consequences

- A query or a command plan item that calls a function outside the allowlist is refused at build time, with workerd's own message, instead of only failing later on a deployed D1 database or a Durable Object.
- A bare (uncast) call to a refused function, such as `select sqlite_version() as v`, is refused by this check before the build's separate "an expression with no type needs a cast" rule has a chance to fire, because `Engine.prepare()` runs first in `Typer.analyze()`. The message is the authorizer's, not the cast rule's.
- The build's own internal diagnostic `select sqlite_version()` calls are unaffected, because they call `this.db.prepare(...)` directly and never go through `Engine.prepare()`.
- **Unmeasured adjacent scope.** DDL — a table, trigger, or view's own `CREATE` statement — is not run through `Engine.prepare()`, so a function call written directly in DDL is not checked by this decision. `example/migrations/0005_customer_name_not_empty.sql`'s `CHECK` constraint, which calls `length()`, is one example of a function call that already appears in DDL in this project; `length` happens to be on the allowlist, so it is unaffected either way. Separately, and not by design: preparing a DML statement that fires a trigger compiles that trigger's body as part of the same prepare, so a trigger body's function call is in fact reached by this check whenever a plan item's own prepare fires it — even though the trigger's own `CREATE TRIGGER` statement was never itself checked. Neither DDL's own function calls nor this indirect trigger-body path were measured against D1 or a Durable Object this round; `cloudflare/workerd` carries a patch named `patches/sqlite/0006-call-authorizer-in-default-column-expressions.patch` that suggests workerd's own authorizer treats at least some DDL specially, but this decision does not read or rely on that patch's contents. A DDL-focused check, if one is ever needed, is a separate decision.
- `test/function-allowlist.test.ts` runs the allowlist's own two representative cases — a refused function (`sqlite_version`) and an allowed one (`random`) — against real D1 and Durable Object storage through Miniflare, so a future change to workerd's own allowlist is caught by a difference between the real deploy targets and this project's local copy, not only by a difference nobody re-derives by hand.
