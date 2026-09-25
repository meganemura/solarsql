# Platform limits

D1 and a Durable Object add limits that SQLite itself does not have.
Every number below was read from the Cloudflare documentation on 2026-09-19.
Check the URL in each row before you rely on a number; Cloudflare changes these limits.

| Limit | D1 | Durable Object SQLite | Source (URL) | Checked |
|---|---|---|---|---|
| Bound parameters per statement | 100 | 100 | https://developers.cloudflare.com/d1/platform/limits/ ; https://developers.cloudflare.com/durable-objects/platform/limits/ | 2026-09-19 |
| Maximum SQL statement length | 100,000 bytes (100 KB) | 100,000 bytes (100 KB) | https://developers.cloudflare.com/d1/platform/limits/ ; https://developers.cloudflare.com/durable-objects/platform/limits/ | 2026-09-19 |
| Statements per batch (D1) / per transaction (Durable Object) | Not stated as a count. Each statement's own limits (statement length, bound parameters) apply inside a `db.batch()` call. | A Durable Object has no batch API. `ctx.storage.sql.exec()` runs one statement at a time inside a transaction; the docs state no count limit on statements per transaction. | https://developers.cloudflare.com/d1/platform/limits/ ; https://developers.cloudflare.com/durable-objects/best-practices/access-durable-objects-storage/ | 2026-09-19 |
| Maximum response size or rows per query | Not stated. | Not stated. | https://developers.cloudflare.com/d1/platform/limits/ ; https://developers.cloudflare.com/durable-objects/platform/limits/ | 2026-09-19 |
| Maximum string, BLOB, or table row size | 2,000,000 bytes (2 MB), per the Cloudflare docs pages, still current on 2026-09-25 | 2 MB, per the Cloudflare docs pages, still current on 2026-09-25 | https://developers.cloudflare.com/d1/platform/limits/ ; https://developers.cloudflare.com/durable-objects/platform/limits/ | 2026-09-19 |
| Maximum database size | 10 GB (Workers Paid) / 500 MB (Free) | 10 GB per Durable Object (Workers Paid) | https://developers.cloudflare.com/d1/platform/limits/ ; https://developers.cloudflare.com/durable-objects/platform/limits/ | 2026-09-19 |
| Maximum SQL query duration | 30 seconds | Not a separate SQL limit; a Durable Object invocation runs under its own CPU-time and wall-time limits. | https://developers.cloudflare.com/d1/platform/limits/ ; https://developers.cloudflare.com/durable-objects/platform/limits/ | 2026-09-19 |
| SQLite version the platform runs | Not stated. | Not stated. | https://developers.cloudflare.com/d1/platform/limits/ ; https://developers.cloudflare.com/durable-objects/platform/limits/ | 2026-09-19 |
| Maximum number of columns per table | 100 | 100 | https://developers.cloudflare.com/d1/platform/limits/ ; https://developers.cloudflare.com/durable-objects/platform/limits/ | 2026-09-19 |
| Maximum arguments per SQL function | 32 | 32 | https://developers.cloudflare.com/d1/platform/limits/ ; https://developers.cloudflare.com/durable-objects/platform/limits/ | 2026-09-19 |
| Maximum characters (bytes) in a LIKE or GLOB pattern | 50 bytes | 50 bytes | https://developers.cloudflare.com/d1/platform/limits/ ; https://developers.cloudflare.com/durable-objects/platform/limits/ | 2026-09-19 |
| Queries per Worker invocation | 1,000 (Workers Paid) / 50 (Free) ("read subrequest limits") | Not stated. | https://developers.cloudflare.com/d1/platform/limits/ ; https://developers.cloudflare.com/durable-objects/platform/limits/ | 2026-09-19 |

The two pages list the same value for each SQL limit; neither page says why.

### The row-size limit workerd actually sets

The Cloudflare docs pages above still say 2 MB, checked again 2026-09-25.
Workerd's own source sets a different value on every SQLite connection it opens for D1 and a Durable Object (`cloudflare/workerd`, `src/workerd/util/sqlite.c++`, `SqliteDatabase::setupSecurity`, `SQLITE_LIMIT_LENGTH`; the pinned `v1.20260828.1`, commit `8ea6349`, line 1374, sets `4 * 1024 * 1024` (4 MiB); `main` as of commit `1b9b6ea` ("Increase the SQLite row limit to 8 MiB", 2026-09-23), line 1406, sets `MAX_ROW_LENGTH`, defined in `src/workerd/util/sqlite.h` as `8 * 1024 * 1024 + 34` (8 MiB + 34 bytes)).
Measured on Miniflare 5.20260828.0-alpha (workerd 1.20260828.1, the pinned tag's value): `zeroblob(5_000_000)` fails with `SQLITE_TOOBIG` on local D1 and a local Durable Object; a 2.1 MB blob passes. Local Miniflare; deployed unverified.
Three values exist for this one limit: 2 MB (Cloudflare's docs pages, unchanged as of this check), 4 MiB (the pinned workerd tag's source, matching what was measured locally), and 8 MiB + 34 bytes (workerd's `main` branch, not yet in a released tag this project has measured). Which value the deployed platform enforces is unresolved; treat the smallest, documented number as the rule until a remote probe settles it.

## What a json_each array parameter meets first

The adapter encodes an array parameter as one JSON string bound to one slot (`src/runtime/plan.ts`, "the parameter that json_each reads is encoded as JSON text").
An array parameter always occupies one of the 100 bound-parameter slots, so that limit is never what stops it from growing.

Two other limits stop it instead:

- The bound value's own size: 2,000,000 bytes (2 MB) per the Cloudflare docs pages, though workerd's own source sets a different value (see "The row-size limit workerd actually sets" above); this is `SQLITE_LIMIT_LENGTH`.
- The statement's total size: 100,000 bytes (100 KB), the "maximum SQL statement length" row above; this is `SQLITE_LIMIT_SQL_LENGTH`, a separate limit from the one above (SQLite's own reference, https://www.sqlite.org/c3ref/c_limit_attached.html: `SQL_LENGTH` bounds the text of the SQL statement, `LENGTH` bounds a string or BLOB value). A bound value does not count toward the 100 KB statement-length limit; it counts only toward its own row/BLOB size limit.

The recipe in `queries.md` ("a list of any length, one bound value") promises that the array does not need one bound parameter per element, so it does not compete with other parameters for the 100-slot limit (99 when the command has an assert; see below).
It does not promise an unlimited list: the JSON text of the array is a bound value, so it must fit inside the row-size limit, not the 100 KB statement-length limit. Measured on local D1, a local Durable Object, and node:sqlite under workerd's own limits: bound JSON of 425,501, 1,021,201, and 2,042,401 bytes passed through `json_each`; 4,255,001 bytes failed with `string or blob too big`. Local Miniflare; deployed unverified. This replaces an earlier "about 4,500 ids" estimate that assumed the array competed with the 100 KB statement-length limit; ADR 0028:36 already recorded 5,000 ids (about 39 KB) fitting on local D1, consistent with this larger ceiling.

## What these limits mean for a query

- An assert statement uses one of the 100 slots for its run-time token, leaving 99 for the predicate (ADR 0086's amendment). This only applies to an assert's own predicate; a plan item with no assert still has the full 100.
- `json_object('k', v, ...)` takes two arguments per key, so one `json_object` call holds at most 16 keys on both platforms (32 arguments ÷ 2). A wider row needs a nested `json_object` or a second query. The same arithmetic applies to `json_array`, `coalesce`, and any other variadic function: the 32-argument ceiling divides by the arguments each element takes.
- Measured on Miniflare 5.20260828.0-alpha on 2026-09-19: local D1 and a local Durable Object both accepted `select json_object(<17 pairs>)` (34 arguments) without an error, so a local run does not enforce the 32-argument limit. Whether the deployed platform enforces it was not measured; treat the documented number as the rule.
- A `LIKE` parameter (`queries.md`'s `where note like :pattern`) is a bound value. Measured on local D1 and a local Durable Object: a bound 51-byte pattern fails at run time with `LIKE or GLOB pattern too complex`; a bound 50-byte pattern passes; a literal pattern of the same lengths behaves the same way. Neither case fails at prepare (build) time; the failure is a run-time engine error. Local Miniflare; deployed unverified.
- Queries per invocation: each `db.all`, `db.first`, or `db.run` call is one query against D1; `db.batch` (ADR 0035) is one. A loop that calls `db.first` for 60 ids in one Worker invocation hits the Free plan's 50-query limit.
- Columns per table: 100 is the schema ceiling on both platforms. The build checks it (ADR 0134): a `table()` with more than 100 columns is refused at build time, the same as it would fail on D1 or a Durable Object.
- Arguments per SQL function: workerd's own compiled default is 127 (ADR 0134's `WORKERD_LIMITS.functionArg`), not the 32 this page's row above states. The build's gate follows workerd's source and refuses a call past 127 arguments; a call between 17 and 63 argument pairs passes the build even though the documented, 32-argument platform limit says it should not. Which number the deployed platform enforces is unresolved (see ADR 0134); a local Miniflare D1 and a local Durable Object both accepted 34 arguments without an error, so a local run cannot settle it either.

## Limits workerd sets that the Cloudflare docs pages do not state

The Cloudflare D1 and Durable Object limits pages, checked again 2026-09-25, do not list these; each comes from `cloudflare/workerd`, `src/workerd/util/sqlite.c++`, `SqliteDatabase::setupSecurity`, the pinned `v1.20260828.1` (commit `8ea6349`, lines 1374-1388):

| Limit | Value | workerd constant | Checked when |
|---|---|---|---|
| Compound SELECT terms (`UNION`, `UNION ALL`, `INTERSECT`, `EXCEPT`) | 5 | `SQLITE_LIMIT_COMPOUND_SELECT` | Prepare time. A multi-row `VALUES` list is exempt: a 600-row `VALUES` and a 6-row `INSERT ... VALUES` both pass; a 6-term compound `SELECT` fails. |
| Expression tree depth | 100 | `SQLITE_LIMIT_EXPR_DEPTH` | Prepare time. |
| Compiled-instruction (VDBE) program size | 25,000 ops | `SQLITE_LIMIT_VDBE_OP` | Prepare time on node:sqlite (message renamed from SQLite's generic "out of memory", ADR 0134). Effective ceiling measured on a local Durable Object: 21,843 `EXPLAIN` rows before it failed with "out of memory"; local Miniflare, deployed unverified. |
| Trigger recursion depth | 10 | `SQLITE_LIMIT_TRIGGER_DEPTH` | Run time only, never at prepare (a trigger has to actually fire to recurse). |
| Attached databases | 0 | `SQLITE_LIMIT_ATTACHED` | Prepare time; solarsql never issues `ATTACH`, so this only rules out a hand-written statement that tries to. |

The compound-SELECT, expression-depth, and attached-database limits are already gated at build time (ADR 0134, `WORKERD_LIMITS` in `src/build/facts.ts`); the trigger-depth limit is not, because it fires only when a trigger runs.

### A Durable Object's sql.exec() checks the 100 KB limit against the whole statement text it is given

`ctx.storage.sql.exec()` accepts a string that may hold more than one statement; measured on a local Durable Object, 5,000 statements of 25 bytes each (130 KB total) failed with `statement too long`, where D1's own multi-statement `exec()` ran the same text without error. Local Miniflare; deployed unverified. solarsql's `migrate()` (`src/durable.ts:343`) already splits a migration file into individual statements before running each one, so the adapter itself never hits this; a caller who bypasses `migrate()` and hands a Durable Object's `sql.exec()` a large hand-built multi-statement string directly can still hit it.

## What the build checks at prepare time (ADR 0113, ADR 0114, ADR 0134)

`src/build/facts.ts`'s `Engine.prepare()` and its constructor's DDL loop run every query, command plan item, view, trigger body, and DDL statement under workerd's own prepare-time SQLite limits, not `node:sqlite`'s much looser defaults: a 100,000-byte statement, 100 result columns, 100 columns in `CREATE TABLE`, a 5-term compound `SELECT` (`UNION`/`UNION ALL`/etc.; a multi-row `VALUES` is exempt), an expression tree 100 levels deep, 127 arguments to one function call, 100 bound parameters, and workerd's own compiled-instruction ceiling (25,000 VDBE ops) are all refused at build time, with a message naming the limit that fired. `migration.ts`'s `applied()` — a second DDL entry point outside `Engine`, used to replay migration files already written to disk — runs under the same gate, so a hand-edited or pre-existing migration file is refused the same way.

## What the build cannot check

Everything above this line that names a byte size, a row size, or a database size is enforced only at run time by workerd, never at prepare: the 2 MB maximum string/BLOB/row size, the 10 GB (or 500 MB) database size ceiling, the 50-byte `LIKE`/`GLOB` pattern length, and trigger recursion depth (`triggerDepth`) are outside what any prepare-time gate can see, because SQLite itself does not check them until a statement actually runs. `node:sqlite`'s `DatabaseSync.limits` carries no equivalent for the queries-per-invocation or statements-per-batch rows above either; those are Workers platform limits, not SQLite ones. A statement, a query, or a command plan can still pass the build and then fail on D1 or a Durable Object for any of these: a bound value over 2 MB, a database past its size limit, a `LIKE` pattern over 50 bytes, or a trigger that recurses too deep. Nothing in the build catches any of this; only a test against Miniflare or a deployed Worker does.

`node:sqlite`'s own defaults for the `LIKE`/`GLOB` pattern length and the trigger recursion depth are far looser than workerd's (50,000 bytes and 1,000 levels), so an unconfigured node test can pass a query that fails on D1 or a Durable Object. `solarsql/node` exports `NODE_TEST_LIMITS`, `{ likePatternLength: 50, triggerDepth: 10 }`, matching workerd's own values; open a node test's connection with it (`new DatabaseSync(path, { limits: NODE_TEST_LIMITS })`), the way `solarsql init`'s own test template does. The row-size limit is left out on purpose: the candidates measured are 2 MiB (Cloudflare's docs), 4 MiB (the pinned workerd release), and 8 MiB + 34 bytes (workerd main), and a fixed value here would disagree with a deployed value in that range.
