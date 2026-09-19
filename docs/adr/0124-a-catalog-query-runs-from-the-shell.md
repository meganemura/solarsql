# ADR 0124: A catalog query runs from the shell

Status: accepted (2026-09-19)

## Context

running.md's own raw-SQL lines let an agent look at data from a shell, but each one retypes the SQL, skips parameter validation, and returns JSON columns as text. A query already named in a catalog carries its own parameter names and JSON columns; running it by name, instead of by raw text, is cheaper and safer for an agent, without the cost of a server.

## Decision

`solarsql query <module>.<catalog>.<name> --database <file.sqlite> [--params '{"id":"1"}'] [--timeout-ms 30000] [solarsql.config.ts]` resolves the module by its directory basename, the exported `queries(...)` const by name, and the entry by its key, then runs it and prints its rows as one JSON array on stdout, exit 0. It runs the project import in the same direct worker `build` and `migration` already use (`src/build/machine.ts`, ADR 0092, ADR 0109), with the same 30,000 millisecond default deadline, so application code runs under the same conditions as a build.

`--database` opens the file with `new DatabaseSync(file, { readOnly: true })`: a query can only be a SELECT (ADR 0045), so read-only is enough, and a write reaching that handle is refused by node:sqlite itself before any solarsql code runs. `--params` is a JSON object keyed by the generated parameter names, the same object `db.all` takes; a missing or extra key fails with the adapter's own `validateParams` message (ADR 0088), not a new one. A `commands(...)` entry is refused, naming `db.run`, since running a command's plan is out of scope here.

Every error other than a successful run -- a bad option, an unresolved target, a missing parameter, a command entry -- exits 2 with one line on stderr naming the query or the option. This differs from `build`'s and `migration`'s own exit 1 for a `BuildError`: `query` is read from the shell like `grep`, one result or one reason it did not run, not a report a caller inspects for a partial, still-successful generation.

The worker sends its stdout straight through to the parent's own stdout (`runHuman`, the same direct-worker path `build` and `migration` use), not through the report channel `build --json` and `inspect` use: that channel redirects a worker's stdout onto the parent's stderr, so a bare JSON row array could never reach real stdout through it.

## Evidence

`test/slow/cli.test.ts` runs a query with and without `--params` against a temporary database built from `example/migrations`, confirms a JSON column decodes to an array, and confirms a missing parameter, an unknown catalog or entry name, a `commands(...)` entry, and a missing `--database` each exit 2 with a message naming the query or the option.

## Consequences

- `skills/solarsql/references/build.md` documents `query` next to `build`, `build --check`, and `migration`, and running.md points to it from the Adapters section's own raw-SQL lines.
- Commands, D1, Durable Objects, an MCP server, and a REPL are out of scope; a server can wrap `query`'s own resolution logic (`src/build/query.ts`) later.
