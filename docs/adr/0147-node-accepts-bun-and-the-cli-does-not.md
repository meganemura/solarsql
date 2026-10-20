# ADR 0147: node() accepts Bun 1.4.3 or later, and the CLI does not

Status: accepted (2026-10-20). Replaces rule 1 of ADR 0145 for Bun in `node()`. The CLI keeps rule 1 for Bun, and both keep it for Deno.

## Context

ADR 0145 refuses Bun by name. It names what a change that supports Bun needs: a CI job that runs the node adapter's tests on Bun with a SQLite at or above `WORKERD_SQLITE_VERSION`, and a new ADR that replaces rule 1 for Bun with a range of Bun releases.

A consumer that runs on Bun asked for `node()` only, the adapter its own code calls. It does not run the build CLI on Bun.

Measured on 2026-10-20 on Linux x86_64 (Ubuntu 24.04.5), on a copy of this repository whose check was turned off by an environment variable:

- Bun 1.4.3's node:sqlite runs SQLite 3.53.4, with the same source id as Node 24.20.0's (`2026-07-24 19:02:57 bf7c7f30…`). Bun 1.4.2's runs 3.53.2.
- `spike/16-runtime-contract.ts` gives Node's results on every probe on Bun 1.4.3: TEXT with an embedded NUL, an integer beyond the safe range, the named-parameter binding, a savepoint rollback, the error codes of a constraint failure and of a trigger's RAISE, the REAL text through JSON, and the full-scan report of an EXISTS query.
- The unit suite on Bun 1.4.3 (`bun --bun vitest run --project unit`) fails 23 tests that pass on Node. None is in `test/node.test.ts`. 20 are in the build and the CLI: the build re-imports a module file after a test rewrites it, and Bun resolves the old file or none; tests that stub `fs` functions; and the CLI's worker IPC. One is a cleanup diagnostic of `rehearse` that a stubbed `rm` produces. Two fail with `database is locked`, in `query` and `analyze`.

The two lock failures come from Bun, not from the CLI. On Bun 1.4.3 and 1.4.2, `DatabaseSync.close()` on a connection that prepared a statement returns, and later statements on it report `statement has been finalized`, but the file stays open and keeps its lock until the garbage collector runs. Another connection in the same process then cannot change the journal mode of a WAL database. A connection that only opened, or only ran `exec()`, releases the lock on close. Node releases it on close in every case. node:sqlite has no call that finalizes a statement, so the adapter cannot release it earlier.

## Decision

`runtimeRefusal(versions, sqlite, caller)` takes the caller, `"node()"` or `"cli"`.

For `"node()"`, a process whose `process.versions` names Bun is checked against Bun's own range, not the Node version it reports:

1. A Bun release below `BUN_RANGE` (`>=1.4.3`), or one whose version does not parse, is refused. The message gives the Bun version, the Node version it reports, and its SQLite version.
2. A Bun release in the range whose node:sqlite runs a SQLite older than `WORKERD_SQLITE_VERSION`, or gives no version, is refused, as rule 3 of ADR 0145 refuses Node.

The floor is 1.4.3 because it is the first Bun release whose node:sqlite runs 3.53.4 on Linux, and it is the release the Bun CI job runs. The range is open upward, as the Node range is (ADR 0129).

For `"cli"`, Bun is refused by name as before. The message now says that the solarsql CLI does not support Bun, because `node()` does. The build depends on Node's module loader, which the module re-import failures above show.

Deno is refused by name for both callers. For a process that names neither, both callers give the same verdict and message.

The `bun` job in `.github/workflows/ci.yml` runs `npm run test:bun` on ubuntu with Bun 1.4.3: `test/node.test.ts`, the adapter's tests, and `test/bun.test.ts`, which shows that `node()` accepts the process and runs a command, and that the CLI refuses it. The test that replaces `process.versions.node` is skipped on Bun, because Bun's verdict does not read that version. The test that defines `process.versions.bun` puts back the real key afterwards.

## Rejected alternatives

- Accept Bun for the CLI as well. 20 build and CLI tests fail on Bun, and the module re-import failures are in how the build loads a project.
- Keep refusing Bun. The adapter's tests pass on Bun 1.4.3, and the one difference found in database behavior is the lock after close, which a caller can plan for.
- Accept any Bun release whose SQLite reaches the floor, with no Bun range. Bun releases before 1.4.3 were not run against the adapter's tests, and Bun 1.3.14 has no node:sqlite.
- Call the garbage collector in the adapter after a caller closes its database. The adapter does not see the close, and a forced collection costs every caller.

## Consequences

- On Bun 1.4.3 or later with SQLite 3.53.4 or later, `node()` returns an adapter. On an earlier Bun, it throws `UnsupportedRuntimeError`.
- On Bun, a database file that `node()` used stays open after the caller's `close()` until the garbage collector runs. A caller that changes the journal mode of the file, or deletes the file on Windows, after closing it, runs that step in a new process, or on Node.
- Only Linux is measured. On macOS 26.5.2, Bun 1.4.2's node:sqlite runs the system SQLite 3.51.0 (ADR 0145). A Bun release that does the same is refused by rule 2.
- When `WORKERD_SQLITE_VERSION` rises, the first Bun release whose node:sqlite reports the new version becomes the floor, with the Node floors. `docs/releasing.md` lists it.
