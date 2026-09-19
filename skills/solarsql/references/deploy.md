# Develop locally, then deploy

## Develop locally

wrangler (pinned at 4.127.1 in `package.json`) runs the Worker and its D1 database on your machine, with no account and no deploy.

Apply the migration files to the local database, then run the Worker:

```sh
cd example
cp wrangler.example.jsonc wrangler.jsonc   # gitignored; --local needs no real database id
npx wrangler d1 migrations apply solarsql-example --local
npx wrangler dev
```

`wrangler.example.jsonc`'s placeholder `database_id` works for `--local`: `wrangler` never contacts the Cloudflare API for a local command, so it only uses the id to name the local files.

The local database is a SQLite file under `.wrangler/state/v3/d1/miniflare-D1DatabaseObject/<hash>.sqlite`, one file per binding, inside the directory the `wrangler.jsonc` next to it resolves. Open it with `solarsql rehearse` or `sqlite3` to inspect it directly.

`wrangler dev` also runs a project's Durable Object locally; its SQLite storage lives under the same `.wrangler/state` directory, one file per object.

## One Miniflare test for a project

A project can run its own module against the D1 contract on workerd, the same way this repository's tests do, without an account. Add `miniflare` (pinned at `5.20260828.0-alpha` in this repository's `package.json`) as a dev dependency.

Apply the migrations with wrangler first (see above), then point the test's Miniflare instance at the same local database with `resourcePersistencePath`, instead of applying the files again in the test. `d1Databases`' value must match the `database_id` in `wrangler.jsonc`, because that value names the local database file. Then run one command and one query through `d1(env.DB)` inside the Worker:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";

test("the Worker runs a command and a query on D1", async () => {
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      scriptPath: resolve(import.meta.dirname, "worker.ts"),
      compatibilityDate: "2026-08-28",
      compatibilityFlags: ["nodejs_compat"],
      d1Databases: { DB: "<the database_id in wrangler.jsonc>" },
      resourcePersistencePath: resolve(import.meta.dirname, ".wrangler/state/v3"),
    }),
  );
  try {
    const create = await mf.dispatchFetch("http://localhost/", {
      method: "POST",
      body: JSON.stringify({ /* a step your Worker's handler understands */ }),
    });
    assert.equal((await create.json()).ok, true);
  } finally {
    await mf.dispose();
  }
});
```

Run `npx wrangler d1 migrations apply <database> --local` once before this test, the same as before `wrangler dev`; the test opens the file that command wrote and adds no migration step of its own.

## What each layer proves

[running](running.md) already states what node:sqlite and Miniflare each check. The third layer, a deployed Worker, proves the same module code against the real service: production D1's HTTP API, and a real Durable Object instance, past whatever a local engine emulates differently.

## Deploy

The example in `example/` of the repository is a Worker with a D1 binding and a Durable Object, and wrangler deploys it.
Copy the template, create the database, and put the id it prints in the copy:

```sh
cd example
cp wrangler.example.jsonc wrangler.jsonc   # gitignored: it names your database
npx wrangler d1 create solarsql-example    # prints the id for wrangler.jsonc
npx wrangler d1 migrations apply solarsql-example --remote
npx wrangler secret put TOKEN              # any string; the Worker refuses a request without it
npx wrangler deploy
```

`wrangler d1 migrations apply` takes the files of `example/migrations` in name order and keeps its own record of the applied ones.
The Durable Object applies the same files with `migrate()` on its first request.
The Worker refuses a request without `Authorization: Bearer <TOKEN>` once the secret is set.

The remote test sends the steps of the Miniflare test to the deployed Worker, on D1 and on the Durable Object, after a reset of both:

```sh
SOLARSQL_REMOTE_URL=https://solarsql-example.<your subdomain>.workers.dev SOLARSQL_REMOTE_TOKEN=<the secret> node --test test/remote.test.ts
```

`npm test` skips it without the URL. The observe test is skipped on remote D1, because a deployed Worker runs several isolates and the hook's events live in one.
This test runs the example's own steps -- the queries and commands its module already declares -- against the store the reset just emptied; it does not run a migration file, so a rebuild that carries `pragma defer_foreign_keys = on` is not among the steps it sends.

A user's own Worker follows the same shape: a `wrangler.jsonc` with the D1 binding and `migrations_dir`, and a Durable Object class with `new_sqlite_classes`. wrangler's own init writes the Worker; solarsql writes none.
