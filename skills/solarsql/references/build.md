# The build, the CLI, and the messages

For schema DDL and a query catalog without application modules, use [analyze](analyze.md).

`npx solarsql --help` lists commands; `npx solarsql --version` prints the installed package version.
Both write to stdout and exit 0 without loading application configuration or writing files.
Use `npx solarsql help build` or `npx solarsql build --help` for one command.
The aliases are `-h` for help and `-v` for version.
Help accepts only the command name; omit application paths and execution options.
Unknown help targets and extra discovery arguments print usage to stderr and exit 2.

```
npx solarsql init <module> [dir]
npx solarsql build [--timeout-ms 30000] [solarsql.config.ts]
npx solarsql build --check [--timeout-ms 30000] [solarsql.config.ts]
npx solarsql build --json [--timeout-ms 30000] [solarsql.config.ts]
npx solarsql inspect [--timeout-ms 30000] [solarsql.config.ts]
npx solarsql migration <name> [--intent changes.json] [--timeout-ms 30000] [solarsql.config.ts]
npx solarsql query <module>.<catalog>.<name> --database <file.sqlite> [--params '{"id":"1"}'] [--timeout-ms 30000] [solarsql.config.ts]
```

## init

`init <module>` writes `solarsql.config.ts`, `modules/<module>/module.ts` (a placeholder table, a query catalog, two commands), `public.ts`, `module.test.ts` (on node:sqlite), and `tsconfig.json` when there is none; then it runs the build and writes `migrations/0001_initial.sql` with `index.ts`.
The module name is the table name and the directory name, as typed, and matches `[a-z][a-z0-9_]*`.
It never writes over a file: it refuses when any file it would write exists, and when `migrations/` exists.
It writes no Worker, no wrangler configuration, and no package.json.
The files are ES modules; a package.json that says `"type": "commonjs"` gets a note.
`init --empty [dir]` writes `solarsql.config.ts` with `modules: []`, `tsconfig.json` when there is none, and an empty `migrations/index.ts`; no module directory and no migration file, for a model-first project that starts a module by hand. `init <module> --empty` is refused: `--empty` takes no module name.

## build

The build imports every module of `solarsql.config.ts`, applies the schema to an in-memory SQLite, prepares every statement on it, and writes `solarsql.generated.ts` next to each module.
A generated file that is missing gets a stub before the import, so a fresh clone builds whatever the modules import from each other, and a configuration file that imports a module builds too.
It prints `wrote` or `current` per module, with the time to import and type that module at the end of the line, a `+` line per statement added and a `-` line per statement removed, `scan` lines for full scans, a `reads` line per query of a `readsAll` module with the tables that query reads, a `time` line for the whole build, and `migrations are current`, or the statements a migration would hold. Its last line, `next: <command>`, names the next command to run: `npx tsc --noEmit && npm test` after a clean build with migrations current, the migration command when one is pending, or the fix for a blocked migration.
The generated file is keyed by the SQL text: a statement whose text changed has no entry, and `tsc` fails at the call site until the build runs again. The error's expected type says `run npx solarsql build`. Commit the generated file.
If only the DDL changes, unchanged statements can retain stale types that pass `tsc`; `build --check` detects stale generated files.

`build --check` writes nothing and exits 1 when a generated file, `migrations/index.ts`, or a migration is behind the source. It is for CI, for a test hook, and for `prepublishOnly` in a package that ships its generated files.
Normal `build` exits 0 after valid generation, even when a migration is pending or blocked; it reports the status and required action.
Invalid schema, SQL, or module boundaries still fail the build.
`build --check` and `migration <name>` exit 1 for a blocked migration.
A successful build does not establish that the change is ready to deploy.

The CLI runs `build`, `build --check`, `migration`, and `query` in a direct worker with a 30,000 millisecond deadline.
Use `--timeout-ms <positive integer>` to set a different finite deadline.
The parent validates every command option before the worker imports the project.
On expiry, it stops the direct worker and reports the expired budget with a recovery action.
The command does not make claims about application-owned child processes.
Generated files and `migrations/index.ts` replace their old contents atomically.
Review a timed-out migration directory before you remove a retained `.solarsql-generation.lock`.

## migration

`migration <name> [--intent changes.json] [--timeout-ms 30000] [solarsql.config.ts]` runs every `build` check, then writes the pending migration file (full contract: [migrations.md](migrations.md)).
It prints `wrote <relative path>`, the statements the file holds, and `next: npx tsc --noEmit && npm test`.
An error ends with `next: fix the error above, then npx solarsql build`.

## query

`query <module>.<catalog>.<name> --database <file.sqlite>` runs one catalog query and prints its rows as one JSON array on stdout, exit 0.
`<module>` is a directory basename of `solarsql.config.ts`'s `modules`, `<catalog>` an exported `queries(...)` const, `<name>` its entry key.
It imports the project in the same direct worker as `build`, so application code runs under the same conditions; use `--timeout-ms` the same way.
`--database` opens read-only; `--params` takes a JSON object keyed by the generated parameter names, the same object `db.all` takes (queries.md).
A missing or extra key fails with the adapter's own message (ADR 0088); a `commands(...)` entry is refused, naming `db.run`.
Every other error, including a missing `--database`, exits 2 with one line on stderr naming the query or the option.

## Verification after an edit

1. Run `npx solarsql build` after a schema or SQL edit.
2. Run the command the last line names, until it names the project's type check and tests.
   When it reports an ordinary removal, copy its JSON and run the command it prints.
   For other errors, apply the fix in the message and run the build again.
3. Run the project's TypeScript check (`npx tsc --noEmit` by default) and tests.

Use the same configuration path for each command if the project uses a custom path.

## solarsql.config.ts

```ts
import { config } from "solarsql";

export default config({
  modules: ["./modules/orders", "./modules/customers", { dir: "./modules/reports", readsAll: true }],
  migrations: "./migrations",
});
```

`readsAll` lets a report module read every table. `library` (default `"solarsql"`) is the import specifier the generated files use.

## Messages

Each message names the fix. The build reports every failing statement in one run, each under `in:` with its `at:` line; it also reports every failing table, index, view, trigger, and search table of a module in the same run, before it types that module's statements.
Statement errors also name the `module.ts` path, exported catalog, and entry.
Command locations include the plan position, counted from 1, and assert name when applicable, or `returns`.
Shared SQL reports all its catalog locations.

| The message contains | Fix |
|---|---|
| `in:` | one failing statement of the run; the build reports every one before it stops, so fix them all from their own `in:` and `at:` lines |
| `skipped:` | a table failed to create, so the rest of its module's objects (indexes, search tables, views, triggers) were never applied; fix the table first, then rebuild |
| `not checked until its schema builds` | a module's schema failed, so its statements were not typed; fix every schema failure of the module first |
| `columns of` | `no such column` lists `columns of <table>: ...`; pick the intended column from that list |
| `Use exactly one SQL statement` | split SQL into separate plan items; a query entry contains one SELECT or VALUES statement |
| `A query or returns must be SELECT` | move the write into a command plan and read its result in `returns` |
| `A plan item must be SELECT` | use a data statement; let the adapter manage the transaction and use migrations for schema changes |
| `mixes decoded JSON and SQL scalar values` | CAST the JSON branch AS TEXT to use a common output representation |
| `duplicate output column` | give each result column a distinct AS name |
| `query scope does not match SQLite's output columns` | use explicit result columns for this unsupported projection |
| `is an expression with no type` | wrap the expression in `cast(... as integer)`, `cast(... as real)`, `cast(... as text)`, or `cast(... as blob)` |
| `do not stabilize within 32 steps` | use CAST for the recursive expression |
| `is the match operand of` | use it in a `<table> match :param` condition, or as the first argument of `highlight(...)`, `snippet(...)`, or `bm25(...)`, instead of selecting it directly |
| `json_group_array over the outer join alias` | add `filter (where <alias>.<column> is not null)` |
| `inside json yields JSON text` | wrap the subquery in `json(...)` |
| `inside json has no type` | use a column reference, a cast, or `json((select json_group_array(...)))` |
| `json_object key must be a string literal` | write the key as `'name'` |
| `is used with two different types` | give the two places of the parameter one type, or use two parameters |
| `of this statement is` | the same statement text sits in two commands with two types; give it a type of its own, or split it |
| `in one statement and` | the same parameter name has two types across the plan's statements; use one type, or two parameter names |
| `uses changes(), which counts the statement right before it` | put the assert right after the statement it counts |
| `must come before module` | an included command's owner (ADR 0127) must be listed before the including module in `modules` |
| `whose statements no module owns` | an included command's statements do not all belong to one module; include it as exported from its own module's `public.ts` |
| `whose statements more than one module owns` | two modules declare the same statement text as an included command's plan; give one a distinct statement |
| `is used twice` | an included command and the including command share an assert name; rename one |
| `is not named by any statement or assert of module` | a `note` line, not a failure: an included command's parameter that no statement or assert of the including module names is a parameter nothing ties to the including row; add an assert that ties it, or give the shared value one name |
| `the returns clause uses changes()` | read the command's changes result instead |
| `RETURNING clause is discarded` | move the read into the command's `returns` field instead |
| `does not export it` | a module's generated file uses another module's id type that the owner's `public.ts` no longer exports; add the `export type { ... }` line the message names |
| `use a named parameter (:name) instead of` | replace `?` with `:name` |
| `Use its public.ts, or declare readsAll for a report module` | a read of another module's table: read through the owner's `public.ts`, or declare `readsAll` on a report module; a write (`inserts into`, `updates`, `deletes from`) moves to the owner |
| `shows public.ts; import from there` | import from the other module's `public.ts` |
| `has no primary key. Declare one` | `id text primary key not null` |
| `is not STRICT. Add` | add `strict` after the closing parenthesis |
| `is declared by module` | one owner per table |
| `has a foreign key to` | fix the foreign key's target table or column name |
| `which maps to no TypeScript type` | use `text`, `integer`, `real`, `blob`, or `any` |
| `needs one CREATE TABLE statement` (and `CREATE INDEX`, `CREATE VIEW`, `CREATE TRIGGER`, `CREATE VIRTUAL TABLE ... USING fts5(...)`) | one CREATE statement per call |
| `A trigger belongs to the module of its table or view` | move the trigger to the owner of its table or view |
| `An index belongs to the module of its table` | move the index to the owner of its table |
| `schema:` | the engine refused the DDL; the rest is its own message |
| `is missing. Run: npx solarsql build` | run the build; a check writes nothing |
| `is not in modules` | the configuration imports a module it does not list; add the module's directory to `modules` |
| `migration pending. Write the migration` | run `npx solarsql migration <name>` |
| `migration blocked:` | follow the reason. For an ordinary removal, copy the exact JSON and command. For another block, split an ambiguous change, add a default, or write a data-preserving migration for a rebuild with foreign-key delete actions |
| `Invalid migration intent` | check the file is valid JSON matching the migration-intent shape; the rest of the message names the specific problem |
| `generated files are stale` | run `npx solarsql build` |
| `migration name must match` | rename: `[a-z0-9_]+` |
| `module name must match` | rename: `[a-z][a-z0-9_]*` |
| `requires an integer` | pass `--timeout-ms` a positive integer, at most 2147483647 |
| `exists. init is for a project without one` | init never writes over a file; add a module by hand ([schema.md](schema.md)) |
| `migrations/ exists` | init never writes over a project with a migration history; add a module by hand ([schema.md](schema.md)) |
| `query name must be <module>.<catalog>.<name>` | pass the module directory's basename, the exported catalog const, and the entry key, joined by dots |
| `no module named` | check `<module>` against `solarsql.config.ts`'s `modules` |
| `no query catalog named` / `no query named` | check `<catalog>` and `<name>` against the module's `module.ts` |
| `is a command, not a query. Run a command through db.run` | commands are out of scope for `query`; call `db.run` from application code instead |
| `missing parameter` / `unexpected parameter` | fix `--params`' JSON object to match the query's own declared keys (ADR 0088) |
| `--database is required` / `--database <file>:` | pass `--database <file.sqlite>`; the second form also carries the engine's own open failure |

A statement that does not prepare fails with the engine's own message, such as `no such column: x`, under the module and the statement.

## For an agent working in a project

Point the project's AGENTS.md at `node_modules/solarsql/skills/solarsql/SKILL.md`; the package ships this skill.

## Inspect an operation contract

Run `npx solarsql inspect solarsql.config.ts` for JSON with format `version: 1`.
`result.inspection.operations` lists each SQL string, its catalog locations, parameter and result types, column origins, and engine access records.
Types combine engine metadata with static scope and expression rules. Column origins are evidence, not a complete proof of the result type.
The report identifies the local SQLite version and states that deployment compatibility was not verified.

Each read operation's entry also carries `plan`: EXPLAIN QUERY PLAN's own account of that SELECT, VALUES, or WITH-prefixed read, or `null` for a write. `rows` holds the plan verbatim (`id`, `parent`, `detail`); `scans` names each table SQLite reads in full; `searches` names each table an index (or a table's own key) narrows, with the index name or `null` for a key with no separate index object; `tempBtree` is true when a sort, a group, or a DISTINCT needed a temporary B-tree because no index served it. A `SCAN` on a table with a WHERE clause is the same fact `build`'s own `scan` line already reports, from the same engine call. A name in `scans` or `searches[].table` is the alias as the SQL wrote it (`from orders o` reports `"o"`, not `"orders"`); the build's `scan` line names the table, resolved from that alias. The plan comes from node:sqlite's planner against an empty, freshly built schema; a deployed database that has run `ANALYZE` holds row-count statistics this planner does not have, and may choose a different plan.

`inspect` and `build --json` emit one JSON document on stdout.
Application import logs go to stderr. A premature import exit produces `BUILD_WORKER_FAILED`; inspect stderr to locate the cause.
Inspection writes no build artifacts. Configuration and module imports still execute application JavaScript; inspection is not a sandbox.
Both commands give the report worker a 30,000 millisecond deadline. Use `--timeout-ms <positive integer>` to set a different finite deadline; the parent validates it before it imports the configuration.
`BUILD_TIMEOUT` has the expired `timeoutMs` and tells the caller to use a larger budget after it inspects the import and build work.
A missing generated file requires a build first. A stale file or pending migration produces exit 1 and diagnostics with a recovery action.
`build --json` provides machine-readable generation results; combine it with `--check` for verification.
`BUILD_FAILED` preserves the error message, SQL when available, catalog locations when available, and a machine-readable `action` string when the error names one (for example, a colliding migration sequence).
