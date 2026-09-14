# ADR 0096: `migration` runs every `build` check before it writes a file

Status: accepted (2026-09-14)

## Context

`solarsql migration <name>` loads the project configuration and diffs the declared schema against the migration files already applied. It never ran `checkImports`, `checkBoundary`, the STRICT/primary-key/foreign-key checks, or `checkCommands`, the checks `build` runs. Those checks exist only inside `build`.

A coding agent that follows the documented one-line workflow, `solarsql migration <name>`, gets a clean exit and a written file even when a command plan writes another module's table, or a table fails a STRICT, primary-key, or foreign-key rule, or a plan item breaks one of `build`'s command-plan rules. The violation only surfaces later, if a separate `build --check` step runs before commit or deploy.

## Decision

`migration` loads the configuration once and runs `build`'s checks on that one load (`write: false`) before it touches the migrations directory. `build` splits into `load`, unchanged, and the rest of its body, factored into a function that takes an already-loaded configuration; `build` itself calls `load` then that function, and `migration` calls `load` then that same function, passing `write: false`. `write: false` is the same mode `build --check` already uses: every check `build` runs, and no generated file is written. A project `build` would refuse now refuses inside `migration` too, with the same `BuildError` and the same location.

## Why

`build`'s checks are one interleaved pass across module ownership, STRICT/primary-key/foreign-key rules, view and trigger boundaries, per-statement typing and boundary checks, and command-plan rules; the module boundary is only one of them. A narrower, module-boundary-only check function would still miss the others, and would drift from `build`'s own checks the next time one of them changes, since nothing would keep two copies in step. Calling `build` wholesale reuses the exact same code, so `migration` can never accept what `build` would refuse.

## Consequences

- `migration` now refuses for any reason `build` would refuse, not only a module-boundary violation: a table that is not STRICT, a table with no primary key, a foreign key with no matching target, a plan item whose `RETURNING` clause the run time would discard, a misplaced `changes()`, and so on. This is a contract change to a documented command: `migration` could previously write a file, or report nothing to migrate, for a project `build` itself would already refuse.
- The configuration is imported once. The migration history is replayed twice inside `migration` (once inside the checks, once by `migration`'s own diff against the supplied intent); both replays run against an in-memory SQLite database and are cheap. A second full import was considered and rejected: a project's configuration can carry import-time side effects (a module-level listener, a global patched for a test harness), and a second import would run every one of those a second time, in the same process, for every `migration` invocation.
- No new check is added. The fix reuses `build`'s own checks unchanged, on the same loaded configuration `migration` already needed.
