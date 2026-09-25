# ADR 0140: a file-backed read-only open waits out a held SQLite lock

Status: accepted (2026-09-25). Cites ADR 0121, which tried `{ timeout: 5000 }` for rehearse's own backup step and could not confirm it as a fix for that different problem (a WAL source touched earlier in the same process); ADR 0121 did not decide against a busy timeout for a different problem.

## Context

`solarsql query --database`, `solarsql rehearse`, and `solarsql analyze --database` open their database with `new DatabaseSync(path, { readOnly: true })`. node:sqlite's `timeout` option (the SQLite busy timeout) defaults to 0, so an overlapping open on a WAL file another connection holds a lock on fails at once with SQLITE_BUSY or SQLITE_LOCKED, instead of waiting the lock out.

The files these commands point at are in WAL mode: `wrangler dev`'s own D1 file and a Durable Object's own file (`deploy.md`). A short-lived read-only connection racing a `wrangler dev` reload, or a moment with no long-lived connection at all, hits `database is locked`.

Measured (Node 26.7.0, SQLite 3.53.4): four read-only processes opening a plain WAL file 1,500 times each failed 74-93 times per process on select and 11-16 on `vacuum into` at `timeout: 0`; `timeout: 5000` failed 0 of 12,000 opens, the worst wait 57.9ms. Against the shipped CLI on an idle `wrangler dev` D1 file, `query` failed 3/400 and `rehearse` failed 1/400 at `timeout: 0`; both failed 0/400 at `timeout: 5000`. A lock held 1.5-2.3s was waited out with a timeout; `timeout: 0` failed immediately.

`query.ts`'s own try block covered only the open, so a lock that fired during the query itself (rather than at open) reported with no file path. `rehearse.ts` already reported its own stage name (`SNAPSHOT_FAILED`) but not the path or a "retry" hint.

## Decision

`query.ts`, `rehearse.ts`, and `analyze.ts` each open their file-backed read-only connection with a busy timeout of `min(5000, effectiveTimeoutMs - 1000)` milliseconds (`src/build/lock-timeout.ts`), where `effectiveTimeoutMs` is the command's own `--timeout-ms` (default 30,000 for `query`, 5,000 for `analyze`, which has no `--timeout-ms` flag). The 1,000ms margin leaves room for the CLI's own parent-process deadline (which runs in a separate process and would otherwise report a generic time-budget message before the lock message surfaces); the 5,000ms cap keeps an unusually large `--timeout-ms` from turning a lock into a multi-minute wait.

When a statement still fails after the wait with `.errcode & 0xff` equal to 5 (SQLITE_BUSY) or 6 (SQLITE_LOCKED), the diagnostic names the file path and says another connection held it past the wait, and to retry (`lockMessage`, `src/build/lock-timeout.ts`). `query.ts`'s try block now wraps the query's own execution, not only the open, so a lock that fires later still gets the path. No message names `wrangler dev`: SQLite cannot report who holds a lock.

`node()` and a caller-constructed `DatabaseSync` connection are out of scope: this ADR is about the three CLI-owned, short-lived, file-backed opens, not a library entry point whose connection lifetime and lock strategy are the caller's own choice. D1 and a Durable Object refuse `pragma busy_timeout` from Worker code (SQLITE_AUTH, measured on Miniflare), so a run-time equivalent for those adapters does not exist to add.

## Consequences

- `solarsql query`, `solarsql rehearse`, and `solarsql analyze` wait out a lock instead of failing on first contact, at the cost of up to 5s (or less, under a tight `--timeout-ms`) added latency to a genuine failure.
- A lock that outlasts the wait reports the file path and "locked" in one line, distinct from a `--timeout-ms` budget message.
