# Changelog

The format follows Keep a Changelog, and the versions follow SemVer. Before 1.0, a minor version may change the API; the entry says what changed.

## 0.1.0 (unreleased)

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
