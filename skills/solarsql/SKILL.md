---
name: solarsql
description: Use when a project uses solarsql, the typed SQL layer for SQLite on Cloudflare D1 and Durable Objects. Covers writing or changing a module.ts (tables, indexes, views, triggers, FTS5 search tables, queries, commands), the type a parameter or a column gets, the tables a query reads, a build message and its fix, a migration, a module's test on node:sqlite, wiring an adapter in a Worker, and deploying the example. Also use when the user names solarsql, `solarsql build`, `solarsql migration`, `solarsql init`, `solarsql.generated.ts`, a plan, or an assert.
---

# solarsql

A module owns its tables and shows other modules one `public.ts`.
The schema is SQLite DDL in string literals.
Queries are SQL in string literals with `:name` parameters, listed in a catalog.
A command is a plan: statements and asserts that run as one D1 batch or one Durable Object transaction, and a failure comes back as a value.
Rows are plain values.
Types come from the real engine at build time, keyed by the SQL text, and a stale type fails to compile.

The files of a module: `module.ts` (schema, queries, commands), `public.ts` (what other modules may import), `solarsql.generated.ts` (written by the build, committed).
The migration files are `migrations/NNNN_<name>.sql` and `migrations/index.ts`.

## Workflow

Load the reference of the step before you edit.

1. **Start a project**: `npx solarsql init <module>`. What it writes and what it refuses: [references/build.md](references/build.md).
2. **Change the schema**: edit `table()`, `index()`, `view()`, `trigger()`, or `search()` in `module.ts`, then `npx solarsql build`, then `npx solarsql migration <name>`. Rules and types of the DDL: [references/schema.md](references/schema.md). What the migration contains, and one file for a project where every database starts empty: [references/migrations.md](references/migrations.md).
3. **Add a query**: a key in `queries(generated, { ... })`, then `npx solarsql build`. How a parameter and a column get their types, and the recipes for lists, rows, optional filters, sorting, paging, JSON, and search: [references/queries.md](references/queries.md).
4. **Add a command**: a key in `commands(generated, { ... })` with `plan`, asserts, and `returns`, then `npx solarsql build`. Plans, asserts, results by `kind` with the rows the plan changed, and what a plan may touch: [references/commands.md](references/commands.md).
5. **Run it**: `d1(env.DB)`, `durable(ctx.storage)`, or `node(db)`; `db.all`, `db.first`, `db.run`, `db.batch`; `Row` and `Params` outside the module; the tables a query or a command reads, in `meta.reads`; the observe hook; ids; a module's test: [references/running.md](references/running.md).
6. **Read a build message**: the message names the fix. The table of messages: [references/build.md](references/build.md).
7. **Deploy the example** and run its steps on remote D1 and a Durable Object: [references/deploy.md](references/deploy.md).

After any change to SQL text, run `npx solarsql build`; a statement whose text changed has no type until then, and `tsc` fails at the call site.

## The rules the build enforces

- Every table is `strict` and has a primary key that is `not null`.
- A statement, a view, or a trigger body of a module touches the tables of that module, the primary keys its foreign keys reference, and the foreign key columns of tables that reference its own. A module with `readsAll` may read every table. A write into another module's table is always refused.
- An index sits on a table of its module, and a trigger on a table or a view of its module.
- A file of a module imports another module only through that module's `public.ts`.
- An expression column has a `cast(... as integer | real | text)`.
- A `json_group_array` over an outer join has a `filter (where ... is not null)`.
- A parameter has one type across a command, and `changes()` in an assert follows the statement it counts.
- The migration files reproduce the schema; otherwise the build asks for `solarsql migration <name>`.

## Where the reasoning is

A reference states a rule. The ADR that decided the rule, in `docs/adr/` of the repository, holds the reasoning and the measurement behind it.
