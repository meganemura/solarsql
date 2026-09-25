# ADR 0137: The observe event names the plan item that failed

Status: accepted (2026-09-25). Extends ADR 0039 and ADR 0081.

## Context

A command runs as one D1 batch or one Durable Object transaction. When a plan item throws an unclassified error or a constraint failure, the caller gets the engine's own error and the observe hook gets one event with outcome `'error'` or a constraint kind (`src/runtime/plan.ts`; `Observed`, `src/index.ts`). Neither names the item that failed. An assert failure is already named (`outcome: 'assert:<name>'`, ADR 0086); assert names are unique across a command's expanded plan (ADR 0127). The build already names a build-time failure by module, catalog entry, and plan position, and the migration runner names `'statement N of M'`. The run time named nothing.

Measured (node v26.7.0, Miniflare 5.20260828.0-alpha) with a 3-statement command whose statement 2 is `update a set n = json_extract(:doc, '$.n') where id = :id` with `doc = '{not json'` (a parameter-dependent failure the build cannot catch):

- node: rejects with the engine's own `malformed JSON` error (its own `code`, `errcode`, `errstr`); the observe event carries `{ kind: 'command', name, ms, outcome: 'error' }`; the stack shows `durable.ts` inside `Array.forEach`, not the index.
- Durable Object: rejects with `'malformed JSON: SQLITE_ERROR'` (message only); the same shape of event.
- D1: rejects with `'D1_ERROR: malformed JSON: SQLITE_ERROR'` (message and cause only); no field names the index, and a failed batch returns no replies at all (D1's own `batch()` contract names no index either: https://developers.cloudflare.com/d1/worker-api/d1-database/).
- A catalog name is not unique across a project's modules (the example's own `clear` exists in both `customers` and `orders`), so a location needs the SQL key, not only a name.

ADR 0030's Consequences say the observe hook carries the catalog name of a query or command "so a span or a log line needs no SQL text." That was written for the *event's own name*, which still holds: `Observed.name` stays the catalog's command or query name. `at.sql` is a second, more specific piece of information this ADR adds, for the one case a name alone cannot disambiguate (a repeated catalog name) and cannot locate (which of several plan items failed).

## Decision

`Observed` gains an optional `at`: `{ position: number; of: number; sql: string; included?: string } | { returns: true; sql: string }`. `position` counts from 1 in the expanded plan (`commands()` flattens an included command's items, ADR 0127); `sql` is the plan item's catalog text, with no bound values; `included` is the including command's included-range name when the position falls inside one. For a batch of reads, `position` is the read's index (1-based) and `of` is the batch's size, and `sql` is that read's own query text.

`at.sql` for a failing assert is its **predicate**, the catalog's own key for it (`commands()`'s `metaOf(generated, item.predicate)`, `src/index.ts`; the build registers the same statement under the key `item.predicate`, `src/build/build.ts`) -- not the text the adapter composes at run time, which now carries a bound invocation token rather than one written into the text (ADR 0086's 2026-09-25 amendment). Naming the predicate keeps `at.sql` stable and matches what a reader of the module's source would search for.

`src/durable.ts` (and `src/node.ts` through it) sets `at` only while one plan item, the returns clause, or one batch read is actually running: reported through `observed()`'s `report()` callback (now an object, `{ meta?, at?, statements? }`, merged call by call -- ADR 0039's 2026-09-25 section shares this same mechanism for `statements`) immediately before the item's own `storage.sql.exec()` call, and cleared (`report({ at: undefined })`) immediately after it returns. A `total_changes()` probe, the guard-table cleanup delete, and the transaction's own commit are not plan items and never get `at` set around them: a probe or cleanup failure, or `transactionSync` itself throwing after its closure already returned, leaves whatever `at` the last completed item cleared it to -- none.

D1 leaves `at` out entirely. A failed D1 batch names no index in its own error, and D1 gives this adapter nothing to attribute a thrown error to one statement with; setting a wrong or synthetic `at` there would be worse than none.

## Rejected alternatives

- **A per-statement callback.** Would run caller code inside the Durable Object's synchronous `transactionSync` closure (an arbitrary caller callback executing inside that boundary is a bigger change than reporting a location), and D1 returns every reply at once, after the whole batch settles, so no callback could fire per statement there in the first place.
- **A mutated or wrapped error.** ADR 0082 keeps a thrown error's own identity; adding a field to it would also fail outright for a thrown primitive or a frozen object, and D1 could never fill the field in (no index), so it would exist on some engines' errors and not others -- an inconsistency this ADR avoids by keeping the location on the *event*, not the thrown value.
- **node's `'sqlite.db.query'` diagnostics_channel event.** Added in Node v26.8.0, still experimental, absent from the v24 docs while `package.json` allows `24.x`, and its own SQL carries bound values -- this project's events never do (ADR 0030).
- **Notifying twice** (once per item, once for the command). ADR 0081 fixes one notification per call; this ADR does not reopen that.

## Evidence

`test/observe-at.test.ts`: a Hegel property draws a plan length `n` in 1..8 and a failing position `k` in 1..n, gives statement `k` a malformed-JSON parameter carrying a random sentinel, and checks that `db.run` rejects with an error whose message and own property names equal a raw `DatabaseSync` throw for the same statement, that the observer gets exactly one event with `at = { position: k, of: n, sql }`, and that `JSON.stringify(event)` never contains the sentinel. Separate cases cover a failure in `returns` (`at.returns`), a failure inside an included command's range (`at.included`), a unique-constraint result carrying the insert's own position unchanged, a failing D1 batch giving no `at`, and `durable()` with a fake `StorageLike` whose `transactionSync` throws only after its closure already returned, giving an event with no `at` at all.

`test/miniflare/observe-plan-item.test.ts`, against real D1 and a real Durable Object (`test/observe-plan-item.worker.ts`): a 3-statement plan whose last item fails on malformed JSON gives, on the Durable Object, the same `at` node's own in-process test gives for the equivalent shape (`{ position: 3, of: 3, sql }`); on D1, no `at` at all.

## Consequences

- `skills/solarsql/references/running.md` documents `at` and that D1 never sets it.
- `docs/adr/0030-program-model-stays-with-the-caller.md`'s Consequences line about needing no SQL text still holds for `Observed.name`; `at.sql` is new and narrower, named here rather than there.
- An agent sees a failed item's location only through an observer; the thrown error a caller catches directly is unchanged (ADR 0082).
