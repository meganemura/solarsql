# Design records

This directory holds the design decisions of solarsql as Architecture Decision Records (ADRs).
Read the ADRs before you change the shape of the library.

Each ADR has one decision.
A new decision gets a new ADR.
A change to a decision gets a new ADR that supersedes the old one.

## Index

| ADR | Decision |
|---|---|
| [0001](adr/0001-typescript-from-scratch.md) | Build in TypeScript from scratch, with no compatibility with existing ORMs |
| [0002](adr/0002-reader-priority.md) | The first reader is a coding agent, the second is a human |
| [0003](adr/0003-sqlite-first.md) | SQLite is the first engine, D1 and Durable Objects are the first targets |
| [0004](adr/0004-ddl-and-sql-in-tagged-templates.md) | Schema and queries are SQL in tagged templates |
| [0005](adr/0005-query-catalog.md) | Queries live in a named catalog |
| [0006](adr/0006-commands-are-plans.md) | A command is a verb on a noun, and its body is a plan |
| [0007](adr/0007-rows-are-plain-values.md) | Rows are plain values with a one-way dependency |
| [0008](adr/0008-module-owns-tables.md) | A module owns its tables and shows one public file |
| [0009](adr/0009-boundary-by-static-check.md) | Module boundaries are enforced by static checks |
| [0010](adr/0010-types-from-the-engine.md) | Types come from the real engine, keyed by the SQL text |
| [0011](adr/0011-one-to-many-as-json.md) | One-to-many reads are JSON aggregation in the SQL |
| [0012](adr/0012-constraints-in-ddl.md) | Single-row constraints live in DDL, multi-row rules in asserts |
| [0013](adr/0013-migrations-from-declared-ddl.md) | Migrations are generated from the declared DDL |
| [0014](adr/0014-verification-loop.md) | The inner loop is synchronous and in-process |
| [0015](adr/0015-assert-is-a-guard-row.md) | An assert is a row in a guard table with one trigger |
| [0016](adr/0016-ids-are-uuid-v7.md) | Ids are UUID v7 strings made on the client |
| [0017](adr/0017-expression-columns-carry-a-cast.md) | An expression column carries a CAST |
| [0018](adr/0018-primary-keys-are-not-null.md) | A primary key column is NOT NULL |
| [0019](adr/0019-table-rebuild-order.md) | A table rebuild copies rows through a side table |
| [0020](adr/0020-no-sql-parser.md) | No SQL parser: a scanner and engine probes |
| [0021](adr/0021-sql-is-a-string-literal.md) | SQL is a plain string literal (supersedes the template form of 0004) |
| [0022](adr/0022-named-parameters-bound-by-position.md) | Named parameters, bound by position |
| [0023](adr/0023-command-result-is-a-value.md) | A command result is a value, and an assert failure is one of its cases |
| [0024](adr/0024-package-ships-source-and-dist.md) | The package ships the source and the compiled output |
| [0025](adr/0025-generated-file-per-module.md) | One generated file per module, committed |
| [0026](adr/0026-migration-on-demand.md) | The build checks migrations, a separate command writes one |
| [0027](adr/0027-boundary-scope.md) | What the boundary check sees |
| [0028](adr/0028-dynamic-sql-is-static-sql.md) | Dynamic SQL is static SQL with typed parameters |
| [0029](adr/0029-tables-are-strict.md) | Tables are STRICT, so stored values match the generated types |
| [0030](adr/0030-program-model-stays-with-the-caller.md) | The program model stays with the caller, and failures are values |
| [0031](adr/0031-some-casts-are-not-null.md) | A CAST over a shape that is never null is not null |
| [0032](adr/0032-node-sqlite-adapter.md) | A node:sqlite adapter for tests and scripts |
| [0033](adr/0033-one-source-file-per-module.md) | A module is three files: its source, its public file, and its generated file |
| [0034](adr/0034-search-is-an-fts5-table.md) | Full-text search is an FTS5 table declared with search() |
| [0035](adr/0035-several-reads-in-one-round-trip.md) | Several reads go in one D1 round trip through db.batch |
| [0036](adr/0036-the-example-deploys-with-wrangler.md) | The example deploys with wrangler, and a remote test runs its steps |
| [0037](adr/0037-init-writes-the-first-module.md) | init writes the first module and runs the first build |
| [0038](adr/0038-the-skill-is-the-usage-documentation.md) | The skill is the usage documentation, and the README is the door |

## Measurements

[v0-measurements.md](v0-measurements.md), [v1-measurements.md](v1-measurements.md), and [v2-measurements.md](v2-measurements.md) record the experiments that the ADRs cite.
[v3-measurements.md](v3-measurements.md) records the experiments of v3, which measure the premise of the library against Drizzle with fresh agents.
Each entry has the command, the output, and the conclusion.
