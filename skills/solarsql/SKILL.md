---
name: solarsql
description: Use when a project uses solarsql, the typed SQL layer for SQLite on Cloudflare D1 and Durable Objects. Covers writing or changing a module.ts (tables, indexes, views, triggers, FTS5 search tables, queries, commands), the type a parameter or a column gets, the tables a query reads, a build message and its fix, a migration, a module's test on node:sqlite, wiring an adapter in a Worker, and deploying the example. Also use when the user names solarsql, `solarsql build`, `solarsql migration`, `solarsql init`, `solarsql.generated.ts`, a plan, an assert, or a platform limit.
---

# solarsql

For an existing schema and a SQL catalog, start with [schema-only analysis](references/analyze.md).
It generates query types without module ownership or identity rules.
The module workflow below adds those policies when you want them.
For a complete example, follow [SQL growth, repair, and rehearsal](references/sql-workflow.md).

A module owns its tables and shows other modules one `public.ts`.
The schema is SQLite DDL in string literals.
Queries are SQL in string literals with `:name` parameters, listed in a catalog.
A command is a plan: statements and asserts that run as one D1 batch or one Durable Object transaction, and a failure comes back as a value.
Rows are plain values.
Types come from the real engine at build time, keyed by the SQL text.
Verify generated types with the [build workflow](references/build.md#verification-after-an-edit).

The files of a module: `module.ts` (schema, queries, commands), `public.ts` (what other modules may import), `solarsql.generated.ts` (written by the build, committed).
The migration files are `migrations/NNNN_<name>.sql` and `migrations/index.ts`.

## Workflow

Run the command the last line names. Open a reference when a message names one, or when the rule you need is not in this file.

1. **Start a project**: `npx solarsql init <module>`. What it writes and what it refuses: [references/build.md](references/build.md).
2. **Change the schema**: edit `table()`, `index()`, `view()`, `trigger()`, or `search()` in `module.ts`, then follow the [build and migration workflow](references/build.md#verification-after-an-edit). Rules and types of the DDL: [references/schema.md](references/schema.md). The build prints every failing statement with its `at:` line, and the columns of the table on `no such column`. Fix them from the message. After a DDL edit, run `npx solarsql build` before you search. It lists every trigger, view, and search table that still uses the old name. Once those match, one run lists every query and plan statement that still names it, each with its `at:` line. What the migration contains, and one file for a project where every database starts empty: [references/migrations.md](references/migrations.md); rehearse it against a snapshot of real data first: [references/rehearse.md](references/rehearse.md). The build prints the statements the migration will hold. When it prints `changes.json`, copy that JSON into the file and run the printed command.
3. **Add a query**: a key in `queries(generated, { ... })`, then `npx solarsql build`. How a parameter and a column get their types, and the recipes for lists, rows, optional filters, sorting, paging, JSON, and search: [references/queries.md](references/queries.md). D1 and a Durable Object cap bound parameters, statement length, and row size beyond what `node:sqlite` enforces at build time: [references/limits.md](references/limits.md).
4. **Add a command**: a key in `commands(generated, { ... })` with `plan`, asserts, and `returns`, then `npx solarsql build`. Plans, asserts, results by `kind` with the rows the plan changed, and what a plan may touch: [references/commands.md](references/commands.md). A write into another module's table moves into a command of the module that owns the table. Copy the shape of a command already in that module's module.ts and export it from public.ts.
5. **Run it**: `d1(env.DB)`, `durable(ctx.storage)`, or `node(db)`; `db.all`, `db.first`, `db.run`, `db.batch`; `Row` and `Params` outside the module; the tables a query or a command reads, in `meta.reads`; the observe hook; ids; a module's test; on a Durable Object: [references/running.md](references/running.md).
6. **Read a build message**: the message names the fix. The table of messages: [references/build.md](references/build.md).
7. **Develop locally** with wrangler and a Miniflare test, then **deploy the example** and run its steps on remote D1 and a Durable Object: [references/deploy.md](references/deploy.md).

After an edit, complete the [verification workflow](references/build.md#verification-after-an-edit). A tsc error on a SQL string literal means the generated file is stale: run `npx solarsql build`.

## The rules the build enforces

- Queries and `returns` are SELECT or VALUES statements; each plan SQL item is one SELECT, VALUES, or data-changing statement. [Statement roles](references/commands.md#the-parts).
- Query scopes determine compound result types and outer-join nullability. Unsupported shapes fail during the build. [Result types](references/queries.md#the-type-of-a-column).
- Every table is `strict` and has a primary key that is `not null`.
- A statement, a view, or a trigger body of a module touches the tables of that module, the primary keys its foreign keys reference, and the foreign key columns of tables that reference its own. A module with `readsAll` may read every table. A write into another module's table is always refused.
- An index sits on a table of its module, and a trigger on a table or a view of its module.
- A file of a module imports another module only through that module's `public.ts`.
- An expression column has a `cast(... as integer | real | text | blob)`.
- A `json_group_array` over an outer join has a `filter (where ... is not null)`.
- A parameter has one type across a command, and `changes()` in an assert follows the statement it counts.
- The migration files reproduce the schema; otherwise the build asks for `solarsql migration <name>`.

## Where the reasoning is

A reference states a rule. The ADR that decided the rule, in `docs/adr/` of the repository, holds the reasoning and the measurement behind it.
