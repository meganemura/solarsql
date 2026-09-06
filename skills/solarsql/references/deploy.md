# Deploy the example

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

A user's own Worker follows the same shape: a `wrangler.jsonc` with the D1 binding and `migrations_dir`, and a Durable Object class with `new_sqlite_classes`. wrangler's own init writes the Worker; solarsql writes none.
