// Responsibility: the busy-timeout budget and lock diagnostic that every
// file-backed read-only DatabaseSync open in src/build/ shares (query.ts,
// rehearse.ts; analyze.ts's own open is out of scope for this file -- see
// its own TODO). node:sqlite's `timeout` option defaults to 0, so an
// overlapping open on a WAL file another process holds a lock on fails at
// once with SQLITE_BUSY/SQLITE_LOCKED instead of waiting the lock out
// (measured: a lock held 1.5-2.3s is waited out with a timeout; timeout 0
// fails immediately). See docs/ ADR 0140.
// Boundary: pure functions only. No DatabaseSync import here, so a caller
// with no SQLite dependency (a future analyze.ts refactor, a test) can
// import this without pulling node:sqlite in.

// The CLI's own parent-process deadline (--timeout-ms) runs in the parent
// (cli.ts); the worker must stop waiting on a lock well before that
// deadline kills it, or the parent's own timeout message wins the race and
// hides the lock. A fixed 1,000ms margin covers fork() and module load
// (measured well under 300ms); 5,000ms caps the wait so an unusually large
// --timeout-ms does not turn a lock into a multi-minute hang.
export function busyTimeoutMs(effectiveTimeoutMs: number): number {
  return Math.max(0, Math.min(5000, effectiveTimeoutMs - 1000));
}

// SQLITE_BUSY = 5, SQLITE_LOCKED = 6; node:sqlite reports an extended code
// (e.g. 261 = SQLITE_BUSY_RECOVERY) in .errcode, so the primary code is the
// low byte: e.errcode & 0xff equal to 5 or 6.
export function isLockError(e: unknown): boolean {
  const errcode = (e as { errcode?: unknown } | null)?.errcode;
  if (typeof errcode !== "number") return false;
  const primary = errcode & 0xff;
  return primary === 5 || primary === 6;
}

// One line naming the file, the wait, and the fix, for query's stderr
// line, rehearse's SNAPSHOT_FAILED diagnostic, and analyze's BUILD_FAILED
// diagnostic. Never names wrangler dev: SQLite cannot report who holds a
// lock.
export function lockMessage(path: string, waitedMs: number): string {
  return `${path} is locked: another connection held it for longer than ${waitedMs}ms. Retry.`;
}
