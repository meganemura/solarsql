# ADR 0133: The build refuses INSERT OR ROLLBACK and UPDATE OR ROLLBACK as a plan item

Status: accepted (2026-09-25). Extends ADR 0045.

## Context

ADR 0045 already says the build refuses transaction control, PRAGMA, and schema changes in a query, `returns`, or a plan item, because the adapter must own the transaction that gives a command its rollback guarantee (ADR 0072). `src/build/statements.ts`'s `catalogStatement` checked only the outer verb of a plan item, so `INSERT OR ROLLBACK` and `UPDATE OR ROLLBACK` -- SQLite's `ROLLBACK` conflict-resolution algorithm, which ends the enclosing transaction from inside the statement that violates a constraint -- built and typed like any other write, including behind a leading `WITH`.

Measured through the real `d1()`, `durable()`, and `node()` adapters with a hand-built `Command` (`insert log 'first'`, `insert or rollback` with a conflicting primary key, `insert log 'third'`; Miniflare 5.20260828.0-alpha, workerd 1.20260828.1, node:sqlite 3.53.4):

- D1: `run()` threw an unclassified error; `constraintFailure()` (`src/runtime/plan.ts`) cannot classify it; no plan row stayed committed.
- Durable Object: the Worker boundary returned HTTP 500 from inside the object's own `try`/`catch`. The 500 discarded every write of the request, including an earlier, already-`{ ok: true }` write in the same request and setup DDL the same request made.
- node: `AggregateError` from failed savepoint cleanup (`UNIQUE constraint failed`, then `no such savepoint`); with a caller-owned `BEGIN`, the caller's own transaction ended too.
- The default `ABORT` gives the same data outcome as a typed failure value for all three adapters, so `OR ROLLBACK` adds nothing a refused-and-redirected caller loses.

This is the same shape ADR 0117 refused for a deferred foreign key: a declaration `run()` cannot classify or catch, refused at build time instead of only documented.

## Decision

`catalogStatement` (`src/build/statements.ts`, role `"plan"`) refuses a plan item whose outer verb, after any leading `WITH`, is `INSERT OR ROLLBACK` or `UPDATE OR ROLLBACK`. The message: the adapter owns the transaction; leave the default (`ABORT`) to get a failure value, or use `OR IGNORE` to skip a row that fails a uniqueness, `NOT NULL`, or `CHECK` constraint (not a foreign key).

`ON CONFLICT ROLLBACK` in table DDL and `RAISE(ROLLBACK, ...)` in a trigger body are out of scope: neither was measured, and both reach the database through DDL the build already checks by a different path (ADR 0045's schema-change refusal already keeps transaction-ending DDL out of a plan item).

## Why

`run()` cannot classify or catch this failure on any of the three targets, and a Durable Object's case can lose a write the caller already observed as `{ ok: true }` in the same request -- the same failure pair ADR 0117 refused a deferred foreign key for. `ABORT` already gives a typed failure value with no loss, so refusing `OR ROLLBACK` removes a trap with no working alternative it replaces.

## Consequences

- A plan item cannot use `OR ROLLBACK`. `INSERT OR IGNORE`, `INSERT OR REPLACE`, `INSERT OR ABORT`, `INSERT OR FAIL`, and `UPDATE OR IGNORE` (and the rest of that family other than `ROLLBACK`) still build.
- This refusal narrows ADR 0072's own claim that a transaction-ending conflict such as `INSERT OR ROLLBACK` can roll back the caller's outer transaction: that claim now holds only for direct SQL a caller writes by hand outside a built plan (`test/node.test.ts`'s hand-built-`Command` test keeps running unchanged, since `catalogStatement` runs only at build time, not at `run()`). `skills/solarsql/references/running.md` is reworded to say so.
- `test/statement-contract.test.ts` pins the refusal for `INSERT OR ROLLBACK`, `UPDATE OR ROLLBACK`, and the `WITH ... INSERT OR ROLLBACK` form, and confirms the other conflict-resolution keywords still build.
- `test/miniflare/or-rollback.test.ts` pins today's run-time behavior a caller can no longer reach through a built plan: D1's unclassified `run()` rejection with no plan row remaining, and a Durable Object's HTTP 500 with no plan row remaining in a later request.
