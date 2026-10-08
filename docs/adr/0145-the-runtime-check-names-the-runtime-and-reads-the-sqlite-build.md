# ADR 0145: The runtime check names the runtime and reads the SQLite build

Status: accepted (2026-10-08). Partially supersedes ADR 0129: the inputs, the order, and the messages of the check change. The Node range and the way to derive it remain.

## Context

ADR 0129 refuses a Node release outside `^24.20.0 || >=26.7.0`.
The range stands in, in part, for a fact that the check can read directly: node:sqlite runs SQLite 3.53.4, the SQLite that the pinned workerd builds.
The other part is Node's own code: ADR 0129 also found a binding that truncates TEXT at an embedded NUL (Node 24.10.0-24.15.0 and 25.6.1) and a module-loader failure on a fresh clone (Node 24.10.0 and 24.11.0).

Two kinds of process got the wrong answer, or the right answer for the wrong reason:

- Bun 1.4.2 sets `process.versions.bun` to `1.4.2` and `process.versions.node` to `26.3.0`, the Node release it imitates. The check refused it with "Node reports 26.3.0". That message named the runtime only by the Node release it imitates, and it left out the SQLite build.
- Node's build configuration can link a system SQLite (`process.config.variables.node_shared_sqlite`, which is `false` in the official 26.7.0 build). A Node release in the range that links an older system SQLite passed the check.

Section 5 of `docs/v5-measurements.md` records what node:sqlite does on Node 26.7.0, 24.20.0, 24.18.0, and 25.6.1, and on Bun 1.4.2, on macOS 26.5.2 (`spike/16-runtime-contract.ts`).
On the binding probes, Bun 1.4.2 gives the results of Node 24.18.0, 24.20.0, and 26.7.0: TEXT with an embedded NUL, an integer beyond the safe range, the adapter's named-parameter binding, a savepoint rollback, and the error codes of a constraint failure and of a trigger's RAISE.
Its SQLite gives different results. The system SQLite 3.51.0 of macOS 26.5.2 returns `[0.3]` for `json_array(0.1 + 0.2)`, where 3.53.4 returns `[0.30000000000000004]`. For an EXISTS query, `Engine.fullScans()` reports a table that it does not report on Node 26.7.0.

## Decision

`runtimeRefusal(versions, sqlite)` in `src/runtime/node-version.ts` takes `process.versions` and the version that node:sqlite reports, or null when the caller could not read one.
It returns an `UnsupportedRuntimeError`, or null.
It applies three rules in this order:

1. A runtime that names itself in `process.versions` (`bun` or `deno`) is refused by name. The message gives the runtime's version, the Node version it reports, and its SQLite version.
2. A Node release outside `NODE_RANGE` is refused. The message gives the Node version and the SQLite version.
3. A node:sqlite that runs a SQLite older than `WORKERD_SQLITE_VERSION`, or that gives no version, is refused. Each component of the version compares as a number. A newer SQLite passes, and the build's existing note reports the difference.

The Node range stays for Node's own code, which a SQLite version does not identify.
Rule 3 is a floor. It refuses an older SQLite, and it does not show that a build of 3.53.4 or later returns what workerd's does; the value probes of `test/miniflare/sqlite-version.test.ts` stay the check of that.

`WORKERD_SQLITE_VERSION` moves from `src/build/facts.ts` to `src/runtime/node-version.ts`.
`node.ts` and the runtime contract cannot import the compiler, and the constant is now the SQLite floor as well.

`node()` reads the SQLite version from a new in-memory connection.
Every DatabaseSync in a process links the same SQLite, and the caller's database can be closed or not yet open.
`node.ts` opens that connection through `process.getBuiltinModule("node:sqlite")` and keeps its type-only import of node:sqlite, so `solarsql/node` still loads on a runtime without node:sqlite, as it did before.
The CLI reads the version through `linkedSqliteVersion()` in `src/build/facts.ts`.
Both readers return null when the read fails, so rule 1 still names the runtime.

The error has the code `UNSUPPORTED_RUNTIME`, and `solarsql/node` exports its class.
The CLI prints the message as one line on stderr.
For `--json`, `inspect`, `rehearse`, and `analyze`, whose failures are JSON reports, the CLI prints a report whose one diagnostic has the code `UNSUPPORTED_RUNTIME` and the same message.
Before this change, the CLI printed the plain line for those commands too.

## Bun

solarsql does not support Bun. Two facts decide it:

- Bun's `process.versions.node` names the Node release that Bun imitates (24.3.0 on Bun 1.3.14, 26.3.0 on Bun 1.4.2), and it says nothing about the node:sqlite that comes with Bun: Bun 1.3.14 does not resolve `node:sqlite`, and Bun 1.4.2 does.
- On macOS 26.5.2, Bun 1.4.2's node:sqlite runs the system SQLite 3.51.0. Two measured results differ from Node 26.7.0, whose node:sqlite runs 3.53.4, the pinned workerd's version: the REAL text through JSON, and the full-scan report of an EXISTS query.

A change that supports Bun needs a CI job that runs the node adapter's tests on Bun with a SQLite at or above `WORKERD_SQLITE_VERSION`, and a new ADR that replaces rule 1 for Bun with a range of Bun releases.

Rule 1 also refuses Deno when `process.versions.deno` is present. The measurements in section 5 cover Node and Bun.

## Consequences

- On Bun 1.4.2 with the SQLite of macOS 26.5.2, `node()` throws, and the CLI prints: `solarsql requires Node ^24.20.0 || >=26.7.0 and node:sqlite on SQLite 3.53.4 or later, the SQLite that workerd runs in the release's tests. This process runs Bun 1.4.2, which reports Node 26.3.0, and its node:sqlite runs SQLite 3.51.0. solarsql does not support Bun; run the command with Node.`
- A Node build in the range that links an older SQLite is now refused.
- A program tells the refusal apart from other errors by `error.code === "UNSUPPORTED_RUNTIME"`, or by `instanceof UnsupportedRuntimeError`.
- When a miniflare bump raises `WORKERD_SQLITE_VERSION`, the SQLite floor rises with it. `docs/releasing.md` names the places to move with it.
- `node()` opens and closes one in-memory connection per call.
