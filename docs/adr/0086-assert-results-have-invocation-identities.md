# ADR 0086: Assert results have invocation identities

Status: accepted (2026-09-14)

## Context

SQLite reports a trigger abort through its message and constraint code.
The adapter previously matched that message directly against the command's public assert names.
A user trigger with the same message was therefore reported as a failed solarsql assert, even when the guard statement did not run.

## Decision

Give each command invocation a random guard token.
Put the token, an internal prefix, and the public assert name in the guard row.
Classify a trigger abort only when its complete message contains the token for that invocation.
Return only the public assert name in `CommandResult`.
Rethrow user trigger errors unchanged when their messages match a public name or resemble the internal prefix.

## Evidence

A property varies valid public names, invocation tokens, and engine message wrappers.
Only the identity for the current invocation becomes an assert result.
A public command meets same-name and prefix-like user triggers on Node, local D1, and a Durable Object.
Each adapter rethrows those errors and retains zero inserted rows.
Existing command tests retain genuine assert results and transaction rollback.

## 2026-09-25: the token binds as a value; it does not sit in the SQL text

The Decision above says to "put the token ... in the guard row"; it says nothing about how. `assertStatement()` wrote the token into the SQL text as a string literal, so the text of a command's own assert statement was a fresh string every run: never "one prepared statement per query" (ADR 0028's own claim, corrected there today), never the same D1 insights row twice (D1 groups by exact query string; developers.cloudflare.com/d1/observability/metrics-analytics/), and never a cache hit in workerd's per-text compiled-statement cache (`SqlStorage::exec`, LRU, capped at 1 MiB of SQL text: cloudflare/workerd `src/workerd/api/sql.c++`, commit 5d1832a, lines 19-24 and 42-95).

Measured by `spike/15-assert-token-cache.ts` against one Durable Object, local workerd, 2026-09-25: writing a fresh token into the text every run raised the workerd process's RSS from 67.0 MB to 88.3 MB across runs 1,001 to 10,001, with the rise visibly slowing over the last 3,000 runs; binding the same token as a value instead, so the text is the same every run, raised RSS only from 64.8 MB to 73.5 MB over the same span. See `docs/v5-measurements.md` section 4 for the full sampled series.

`assertStatement(name, predicate, token?)` now emits `insert into solarsql_assert (ok, name) select (case when (<predicate>) then 1 else 0 end), 'solarsql:assert:' || ? || ':<name>'` when a token is given: the placeholder sits after the predicate's own named parameters (ADR 0071's first-appearance order), and the adapter appends the token as the statement's last bound value (`assertBindValues()`, `src/runtime/plan.ts`). Called with no token, from the build, the text keeps the name embedded as a literal (`'<name>'`, no placeholder): the build only prepares this form to read the predicate's own parameter and column types, never runs it, and `typegen.ts` refuses an anonymous `?` in a typed statement. The token itself never appears in a command's declared parameters, `validateParams()` error, or `Params` type.

D1 and a Durable Object-backed SQLite both cap bound values per statement at 100 (`limits.md`). The token now uses one of those 100 for every assert statement, so the build refuses a predicate that itself names 100 or more parameters (`checkAssertParamBudget()`, `src/build/build.ts`): 99 is the most a predicate may declare. `limits.md`'s bound-parameters row and its array-parameter note carry this 99-slot budget.

On node:sqlite, `node.ts`'s `storageOf().sql.exec()` bound a predicate's own named slots as one named object; a trailing anonymous `?` for the token then bound as NULL underneath it, and the guard table's `name text not null` failed where a real assert result should have appeared. Fixed by passing the named object and the remaining positional values (here, only the token) as separate arguments to `statement.all()`.
