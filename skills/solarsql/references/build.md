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
npx solarsql migration <name> [--intent changes.json] [--timeout-ms 30000] [solarsql.config.ts]
```

## init

`init <module>` writes `solarsql.config.ts`, `modules/<module>/module.ts` (a placeholder table, a query catalog, two commands), `public.ts`, `module.test.ts` (on node:sqlite), and `tsconfig.json` when there is none; then it runs the build and writes `migrations/0001_initial.sql` with `index.ts`.
The module name is the table name and the directory name, as typed, and matches `[a-z][a-z0-9_]*`.
It never writes over a file: it refuses when any file it would write exists, and when `migrations/` exists.
It writes no Worker, no wrangler configuration, and no package.json.
The files are ES modules; a package.json that says `"type": "commonjs"` gets a note.

## build

The build imports every module of `solarsql.config.ts`, applies the schema to an in-memory SQLite, prepares every statement on it, and writes `solarsql.generated.ts` next to each module.
A generated file that is missing gets a stub before the import, so a fresh clone builds whatever the modules import from each other, and a configuration file that imports a module builds too.
It prints `wrote` or `current` per module, with the time to import and type that module at the end of the line, a `+` line per statement added and a `-` line per statement removed, `scan` lines for full scans, a `reads` line per query of a `readsAll` module with the tables that query reads, a `time` line for the whole build, and `migrations are current`, or the statements a migration would hold.
The generated file is keyed by the SQL text: a statement whose text changed has no entry, and `tsc` fails at the call site until the build runs again. Commit the generated file.
If only the DDL changes, unchanged statements can retain stale types that pass `tsc`; `build --check` detects stale generated files.

`build --check` writes nothing and exits 1 when a generated file, `migrations/index.ts`, or a migration is behind the source. It is for CI, for a test hook, and for `prepublishOnly` in a package that ships its generated files.
Normal `build` exits 0 after valid generation, even when a migration is pending or blocked; it reports the status and required action.
Invalid schema, SQL, or module boundaries still fail the build.
`build --check` and `migration <name>` exit 1 for a blocked migration.
A successful build does not establish that the change is ready to deploy.

The CLI runs `build`, `build --check`, and `migration` in a direct worker with a 30,000 millisecond deadline.
Use `--timeout-ms <positive integer>` to set a different finite deadline.
The parent validates every command option before the worker imports the project.
On expiry, it stops the direct worker and reports the expired budget with a recovery action.
The command does not make claims about application-owned child processes.
Generated files and `migrations/index.ts` replace their old contents atomically.
Review a timed-out migration directory before you remove a retained `.solarsql-generation.lock`.

## Verification after an edit

1. Run `npx solarsql build` after a schema or SQL edit.
2. Read the migration status, even when the build exits 0.
   When it says `migration pending. Write the migration`, run `npx solarsql migration <name>`.
   When it reports an ordinary removal, copy its JSON and run the command it prints.
   For other errors, apply the fix in the message and run the build again.
3. Run `npx solarsql build --check` to verify generated files and migrations against the source.
4. Run the project's TypeScript check (`npx tsc --noEmit` by default) and tests.

Use the same configuration path for each command if the project uses a custom path.

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
Statement errors also name the `module.ts` path, exported catalog, and entry.
Command locations include the plan position, counted from 1, and assert name when applicable, or `returns`.
Shared SQL reports all its catalog locations.

| The message contains | Fix |
|---|---|
| `Use exactly one SQL statement` | split SQL into separate plan items; a query entry contains one SELECT or VALUES statement |
| `A query or returns must be SELECT` | move the write into a command plan and read its result in `returns` |
| `A plan item must be SELECT` | use a data statement; let the adapter manage the transaction and use migrations for schema changes |
| `mixes decoded JSON and SQL scalar values` | CAST the JSON branch AS TEXT to use a common output representation |
| `duplicate output column` | give each result column a distinct AS name |
| `query scope does not match SQLite's output columns` | use explicit result columns for this unsupported projection |
| `is an expression with no type` | wrap the expression in `cast(... as integer)`, `cast(... as real)`, `cast(... as text)`, or `cast(... as blob)` |
| `json_group_array over the outer join alias` | add `filter (where <alias>.<column> is not null)` |
| `inside json yields JSON text` | wrap the subquery in `json(...)` |
| `inside json has no type` | use a column reference, a cast, or `json((select json_group_array(...)))` |
| `json_object key must be a string literal` | write the key as `'name'` |
| `is used with two different types` | give the two places of the parameter one type, or use two parameters |
| `of this statement is` | the same statement text sits in two commands with two types; give it a type of its own, or split it |
| `uses changes(), which counts the statement right before it` | put the assert right after the statement it counts |
| `the returns clause uses changes()` | read the command's changes result instead |
| `RETURNING clause is discarded` | move the read into the command's `returns` field instead |
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
| `generated files are stale` | run `npx solarsql build` |
| `migration name must match` | rename: `[a-z0-9_]+` |
| `module name must match` | rename: `[a-z][a-z0-9_]*` |
| `exists. init is for a project without one` | init never writes over a file; add a module by hand ([schema.md](schema.md)) |

A statement that does not prepare fails with the engine's own message, such as `no such column: x`, under the module and the statement.

## For an agent working in a project

Point the project's AGENTS.md at `node_modules/solarsql/skills/solarsql/SKILL.md`; the package ships this skill.

## Inspect an operation contract

Run `npx solarsql inspect solarsql.config.ts` for JSON with format `version: 1`.
`result.inspection.operations` lists each SQL string, its catalog locations, parameter and result types, column origins, and engine access records.
Types combine engine metadata with static scope and expression rules. Column origins are evidence, not a complete proof of the result type.
The report identifies the local SQLite version and states that deployment compatibility was not verified.

`inspect` and `build --json` emit one JSON document on stdout.
Application import logs go to stderr. A premature import exit produces `BUILD_WORKER_FAILED`; inspect stderr to locate the cause.
Inspection writes no build artifacts. Configuration and module imports still execute application JavaScript; inspection is not a sandbox.
Both commands give the report worker a 30,000 millisecond deadline. Use `--timeout-ms <positive integer>` to set a different finite deadline; the parent validates it before it imports the configuration.
`BUILD_TIMEOUT` has the expired `timeoutMs` and tells the caller to use a larger budget after it inspects the import and build work.
A missing generated file requires a build first. A stale file or pending migration produces exit 1 and diagnostics with a recovery action.
`build --json` provides machine-readable generation results; combine it with `--check` for verification.
`BUILD_FAILED` preserves the error message, SQL when available, catalog locations when available, and a machine-readable `action` string when the error names one (for example, a colliding migration sequence).
