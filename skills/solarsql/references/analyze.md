# Adopt an existing schema

Use `analyze` when you have SQLite DDL and want query types before defining solarsql modules.
It accepts tables without primary keys and preserves your SQL strings.

Write CREATE statements in `schema.sql` and a named catalog in `queries.json`:

```json
{
  "list": "select name from items order by name"
}
```

Generate a file, then check it in CI:

```sh
npx solarsql analyze schema.sql queries.json --out solarsql.generated.ts
npx solarsql analyze schema.sql queries.json --out solarsql.generated.ts --check
```

Each command emits versioned JSON with parameter types, result types, origins, and accesses.
Without `--out`, the JSON also contains the generated TypeScript text.
`--check` writes nothing and exits 1 for stale output.
Errors include the query location when analysis reaches that query.

```ts
import { queries } from "solarsql";
import { node } from "solarsql/node";
import { DatabaseSync } from "node:sqlite";
import { generated, statements } from "./solarsql.generated.ts";

const q = queries(generated, statements);
const sqlite = new DatabaseSync("app.sqlite");
const db = node(sqlite);
try {
  console.log(await db.all(q.list));
} finally {
  sqlite.close();
}
```

The same connection remains available for direct SQL.
Analysis creates an in-memory schema; it imports no application JavaScript and changes no existing database.
Supply schema DDL without INSERT, ATTACH, or PRAGMA statements.
Query names `kind`, `entries`, and `__proto__` are reserved.

Non-STRICT columns produce `SqlValue`: their declared affinity cannot prove the stored class.
STRICT columns produce scalar types, without identity brands or CHECK-literal unions.
Use runtime narrowing for existing flexible values.
An explicit SQL CAST changes SQLite conversion behavior and can give a narrower result type.
The supported query shapes and named parameter rules in [queries](queries.md) also apply here.

The supplied DDL must describe your database.
This check proves a local contract, not production schema freshness or Cloudflare behavior.
Use [migration rehearsal](migrations.md) with a populated snapshot for a proposed transition.
See [running](running.md) for adapter conversions and numeric limits.
