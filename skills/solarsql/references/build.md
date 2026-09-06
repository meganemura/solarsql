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

`readsAll` lets a module read every table; it is for reports. `library` (default `"solarsql"`) is the import specifier the generated files use.

## Messages

Each message names the fix. The build stops at the first, and prints the statement under `in:`.

| Message begins with | Fix |
|---|---|
| `column "x" is an expression with no type` | wrap the expression in `cast(... as integer)`, `cast(... as real)`, or `cast(... as text)` |
| `json_group_array over the outer join alias` | add `filter (where <alias>.<column> is not null)` |
| `the subquery "..." inside json yields JSON text` | wrap the subquery in `json(...)` |
| `value "..." inside json has no type` | use a column reference, a cast, or `json((select json_group_array(...)))` |
| `json_object key must be a string literal` | write the key as `'name'` |
| `parameter :p is used with two different types` | give the two places one type, or use two parameters |
| `parameter :p of this statement is` | the same statement text sits in two commands with two types; give it a type of its own, or split it |
| `command m.c: assert a uses changes()` | put the assert right after the statement it counts |
| `use a named parameter (:name) instead of` | replace `?` with `:name` |
| `module m reads t.c. Module o owns t` | read through the owner's `public.ts`, or declare `readsAll` for a report module |
| `module m inserts into t`, `updates t`, `deletes from t` | a write into another module's table; move the statement to the owner |
| `module m: view v reads t.c` / `module m: trigger x ...` | a view or a trigger body reaches another module's table; same fix |
| `module m: module.ts imports ../o/module.ts` | import from `../o/public.ts` |
| `table t has no primary key` | declare one: `id text primary key not null` |
| `table t is not STRICT` | add `strict` after the closing parenthesis |
| `table t is declared by module a and by module b` | one owner per table |
| `column t.c has the declared type "x", which maps to no TypeScript type` | use `text`, `integer`, `real`, `blob`, or `any` |
| `module m: table() needs one CREATE TABLE statement` (and `index()`, `view()`, `trigger()`, `search()`) | one CREATE statement per call; `search()` needs `using fts5(...)` |
| `module m: trigger x is on t, which` | a trigger sits on a table or a view of its own module |
| `module m: index i is on t, which` | an index sits on a table of its own module |
| `schema:` | the engine refused the DDL; the rest is its own message |
| `module m: solarsql.generated.ts is missing` | run `npx solarsql build` (a check writes nothing) |
| `schema changed. Write the migration` | run `npx solarsql migration <name>` |
| `migration blocked:` | a table both loses and gains a column, or a new column is `not null` without a default; split the change or add a default |
| `generated files are stale` | run `npx solarsql build` |
| `migration name must match [a-z0-9_]+` | rename |
| `module name must match [a-z][a-z0-9_]*` | rename |
| `... exists. init is for a project without one` | init never writes over a file; add a module by hand ([schema.md](schema.md)) |

A statement that does not prepare fails with the engine's own message, such as `no such column: x`, under the module and the statement.

## For an agent working in a project

Point the project's AGENTS.md at `node_modules/solarsql/skills/solarsql/SKILL.md`; the package ships this skill.
