# Design records

How a version is released: [releasing.md](releasing.md).

This directory holds the design decisions of solarsql as Architecture Decision Records (ADRs).
Read the ADRs before you change the shape of the library.

Each ADR has one decision.
A new decision gets a new ADR.
A change to a decision gets a new ADR that supersedes the old one.

## Index

| ADR | Decision |
|---|---|
| [0001](adr/0001-typescript-from-scratch.md) | Build in TypeScript from scratch |
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
| [0039](adr/0039-observe-carries-the-engine-meta.md) | The observe hook carries D1's meta |
| [0040](adr/0040-the-build-writes-the-stub-an-import-asks-for.md) | The build writes the stub an import asks for, so a fresh clone builds in any module order and a configuration file may import a module |
| [0041](adr/0041-the-generated-meta-names-the-tables-a-statement-reads.md) | The generated meta names the tables a statement reads, for a caller that routes or invalidates by table |
| [0042](adr/0042-the-command-result-counts-the-rows-it-changed.md) | The command result counts the rows it changed |
| [0043](adr/0043-build-generates-and-check-verifies.md) | Build generates; check verifies generated files and migrations (supersedes the build exit behavior of 0026) |
| [0044](adr/0044-build-errors-name-the-statement-location.md) | Statement errors name the source file, catalog entry, and command position |
| [0045](adr/0045-statement-roles-are-build-contracts.md) | Statement roles and one statement per item are build contracts |
| [0046](adr/0046-rebuilds-check-foreign-key-delete-actions.md) | Automatic rebuilds check incoming foreign-key delete actions |
| [0047](adr/0047-reject-unproven-result-types.md) | Reject unproven compound and outer-join types; narrow JSON nullability only with evidence |
| [0048](adr/0048-result-types-follow-query-scopes.md) | Infer result types through query scopes, joins, and compound branches |
| [0049](adr/0049-recursive-query-types-reach-a-fixed-point.md) | Recursive CTE result types must reach a fixed point |
| [0050](adr/0050-values-rows-use-expression-inference.md) | Infer VALUES rows and recursive seeds without changing runtime SQL |
| [0051](adr/0051-parameter-sites-retain-their-scope.md) | Resolve parameter aliases at each source position |
| [0052](adr/0052-parameters-use-query-source-types.md) | Share query source types with parameter inference |
| [0053](adr/0053-identity-brands-require-text-storage.md) | Identity brands require text storage |
| [0054](adr/0054-adapters-normalize-blob-results.md) | Adapters normalize BLOB results |
| [0055](adr/0055-inspection-exposes-operation-contracts.md) | Inspection exposes operation contracts |
| [0056](adr/0056-migration-history-records-sql.md) | Migration history records SQL |
| [0057](adr/0057-rehearse-on-a-database-snapshot.md) | Rehearse transitions on a database snapshot |
| [0058](adr/0058-analyze-schema-without-module-policy.md) | Analyze a schema without module policy |
| [0059](adr/0059-verify-the-sql-change-workflow.md) | Verify the SQL change workflow |
| [0060](adr/0060-migration-generation-preserves-history.md) | Migration generation preserves history |
| [0061](adr/0061-check-types-follow-stored-values.md) | CHECK types follow stored values |
| [0062](adr/0062-machine-reports-use-a-separate-channel.md) | Machine reports use a separate channel |
| [0063](adr/0063-measure-the-backup-lifecycle.md) | Measure the backup lifecycle before changing it |
| [0064](adr/0064-table-attributes-come-from-sqlite.md) | Table attributes come from SQLite |
| [0065](adr/0065-rehearsal-cli-owns-a-time-budget.md) | The rehearsal CLI owns a time budget |
| [0066](adr/0066-analyze-an-existing-database.md) | Analyze an existing database without copying its DDL |
| [0067](adr/0067-row-identifiers-follow-sqlite.md) | Row identifiers follow SQLite name resolution |
| [0068](adr/0068-rebuilds-preserve-row-identifiers.md) | Rebuilds preserve accessible row identifiers |
| [0069](adr/0069-use-the-literal-sqlite-reserved-prefix.md) | Use the literal SQLite reserved prefix |
| [0070](adr/0070-rebuilds-retain-autoincrement-history.md) | Rebuilds retain AUTOINCREMENT history |
| [0071](adr/0071-preserve-sqlite-parameter-slots.md) | Preserve SQLite named-parameter slots |
| [0072](adr/0072-node-commands-use-savepoints.md) | Node commands use savepoints |
| [0073](adr/0073-tests-own-runtimes-on-first-use.md) | Tests own runtimes on first use |
| [0074](adr/0074-json-values-follow-decoded-output.md) | JSON values follow decoded output |
| [0075](adr/0075-blob-literals-keep-their-sqlite-type.md) | BLOB literals keep their SQLite type |
| [0076](adr/0076-json-decoding-follows-the-whole-expression.md) | JSON decoding follows the whole expression |
| [0077](adr/0077-casts-follow-complete-sql-expressions.md) | Casts follow complete SQL expressions |
| [0078](adr/0078-json-object-types-follow-decoded-keys.md) | JSON object types follow decoded keys |
| [0079](adr/0079-json-aggregate-types-retain-sql-ordering.md) | JSON aggregate types retain SQL ordering |
| [0080](adr/0080-numeric-tokens-retain-sqlite-spellings.md) | Numeric tokens retain SQLite spellings |
| [0081](adr/0081-observation-cannot-change-database-outcomes.md) | Observation cannot change database outcomes |
| [0082](adr/0082-unknown-errors-retain-their-identity.md) | Unknown errors retain their identity |
| [0083](adr/0083-unique-index-failures-name-the-index.md) | Unique index failures name the index |
| [0084](adr/0084-example-suites-own-selected-runtimes.md) | Example suites own selected runtimes |
| [0085](adr/0085-cli-discovery-precedes-project-loading.md) | CLI discovery precedes project loading |
| [0086](adr/0086-assert-results-have-invocation-identities.md) | Assert results have invocation identities |
| [0087](adr/0087-ambiguous-constraint-targets-remain-errors.md) | Ambiguous constraint targets remain errors |
| [0088](adr/0088-runtime-parameters-match-the-operation-contract.md) | Runtime parameters match the operation contract |
| [0089](adr/0089-machine-cli-has-a-time-budget.md) | Machine CLI reports have a time budget |
| [0090](adr/0090-automatic-destructive-migrations-need-intent.md) | Automatic destructive migrations need an exact intent |
| [0091](adr/0091-column-renames-use-the-migration-intent.md) | Column renames use the migration intent |
| [0092](adr/0092-project-cli-has-a-time-budget.md) | Project-loading CLI commands have a time budget |
| [0093](adr/0093-assert-rows-are-deleted-at-the-end-of-the-plan.md) | Assert rows are deleted at the end of the plan |
| [0094](adr/0094-a-shared-migration-sequence-is-a-build-time-error.md) | A shared migration sequence is a build-time error |
| [0095](adr/0095-an-assert-predicate-normalizes-to-0-or-1-at-run-time.md) | An assert predicate normalizes to 0 or 1 at run time |

## Measurements

[v0-measurements.md](v0-measurements.md), [v1-measurements.md](v1-measurements.md), and [v2-measurements.md](v2-measurements.md) record the experiments that the ADRs cite.
Each entry has the command, the output, and the conclusion.
