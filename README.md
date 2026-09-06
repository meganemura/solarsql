# solarsql

A typed SQL layer for SQLite on Cloudflare, for D1 and Durable Objects.
It is written for a coding agent that reads one module at a time, and for the human who reviews the agent's work.
Before 1.0 a minor version may change the API; the [changelog](CHANGELOG.md) says what changed.

You write SQL. The build step asks the real engine what the SQL returns, and writes the types down.
A command is a list of statements and asserts that runs as one transaction on both targets, and a failure comes back as a value.
A module owns its tables, and the build step refuses a statement that reaches into another module's tables.

## Start a project

```sh
npm install solarsql
npm install --save-dev typescript @types/node
npx solarsql init orders
node --test
```

`init` writes `solarsql.config.ts`, the module `modules/orders/` with a placeholder table, a query catalog, two commands, and a test on node:sqlite, and `tsconfig.json` when there is none.
Then it runs the first build and writes `migrations/0001_initial.sql`.
Replace the table with your own, run `npx solarsql build`, and write the next migration.
A Worker imports an adapter; wrangler's own init makes the Worker.
The files are ES modules, so `package.json` needs `"type": "module"` if it names a type at all.

## The shape

```
solarsql.config.ts
modules/
  orders/
    module.ts               the schema (tables, indexes, search tables, views, triggers), the queries, and the commands, as SQL strings
    public.ts               what other modules may import
    solarsql.generated.ts   written by `solarsql build`, committed
migrations/
  0001_initial.sql          written by `solarsql migration <name>`
  index.ts                  the same files, for a Durable Object
```

```ts
export const orderCommands = commands(generated, {
  confirm: {
    plan: [
      assert("has_lines", "exists (select 1 from order_lines where order_id = :id)"),
      "update orders set status = 'confirmed' where id = :id and status = 'draft'",
      assert("was_draft", "changes() = 1"),
    ],
    returns: "select id, customer_id, status, note from orders where id = :id",
  },
});

const result = await db.run(orderCommands.confirm, { id });
// { ok: true; rows: [...] } | { ok: false; kind: "assert"; assert: "has_lines" | "was_draft" } | { ok: false; kind: "unique"; ... }
```

## Read next

The usage documentation is a skill, written for an agent first: [skills/solarsql/SKILL.md](skills/solarsql/SKILL.md) is the workflow, and its references hold the rules.
The package ships it; in a project, point AGENTS.md at `node_modules/solarsql/skills/solarsql/SKILL.md`.

| To | Read |
|---|---|
| declare tables, indexes, views, triggers, search tables; the types the DDL gives | [schema.md](skills/solarsql/references/schema.md) |
| write a query; how a parameter and a column get their types; lists, rows, optional filters, sorting, paging, JSON, search | [queries.md](skills/solarsql/references/queries.md) |
| write a command: plans, asserts, results by `kind`, what a plan may touch | [commands.md](skills/solarsql/references/commands.md) |
| run it: the adapters, `all`/`first`/`run`/`batch`, observe, ids, a module's test | [running.md](skills/solarsql/references/running.md) |
| the CLI, the build, the config, and every message with its fix | [build.md](skills/solarsql/references/build.md) |
| what a migration holds, and how each target applies it | [migrations.md](skills/solarsql/references/migrations.md) |
| deploy the example and run its steps on remote D1 and a Durable Object | [deploy.md](skills/solarsql/references/deploy.md) |

## Requirements

Node 24.10 or later runs the build, because it needs `DatabaseSync.setAuthorizer()` of node:sqlite. The tests of this repository run on Node 24 and 26.
TypeScript 5.8 or later: the tsconfig `init` writes sets `erasableSyntaxOnly`, which is the syntax Node's type stripping runs, and reads the imports with a `.ts` extension that the stripping needs (`allowImportingTsExtensions` under `noEmit`, or `rewriteRelativeImportExtensions` when tsc emits).

## Design

The design decisions are in [docs/](docs/README.md), one ADR each, with the measurements they rest on.
The example project in [example/](example/) is the one the tests run on D1, on a Durable Object, and on node:sqlite.

## License

MIT
