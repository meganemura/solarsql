# ADR 0129: The Node floor tracks the workerd SQLite version

Status: accepted (2026-09-25).

## Context

`package.json` declared `engines.node` as `>=24.10.0`, a floor set for one API (`DatabaseSync.setAuthorizer()`), and nothing in `src/` checked it: npm treats `engines` as a warning, and CI's `node-version: "24"` and `"26"` resolve to each line's newest release, so the declared floor never ran.

ADR 0014 rests on "the fast engine is the same engine": `node()` (`test/node.test.ts:1-3`) promises that a query behaves on `node:sqlite` as it does on D1 and a Durable Object, because both paths use the same SQLite. That promise holds only when `node:sqlite`'s bundled SQLite version matches the SQLite that the release's Miniflare pin builds for D1 and a Durable Object. Measured on 2026-09-25 against official darwin-arm64 Node builds (solarsql 0.6.0), the pinned workerd 1.20260828.1 builds SQLite 3.53.4, and Miniflare D1 and a Miniflare Durable Object both report 3.53.4. `node:sqlite`'s reported SQLite version, by Node release:

| Node release | SQLite |
| --- | --- |
| 24.10.0-24.13.0 | 3.50.4 |
| 24.13.1-24.14.0 | 3.51.2 |
| 24.15.0 | 3.51.3 |
| 24.16.0-24.17.0 | 3.53.0 |
| 24.18.0 | 3.53.1 |
| 24.19.0 | 3.53.3 |
| 24.20.0-24.21.0 | 3.53.4 |
| 25.6.1 | 3.51.2 |
| 26.7.0 | 3.53.4 |

Below the SQLite-3.53.4 releases, four failures were measured. (1) `node:sqlite` returns TEXT truncated at an embedded NUL on 24.10.0-24.15.0 and 25.6.1, though the stored bytes are intact; `solarsql query` prints the truncated value. (2) A fresh clone's `solarsql build`, importing another module's `public.ts`, fails with `ERR_MODULE_NOT_FOUND` on 24.10.0 and 24.11.0. (3) SQLite 3.51.x rewrites `EXISTS` into a join, so `Engine.fullScans()` reports fewer scans than 3.53.4 does, on 24.13.1, 24.15.0 and 25.6.1. (4) `json_array(0.1+0.2)` reads `'[0.3]'` on SQLite 3.50.4 through 3.53.1 and `'[0.30000000000000004]'` on 3.53.3 and later, on D1, and on a Durable Object; a value that round-trips through `node()` and JSON can read back rounded on the older builds. `npm test` passes on 24.16.0, 24.20.0, 24.21.0 and 26.7.0; the REAL-through-JSON drift (4) is the only measured reason to exclude 24.16-24.19, since the suite does not catch it there.

## Decision

`engines.node` is `"^24.20.0 || >=26.7.0"`: the lowest release on each supported line whose `node:sqlite` reports SQLite 3.53.4, the version the pinned workerd builds. It excludes Node 25 (3.51.2) on purpose.

The range is a floor, open upward. A later Node release can ship a newer SQLite than the pinned workerd builds; a separate, already-planned build note is to report that `node:sqlite`/workerd SQLite mismatch, and this ADR does not close that gap.

A change that bumps the workerd or Miniflare pin re-derives the floor from Node's `CHANGELOG_V24.md`/`CHANGELOG_V26.md` (which SQLite version each release's `node:sqlite` reports) and raises `engines.node` in the same change, with the measurements that justify it.

`src/runtime/node-version.ts` exports a pure function, `nodeVersionError(version: string): string | null`, that carries this exact range and refuses with a message naming the running version, the range, and the reason. `src/build/cli.ts` calls it before every command except `--help`, `-h`, `help`, `--version` and `-v`, which keep answering without a project even when no `solarsql.config.ts` exists. `src/node.ts`'s `node()` calls it at construction, so `solarsql query` and any script that builds a `Database` through `node()` are covered without a second check.

## Consequences

- `npm install` on an excluded Node version still only warns (npm's own behavior); `solarsql build`, `solarsql query`, and any script that calls `node()` now refuse with a one-line message instead of running on an SQLite build ADR 0014's promise does not cover.
- CI runs the tests, the typecheck, and the example's `build --check` on Node 24 and 26 (each line's newest release) and, on ubuntu only, on the floor itself (24.20.0 and 26.7.0), so a regression at the floor is caught even though "24" and "26" resolve upward.
- Node 24.10.0-24.19.0, all of Node 25, and Node 26.0.0-26.6.0 no longer install cleanly; `README.md`, `docs/releasing.md`, and `publish.yml`'s release-gate step name the new floor.
