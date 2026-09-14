# ADR 0094: A shared migration sequence number is a build-time error, not a runtime tolerance

Status: accepted (2026-09-14)

## Context

Two branches can each generate the next migration file independently and land on the same sequence number, for example two files both named `0005_*.sql`.
`migrationSequence()` (`src/build/migration-files.ts`) already refuses that, but only inside `migration()`, when a new file is generated.
`build` and `build --check` never called it, so the same colliding pair passed both checks silently.
At run time, `migrate()` (`src/durable.ts`) replays migration files in name order.
A database that already applied one of the two colliding files before the other existed throws `MIGRATION_ORDER` on the merged history; a database that applied them in the other order accepts it without complaint.
The same `migrations/` directory therefore succeeds or fails at deploy time depending on which branch reached a given database first.

## Decision

`build` and `build --check` now call `migrationSequence()` over the migration directory, the same check `migration()` already runs.
A shared or out-of-order sequence number is a build error before merge, not only a failure discovered when generating the next file.

`migrate()`'s `MIGRATION_ORDER` check is not relaxed.
Two files that share a sequence number still differ in file name, and a database that already applied one of them before the other existed passed through a different intermediate schema than a database that applied them in the other order, even when neither file's own content ever changed.
Treating both orders as equivalent would let two databases that ran the same migration files in a different order both call themselves in sync.

## Why

Catching the collision at build time removes the need to tolerate it at run time: once `build --check` refuses a shared sequence number, no new collision reaches a deployment.
Loosening `migrate()`'s ordering check would only help a database that already deployed one branch's colliding file before this decision shipped, and it would do so by weakening the one guarantee `migrate()` exists to keep: that the history on disk is the history a given database actually replayed.

## Consequences

- A project with two applied, colliding files already in production before this decision ships still cannot rename either of them; `migrate()`'s `MIGRATION_CHANGED` and `MISSING_MIGRATION` checks continue to refuse that. Its repair is a new migration file that reconciles the schema to a single, agreed state, applied and recorded like any other migration.
- `migrationSequence()`'s own error message states this repair path directly, instead of only suggesting a rename that `migrate()` would refuse once either file is applied.
- `applied()` (`src/build/migration.ts`), used by `migrationStatus` for both `build` and `build --check`, now names the specific migration file a replay failure came from, matching the location-wrapped errors `build.ts` raises everywhere else.
