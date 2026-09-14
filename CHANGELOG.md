# Changelog

The format follows Keep a Changelog, and the versions follow SemVer. Before 1.0, a minor version may change the API; the entry says what changed.

## Unreleased

- Fixed: `solarsql migration` runs every check `solarsql build` runs, including the module-boundary check, before it writes a migration file (ADR 0096).
- Fixed: a CHECK column narrows to its literal union when the predicate is `column IN (literal, ...) OR column IS NULL`, the same as `IN (...)` alone (ADR 0097).
- Fixed: a generated union type drops a string or number literal member once the bare `string` or `number` type is already a member of the same union (ADR 0098).
- Fixed: a parameter-validation error names the query or command that rejected the call, and what it declares (ADR 0088).
- Fixed: a trigger body's own closing `END` no longer ends early on a column, or a `new.`/`old.` reference, literally named `end`.
- Fixed: `solarsql build` takes the same lock `solarsql migration` uses before it writes `migrations/index.ts`, so a build racing a migration no longer overwrites the migration's own result with a stale index (ADR 0060).
- Fixed: a colliding migration sequence number names every file that shares it, not only one, and the diagnostic carries a machine-readable `action` field (ADR 0094).
- Fixed: a migration replay error names the failing statement's position within its file, when the file holds more than one statement.
- Fixed: `INDEXED BY` and `NOT INDEXED` no longer shadow a table's own alias, so a parameter compared against that table keeps its narrow inferred type.
- Fixed: a table rebuild now refuses to replay when it does not know about a column the table actually has, instead of silently dropping that column or nulling its data; this can happen when a rebuild is merged behind a sibling migration that added a column after the rebuild was generated (ADR 0099).
- Fixed: a rebuild-refusal error names the migration that most recently (re-)introduced the at-risk column, instead of the first migration that ever did, when the column was dropped and later re-added (ADR 0099).
- Fixed: a table rebuild now refuses to replay when a column it rebuilds has a different declared shape than its generator saw, not only when the column is unknown to it; this can happen when two branches each rebuild the same table for unrelated reasons (ADR 0101).
- Fixed: a write plan item with a computed RETURNING expression (a CAST, a JSON constructor) now fails with "RETURNING clause is discarded at run time", the same refusal a bare RETURNING column already got, instead of a "wrap it in cast(...)" error the expression already satisfies (ADR 0100).
- Fixed: `rehearse` rejects a named or anonymous parameter in a `checks.assertions` entry, instead of silently binding it to `NULL` and letting the assertion's predicate pass regardless of the real data.

## 0.4.0 (2026-09-14)

- Fixed: an assert predicate that evaluates to NULL, or to text SQLite cannot read as a number, now fails as a normal assert (`kind: "assert"`), not a constraint failure naming the internal guard table. The build also refuses a `returns` clause that calls `changes()`, the same as a misplaced `changes()` inside an assert (ADR 0095).

- Fixed: a `CASE ... END` expression inside a trigger body no longer ends the trigger early when a migration file is replayed.

- Added: the build refuses two migration files that share a sequence number before they merge, not only when a new file is generated (ADR 0094).

- Added: the build refuses a foreign key whose target table or column the schema does not declare.

- Added: the build refuses a write plan item (`insert`, `update`, `delete`, or `replace`) with a `RETURNING` clause, which the adapter discards at run time; move the read into the command's `returns` field instead.

- Fixed: a command with an assert deletes the guard table's rows once its plan and `returns` clause finish, so the table returns to zero rows between commands. A command's `rows_written` on D1 now includes this cleanup delete (ADR 0093).

- Fixed: `solarsql build`'s full-scan report no longer names a CTE or a derived table's alias as a scanned table.

- Fixed: a worker CLI command's real result is no longer discarded to a deadline timer that was still armed when the result arrived.

- Fixed: a worker's report message is refused unless it carries the expected protocol and token, closing a gap where another process on the same channel could inject a report.

- Fixed: a migration-intent rename's missing-column error names the case-sensitivity requirement: match the declared DDL spelling exactly, including its case.

- Fixed: a generated migration file is written to a temporary file and linked into place, so a killed write leaves no partial file at the final name.

- Added: `checks.cases` in rehearsal executes named-parameter queries before and after a migration, catching failures that a column check alone misses. A top-level boolean parameter is rejected; SQLite bind values have none.

- Added: `build`, `build --check`, and `migration` run the project configuration import in a worker with a time budget, superseding ADR 0089 for these commands (ADR 0092).

- Added: a migration intent file carries a column rename, so the generator emits `RENAME COLUMN` instead of a drop and an add (ADR 0091).

- Added: automatic migration generation refuses a dropped table or column without an exact migration intent (ADR 0090).

- Added: `inspect` and `build --json` report workers run with a time budget (ADR 0089).

- Added: runtime parameter objects must match each generated operation before SQL executes (ADR 0088).

- Fixed: ambiguous dotted constraint targets remain engine errors instead of naming incorrect schema objects (ADR 0087).

- Fixed: user trigger messages cannot impersonate command assertion failures (ADR 0086).

- Added: CLI help and installed-version discovery without loading application configuration (ADR 0085).

- Fixed: excluded example tests do not start Worker runtimes or prevent process exit (ADR 0084).

- Added: `unique_index` command failures name the violated index; exhaustive constraint switches must handle the new variant (ADR 0083).

- Fixed: constraint classification preserves unknown thrown values instead of replacing them with TypeErrors (ADR 0082).

- Fixed: observer failures cannot replace database results or notify twice after a committed command (ADR 0081).

- Fixed: numeric literals retain hexadecimal prefixes, digit separators, and decimal exponent spellings (ADR 0080).

- Added: DISTINCT and local ORDER BY inside JSON aggregates without SQL rewriting (ADR 0079).

- Fixed: JSON object contracts use the final repeated key and accept comments around literal keys (ADR 0078).

- Fixed: complete CAST expressions retain BLOB types, SQL comments, and conservative nullability (ADR 0077).

- Fixed: JSON decoding and result types follow complete expressions instead of nested function calls (ADR 0076).

- Added: BLOB literal types through query scopes without SQL rewriting (ADR 0075).

- Fixed: JSON constructors expose decoded JSONB and flexible storage as `JsonValue` instead of binary values (ADR 0074).

- Fixed: focused D1 tests start runtimes only when used and exit after their selected work (ADR 0073).

- Added: Node commands compose with caller-owned transactions through savepoints (ADR 0072).

- Fixed: distinct SQLite named parameters retain their slots and types; ambiguous bare names use prefixed caller keys (ADR 0071).

- Fixed: rebuilds retain AUTOINCREMENT history, including deleted maxima and empty tables (ADR 0070).

- Fixed: schema analysis and migrations retain legal names such as `sqliteCache` (ADR 0069).

- Fixed: table rebuilds preserve accessible row identifiers and refuse ambiguous alias changes (ADR 0068).

- Added: native row-identifier types with SQLite output names, shadowing, and join nullability (ADR 0067).

- Added: `analyze --database` derives query contracts from a consistent read-only SQLite view and protects source aliases and companion files (ADR 0066).

- Added: rehearsal CLI deadlines with `--timeout-ms`, structured timeout diagnostics, and parent-owned snapshot cleanup (ADR 0065).

- Fixed: type and migration facts use SQLite table attributes, so DDL comments cannot enable STRICT or WITHOUT ROWID (ADR 0064).

- Added: a bounded backup lifecycle experiment with phase timings and snapshot identity checks (ADR 0063).

- Fixed: machine build reports retain valid JSON when application imports write logs, throw, or exit early (ADR 0062).

- Fixed: CHECK-derived types respect stored value classes, complete predicates, collations, and literal whitespace (ADR 0061).

- Fixed: migration generation appends after sequence gaps, refuses ambiguous replay order, and preserves existing files during competing generation (ADR 0060).

- Added: `analyze` generates types and metadata from schema DDL and a JSON query catalog, without module imports or identity rules (ADR 0058).
- Added: `inspect` and `build --json` expose operation contracts, accesses, freshness, and structured diagnostics (ADR 0055).
- Added: `rehearse` checks a populated SQLite snapshot with integrity checks, old queries, and data assertions (ADRs 0057 and 0059).
- Changed: Node and Durable Object migration history records exact SQL and rejects changed, missing, duplicate, or out-of-order files. Legacy history requires explicit adoption (ADR 0056).
- Fixed: integer and BLOB primary keys retain their scalar types; identity brands require text storage (ADR 0053).
- Fixed: adapters normalize BLOB results to `Uint8Array`, including D1 byte arrays, before JSON decoding (ADR 0054).

- Added: parameters inherit CTE, view, and derived-table column types. Nested references use their local scope (ADR 0052).
- Added: VALUES rows and recursive seeds use generated result types without changes to runtime SQL (ADR 0050).
- Fixed: parameter aliases resolve within their SELECT scopes and compound branches (ADR 0051).
- Added: recursive CTE inference with a SELECT seed and stable UNION result types (ADR 0049).
- Fixed: parent rebuilds with incoming ON DELETE actions now block automatic migration generation, preventing cascading child-row loss (ADR 0046).
- Changed: queries and `returns` require SELECT or VALUES; each plan item contains one SELECT, VALUES, or DML statement. Transaction control and schema statements are refused (ADR 0045).
- Added: query scope inference for CTEs, views, derived tables, compound SELECTs, RIGHT JOIN, and FULL JOIN. SQL text stays unchanged (ADR 0048).
- Fixed: JSON aggregate filters narrow only the outer alias they prove present; other aliases retain nullability.
- Fixed: result types follow source scopes and join nullability. Scalar subqueries allow null; non-null CTE and view outputs retain their precision. Wildcards expand before later expressions. Duplicate output names are refused.
- Changed: `solarsql build` exits 0 after valid generation even when a migration is pending or blocked, and reports the required action. Use `build --check` for CI and release gates; it still fails for stale files and pending or blocked migrations (ADR 0043).
- Added: statement errors identify `module.ts`, the exported catalog and entry, and the command plan position, assert name, or `returns`. Shared SQL reports all its locations (ADR 0044).
- Fixed: recovery commands preserve a custom configuration path.
- Docs: the verification workflow includes generation, migration, `build --check`, the TypeScript check, and project tests. DDL edits with unchanged SQL require the build check to detect stale types.

## 0.3.0 (2026-09-11)

- Added: `changes` in the result of `db.run`: `{ ok: true; rows; changes }`, the rows the plan's statements inserted, updated, or deleted, their triggers' rows included, as D1's `meta.changes` counts them; an assert and `returns` add nothing (ADR 0042). The deployed example Worker reports it after a redeploy.
- Added: `solarsql build` prints a `reads` line per query of a module with `readsAll`, with the tables the query reads, and the time each module took to import and to type; a `time` line gives the whole build.
- Docs: the cast rule in one line before the column table, with the JSON shapes as the exception; `Row` and `Params` outside the module; one migration file for a project where every database starts empty; `build --check` as a publish gate.

## 0.2.0 (2026-09-10)

- Added: `reads` in the generated meta of every statement: the tables of the schema it reads, sorted, once each, reached directly, through a view, through a trigger, or by a foreign key check (ADR 0041). `query.meta.reads` and `command.meta.statements[i].reads` carry it. The generated file gains a field, so a project that upgrades runs `npx solarsql build`; `tsc` names the generated file until then.
- Fixed: `solarsql build` on a fresh clone wrote the stub of a generated file one module at a time, after importing the configuration file. A module with a value import of a module listed after it, and a configuration file that imports a module through its `public.ts`, failed with `ERR_MODULE_NOT_FOUND`. The build now writes every stub before it imports a module, and writes the stub a configuration import asks for (ADR 0040).
- Docs: the never-null row of the column table in `queries.md` shows the cast around each shape; a bare `coalesce(x, 0)` was never accepted.

## 0.1.0 (2026-09-10)

The first release.

- A module owns its tables and shows other modules one `public.ts`; `module.ts` holds the schema, the queries, and the commands as SQL strings.
- `solarsql build` asks the real engine (node:sqlite) for the types of every statement and writes `solarsql.generated.ts`, keyed by the SQL text; `build --check` for CI.
- Schema: `table()` (STRICT, a primary key), `index()`, `view()`, `trigger()`, `search()` (FTS5); a CHECK list becomes a union type; a generated column reads like any other.
- Queries: named parameters typed from where they sit; JSON aggregations and nested arrays as typed values; lists and rows through one `json_each` parameter; casts with a never-null rule for counts, ranks, `exists`, and `coalesce`.
- Commands: a plan of statements and asserts as one D1 batch or one Durable Object transaction; `returns`; a failed assert and a rejected row as values with one `kind`.
- Boundary: a statement, a view, a trigger body, or an import that reaches into another module is refused at build time; `readsAll` for a report module.
- Adapters: `solarsql/d1`, `solarsql/durable`, `solarsql/node`; `all`, `first`, `run`, `batch`; an observe hook with D1's `meta`.
- Ids: `newId()` makes a UUID v7; the primary key of each table is a branded string.
- Migrations: `solarsql migration <name>` writes the difference as a wrangler file (add column, rebuild under foreign keys, views, triggers, search tables) and `migrations/index.ts` for a Durable Object.
- `solarsql init <module>` starts a project: the configuration, one module, a test on node:sqlite, the first build, the first migration.
- The usage documentation is a skill, `skills/solarsql/SKILL.md` with references, shipped in the package.
