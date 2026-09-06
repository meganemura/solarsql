# The build, the CLI, and the messages

```
npx solarsql init <module> [dir]
npx solarsql build [solarsql.config.ts]
npx solarsql build --check [solarsql.config.ts]
npx solarsql migration <name> [solarsql.config.ts]
```

## init

`init <module>` writes `solarsql.config.ts`, `modules/<module>/module.ts` (a placeholder table, a query catalog, two commands), `public.ts`, `module.test.ts` (on node:sqlite), and `tsconfig.json` when there is none; then it runs the build and writes `migrations/0001_initial.sql` with `index.ts`.
The module name is the table name and the directory name, as typed, and matches `[a-z][a-z0-9_]*`.
It never writes over a file: it refuses when any file it would write exists, and when `migrations/` exists.
It writes no Worker, no wrangler configuration, and no package.json.
The files are ES modules; a package.json that says `"type": "commonjs"` gets a note.

## build

The build imports every module of `solarsql.config.ts`, applies the schema to an in-memory SQLite, prepares every statement on it, and writes `solarsql.generated.ts` next to each module.
It prints `wrote` or `current` per module, a `+` line per statement added and a `-` line per statement removed, `scan` lines for full scans, and `migrations are current`, or the statements a migration would hold.
The generated file is keyed by the SQL text: a statement whose text changed has no entry, and `tsc` fails at the call site until the build runs again. Commit the generated file.

`build --check` writes nothing and exits 1 when a generated file, `migrations/index.ts`, or a migration is behind the source. It is for CI and for a test hook.

## solarsql.config.ts

```ts
import { config } from "solarsql";

export default config({
  modules: ["./modules/customers", "./modules/orders", { dir: "./modules/reports", readsAll: true }],
  migrations: "./migrations",
});
```

`readsAll` lets a report module read every table. `library` (default `"solarsql"`) is the import specifier the generated files use.

## Messages

Each message names the fix. The build stops at the first, and prints the statement under `in:`.

| The message contains | Fix |
|---|---|
| `is an expression with no type` | wrap the expression in `cast(... as integer)`, `cast(... as real)`, or `cast(... as text)` |
| `json_group_array over the outer join alias` | add `filter (where <alias>.<column> is not null)` |
| `inside json yields JSON text` | wrap the subquery in `json(...)` |
| `inside json has no type` | use a column reference, a cast, or `json((select json_group_array(...)))` |
| `json_object key must be a string literal` | write the key as `'name'` |
| `is used with two different types` | give the two places of the parameter one type, or use two parameters |
| `of this statement is` | the same statement text sits in two commands with two types; give it a type of its own, or split it |
| `uses changes(), which counts the statement right before it` | put the assert right after the statement it counts |
| `use a named parameter (:name) instead of` | replace `?` with `:name` |
| `Use its public.ts, or declare readsAll for a report module` | a read of another module's table: read through the owner's `public.ts`, or declare `readsAll` on a report module; a write (`inserts into`, `updates`, `deletes from`) moves to the owner |
| `shows public.ts; import from there` | import from the other module's `public.ts` |
| `has no primary key. Declare one` | `id text primary key not null` |
| `is not STRICT. Add` | add `strict` after the closing parenthesis |
| `is declared by module` | one owner per table |
| `which maps to no TypeScript type` | use `text`, `integer`, `real`, `blob`, or `any` |
| `needs one CREATE TABLE statement` (and `CREATE INDEX`, `CREATE VIEW`, `CREATE TRIGGER`, `CREATE VIRTUAL TABLE ... USING fts5(...)`) | one CREATE statement per call |
| `A trigger belongs to the module of its table or view` | move the trigger to the owner of its table or view |
| `An index belongs to the module of its table` | move the index to the owner of its table |
| `schema:` | the engine refused the DDL; the rest is its own message |
| `is missing. Run: npx solarsql build` | run the build; a check writes nothing |
| `schema changed. Write the migration` | run `npx solarsql migration <name>` |
| `migration blocked:` | a table both loses and gains a column, or a new column is `not null` without a default; split the change or add a default |
| `generated files are stale` | run `npx solarsql build` |
| `migration name must match` | rename: `[a-z0-9_]+` |
| `module name must match` | rename: `[a-z][a-z0-9_]*` |
| `exists. init is for a project without one` | init never writes over a file; add a module by hand ([schema.md](schema.md)) |

A statement that does not prepare fails with the engine's own message, such as `no such column: x`, under the module and the statement.

## For an agent working in a project

Point the project's AGENTS.md at `node_modules/solarsql/skills/solarsql/SKILL.md`; the package ships this skill.
