# ADR 0135: A DELETE's RETURNING rows are the command's rows

Status: accepted (2026-09-25). Supersedes ADR 0110 (including its first Consequence). Amends ADR 0100's Consequences (the `Typer.analyze` bullet and the "computed RETURNING expression" bullet).

## Context

ADR 0110 refuses every write plan item's RETURNING clause, reasoning that "the adapter discards whatever rows come back," and tells the caller to "move the read into the command's `returns` field instead." `returns` runs after the plan's last statement (`commands.md`), so for a DELETE the caller's own advice reads a row that is already gone.

Measured on node with today's source: `plan delete from tokens where id = :id with returns select payload from tokens where id = :id` builds and runs to `{ ok: true, rows: [], changes: 1 }`; the token is deleted and the payload never reaches the caller. Take-and-delete (consume a one-time token, pop N jobs, drain an outbox) is one statement in SQLite, `delete ... returning ...`.

ADR 0110's reason does not hold for DELETE: the adapters already hold the rows a write statement's reply carries. `src/d1.ts` reads only `results[command.plan.length]` (the `returns` reply's own position); D1's `batch()` returns one `D1Result` per statement in order (`test/miniflare/d1-returning.test.ts` shows DELETE and UPDATE RETURNING rows inside a batch). `src/durable.ts` calls `cursor.toArray()` on every plan item's cursor and discards it. `src/node.ts` runs through `durable()`.

Scope is DELETE only. RETURNING shows a row as it was before an AFTER trigger ran (SQLite's `lang_returning.html`, section 3); measured on all three engines, INSERT/UPDATE RETURNING missed a value an AFTER trigger wrote, while `returns` saw it (the example's `orders_touch` trigger has that shape). INSERT and UPDATE keep ADR 0110's refusal.

## Decision

1. **Build**: a DELETE (or `WITH ... DELETE`) plan item with RETURNING is accepted. INSERT, UPDATE, and REPLACE with RETURNING keep ADR 0110's refusal, using the same message. A command with two row sources — `returns` together with such an item, or two such items — is refused, naming both. A RETURNING list with a subquery that reads the DELETE's own target table is refused: that value is indeterminate while the delete runs (`lang_returning.html`, section 2.2).
2. **Generated file**: a DELETE ... RETURNING entry's type carries `returning: true`; its runtime meta object carries the same flag. `commands()` (`src/index.ts`) scans a command's own (non-included) plan items for this flag at construction and records the matching index as `returningIndex`, so an adapter finds the row source by a field lookup, the same way it already finds a JSON column through `json`, not by reading SQL text. `PlanRows` picks `returns` when the shape declares one, else the row type of the plan item whose generated entry carries `returning: true`, else `never` (unchanged for a command with neither).
3. **Adapters**: with no `returns`, `src/d1.ts` reads rows from `results[command.returningIndex]`; `src/durable.ts` keeps the marked item's own cursor's `toArray()` instead of discarding it. Both parse JSON through that item's own `meta.json`, the way `returns` already does.
4. **Included commands** (ADR 0127): the including command owns the row source. An included item's own `returning` marker is never a candidate for the including command's `returningIndex` — `commands()` only ever sets it from a plain item of the including plan's own, never from a spliced-in included item — so an included row-source item always runs as an ordinary write and its rows are dropped, the same rule ADR 0127 already gives an included `returns`. This drop is deliberate: it avoids the silent-loss shape ADR 0110's own precedent (solarsql-3ak) refused, because the caller who wrote the including command chose not to declare a row source of its own, unlike ADR 0110's case, where the build refused a caller's stated intent to read a row a write plan item cannot carry.

## Why

The adapters already have the rows a DELETE ... RETURNING plan item's own reply carries; ADR 0110's refusal for this one shape produced only wrong advice (move the read into `returns`, which for a DELETE reads nothing) with no adapter limitation behind it. INSERT and UPDATE keep the refusal because their working alternative — reading the value before the write, or through `returns` after it — is not this ADR's subject, and because their AFTER-trigger row-visibility trade-off (RETURNING sees the pre-trigger value; `returns` sees the post-trigger value) is unmeasured for them, unlike the DELETE case measured here.

## Consequences

- With no `returns`, a command's rows come from a DELETE ... RETURNING plan item's own row type; a command with `returns` is unaffected; a command with neither still gets `never[]`.
- A command cannot pair `returns` with a DELETE ... RETURNING item, or declare two such items: the build refuses both, naming the row sources it found.
- A RETURNING list may not read the DELETE's own target table in a subquery.
- `commands.md` documents the row source, RETURNING's arbitrary row order (the caller sorts), at-most-once delivery (a caller that needs at-least-once uses a claim-then-acknowledge pair of commands instead), and the portable limit form `where id in (select id from t order by ... limit :n)` (node's own SQLite refuses `delete ... order by ... limit`). `build.md`'s `RETURNING clause is discarded` row is followed by a second row naming the DELETE exception.
- `test/statement-contract.test.ts`, `test/commands.test.ts`, and `test/miniflare/delete-returning.test.ts` pin the build-time refusals, the runtime row selection (including the two include-command cases: an including command's own `returns` wins, and an including command with no `returns` drops an included row source), and the same behavior on D1 and a Durable Object.
