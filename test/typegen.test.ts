// The type generator turns engine facts into TypeScript text. These cases
// pin the text for the shapes the library supports, and the errors for the
// shapes it refuses.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { Engine } from "../src/build/facts.ts";
import { BuildError, Typer, brandName, type Brand } from "../src/build/typegen.ts";
import { GUARD_DDL, assertStatement } from "../src/runtime/plan.ts";

const ddl = [
  `-- A customer.
  create table customers (id text primary key not null, name text not null) strict`,
  `create table orders (
    id text primary key not null,
    customer_id text not null references customers(id),
    parent_id text references orders(id),
    status text not null check (status in ('draft', 'confirmed')),
    note text
  )`,
  `create table order_lines (id text primary key not null, order_id text not null references orders(id), sku text not null, qty integer not null, price real)`,
  `create table files (id text primary key not null, size integer not null, flag integer not null check (flag in (0, 1)), total integer not null as (size * 2) stored, label text as (id || ':' || size) virtual) strict`,
  `create table tags (id text primary key not null, line_id text not null references order_lines(id), name text not null) strict`,
  `create virtual table note_search using fts5(order_id unindexed, note)`,
  ...GUARD_DDL,
];

function typer(): Typer {
  const engine = new Engine(ddl);
  const brands = new Map<string, Brand>();
  for (const t of engine.tables()) {
    const pk = t.columns.filter((c) => c.pk > 0);
    if (pk.length === 1) brands.set(t.name, { table: t.name, column: pk[0]!.name, typeName: brandName(t.name), module: "m" });
  }
  return new Typer(engine, brands);
}

describe("Typer.analyze", () => {
  const t = typer();

  test("a select with a parameter on the primary key", () => {
    const a = t.analyze("-- One order, or none.\nselect id, status, note from orders where id = :id", "orders");
    assert.equal(a.doc, "One order, or none.");
    assert.equal(a.returnsRows, true);
    assert.deepEqual(a.params, [{ name: "id", type: "OrdersId", encode: false }]);
    assert.deepEqual(a.columns, [
      { name: "id", type: "OrdersId", json: false },
      { name: "status", type: '"draft" | "confirmed"', json: false },
      { name: "note", type: "string | null", json: false },
    ]);
    assert.deepEqual([...a.brands], ["OrdersId"]);
  });

  test("an insert infers parameter types from the column list", () => {
    const a = t.analyze("insert into orders (id, customer_id, status) values (:id, :customer_id, 'draft')", "orders");
    assert.equal(a.returnsRows, false);
    assert.deepEqual(a.params, [{ name: "id", type: "OrdersId", encode: false }, { name: "customer_id", type: "CustomersId", encode: false }]);
    assert.deepEqual([...a.brands].sort(), ["CustomersId", "OrdersId"]);
  });

  test("an update infers from SET and WHERE, nullable column allows null", () => {
    const a = t.analyze("update orders set note = :note where id = :id and status = :status", "orders");
    assert.deepEqual(a.params.map((p) => [p.name, p.type]), [["note", "string | null"], ["id", "OrdersId"], ["status", '"draft" | "confirmed"']]);
  });

  test("a JSON aggregation over an outer join with a filter", () => {
    const a = t.analyze(
      `select o.id, c.name as customer_name,
        coalesce(json_group_array(json_object('id', l.id, 'qty', l.qty, 'total', cast(l.qty * l.price as real))) filter (where l.id is not null), '[]') as lines
      from orders o join customers c on c.id = o.customer_id left join order_lines l on l.order_id = o.id
      where o.customer_id = :customer_id group by o.id`,
      "orders",
    );
    assert.deepEqual(a.params, [{ name: "customer_id", type: "CustomersId", encode: false }]);
    assert.deepEqual(a.columns, [
      { name: "id", type: "OrdersId", json: false },
      { name: "customer_name", type: "string", json: false },
      { name: "lines", type: 'Array<{ "id": OrderLinesId; "qty": number; "total": number | null }>', json: true },
    ]);
  });

  test("a one-to-many inside a one-to-many: json((select json_group_array(...))) inside json_object", () => {
    const a = t.analyze(
      "select o.id, coalesce(json_group_array(json_object('id', l.id, 'tags', json((select json_group_array(g.name) from tags g where g.line_id = l.id)))) filter (where l.id is not null), '[]') as lines from orders o left join order_lines l on l.order_id = o.id where o.id = :id group by o.id",
      "orders",
    );
    assert.deepEqual(a.columns, [
      { name: "id", type: "OrdersId", json: false },
      { name: "lines", type: 'Array<{ "id": OrderLinesId; "tags": Array<string> }>', json: true },
    ]);
    // A json_object subquery may find no row, so it allows null.
    const b = t.analyze("select json_object('first', json((select json_object('id', l.id, 'sku', l.sku) from order_lines l where l.order_id = o.id order by l.id limit 1))) as summary from orders o where o.id = :id", "orders");
    assert.deepEqual(b.columns, [{ name: "summary", type: '{ "first": { "id": OrderLinesId; "sku": string } | null }', json: true }]);
    // Without json() the subquery nests as a string, and the build says so.
    assert.throws(
      () => t.analyze("select json_object('id', o.id, 'tags', (select json_group_array(g.name) from tags g where g.line_id = o.id)) as x from orders o", "orders"),
      (e: unknown) => e instanceof BuildError && /Wrap it in json\(\.\.\.\)/.test(e.message),
    );
  });

  test("a JSON aggregation without a filter over an outer join is refused", () => {
    assert.throws(
      () => t.analyze("select o.id, json_group_array(json_object('id', l.id)) as lines from orders o left join order_lines l on l.order_id = o.id group by o.id", "orders"),
      (e: unknown) => e instanceof BuildError && /needs a filter/.test(e.message),
    );
  });

  test("a self join marks the outer side nullable", () => {
    const a = t.analyze("select o.id, p.status as parent_status from orders o left join orders p on p.id = o.parent_id", "orders");
    assert.deepEqual(a.columns, [
      { name: "id", type: "OrdersId", json: false },
      { name: "parent_status", type: '"draft" | "confirmed" | null', json: false },
    ]);
  });

  test("an expression column needs a cast", () => {
    assert.throws(() => t.analyze("select count(*) as n from orders", "orders"), (e: unknown) => e instanceof BuildError && /cast\(\.\.\. as integer\)/.test(e.message));
    const a = t.analyze("select cast(count(*) as integer) as n from orders", "orders");
    assert.deepEqual(a.columns, [{ name: "n", type: "number", json: false }]);
  });

  test("a cast over count, exists, a ranking function, or coalesce with a literal is not null; other expressions are", () => {
    const types = (sql: string) => t.analyze(sql, "orders").columns.map((c) => c.type);
    assert.deepEqual(types("select cast(count(id) as integer) as a, cast(total(qty) as real) as b, cast(exists (select 1 from orders) as integer) as c from order_lines"), ["number", "number", "number"]);
    assert.deepEqual(types("select cast(row_number() over (order by id) as integer) as rn, cast(count(*) filter (where qty > 1) as integer) as big from order_lines"), ["number", "number"]);
    assert.deepEqual(types("select cast(coalesce(sum(qty), 0) as integer) as a, cast(ifnull(note, 'none') as text) as b from orders o join order_lines l on l.order_id = o.id"), ["number", "string"]);
    // sum can be null, a division can be null, and coalesce with a nullable column stays nullable.
    assert.deepEqual(types("select cast(sum(qty) as integer) as a, cast(count(*) / nullif(qty, 0) as integer) as b, cast(coalesce(sku, note) as text) as c from order_lines l join orders o on o.id = l.order_id"), ["number | null", "number | null", "string | null"]);
    // Inside json_object the same rule applies.
    assert.deepEqual(types("select json_object('n', cast(count(*) as integer), 's', cast(sum(qty) as integer)) as o from order_lines"), ['{ "n": number; "s": number | null }']);
  });

  test("one parameter at two sites: null only when every site allows it, and CASE lists union", () => {
    const a = t.analyze("select id from orders where id = :id or parent_id = :id", "orders");
    assert.deepEqual(a.params, [{ name: "id", type: "OrdersId", encode: false }]);
    const b = t.analyze("select id from orders where note = :n or note = :n", "orders");
    assert.deepEqual(b.params, [{ name: "n", type: "string | null", encode: false }]);
    const c = t.analyze("select id from orders order by case :dir when 'asc' then id end asc, case :dir when 'desc' then id end desc", "orders");
    assert.deepEqual(c.params, [{ name: "dir", type: '"asc" | "desc"', encode: false }]);
  });

  test("insert or ignore, insert or replace, and replace into type their parameters", () => {
    for (const head of ["insert or ignore into", "insert or replace into", "replace into"]) {
      const a = t.analyze(`${head} customers (id, name) values (:id, :name)`, "customers");
      assert.deepEqual(a.params.map((p) => [p.name, p.type]), [["id", "CustomersId"], ["name", "string"]], head);
    }
  });

  test("json_each anywhere: a bulk update from JSON rows is an encoded array of typed objects", () => {
    const a = t.analyze("update order_lines set qty = (select value ->> 'qty' from json_each(:lines) where value ->> 'id' = order_lines.id) where order_id = :order_id and id in (select value ->> 'id' from json_each(:lines))", "orders");
    assert.deepEqual(a.params, [
      { name: "lines", type: 'readonly { "qty": number; "id": OrderLinesId }[]', encode: true },
      { name: "order_id", type: "OrdersId", encode: false },
    ]);
    // A key with no column context is SqlValue; a bare use is an array of SqlValue.
    const b = t.analyze("select cast(value ->> 'x' as text) as x from json_each(:rows)", "orders");
    assert.deepEqual(b.params, [{ name: "rows", type: 'readonly { "x": SqlValue }[]', encode: true }]);
    const c = t.analyze("delete from order_lines where id in (select value from json_each(:ids)) and :ids is not null", "orders");
    assert.deepEqual(c.params, [{ name: "ids", type: "readonly OrderLinesId[] | null", encode: true }]);
    const d = t.analyze("insert into customers (id, name) select value, 'anon' from json_each(:ids)", "customers");
    assert.deepEqual(d.params, [{ name: "ids", type: "readonly CustomersId[]", encode: true }]);
  });

  test("an anonymous parameter is refused", () => {
    assert.throws(() => t.analyze("select id from orders where id = ?", "orders"), (e: unknown) => e instanceof BuildError && /named parameter/.test(e.message));
  });

  test("one parameter with two types is refused", () => {
    assert.throws(() => t.analyze("select id from orders where id = :x or customer_id = :x", "orders"), (e: unknown) => e instanceof BuildError && /two different types/.test(e.message));
  });

  test("the engine's message for an unknown column is kept", () => {
    assert.throws(() => t.analyze("select nope from orders", "orders"), (e: unknown) => e instanceof BuildError && /no such column: nope/.test(e.message));
  });

  test("an assert predicate as its composed statement", () => {
    const a = t.analyze(assertStatement("has_lines", "exists (select 1 from order_lines where order_id = :id)"), "orders");
    assert.equal(a.returnsRows, false);
    assert.deepEqual(a.params, [{ name: "id", type: "OrdersId", encode: false }]);
  });

  test("insert ... select from json_each types the rows parameter from the column list", () => {
    const a = t.analyze("insert into order_lines (id, order_id, sku, qty) select value ->> 'id', :order_id, value ->> 'sku', value ->> 'qty' from json_each(:lines)", "orders");
    assert.deepEqual(a.params, [
      { name: "order_id", type: "OrdersId", encode: false },
      { name: "lines", type: 'readonly { "id": OrderLinesId; "sku": string; "qty": number }[]', encode: true },
    ]);
  });

  test("an IN list through json_each is an array of the column type", () => {
    const a = t.analyze("select id from orders o where o.id in (select value from json_each(:ids))", "orders");
    assert.deepEqual(a.params, [{ name: "ids", type: "readonly OrdersId[]", encode: true }]);
  });

  test("a sort chosen by a parameter is a union, and limit and offset are numbers", () => {
    const a = t.analyze("select id from orders where customer_id = :c order by case :sort when 'id' then id when 'status' then status end limit :limit offset :offset", "orders");
    assert.deepEqual(a.params.map((p) => [p.name, p.type]), [["c", "CustomersId"], ["sort", '"id" | "status"'], ["limit", "number"], ["offset", "number"]]);
  });

  test("an optional filter is reported as a full scan", () => {
    const a = t.analyze("select id from orders where (:status is null or status = :status)", "orders");
    assert.deepEqual(a.params, [{ name: "status", type: '"draft" | "confirmed" | null', encode: false }]);
    assert.deepEqual(a.scans, ["orders"]);
    assert.deepEqual(t.analyze("select id from orders where id = :id", "orders").scans, []);
  });

  test("a generated column is read with its type, and an integer check list is a union of numbers", () => {
    const a = t.analyze("select id, size, flag, total, label from files where flag = :flag", "files");
    assert.deepEqual(a.columns.map((c) => [c.name, c.type]), [["id", "FilesId"], ["size", "number"], ["flag", "0 | 1"], ["total", "number"], ["label", "string | null"]]);
    assert.deepEqual(a.params, [{ name: "flag", type: "0 | 1", encode: false }]);
    // The engine refuses a write to a generated column, with its own message.
    assert.throws(() => t.analyze("insert into files (id, size, flag, total) values (:id, :size, :flag, :total)", "files"), (e: unknown) => e instanceof BuildError && /generated column/.test(e.message));
  });

  test("a full-text search table: text columns, a numeric rank, and a string match parameter", () => {
    const a = t.analyze("select order_id, note, rank, cast(bm25(note_search) as real) as score from note_search where note_search match :q order by rank", "orders");
    assert.deepEqual(a.columns.map((c) => [c.name, c.type]), [["order_id", "string | null"], ["note", "string | null"], ["rank", "number | null"], ["score", "number | null"]]);
    assert.deepEqual(a.params, [{ name: "q", type: "string", encode: false }]);
    assert.deepEqual(a.scans, []);
    const b = t.analyze("insert into note_search (order_id, note) values (:id, :note)", "orders");
    assert.deepEqual(b.params.map((p) => [p.name, p.type]), [["id", "string | null"], ["note", "string | null"]]);
  });

  test("returning gives rows with brands", () => {
    const a = t.analyze("insert into customers (id, name) values (:id, :name) returning id, name", "customers");
    assert.equal(a.returnsRows, true);
    assert.deepEqual(a.columns, [{ name: "id", type: "CustomersId", json: false }, { name: "name", type: "string", json: false }]);
  });
});

describe("row type soundness", () => {
  test("compound JSON decoding requires compatible branch values", () => {
    const engine = new Engine(["create table a(id text primary key, n integer not null) strict"]);
    try {
      const t = new Typer(engine, new Map());
      assert.throws(() => t.analyze("select json_object('n', n) as value from a union all select 'text'", "m"), /mixes decoded JSON/);
      assert.deepEqual(t.analyze("select cast(json_object('n', n) as text) as value from a union all select 'text'", "m").columns, [{ name: "value", type: "string | null", json: false }]);
      assert.doesNotThrow(() => t.analyze("select cast('union right join' as text) as value from a /* full join */", "m"));
      assert.doesNotThrow(() => t.analyze('select n as "union" from a', "m"));
      assert.throws(() => t.analyze("with recursive x(n) as (select 1 union all select n+1 from x where n<3) select n from x", "m"), /expression with no type/);
    } finally { engine.close(); }
  });

  test("JSON filters narrow only the outer alias whose NULL rows they exclude", () => {
    const engine = new Engine([
      "create table a(id text primary key, n integer not null) strict",
      "create table b(id text primary key, n integer not null) strict",
      "create table c(id text primary key, n integer not null) strict",
    ]);
    try {
      engine.db.exec("insert into a values ('a',1); insert into b values ('a',2)");
      const t = new Typer(engine, new Map());
      for (const predicate of ["a.id is not null", "b.id is not null or 1", "b.n is null"]) {
        const sql = `select json_group_array(json_object('n', c.n)) filter(where ${predicate}) as value from a left join b on a.id=b.id left join c on a.id=c.id`;
        assert.equal(t.analyze(sql, "m").columns[0]!.type, 'Array<{ "n": number | null }>');
        assert.deepEqual(JSON.parse(engine.db.prepare(sql).get()!.value as string), predicate === "b.n is null" ? [] : [{ n: null }]);
      }
      const sql = "select json_group_array(json_object('bn', b.n, 'cn', c.n)) filter(where b.id is not null) as value from a left join b on a.id=b.id left join c on a.id=c.id";
      assert.equal(t.analyze(sql, "m").columns[0]!.type, 'Array<{ "bn": number; "cn": number | null }>');
      assert.deepEqual(JSON.parse(engine.db.prepare(sql).get()!.value as string), [{ bn: 2, cn: null }]);
    } finally {
      engine.close();
    }
  });
});

test("origin columns retain NULL from views, query scopes, scalar subqueries, and wildcard joins", () => {
  const engine = new Engine([
    "create table a(id integer primary key not null) strict",
    "create table b(id integer primary key not null) strict",
    "create view v as select b.id from a left join b on a.id=b.id",
  ]);
  try {
    engine.db.exec("insert into a values (1)");
    const t = new Typer(engine, new Map());
    for (const sql of [
      "select v.id from v", "select id from v",
      "select x.id from (select b.id from a left join b on a.id=b.id) x",
      "with x as (select b.id from a left join b on a.id=b.id) select x.id from x",
      "with b as (select inner_b.id from a left join main.b inner_b on a.id=inner_b.id) select b.id from b",
      "select b.* from a left join b on a.id=b.id",
      "select (select id from b) as id",
    ]) {
      assert.equal(engine.db.prepare(sql).get()!.id, null, sql);
      assert.equal(t.analyze(sql, "m").columns[0]!.type, "number | null", sql);
    }
    assert.throws(() => t.analyze("select * from a left join b on a.id=b.id", "m"), /duplicate output column.*id/);
    assert.throws(() => t.analyze("select a.id, b.id from a left join b on a.id=b.id", "m"), /duplicate output column.*id/);
  } finally { engine.close(); }
});

test('CHECK literals describe stored classes only when the complete predicate proves them', () => {
  for (const [definition, input, expected] of [
    ['text not null check(value in (1))', 1, 'string'],
    ["integer not null check(value in ('1'))", '1', 'number'],
    ['real not null check(value in (1))', 1, '1'],
    ["any not null check(value in ('1'))", '1', '"1"'],
    ["text not null check(value in ('a') or value='b')", 'b', 'string'],
    ["text check(value in ('a','b') or value is null)", null, '"a" | "b" | null'],
    ["text check(value in ('a','b') or value is null)", 'a', '"a" | "b" | null'],
    ["text check(value is null or value in ('a','b'))", 'b', '"a" | "b" | null'],
    ["text check(value in ('a') or value is not null)", null, 'string | null'],
    ["text collate nocase not null check(value in ('a'))", 'A', 'string'],
    ["text collate rtrim not null check(value in ('a'))", 'a ', 'string'],
    ["text collate binary not null check(value in ('A'))", 'A', '"A"'],
    ["text not null check(value in ('x)y''z'))", "x)y'z", '"x)y\'z"'],
    ["text not null check(value in ('\r'))", '\r', '"\\r"'],
    ['integer not null check(value in (-1, +2))', -1, '-1 | 2'],
    ['real not null check(value in (1e999))', Infinity, 'number'],
    ["text check(value in ('a'))", null, '"a" | null'],
  ] as const) {
    const engine = new Engine([`create table t(value ${definition}) strict`]);
    try {
      const literal = typeof input === 'string' ? `'${input.replaceAll("'","''")}'` : input === null ? 'null' : Number.isFinite(input) ? String(input) : '1e999';
      engine.db.exec(`insert into t values (${literal})`);
      assert.equal(new Typer(engine,new Map()).analyze('select value from t','t').columns[0]!.type,expected,definition);
      const actual = engine.db.prepare('select value from t').get()!.value;
      if (expected === 'string' || expected === 'number') assert.equal(typeof actual,expected);
      else assert.deepEqual(actual,input);
    } finally {engine.close();}
  }
});

test('CHECK types admit the values SQLite stores after affinity conversion', async () => {
  const {test:property} = await import('@hegeldev/hegel');
  const gs = await import('@hegeldev/hegel/generators');
  property(tc => {
    const storage = tc.draw(gs.sampledFrom(['text','integer','real','any']));
    const n = tc.draw(gs.integers({minValue:-1_000_000,maxValue:1_000_000}));
    let value: string | number = tc.draw(gs.booleans()) ? n : String(n);
    if ((storage === 'text' || storage === 'any') && tc.draw(gs.booleans())) {
      // NUL cannot appear in SQL source. It is not a valid DDL string literal.
      value = tc.draw(gs.text({maxSize:50})).replaceAll('\0','');
    }
    const literal = typeof value === 'string' ? `'${value.replaceAll("'","''")}'` : String(value);
    const engine = new Engine([`create table t(value ${storage} not null check(value in (${literal}))) strict`]);
    try {
      // Use the same SQL literal class; Node number parameters bind as REAL.
      engine.db.exec(`insert into t values (${literal})`);
      const actual = engine.db.prepare('select value from t').get()!.value;
      const type = new Typer(engine,new Map()).analyze('select value from t','t').columns[0]!.type;
      if (type === 'string' || type === 'number') assert.equal(typeof actual,type);
      else assert.deepEqual(actual,JSON.parse(type));
    } finally {engine.close();}
  });
});

test('conflicting parameter types identify the generated qualified key', () => {
  const engine=new Engine(['create table items(id integer not null,value text not null) strict']);
  try {
    const typer=new Typer(engine,new Map());
    assert.throws(()=>typer.analyze('select id from items where id=:id or value=:id or id=@id',''), /parameter ":id" is used with two different types/);
  }finally{engine.close();}
});

test('JSON constructors describe decoded JSONB and flexible storage values', () => {
  for (const storage of ['blob', 'any']) {
    const engine=new Engine([`create table payload(value ${storage}) strict`]);
    try {
      const typer=new Typer(engine,new Map());
      assert.equal(typer.analyze("select json_object('data',value) as result from payload",'').columns[0]!.type,'{ "data": JsonValue }');
      assert.equal(typer.analyze('select json_group_array(value) as result from payload','').columns[0]!.type,'Array<JsonValue>');
      for (const value of [{nested:[true,null,3]},[1,'a'],true,null,17,'text']) {
        engine.db.prepare('insert into payload values(jsonb(?))').run(JSON.stringify(value));
        assert.deepEqual(JSON.parse(engine.db.prepare("select json_object('data',value) as result from payload").get()!.result as string),{data:value});
        engine.db.exec('delete from payload');
      }
      engine.db.exec("insert into payload values(x'00ff')");
      assert.throws(()=>engine.db.prepare("select json_object('data',value) from payload").get(),/JSON/);
      if(storage==='blob') assert.equal(typer.analyze('select value from payload','').columns[0]!.type,'Uint8Array | null');
      assert.equal(typer.analyze("select json_object('data',cast(value as text)) as result from payload",'').columns[0]!.type,'{ "data": string | null }');
      assert.equal(typer.analyze("select json_object('data',null,'count',3) as result",'').columns[0]!.type,'{ "data": null; "count": number }');
    }finally{engine.close();}
  }
});

test('JSONB constructor values round-trip nested generated JSON', async () => {
  const {test:property}=await import('@hegeldev/hegel');
  const gs=await import('@hegeldev/hegel/generators');
  const engine=new Engine(['create table payload(value blob not null) strict']);
  try {
    const insert=engine.db.prepare('insert into payload values(jsonb(?))');
    const read=engine.db.prepare("select json_object('data',value) as result from payload");
    property(tc=>{
      const value={items:tc.draw(gs.arrays(gs.integers({minValue:-100000,maxValue:100000}))),text:tc.draw(gs.text()),nested:{flag:tc.draw(gs.booleans()),empty:null}};
      engine.db.exec('delete from payload');
      insert.run(JSON.stringify(value));
      assert.deepEqual(JSON.parse(read.get()!.result as string),{data:value});
      assert.equal(new Typer(engine,new Map()).analyze("select json_object('data',value) as result from payload",'').columns[0]!.type,'{ "data": JsonValue }');
    },{testCases:1000});
  }finally{engine.close();}
});

test('BLOB literal types preserve engine values across query scopes', async () => {
  const {test:property}=await import('@hegeldev/hegel');
  const gs=await import('@hegeldev/hegel/generators');
  const engine=new Engine([]);
  try {
    property(tc=>{
      const bytes=Uint8Array.from(tc.draw(gs.binary()));
      const hex=Buffer.from(bytes).toString('hex');
      const literal=tc.draw(gs.booleans()) ? `x'${hex}'` : `X'${hex.toUpperCase()}'`;
      for(const sql of [`select ${literal}`,`values (${literal})`,`with data as (select ${literal} as value) select value from data`,`select value from (select (${literal}) as value)`]) {
        const analysis=new Typer(engine,new Map()).analyze(sql,'');
        assert.equal(analysis.sql,sql);
        assert.equal(analysis.columns[0]!.type,'Uint8Array');
        const statement=engine.db.prepare(sql);
        assert.equal(analysis.columns[0]!.name,statement.columns()[0]!.name);
        assert.deepEqual(statement.get()![analysis.columns[0]!.name],bytes);
      }
    },{testCases:1000});
    for(const literal of ["x'0'","x'gg'","x'00"]) assert.throws(()=>new Typer(engine,new Map()).analyze(`select ${literal}`,''));
    assert.equal(new Typer(engine,new Map()).analyze("values (x''),(null)",'').columns[0]!.type,'Uint8Array | null');
    const jsonb=engine.db.prepare("select hex(jsonb('{\"data\":[true,null]}')) as value").get()!.value;
    const sql=`select json_object('value',x'${jsonb}') as result`;
    assert.equal(new Typer(engine,new Map()).analyze(sql,'').columns[0]!.type,'{ "value": JsonValue }');
    assert.deepEqual(JSON.parse(engine.db.prepare(sql).get()!.result as string),{value:{data:[true,null]}});
  }finally{engine.close();}
});

test('JSON decoding follows the complete expression and explicit scalar casts', async () => {
  const {test:property}=await import('@hegeldev/hegel');
  const gs=await import('@hegeldev/hegel/generators');
  const {parseJson}=await import('../src/runtime/plan.ts');
  const engine=new Engine([]);
  try {
    property(tc=>{
      const n=tc.draw(gs.integers({minValue:-100000,maxValue:100000}));
      const json=`json_object('value',${n})`;
      const [expr,type]=tc.draw(gs.sampledFrom([
        [`length(${json})`,'integer'],[`${json} = '{}'`,'integer'],[`${json} || 'suffix'`,'text'],
        [`substr(${json},1,2)`,'text'],[`case when 1 then ${json} else '{}' end`,'text'],
      ]));
      const sql=`select ${expr} as value`;
      engine.db.prepare(sql).get();
      assert.throws(()=>new Typer(engine,new Map()).analyze(sql,''),/cast/);
      assert.throws(()=>new Typer(engine,new Map()).analyze(`select json_group_array(${expr}) as value`,''),/cast/);
      const cast=`select cast(${expr} as ${type}) as value`;
      const analysis=new Typer(engine,new Map()).analyze(cast,'');
      assert.deepEqual(analysis.columns,[{name:'value',type:type==='integer'?'number | null':'string | null',json:false}]);
      const actual=engine.db.prepare(cast).get()!;
      assert.deepEqual(parseJson([actual],analysis.columns.filter(c=>c.json).map(c=>c.name),'native'),[{...actual}]);
    },{testCases:1000});
    for(const expr of ["json_group_array(json_object('value',1)) filter(where 1) over ()","coalesce(json_group_array(json_object('value',1)) filter(where 1), '[]')","(json_group_array(json_object('value',1)))"]) {
      const sql=`select ${expr} as value`;
      assert.deepEqual(new Typer(engine,new Map()).analyze(sql,'').columns,[{name:'value',type:'Array<{ "value": number }>',json:true}]);
      assert.deepEqual(JSON.parse(engine.db.prepare(sql).get()!.value as string),[{value:1}]);
    }
    assert.throws(()=>new Typer(engine,new Map()).analyze("select json_object('value',json((select json_group_array(1))) || 'x')",''),/cast/);
    assert.throws(()=>new Typer(engine,new Map()).analyze("select json_object('value',json((select length(json_group_array(1)))))",''),/cast/);
  }finally{engine.close();}
});

test('complete BLOB casts retain binary values through SQL trivia and scopes', async () => {
  const {test:property}=await import('@hegeldev/hegel');
  const gs=await import('@hegeldev/hegel/generators');
  const engine=new Engine([]);
  try {
    property(tc=>{
      const bytes=Uint8Array.from(tc.draw(gs.binary()));
      const literal=`x'${Buffer.from(bytes).toString('hex')}'`;
      const gap=tc.draw(gs.sampledFrom([' ','\n',' /* conversion */ ']));
      const cast=`(cast${gap}(${literal}${gap}as${gap}BLOB))`;
      for(const sql of [`select ${cast} as value`,`with data as (select ${cast} as value) select value from data`]) {
        const analysis=new Typer(engine,new Map()).analyze(sql,'');
        assert.deepEqual(analysis.columns,[{name:'value',type:'Uint8Array | null',json:false}]);
        assert.equal(analysis.sql,sql);
        assert.deepEqual(engine.db.prepare(sql).get()!.value,bytes);
      }
    },{testCases:1000});
    for(const target of ['integer','real','text','blob']) {
      const sql=`select json_object('value',(cast /* note */ (null AS /* note */ ${target}))) as value`;
      const type=target==='blob'?'JsonValue':target==='text'?'string | null':'number | null';
      assert.equal(new Typer(engine,new Map()).analyze(sql,'').columns[0]!.type,`{ "value": ${type} }`);
      assert.deepEqual(JSON.parse(engine.db.prepare(sql).get()!.value as string),{value:null});
    }
    for(const inner of ['exists(select 1) + null','not exists(select 1) + null']) {
      const sql=`select cast /* why */ (${inner} as integer) as value`;
      assert.equal(new Typer(engine,new Map()).analyze(sql,'').columns[0]!.type,'number | null');
      assert.equal(engine.db.prepare(sql).get()!.value,null);
    }
    assert.equal(new Typer(engine,new Map()).analyze('select cast /* why */ (count(*) as integer) as value','').columns[0]!.type,'number');
    assert.throws(()=>new Typer(engine,new Map()).analyze("select json_object('value',length(cast('x' as text)))",''),/cast/);
    assert.throws(()=>new Typer(engine,new Map()).analyze("select json_object('value',cast(1 as integer) + 2)",''),/cast/);
  }finally{engine.close();}
});

test('decoded JSON object keys use the last value contract', async () => {
  const {test:property}=await import('@hegeldev/hegel');
  const gs=await import('@hegeldev/hegel/generators');
  const engine=new Engine([]);
  try {
    property(tc=>{
      // SQLite source literals cannot contain NUL; every other drawn character remains.
      const key=tc.draw(gs.text()).replaceAll('\0','');
      const literal=`'${key.replaceAll("'","''")}'`;
      const sql=`select json_object(${literal},length('overwritten'),/* last */ (${literal}), 'last') as value`;
      const analysis=new Typer(engine,new Map()).analyze(sql,'');
      assert.equal(analysis.sql,sql);
      assert.equal(analysis.columns[0]!.type,`{ ${JSON.stringify(key)}: string }`);
      assert.deepEqual(JSON.parse(engine.db.prepare(sql).get()!.value as string),{[key]:'last'});
    },{testCases:1000});
    const sql="select json_object('data',1,'data',json_object('nested',null),'__proto__','safe') as value";
    assert.equal(new Typer(engine,new Map()).analyze(sql,'').columns[0]!.type,'{ "data": { "nested": null }; "__proto__": string }');
    assert.deepEqual(JSON.parse(engine.db.prepare(sql).get()!.value as string),{data:{nested:null},['__proto__']:'safe'});
    assert.throws(()=>new Typer(engine,new Map()).analyze("select json_object(cast('key' as text),1)",''),/key must be a string literal/);
  }finally{engine.close();}
});

test('ordered JSON aggregates retain value types and SQLite ordering', async () => {
  const {test:property}=await import('@hegeldev/hegel');
  const gs=await import('@hegeldev/hegel/generators');
  const engine=new Engine(['create table items(value integer) strict']);
  try {
    const insert=engine.db.prepare('insert into items values(?)');
    property(tc=>{
      const values:(number|null)[]=tc.draw(gs.arrays(gs.integers({minValue:-10000,maxValue:10000})));
      if(tc.draw(gs.booleans())) values.push(null);
      const distinct=tc.draw(gs.booleans());
      const desc=tc.draw(gs.booleans());
      engine.db.exec('delete from items');for(const value of values) insert.run(value);
      const sql=`select json_group_array(${distinct?'distinct ':''}value order by value ${desc?'desc':'asc'}) as result from items`;
      const analysis=new Typer(engine,new Map()).analyze(sql,'');
      assert.deepEqual(analysis.columns,[{name:'result',type:'Array<number | null>',json:true}]);
      assert.equal(analysis.sql,sql);
      const expected=(distinct?[...new Set(values)]:[...values]).sort((a,b)=>{const cmp=a===b?0:a===null?-1:b===null?1:a-b;return desc?-cmp:cmp;});
      assert.deepEqual(JSON.parse(engine.db.prepare(sql).get()!.result as string),expected);
    },{testCases:1000});
    engine.db.exec('delete from items;insert into items values(1),(2),(null)');
    for(const sql of [
      "select json_group_array(json_object('n',value) order by coalesce(value,0) desc, cast(value as text) collate binary) filter(where value is not null) as result from items",
      "select json_group_array(distinct json_object('n',value) order by value desc) filter(where value is not null) as result from items",
    ]) {
      assert.equal(new Typer(engine,new Map()).analyze(sql,'').columns[0]!.type,'Array<{ "n": number | null }>');
      assert.deepEqual(JSON.parse(engine.db.prepare(sql).get()!.result as string),[{n:2},{n:1}]);
    }
    assert.throws(()=>new Typer(engine,new Map()).analyze('select json_group_array(value order by) from items',''));
  }finally{engine.close();}
});

test('numeric literal spellings retain their engine type and source', async () => {
  const {test:property}=await import('@hegeldev/hegel');
  const gs=await import('@hegeldev/hegel/generators');
  const {tokenize}=await import('../src/build/scan.ts');
  const engine=new Engine([]);
  try {
    property(tc=>{
      const n=tc.draw(gs.integers({minValue:0,maxValue:Number.MAX_SAFE_INTEGER}));
      const hex=tc.draw(gs.booleans());
      const digits=n.toString(hex?16:10);
      const separated=tc.draw(gs.booleans())?digits.split('').join('_'):digits;
      const literal=hex?`${tc.draw(gs.booleans())?'0X':'0x'}${separated}`:separated;
      assert.deepEqual(tokenize(literal),[{type:'number',text:literal,start:0,end:literal.length,depth:0}]);
      for(const sql of [`select ${literal} as value`,`values (${literal})`,`with data as (select ${literal} as value) select value from data`]) {
        const analysis=new Typer(engine,new Map()).analyze(sql,'');
        assert.equal(analysis.sql,sql);
        assert.equal(analysis.columns[0]!.type,'number');
        assert.equal(engine.db.prepare(sql).get()![analysis.columns[0]!.name],n);
      }
    },{testCases:1000});
    for(const literal of ['1.','1.e2','.1_2','1_2.3_4e+0_2','-0Xf_f','+1_000','0XFF']) {
      const sql=`select json_object('value',${literal}) as result`;
      assert.equal(new Typer(engine,new Map()).analyze(sql,'').columns[0]!.type,'{ "value": number }');
      const expected=/^[+-]?0x/i.test(literal)?(literal[0]==='-'?-1:1)*Number(literal.replace(/^[+-]/,'').replaceAll('_','')):Number(literal.replaceAll('_',''));
      assert.deepEqual(JSON.parse(engine.db.prepare(sql).get()!.result as string),{value:expected});
    }
    for(const literal of ['1__2','0X_FF','1_.0','1._0','1e_2']) assert.throws(()=>new Typer(engine,new Map()).analyze(`select ${literal} as value`,''));
    const sql="select 1_000 + :amount, '0XFF' as quoted";
    const tokens=tokenize(sql);
    assert.equal(tokens.map(t=>t.text).join(''),sql);
    assert.deepEqual(tokens.filter(t=>t.type==='param').map(t=>t.text),[':amount']);
    for(const token of tokens)assert.equal(sql.slice(token.start,token.end),token.text);
  }finally{engine.close();}
});
