# ADR 0134: The build prepares every user statement under workerd's own SQLite limits

Status: accepted (2026-09-25)

## Context

D1 and a Durable Object's own storage both run SQLite with limits workerd sets on every connection it opens (`cloudflare/workerd`, `src/workerd/util/sqlite.c++`, `SqliteDatabase::setupSecurity`, lines 1406-1421 on main as of 2026-09-25; the same values at lines 1380-1387 in the pinned `v1.20260828.1`): `SQL_LENGTH` 100,000, `COLUMN` 100, `EXPR_DEPTH` 100, `COMPOUND_SELECT` 5, `VDBE_OP` 25,000, `FUNCTION_ARG` 127, `ATTACHED` 0, `VARIABLE_NUMBER` 100, plus the run-time-only `LENGTH`, `LIKE_PATTERN_LENGTH` 50, and `TRIGGER_DEPTH` 10.

The build prepares SQL on `node:sqlite`, which carries SQLite's own defaults (Node 26.7.0 / SQLite 3.53.4: `compoundSelect` 500, `exprDepth` 1000, `column` 2000, `functionArg` 1000, `variableNumber` 32766, `sqlLength` 1e9, `vdbeOp` 250,000,000) at every prepare site: `Engine.prepare()` and the `Engine` constructor's DDL loop (`src/build/facts.ts`), and `migration.ts`'s `applied()`. `skills/solarsql/references/limits.md` already told a reader the build does not check these limits.

ADR 0113 put the same problem to a narrower question — a function call outside workerd's own allowlist — and answered it with a call-scoped `setAuthorizer()`. This decision extends that answer to the prepare-time size and shape limits above, at the two sites ADR 0113 and ADR 0114 already gate.

Measured on Node 26.7.0, with workerd's own values set on `node:sqlite` through `DatabaseSync.limits` (`nodejs/node` PR #61298; the constructor form ships from Node 24.15.0 / 25.8.0, and this project's own Node floor, ADR 0129, is `^24.20.0 || >=26.7.0`), each pair below gave the same pass/fail on node, on Miniflare 5.20260828.0-alpha D1, and on a local Miniflare Durable Object, while the unmodified build accepted every failing case: a 6-term `UNION ALL` (also inside a CTE) against a 5-term one, with a 600-row `VALUES` exempt from the same limit; `coalesce`/`json_object` with 127 against 128 arguments; a 100-term against a 101-term addition chain; 100 against 101 result columns and against 101 columns in `CREATE TABLE`; 100 against 101 named parameters; a 100,000-byte against a 100,001-byte statement.

## Decision

`src/build/facts.ts` carries a `WORKERD_LIMITS` constant next to `ALLOWED_SQLITE_FUNCTIONS`: `sqlLength` 100,000, `column` 100, `exprDepth` 100, `compoundSelect` 5, `vdbeOp` 25,000, `functionArg` 127, `variableNumber` 100, `attach` 0. `length`, `likePatternLength`, and `triggerDepth` are left out: workerd enforces each of the three only at run time (a row write, a `LIKE` call, a trigger firing), never at prepare, so a prepare-time gate around them would check nothing.

A new `withWorkerdLimits(db, fn)` sets these values on `db.limits` for the duration of `fn` only, then restores the connection's own previous values (read with `{...db.limits}` first) in a `finally`, whatever `fn` does — the same call-scoped shape `withDeniedFunctions` already uses for the allowlist authorizer, applied for the same reason: the `Engine` may run on a caller-supplied connection (`facts.ts`'s constructor, `database ?? new DatabaseSync(":memory:")`), so a change here must never leak past the one call that needed it. The implementation never assigns `Infinity` to a limit; `DatabaseSync.limits` treats that value as "no limit," which would silently widen a connection that had a tighter limit before the call.

`withWorkerdLimits` wraps `Engine.prepare()` and the `Engine` constructor's own per-statement DDL loop, the same two sites `withDeniedFunctions` already wraps (ADR 0113, ADR 0114); a view or a trigger body reaches both through `build.ts`'s own calls into `engine.prepare()` (lines 512 and 885), so no further call site was needed for either. `migration.ts`'s `applied()` is a third, `Engine`-external DDL replay path with its own `withDeniedFunctions(db, () => db.exec(s))` call; it now wraps that same call in `withWorkerdLimits` too, so a migration file already written to disk — generated before this check existed, or edited by hand — is refused the same way a fresh build is.

node:sqlite reports the `vdbeOp` limit as SQLite's own generic `out of memory` (`errcode` 7), with no limit-specific text. `withWorkerdLimits` renames exactly that message to name workerd's limit, so a `vdbeOp` refusal reads the same as every other `WORKERD_LIMITS` case, whose SQLite messages already name the limit (`too many terms in compound SELECT`, `too many columns in result set`, and so on) with no rewriting needed.

### Rejected: a limit on the whole connection

A permanent, connection-wide limit (set once for the `Engine`'s lifetime, the same shape ADR 0113 rejected for the allowlist) was measured and rejected. The build's own internal wrapper SQL — the temp-table dedup `create temp table ... as select * from (...) limit 0` (`facts.ts`, the `columns()` path) and `explain query plan ...` (`facts.ts`, `fullScans()` and `plan()`) — is built from the same user SQL text and can itself exceed `sqlLength` or `column` once wrapped, turning a legal 99,990-byte user statement into a false "string or blob too big" build error that names no user statement. A call-scoped limit, narrowed to the one `db.prepare()` or `db.exec()` call that runs the user's own text, leaves every wrapper call at the connection's real (unlimited) size.

### Rejected: a second, limited connection

Preparing user SQL against a second `DatabaseSync` connection carrying the limits, instead of the caller's own connection, was also considered. It would replay the whole schema a second time for every statement checked and add no coverage a call-scoped limit on the existing connection does not already give.

### FUNCTION_ARG: workerd's source against the documented platform limit

`functionArg` 127 matches workerd's own compiled default. The Cloudflare D1 and Durable Object limit pages (`skills/solarsql/references/limits.md`) instead state 32 arguments per SQL function. This decision follows the source constant, not the docs page, because the source is what actually compiles into the deployed binary; a Miniflare probe on 2026-09-19 (recorded in `limits.md`) already found a local D1 and a local Durable Object both accepting a 34-argument `json_object` call without an error, so the local runtime does not enforce the lower, documented number either. Until a remote probe against a deployed Worker settles which number the production platform enforces, this gate accepts a call with 17-63 argument pairs that a deployed platform might still refuse; `limits.md` records this gap next to the 32-argument row.

## Consequences

- A statement that would fail on every call on D1 or a Durable Object for exceeding one of these eight limits is refused at build time instead, with a message naming the limit that fired.
- A caller-supplied `DatabaseSync` connection's own limits are unchanged after a build: `withWorkerdLimits` never widens or narrows a connection past the one call it wraps.
- `migration.ts`'s `applied()` gates the same limits, so a migration file with a statement past one of them is refused at replay, not only on deploy; `test/facts.test.ts` pins one case (a 101-column `CREATE TABLE`) through `applied()` directly.
- The `FUNCTION_ARG` gap between workerd's source (127) and the Cloudflare docs page (32) is unresolved; this decision picks the source value and records the gap rather than guessing which one production enforces.
- `test/facts.test.ts` pins each limit's own boundary pair on `node:sqlite`, and `test/miniflare/prepare-limits.test.ts` pins the same cases against real D1 and Durable Object storage through Miniflare, asserting all three verdicts agree, with no case placed between 15,000 and 25,000 VDBE ops — the band this round measured node:sqlite and a local Durable Object disagreeing in (a local Durable Object accepted up to 21,843 ops on macOS where node:sqlite's own `vdbeOp` 25,000 already refuses).
