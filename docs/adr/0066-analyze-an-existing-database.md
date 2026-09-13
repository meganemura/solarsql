# ADR 0066: Analyze an existing database without copying its DDL

Status: accepted (2026-09-13)

## Context

An agent adding one typed query should not need to reproduce an application's schema in another file.
The source database already provides table attributes, indexes, views, virtual tables, and column origins.
A changing WAL database requires one consistent view across those metadata reads.

## Decision

Add `solarsql analyze --database app.sqlite queries.json` alongside the DDL input mode.
Open the canonical source path with a read-only SQLite connection.
Start a read transaction and read the schema before deriving query contracts.
Every later metadata probe uses that schema view, including connection-local temporary affinity probes.
Close the connection after success or failure.

The JSON report identifies the canonical source path, schema version, and a SHA-256 hash of the observed schema records.
The generated TypeScript preserves the original SQL and contains no source-machine path.
Existing indexes and virtual tables remain available to the engine without a DDL reconstruction step.
Non-STRICT columns retain SqlValue, while STRICT columns retain scalar types.

Before writing generated output, reject paths that name an input or a SQLite WAL, shared-memory, or rollback-journal companion.
Follow symbolic links, including dangling output links, and compare file identities to reject hard-link aliases.
The DDL mode retains its existing contract and uses the same output protection.

## Evidence

Tests analyze a populated WAL database with an index, view, trigger, virtual table, and non-STRICT table.
A generated caller compiles and runs through the Node adapter alongside direct SQL on the same database.
A writer commits a schema change after the reader's first schema read; the analysis retains its original view.
Hegel varies stored values while checking that analysis preserves both source bytes and row values.
CLI tests reject source aliases and companion outputs, then detect stale types after a schema change.

## Boundary

The report describes the source view observed during this invocation.
It does not establish later production freshness or Cloudflare compatibility.
Extensions unavailable to the local SQLite engine can still prevent analysis.
