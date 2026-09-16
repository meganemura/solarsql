# ADR 0117: The build refuses a deferred foreign key

Status: accepted (2026-09-17)

## Context

A `references ... deferrable initially deferred` foreign key (column-level, or as a table constraint, `foreign key (...) references ... deferrable initially deferred`) is valid SQLite. Before this decision, `Engine`'s own constructor accepted it, the same as any other `CREATE TABLE`: the deferred flag does not appear in `pragma_foreign_key_list`'s columns at all, so `facts.ts`'s `foreignKeys` cannot see it, and the migration diff already treats a deferred and an immediate foreign key as the same shape.

Measured directly (Miniflare, workerd, the same engine Cloudflare deploys): D1's `run()` (`src/d1.ts`) cannot classify a violation of this kind of foreign key today, and a Durable Object's `run()` (`src/durable.ts`) cannot catch one at all. On D1, `run()` falls through to an unclassified `throw`, because the platform's own rejection message wraps SQLite's `FOREIGN KEY constraint failed` text behind a prefix `constraintFailure()`'s `bareMessage()` does not strip. On a Durable Object, the violation is not raised by `transactionSync`'s own RELEASE: it surfaces only at the request's own implicit commit, after `run()` has already returned a value its own caller never receives, and the platform resets the object and returns its own response in place of whatever `run()` resolved to -- the same mechanism an earlier fix closed for `migrate()` specifically (`src/durable.ts`'s per-file `pragma foreign_key_check` scan), reaching `run()` too.

## Decision

`src/build/build.ts`'s per-table validation loop -- alongside its existing primary-key, STRICT, and foreign-key-target checks -- refuses a table that declares a foreign key `DEFERRABLE INITIALLY DEFERRED`. A table's declared `CREATE TABLE` text (not `pragma_foreign_key_list`, which cannot express the modifier) is tokenized and checked for the exact three-token sequence `DEFERRABLE INITIALLY DEFERRED`. `NOT DEFERRABLE`, a bare `DEFERRABLE`, and `DEFERRABLE INITIALLY IMMEDIATE` are SQLite's ordinary immediate behavior and are not refused; only the one sequence that defers a foreign key's exception past the write that violates it is.

Two other shapes were considered and rejected. Documenting the limitation instead of refusing it was rejected: it leaves a real trap in place with only a warning against it. Adding a per-call `pragma foreign_key_check` scan to `run()` itself -- the shape `migrate()` already uses, once per file -- was rejected: `run()` executes on every command, not once per migration file, so that scan would cost every command using it, to guard against a schema shape a declaration-time refusal already prevents from existing.

`solarsql`'s own generated migrations use `pragma defer_foreign_keys = on` for a rebuild (`migration.ts`'s `needsDefer`), unaffected by this refusal: that pragma is session-scoped, set and cleared around one rebuild, not a permanent schema declaration a table carries forever.

## Why

`run()` cannot classify or catch this failure today on two of solarsql's three targets. Refusing the declaration removes the trap rather than warning about it, matching this project's own precedent (ADR 0114) of refusing DDL its error handling cannot honor. The two targets' failure this closes are separate defects (D1: an unclassified throw; a Durable Object: an uncatchable false success) that happen to share one cause and one fix, not one mechanism -- see ADR 0114 for the earlier, unrelated reason this project refuses other declared DDL at build time.

## Evidence

Reproduced against a real Durable Object and D1 via Miniflare, using a hand-built schema and `Command` reaching `durable()`'s and `d1()`'s real `run()` (the build refuses this schema, so a pinning test cannot build it through the normal path): an immediate foreign key's violation is classified normally on both targets (a 200 response carrying `{ok: false, kind: "foreign_key"}`); the identical fixture with the foreign key declared `DEFERRABLE INITIALLY DEFERRED` instead returns, on D1, a 200 response whose body shows the command's own `catch` observed an unclassified error (`constraintFailure()` returns `null` for its message); and on a Durable Object, an HTTP 500 carrying the platform's own reset message in place of whatever `run()` itself resolved to.

## Consequences

- A module cannot declare a persistent, schema-level deferred foreign key. A caller who needs to insert two mutually-referencing rows in one command orders the plan so the referenced row is inserted first, or uses an ordinary immediate foreign key (SQLite's own default).
- `test/deferred-foreign-key.test.ts` pins the underlying `run()` behavior this refusal prevents a caller from ever reaching: the contrast between an immediate and a deferred foreign key's violation, on both D1 and a Durable Object.
- `test/build.test.ts` pins the refusal itself, for both the column-level and table-level forms, and confirms the three non-deferred forms (`NOT DEFERRABLE`, bare `DEFERRABLE`, `DEFERRABLE INITIALLY IMMEDIATE`) build normally.
- A one-line addition to `bareMessage()` (`src/runtime/plan.ts`) that strips D1's platform-reset prefix would let `constraintFailure()` classify D1's own message for this case -- a separate, smaller diagnostics improvement, not implemented by this decision, and D1-only: it would not touch a Durable Object's uncatchable false success, which this refusal remains the only fix for.
