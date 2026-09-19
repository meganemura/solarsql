# ADR 0121: Rehearsal's snapshot step uses `vacuum into`, not `backup`

Status: accepted (2026-09-19)

## Context

ADR 0063 measured `rehearse()`'s on-disk snapshot step (node:sqlite's `backup()`) waiting 30.09 and 8.10 seconds inside `await backup`, reproducibly, but left the cause unattributed: "The native backup wait is observed, but its cause remains unattributed."

This ADR attributes it far enough to act, without needing the exact OS-level mechanism. `src/node_sqlite.cc` (checked at the matching Node tag, v26.7.0) shows `BackupJob::AfterThreadPoolWork` (lines 538-539) treating `SQLITE_BUSY` and `SQLITE_LOCKED` the same as "still copying": it checks `sqlite3_backup_remaining(backup_)` and, if pages remain, calls `this->ScheduleWork()` again (line 577) with no sleep of its own. `DatabaseSync`'s own open path (`src/node_sqlite.cc:995`) calls `sqlite3_busy_timeout(connection_, open_config_.get_timeout())`, and `OpenConfiguration`'s default (`src/node_sqlite.h:122`) is `timeout_ = 0`, which disables SQLite's busy handler and makes a locked `backup_step` return `SQLITE_BUSY` immediately rather than sleep. A tight BUSY-retry loop under that combination would spin near 100% CPU; the measured wait was at 0% CPU (ADR 0063's own instrumentation and this task's reproduction agree). The wait is therefore not a busy-retry loop at the SQLite or node:sqlite level; it sits somewhere between node's `ScheduleWork()`/threadpool round trip and the OS, which this ADR does not pin down further.

Reproduction (this task, 2026-09-19, same machine and Node version as ADR 0063): a `node --test` file with two `test()`s, the first performing six sequential `rehearse()` calls against a plain (non-WAL) file the test itself had already opened and closed before calling `rehearse()`. Calls 1 and 2 finished in under 1 ms each; calls 3-6 took 30,099, 8,103, 8,102, and 8,101 ms, read from the `solarsql.rehearse` diagnostics channel, entirely inside the `backup` phase. A `console.log` between each `rehearse()` call made the wait disappear; removing every such log reproduced it again, confirming that the earlier "closes its source connection and still waits, but a copy in isolation does not" observation was itself an artifact of an accidental `console.log` between calls in the working reproduction, not evidence against the wait's existence.

## Decision

`rehearse()`'s snapshot step now runs `source.prepare('vacuum into ?').run(path)` on the already-open, read-only source connection, in place of `await backup(source, path)`. `VACUUM INTO` (sqlite.org, `Vacuum.html`) runs synchronously, on the same connection, with no second native handle opened via `sqlite3_open_v2` and no threadpool round trip -- the two things `backup()` adds that this ADR's node_sqlite.cc reading and 0% CPU measurement together point at. It reads through the same B-tree layer as an ordinary `SELECT`, so it still sees only committed data: the existing WAL test (`rehearsal snapshots committed WAL data ...`) still passes unchanged, confirming a row committed via a same-process WAL writer still appears in the snapshot and an in-progress one still does not. `VACUUM INTO` works against a read-only source connection, which `rehearse()` already opens with `{ readOnly: true }`; this was verified empirically here, not assumed from the SQLite documentation, which does not state it directly.

The `backup` phase name is unchanged: it still names "the step that produces the on-disk snapshot," and every diagnostics-channel consumer keys on that name.

`node:sqlite`'s `backup` import is removed from `src/build/rehearse.ts`; nothing else in the codebase imports it.

## Evidence

`node spike/11-backup-lifecycle.ts` and the reproduction described above, on Node 26.7.0, macOS: the same six-call sequence that took 54.4 s total with `backup()` took 11-14 ms total with `vacuum into`, plain and WAL alike. `test/slow/rehearse-file.test.ts` adds a test asserting the `backup` phase (read from the diagnostics channel) finishes in under 2,000 ms for a one-row database, both plain and WAL, source connection closed before `rehearse()` runs; the file's two pre-existing tests are unchanged in behavior and now run in single-digit milliseconds instead of 30-46 s and 8-16 s.

A variant table, from the same reproduction harness (six sequential `rehearse()` calls, no `console.log` between them, WAL source with an earlier same-process writer already closed):

| Variant | Backup/snapshot step, six calls |
| --- | --- |
| `backup()`, default (`timeout: 0`) | 30,099 + 8,103 + 8,102 + 8,101 ms (calls 3-6); calls 1-2 under 1 ms |
| `backup()`, `{ timeout: 5000 }` on the read-only open, isolated single call | fast (0.4 ms) -- did not reproduce the wait in isolation, so this could not be confirmed as a fix against the six-call pattern |
| `backup()`, `{ rate: 0 }` | never finishes: `pages_ = 0` means `sqlite3_backup_step` copies nothing per step, `sqlite3_backup_remaining` never reaches 0, and node's own retry-with-no-sleep (see Context) reschedules forever; killed after runaway CPU and wall time. Do not use `rate: 0` as a workaround. |
| `vacuum into` | 11-14 ms total, plain and WAL, all six calls |

## Consequences

- The rehearsal CLI's 30,000 ms default budget (ADR 0065) is unchanged; this fix removes the case that was hitting it on a tiny database, but this ADR does not change the budget itself.
- `vacuum into` still copies the whole source database in one statement, the same as `backup()` did; a very large source database's snapshot cost is unchanged by this ADR, only the multi-second stall on a small one.
- If a future SQLite or node:sqlite version changes `VACUUM INTO`'s read-only-source behavior or its treatment of an open WAL writer in the same process, the new speed test in `test/slow/rehearse-file.test.ts` (backup phase under 2,000 ms) fails loudly rather than silently regressing to a multi-second wait.
- The exact OS-level mechanism behind `backup()`'s wait remains unattributed, as it was after ADR 0063; this ADR sidesteps it rather than explains it.
