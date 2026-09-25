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
| Maximum string, BLOB, or table row size | 2,000,000 bytes (2 MB) | 2 MB | https://developers.cloudflare.com/d1/platform/limits/ ; https://developers.cloudflare.com/durable-objects/platform/limits/ | 2026-09-19 |
| Maximum database size | 10 GB (Workers Paid) / 500 MB (Free) | 10 GB per Durable Object (Workers Paid) | https://developers.cloudflare.com/d1/platform/limits/ ; https://developers.cloudflare.com/durable-objects/platform/limits/ | 2026-09-19 |
| Maximum SQL query duration | 30 seconds | Not a separate SQL limit; a Durable Object invocation runs under its own CPU-time and wall-time limits. | https://developers.cloudflare.com/d1/platform/limits/ ; https://developers.cloudflare.com/durable-objects/platform/limits/ | 2026-09-19 |
| SQLite version the platform runs | Not stated. | Not stated. | https://developers.cloudflare.com/d1/platform/limits/ ; https://developers.cloudflare.com/durable-objects/platform/limits/ | 2026-09-19 |
| Maximum number of columns per table | 100 | 100 | https://developers.cloudflare.com/d1/platform/limits/ ; https://developers.cloudflare.com/durable-objects/platform/limits/ | 2026-09-19 |
| Maximum arguments per SQL function | 32 | 32 | https://developers.cloudflare.com/d1/platform/limits/ ; https://developers.cloudflare.com/durable-objects/platform/limits/ | 2026-09-19 |
| Maximum characters (bytes) in a LIKE or GLOB pattern | 50 bytes | 50 bytes | https://developers.cloudflare.com/d1/platform/limits/ ; https://developers.cloudflare.com/durable-objects/platform/limits/ | 2026-09-19 |
| Queries per Worker invocation | 1,000 (Workers Paid) / 50 (Free) ("read subrequest limits") | Not stated. | https://developers.cloudflare.com/d1/platform/limits/ ; https://developers.cloudflare.com/durable-objects/platform/limits/ | 2026-09-19 |

The two pages list the same value for each SQL limit; neither page says why.

## What a json_each array parameter meets first

The adapter encodes an array parameter as one JSON string bound to one slot (`src/runtime/plan.ts`, "the parameter that json_each reads is encoded as JSON text").
An array parameter always occupies one of the 100 bound-parameter slots, so that limit is never what stops it from growing.

Two other limits stop it instead:

- The bound value's own size: 2,000,000 bytes (2 MB), the "maximum string, BLOB, or table row size" row above.
- The statement's total size: 100,000 bytes (100 KB), the "maximum SQL statement length" row above. Cloudflare does not state whether a bound value's bytes count toward this figure separately from the literal SQL text; treat 100 KB as the tighter of the two until Cloudflare states otherwise.

The recipe in `queries.md` ("a list of any length, one bound value") promises that the array does not need one bound parameter per element, so it does not compete with other parameters for the 100-slot limit.
It does not promise an unlimited list: the JSON text of the array must fit inside the tighter limit above, the 100,000-byte statement length. A 20-byte id, with its quotes and comma, gives about 4,500 ids.

## What these limits mean for a query

- `json_object('k', v, ...)` takes two arguments per key, so one `json_object` call holds at most 16 keys on both platforms (32 arguments ÷ 2). A wider row needs a nested `json_object` or a second query. The same arithmetic applies to `json_array`, `coalesce`, and any other variadic function: the 32-argument ceiling divides by the arguments each element takes.
- Measured on Miniflare 5.20260828.0-alpha on 2026-09-19: local D1 and a local Durable Object both accepted `select json_object(<17 pairs>)` (34 arguments) without an error, so a local run does not enforce the 32-argument limit. Whether the deployed platform enforces it was not measured; treat the documented number as the rule.
- A `LIKE` parameter (`queries.md`'s `where note like :pattern`) is a bound value. The Cloudflare docs page does not say whether a bound pattern counts toward the 50-byte `LIKE`/`GLOB` limit the same way a literal pattern does; treat a bound pattern as subject to the limit until Cloudflare states otherwise.
- Queries per invocation: each `db.all`, `db.first`, or `db.run` call is one query against D1; `db.batch` (ADR 0035) is one. A loop that calls `db.first` for 60 ids in one Worker invocation hits the Free plan's 50-query limit.
- Columns per table: 100 is the schema ceiling on both platforms. The build checks it (ADR 0134): a `table()` with more than 100 columns is refused at build time, the same as it would fail on D1 or a Durable Object.
- Arguments per SQL function: workerd's own compiled default is 127 (ADR 0134's `WORKERD_LIMITS.functionArg`), not the 32 this page's row above states. The build's gate follows workerd's source and refuses a call past 127 arguments; a call between 17 and 63 argument pairs passes the build even though the documented, 32-argument platform limit says it should not. Which number the deployed platform enforces is unresolved (see ADR 0134); a local Miniflare D1 and a local Durable Object both accepted 34 arguments without an error, so a local run cannot settle it either.

## What the build checks at prepare time (ADR 0113, ADR 0114, ADR 0134)

`src/build/facts.ts`'s `Engine.prepare()` and its constructor's DDL loop run every query, command plan item, view, trigger body, and DDL statement under workerd's own prepare-time SQLite limits, not `node:sqlite`'s much looser defaults: a 100,000-byte statement, 100 result columns, 100 columns in `CREATE TABLE`, a 5-term compound `SELECT` (`UNION`/`UNION ALL`/etc.; a multi-row `VALUES` is exempt), an expression tree 100 levels deep, 127 arguments to one function call, 100 bound parameters, and workerd's own compiled-instruction ceiling (25,000 VDBE ops) are all refused at build time, with a message naming the limit that fired. `migration.ts`'s `applied()` — a second DDL entry point outside `Engine`, used to replay migration files already written to disk — runs under the same gate, so a hand-edited or pre-existing migration file is refused the same way.

## What the build cannot check

Everything above this line that names a byte size, a row size, or a database size is enforced only at run time by workerd, never at prepare: the 2 MB maximum string/BLOB/row size, the 10 GB (or 500 MB) database size ceiling, the 50-byte `LIKE`/`GLOB` pattern length, and trigger recursion depth (`triggerDepth`) are outside what any prepare-time gate can see, because SQLite itself does not check them until a statement actually runs. `node:sqlite`'s `DatabaseSync.limits` carries no equivalent for the queries-per-invocation or statements-per-batch rows above either; those are Workers platform limits, not SQLite ones. A statement, a query, or a command plan can still pass the build and then fail on D1 or a Durable Object for any of these: a bound value over 2 MB, a database past its size limit, a `LIKE` pattern over 50 bytes, or a trigger that recurses too deep. Nothing in the build catches any of this; only a test against Miniflare or a deployed Worker does.
