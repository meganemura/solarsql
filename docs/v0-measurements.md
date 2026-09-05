# v0 measurements

Date: 2026-09-06.
These experiments decided whether the design holds.
Each section gives the command, the output, and the conclusion.
Everything here ran on Node 26.7.0 with node:sqlite, and on Miniflare 5.20260828.0-alpha with workerd 1.20260828.1.
Nothing here ran against a remote D1 database.

Run everything:

```
npm test            # 17 tests, three Miniflare suites and one property test
npm run typecheck   # tsc --noEmit
node spike/01-guard-node-sqlite.ts
node spike/02-oracle-node-sqlite.ts
node spike/03-json-typing.ts
node spike/03b-json-typing-followups.ts
node spike/04a-rebuild-under-fk.ts
node spike/04-migration-diff.ts
```

## 1. A false precondition rolls back a D1 batch

Question: can a statement inside `batch()` make the whole batch fail when a precondition is false?

### 1a. SQL mechanics on node:sqlite

Command: `node spike/01-guard-node-sqlite.ts`

```
sqlite_version 3.53.4
[A.create trigger with raise(abort, new.name)] no error
[A.false precondition] error message="not_confirmable" code=ERR_SQLITE_ERROR errcode=1811
[A.false precondition] orders rows after = 0
[A.true precondition] committed
[B.false precondition] error message="CHECK constraint failed: not_confirmable" errcode=275
[C.false precondition (raise rollback)] explicit rollback failed: cannot rollback - no transaction is active
[D.read own write] committed
[E.changes() of previous statement] committed
[E2.changes() when previous update matched nothing] error message="assert failed" errcode=1811
```

Conclusions:

- `raise(abort, new.name)` accepts an expression. One trigger serves every assert. The error message is the assert name.
- A named CHECK also works, with the message `CHECK constraint failed: <name>`. The name is fixed per table, so it fits less well.
- `raise(rollback, ...)` ends the transaction by itself. ABORT is the safe choice inside `transactionSync()`.
- A subquery in statement two reads the write of statement one.
- `changes()` reports the row count of the previous statement and works as an assert input.

### 1b. The same batch on the local D1 engine

Harness: `test/d1.ts` starts one Worker with a D1 binding. The Worker calls `env.DB.batch()`, so the batch takes the production path.

The local D1 implementation runs a batch inside `this.state.storage.transactionSync(() => queries.map(...))` of a Durable Object.

Command: `npm test` (`test/d1-batch-guard.test.ts`)

```
▶ D1 batch with a guard table
  ✔ a false precondition rolls back the whole batch
  ✔ a true precondition lets the batch commit
  ✔ a statement reads the write of the statement before it
  ✔ changes() of the previous statement feeds an assert
  ✔ the same batch through getD1Database() also rolls back
```

The error of the failed batch:

```
{"message":"D1_ERROR: not_confirmable: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_TRIGGER)"}
```

`select count(*) from orders` after the failure returns `{ n: 0 }`.

Conclusion: the mechanism works on the local D1 engine. The remote D1 service was not measured.

Facts found on the way:

- `exec()` splits its input on newlines. A multi-line `CREATE TABLE` fails with `D1_EXEC_ERROR: ... incomplete input`. DDL goes through `batch()`, one statement per entry.
- D1 refuses `sqlite_version()`: `not authorized to use function: sqlite_version`.
- The workerd binary embeds SQLite 3.53.4 (source id 2026-07-24, experimental snapshot). node:sqlite in Node 26.7.0 has 3.53.4. The versions match on this date.
- Miniflare 5 takes a normalized `workers: [...]` configuration. The exported `convertV4MiniflareOptions()` converts the flat v4 options.

## 2. node:sqlite as the type oracle and the boundary oracle

Command: `node spike/02-oracle-node-sqlite.ts`

### 2a. `columns()`

Join across tables:

```
select o.id, o.status, c.name, o.note, o.id as order_id from orders o join customers c on c.id = o.customer_id
  {"column":"id","database":"main","name":"id","table":"orders","type":"TEXT"}
  {"column":"status","database":"main","name":"status","table":"orders","type":"TEXT"}
  {"column":"name","database":"main","name":"name","table":"customers","type":"TEXT"}
  {"column":"note","database":"main","name":"note","table":"orders","type":"TEXT"}
  {"column":"id","database":"main","name":"order_id","table":"orders","type":"TEXT"}
```

Expression columns:

```
  {"column":null,"database":null,"name":"n","table":null,"type":null}       -- count(l.id)
  {"column":null,"database":null,"name":"s","table":null,"type":null}       -- o.status || '!'
  {"column":null,"database":null,"name":"note2","table":null,"type":null}   -- coalesce(o.note, '')
  {"column":null,"database":null,"name":"answer","table":null,"type":null}  -- 42
  {"column":null,"database":null,"name":"param","table":null,"type":null}   -- ?
```

Through other constructs:

```
[cte]       x.id -> order_lines.id TEXT
[subquery]  s.id -> orders.id TEXT
[view]      id   -> orders.id TEXT
[returning] id, status, note -> orders columns with types
[union]     id   -> orders.id only
[left join] l.id -> order_lines.id TEXT, nullability invisible
```

Conclusion: `columns()` gives the origin and the declared type of every column reference, through aliases, CTEs, derived tables, views, and RETURNING. It gives nothing for expressions, for nullability, or for CHECK constraints.

### 2b. `setAuthorizer()`

```
[select join]
  SQLITE_SELECT(null, null, null, null)
  SQLITE_READ("orders", "id", "main", null)
  SQLITE_READ("customers", "name", "main", null)
  SQLITE_READ("orders", "status", "main", null)
  SQLITE_READ("customers", "id", "main", null)
  SQLITE_READ("orders", "customer_id", "main", null)
[view]      SQLITE_READ("orders", "id", "main", "confirmed_orders")
[insert]    SQLITE_INSERT("orders", null, "main", null) / SQLITE_READ("customers", "id", "main", null)
[update]    SQLITE_UPDATE("orders", "status", "main", null) / SQLITE_UPDATE("orders", "note", "main", null)
[assert]    SQLITE_READ("solarsql_assert", "ok", "main", "solarsql_assert_check")
[deny customers]
  denied: select o.id, c.name from orders o join customers c on c.id = o.customer_id
          -> access to customers.name is prohibited
[timing]  callbacks during prepare: 3 / callbacks during run: 0
```

Conclusion: the authorizer fires at prepare time only and reports every access per column. A view or trigger passes its name as the fifth argument. A foreign key check reads the parent primary key, so the allowed set of a module includes the referenced primary keys.

## 3. Typing a JSON aggregation without an AST

Commands: `node spike/03-json-typing.ts`, `node spike/03b-json-typing-followups.ts`

### 3a. Expression affinity through CTAS

```
create temp table probe as <query> limit 0; pragma table_xinfo(probe)
  n            type=""      -- count(l.id)
  s            type=""      -- o.status || '!'
  answer       type=""      -- 42
  qty_text     type="TEXT"  -- cast(l.qty as text)
with casts:
  n         type="INT"      -- cast(count(l.id) as integer)
  total     type="REAL"     -- cast(sum(l.qty * l.price) as real)
```

Conclusion: only a CAST gives an expression a type. See ADR 0017.

### 3b. The nullable side of a LEFT JOIN

```
explain query plan select ... left join order_lines l on l.order_id = o.id ...
  "SEARCH l USING AUTOMATIC COVERING INDEX (order_id=?) LEFT-JOIN"
same query plus where l.qty > 0:
  "SCAN l"                                   -- the engine turned it into an inner join
self-join: orders o left join orders p
  "SEARCH p USING INDEX sqlite_autoindex_orders_1 (id=?) LEFT-JOIN"
```

Conclusion: the `LEFT-JOIN` mark names the nullable alias. The engine removes the mark when a WHERE clause excludes NULL, which is more precise than a text scan.

### 3c. Pairs of `json_object` and a probe query

```
pairs: [{"key":"id","value":"l.id"},{"key":"sku","value":"l.sku"},{"key":"qty","value":"l.qty"},{"key":"price","value":"l.price"},{"key":"total","value":"l.qty * l.price"}]
probe: select ..., l.id as __v0, l.sku as __v1, l.qty as __v2, l.price as __v3, l.qty * l.price as __v4 from ... group by o.id
  id     <- l.id            origin=order_lines.id    type=TEXT
  qty    <- l.qty           origin=order_lines.qty   type=INTEGER
  price  <- l.price         origin=order_lines.price type=REAL
  total  <- l.qty * l.price origin=null              type=null
runtime: {"id":"l2","sku":"B","qty":1,"price":null,"total":null}
```

### 3d. One type from engine facts only

```
type Row = { id: string | null; status: "draft" | "confirmed"; note: string | null;
             parent_status: "draft" | "confirmed" | null;
             lines: Array<{ id: string | null; qty: number; price: number | null; total: number | null }> }
```

`id: string | null` is correct for SQLite: a TEXT primary key in a rowid table accepts NULL. See ADR 0018.

```
  orders  {"name":"id","type":"TEXT","nn":0,"pk":1}    -- rowid table
  tags2   {"name":"id","type":"TEXT","nn":1,"pk":1}    -- without rowid
  insert null into tags2.id (without rowid): NOT NULL constraint failed: tags2.id
```

### 3e. A changed SQL string fails tsc

```
npx tsc --ignoreConfig --noEmit --strict ... spike/03c-literal-keyed-types.ts   -> exit 0
npx tsc --ignoreConfig --noEmit --strict ... spike/stale-type/stale.ts
  error TS2345: Argument of type '"select id, status, note from orders where id = ?"' is not assignable to parameter of type 'keyof Generated'.
```

## 4. Migrations from the declared DDL

### 4a. Rebuild order under foreign keys

Command: `node spike/04a-rebuild-under-fk.ts`

```
[A. create new, copy, drop old, rename (no pragma)]                            FAILED: FOREIGN KEY constraint failed
[B. same as A under defer_foreign_keys = on]                                   FAILED: FOREIGN KEY constraint failed
[C. defer, create new, copy to temp, drop old, rename, insert back from temp]  commit ok; orders rows = 2 ; lines rows = 3
[D. pragma foreign_keys = off inside the transaction, then A]                  FAILED: FOREIGN KEY constraint failed
[E. rename old away first, create new under the real name, copy, drop old]     FAILED: FOREIGN KEY constraint failed
```

Conclusion: only order C commits. See ADR 0019.

### 4b. Diff and round trip

Command: `node spike/04-migration-diff.ts`

```
## v1 initial            0001_v1.sql: three CREATE TABLE, one CREATE INDEX
  round trip equal: true / second diff empty: true
## v2 add-column-and-widen-check
  0002_v2.sql
    pragma defer_foreign_keys = on;
    alter table "order_lines" add column price real not null default 0;
    CREATE TABLE "_solarsql_new_orders" (...);
    create table "_solarsql_copy_orders" as select "id", "customer_id", "status" from "orders";
    drop table "orders";
    alter table "_solarsql_new_orders" rename to "orders";
    insert into "orders" ("id", "customer_id", "status") select "id", "customer_id", "status" from "_solarsql_copy_orders";
    drop table "_solarsql_copy_orders";
    drop index "order_lines_order_id";
    CREATE UNIQUE INDEX order_lines_order_id_sku on order_lines (order_id, sku);
  round trip equal: true / second diff empty: true
  rows after rebuild: 2 orders, 2 lines; foreign keys and the new CHECK hold
## v3 rename-without-declaration
  BLOCKED: table orders: columns [note] removed and [memo] added in one change. Declare a rename if the data must move, or split the change into two migrations.
## v3 rename-declared
  0003_v3.sql: alter table "orders" rename column "note" to "memo";
  round trip equal: true / second diff empty: true
```

### 4c. The generated file on the local D1 engine

Command: `npm test` (`test/d1-migration.test.ts`)

```
▶ D1 applies generated migrations
  ✔ the second file rebuilds orders inside one batch
  ✔ the shape after the migration matches the declaration
  ✔ rows survive the rebuild
  ✔ foreign keys, the new CHECK, and the unique index hold after the rebuild
  ✔ a third diff against the declaration is empty on the node:sqlite side
```

wrangler 4.125.0 appends `INSERT INTO d1_migrations (name) values (...)` to the file, splits it into statements, and sends one `batch()` per file on the local engine.

### 4d. Property test

Command: `npm test` (`test/migration-roundtrip.property.test.ts`)

```
property events: {"alter-only":65,"rebuild":72,"no-op":48,"blocked":15}
✔ migration diff round-trips the declared schema
```

Two hundred random schema pairs, with rows in every table, round-trip.
The test found two defects during v0: an index must be dropped before its column, and a NOT NULL column without a default fails on a table with rows.
Both are now rules of the generator.

## 5. RETURNING on D1

Command: `npm test` (`test/d1-returning.test.ts`)

```
all()   returning: "results":[{"id":"n1","body":"one","n":0}]
run()   returning: "results":[{"id":"n3"}]
batch() returning: [[{"id":"n1","n":1}], [{"id":"n2","body":"two"}], [{"id":"n4"}]]
batch failure:     "D1_ERROR: UNIQUE constraint failed: notes.id: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_PRIMARYKEY)"
```

Conclusion: `INSERT`, `UPDATE`, and `DELETE ... RETURNING` return rows through `all()`, `first()`, `run()`, and `batch()` on the local D1 engine. A failed batch rolls the returned rows back with the rest. The remote D1 service was not measured.
