# v2 measurements

Date: 2026-09-06.
These experiments test the points where other libraries seemed to win, one by one.
Node 26.7.0, Miniflare 5.20260828.0-alpha with workerd 1.20260828.1.
Nothing here ran against a remote D1 database.

## 1. Dynamic SQL as static SQL

Question: can the four needs that fragment APIs serve be one static statement each, and what does the engine do with them?

Commands:

```
node spike/06-dynamic-sql-node.ts
node --test spike/06-dynamic-sql-d1.test.ts
```

Query plans on node:sqlite, 5000 rows, indexes on `customer_id` and `status`:

```
[optional filter, OR form]        SCAN orders
[optional filter, COALESCE form]  SCAN orders
[static query, customer only]     SEARCH orders USING INDEX orders_customer (customer_id=?)
[IN list through json_each]       SEARCH orders USING COVERING INDEX sqlite_autoindex_orders_1 (id=?)
[sort column by parameter]        SCAN orders / USE TEMP B-TREE FOR ORDER BY
[paging]                          SEARCH orders USING INDEX orders_customer (customer_id=?) / USE TEMP B-TREE FOR ORDER BY
```

Timing, 1000 runs each:

```
OR form, customer given         0.215 ms/run
COALESCE form, customer given   0.238 ms/run
static query, customer given    0.041 ms/run
IN via json_each, 200 ids       0.145 ms/run
IN via 200 placeholders         0.154 ms/run
```

D1 in Miniflare:

```
200 placeholders:    {"ok":false,"message":"D1_ERROR: too many SQL variables at offset 230: SQLITE_ERROR"}
100 placeholders:    {"ok":true,"rows":100}
101 placeholders:    {"ok":false,"message":"D1_ERROR: too many SQL variables at offset 230: SQLITE_ERROR"}
json_each, 200 ids:  {"ok":true,"rows":200}
json_each, 5000 ids: {"ok":true,"rows":300}
```

Conclusions:

- A `json_each` list uses the index, costs the same as placeholders, and is the only form that passes 100 values on D1.
- The optional-filter idiom disables the index. The build now reports every statement whose plan scans a table despite a `WHERE`, so the agent can split the query.
- A sort column chosen by `CASE` sorts in a temporary b-tree, as any run-time sort does.

See ADR 0028. The example project has `orderQueries.byIds` and `orderQueries.search`, and `test/example.test.ts` runs them on both targets with 152 ids.

## 2. STRICT tables and runtime validation

Question: does a runtime check of each row add anything that the engine cannot guarantee?

Commands:

```
node spike/07-strict-node.ts
node --test spike/07-strict-d1.test.ts
```

node:sqlite:

```
## plain table
  text into integer column        accepted -> {"id":"a","n":"twelve",...} (typeof n = string)
  float into integer column       accepted -> {"id":"c","n":1.5,...}
  blob into real column           accepted -> {"id":"e","r":{"0":0},...}
## strict table
  text into integer column        rejected: cannot store TEXT value in INTEGER column strict_t.n
  numeric text into integer       accepted -> {"id":"b","n":12,...}
  float into integer column       rejected: cannot store REAL value in INTEGER column strict_t.n
  integer into text column        accepted -> {"id":"d","t":"42",...}
  blob into real column           rejected: cannot store BLOB value in REAL column strict_t.r
  unknown declared type           rejected: unknown datatype for strict_bad.v: "varchar(10)"
## cost of a runtime check per row (node, 100k rows)
  0.5 ns/row
```

D1 in Miniflare:

```
create strict:      {"ok":true}
text into integer:  {"ok":false,"message":"D1_ERROR: cannot store TEXT value in INTEGER column s.n: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_DATATYPE)"}
read back:          {"rows":[{"id":"b","n":12,"r":1.5,"big":9007199254740992}],"types":[{"id":"string","n":"number","r":"number","big":"number"}]}
plain table:        {"rows":[{"id":"a","n":"twelve"}],"types":[{"id":"string","n":"string"}]}
```

Conclusions:

- Without STRICT the generated types can be false at run time, on both engines.
- With STRICT the engine rejects the write, so a read-time check has nothing left to find. The build requires STRICT (ADR 0029).
- D1 returned 9007199254740993 as 9007199254740992: an INTEGER above 2^53 loses precision as a JavaScript number.
- `test/strict-migration.test.ts` shows that adding `strict` to a table with a bad stored value fails the rebuild and rolls the file back.

## 3. Constraint errors on the three engines

Question: can the adapter turn a rejected row into a value with one parser?

Command: `node --test spike/08-errors.test.ts`

```
node   unique pk      "UNIQUE constraint failed: t.id" errcode=1555
node   unique column  "UNIQUE constraint failed: t.email" errcode=2067
node   check unnamed  "CHECK constraint failed: n > 0" errcode=275
node   check named    "CHECK constraint failed: status_ok" errcode=275
node   not null       "NOT NULL constraint failed: t.email" errcode=1299
node   foreign key    "FOREIGN KEY constraint failed" errcode=787
node   datatype       "cannot store TEXT value in INTEGER column t.n" errcode=3091
d1     unique column  "D1_ERROR: UNIQUE constraint failed: t.email: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_UNIQUE)"
do     unique column  "UNIQUE constraint failed: t.email: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_UNIQUE)"
```

The other kinds follow the same pattern on D1 and on the Durable Object: the node:sqlite text, then `: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_<KIND>)`, and `D1_ERROR: ` in front on D1.

Conclusion: one parser covers the three engines. `test/failure.test.ts` round-trips generated messages through the three formats. See ADR 0030.
