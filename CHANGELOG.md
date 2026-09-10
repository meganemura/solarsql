# Changelog

The format follows Keep a Changelog, and the versions follow SemVer. Before 1.0, a minor version may change the API; the entry says what changed.

## 0.3.0 (unreleased)

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
