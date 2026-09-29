// The scanner reads SQL text without a grammar. Properties: the tokens join
// back into the input, a named parameter inside a string literal is not a
// parameter, and statements split at top-level semicolons only.
import { describe, test } from "vitest";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { aliasMap, columnRef, created, definitions, leadingComment, namedParams, normalize, paramSites, quoteIdent, renamedColumn, selectItems, significant, splitStatements, sqliteName, tokenize, unconditionalMatchAliases } from "../src/build/scan.ts";

const ident = gs.fromRegex("[a-z_][a-z0-9_]{0,6}");
const fragment = gs.composite((tc): string => {
  const kind = tc.draw(gs.integers({ minValue: 0, maxValue: 6 }));
  switch (kind) {
    case 0: return tc.draw(ident);
    case 1: return `'${tc.draw(gs.text({ maxSize: 6 })).replace(/'/g, "''")}'`;
    case 2: return `"${tc.draw(ident)}"`;
    case 3: return `:${tc.draw(ident)}`;
    case 4: return String(tc.draw(gs.integers({ minValue: 0, maxValue: 999 })));
    case 5: return tc.draw(gs.sampledFrom(["(", ")", ",", "=", "<>", "||", ".", "*", ";"]));
    default: return tc.draw(gs.sampledFrom([" ", "\n", "  ", "-- note\n"]));
  }
});
const sqlish = gs.composite((tc): string => tc.draw(gs.arrays(fragment, { minSize: 0, maxSize: 12 })).join(""));

function assertSplitMatchesSQLite(sql: string, query: string, expected: unknown): void {
  const direct = new DatabaseSync(":memory:");
  const split = new DatabaseSync(":memory:");
  try {
    direct.exec(sql);
    for (const part of splitStatements(sql)) split.exec(part);
    assert.equal(Object.values(direct.prepare(query).get()!)[0], expected);
    assert.equal(Object.values(split.prepare(query).get()!)[0], expected);
  } finally { direct.close(); split.close(); }
}

function sqliteError(run: () => void): string {
  let caught: unknown;
  try { run(); } catch (error) { caught = error; }
  assert.ok(caught instanceof Error);
  return caught.message;
}

function assertSplitFailsAsSQLite(sql: string): void {
  const direct = new DatabaseSync(":memory:");
  const split = new DatabaseSync(":memory:");
  try {
    const directMessage = sqliteError(() => direct.exec(sql));
    const splitMessage = sqliteError(() => {
      for (const part of splitStatements(sql)) split.exec(part);
    });
    assert.equal(splitMessage, directMessage);
  } finally { direct.close(); split.close(); }
}

function sqliteExecSucceeds(sql: string, splitFirst: boolean): boolean {
  const db = new DatabaseSync(":memory:");
  try {
    if (splitFirst) for (const statement of splitStatements(sql)) db.exec(statement);
    else db.exec(sql);
    return true;
  } catch {
    return false;
  } finally { db.close(); }
}

test("sqliteName folds ASCII case and preserves non-ASCII case", () => {
  hegel.test((tc) => {
    const name = tc.draw(ident);
    const mixed = [...name].map(char => tc.draw(gs.booleans()) ? char.toUpperCase() : char).join("");
    assert.equal(sqliteName(mixed), sqliteName(name));
  });
  for (const [upper, lower] of [["Ä", "ä"], ["Ö", "ö"], ["Ü", "ü"], ["É", "é"]] as const) {
    assert.notEqual(sqliteName(upper), sqliteName(lower));
  }
});

test("normalization preserves literal and quoted identifier bytes", () => {
  hegel.test((tc) => {
    const value = tc.draw(gs.text({ maxSize: 80 }));
    const literal = `'${value.replaceAll("'", "''")}'`;
    const name = `"${value.replaceAll('"', '""')}"`;
    assert.equal(normalize(`SELECT  ${literal}  AS  ${name}`), `select ${literal} as ${name}`);
  });
  assert.equal(normalize("SELECT/* separator */value FROM t"), "select value from t");
});

describe("tokenize", () => {
  test("tokens join back into the input", () => {
    hegel.test((tc) => {
      const sql = tc.draw(sqlish);
      assert.equal(tokenize(sql).map((t) => t.text).join(""), sql);
    });
  });

  test("offsets are contiguous", () => {
    hegel.test((tc) => {
      const sql = tc.draw(sqlish);
      let at = 0;
      for (const t of tokenize(sql)) {
        assert.equal(t.start, at);
        assert.equal(sql.slice(t.start, t.end), t.text);
        at = t.end;
      }
      assert.equal(at, sql.length);
    });
  });
});

describe("namedParams", () => {
  test("a parameter inside a string literal is text", () => {
    hegel.test((tc) => {
      const name = tc.draw(ident);
      const sql = `select ':${name}' as s, :${tc.draw(ident)} as p where x = ':${name}'`;
      const { names } = namedParams(sql);
      assert.equal(names.length, 1);
      assert.notEqual(names[0], name === names[0] ? "" : name);
    });
  });

  test("order is the order of first appearance, without duplicates", () => {
    assert.deepEqual(namedParams("select :b, :a, :b, :c from t where :a = 1").names, ["b", "a", "c"]);
  });

  test("anonymous parameters are reported", () => {
    assert.equal(namedParams("select ? , ?2").anonymous.length, 2);
  });
});

describe("splitStatements", () => {
  const statement = gs.composite((tc): string => {
    const kind = tc.draw(gs.integers({ minValue: 0, maxValue: 2 }));
    const name = tc.draw(ident);
    if (kind === 0) return `create table ${name} (id text primary key not null, note text default 'a;b')`;
    if (kind === 1) return `create trigger ${name}_check before insert on ${name} when new.ok = 0 begin select raise(abort, new.name); select 1; end`;
    return `insert into ${name} values ('x;y', 1) /* block; comment */`;
  });

  test("joining with ';' and splitting gives the statements back", () => {
    hegel.test((tc) => {
      const statements = tc.draw(gs.arrays(statement, { minSize: 0, maxSize: 5 }));
      const file = statements.map((s) => s + ";").join("\n");
      assert.deepEqual(splitStatements(file), statements);
    });
  });

  test("comment-only segments are omitted", () => {
    for (const sql of ["-- x", "/* x */", ";"]) {
      assert.deepEqual(splitStatements(sql), [], sql);
    }
  });

  test("a block comment keeps adjacent minus tokens separate", () => {
    const statements = splitStatements("select 1 -/**/- 2");
    assert.deepEqual(statements, ["select 1 -/**/- 2"]);
    const db = new DatabaseSync(":memory:");
    try {
      assert.equal(Object.values(db.prepare(statements[0]!).get()!)[0], 3);
    } finally { db.close(); }
  });

  test("minus tokens separated by a block comment remain a statement", () => {
    assert.deepEqual(splitStatements("select 1;\n-/**/-"), ["select 1", "-/**/-"]);
    assert.deepEqual(splitStatements("-/**/-"), ["-/**/-"]);
  });

  test("comments in declared types preserve SQLite affinity", () => {
    for (const sql of [
      "create table r(a foo /* text */ bar); insert into r values (1)",
      "create table r(a foo -- text\n bar); insert into r values (1)",
    ]) {
      assertSplitMatchesSQLite(sql, "select typeof(a) from r", "text");
    }
  });

  test("a CTAS column name preserves its source comment", () => {
    assertSplitMatchesSQLite("create table r as select 1/**/+1", "select name from pragma_table_info('r')", "1/**/+1");
  });

  test("a DEFAULT expression preserves its source comment", () => {
    assertSplitMatchesSQLite("create table r(a integer default (1/**/+1))", "select dflt_value from pragma_table_info('r')", "1/**/+1");
  });

  test("non-ASCII characters at a CTAS column boundary remain in its name", () => {
    for (const suffix of ["\u3000", "\u00a0"]) {
      assertSplitMatchesSQLite(`create table r as select 1 as a${suffix}`, "select name from pragma_table_info('r')", `a${suffix}`);
    }
  });

  test("non-SQLite whitespace after a statement remains an invalid segment", () => {
    for (const suffix of ["\u3000", "\u2028"]) assertSplitFailsAsSQLite(`create table r(a);${suffix}`);
  });

  test("a vertical tab attached to a statement remains invalid", () => {
    assertSplitFailsAsSQLite("create table r(a)\u000b");
  });

  test("a leading BOM remains accepted by SQLite", () => {
    const sql = "\ufeffcreate table r(a)";
    assertSplitMatchesSQLite(sql, "select name from sqlite_schema where type = 'table'", "r");
  });

  test("BOM and vertical-tab boundaries match SQLite execution", () => {
    const cases = [
      ["BOM after a statement", "create table r(a);\ufeff", true],
      ["BOM before a semicolon", "\ufeff;create table r(a)", true],
      ["BOM-only file", "\ufeff", true],
      ["BOM with SQLite whitespace", "\ufeff  \n", true],
      ["BOM with a block comment", "\ufeff/* header */\n", true],
      ["vertical tab after a statement", "create table r(a);\v", true],
      ["space and vertical tab after a statement", "create table r(a); \v", true],
      ["vertical tab before a second statement", "select 1;\v select 2", true],
      ["vertical tab after a line comment", "create table r(a); -- x\n\v", true],
      ["vertical tab attached to a statement", "create table r(a)\v", false],
      ["leading vertical tab", "\vcreate table r(a)", false],
      ["BOM inside a token", "select\ufeff 1", false],
      ["BOM inside a numeric token", "select 1.\ufeff", false],
    ] as const;
    for (const [name, sql, expected] of cases) {
      const direct = sqliteExecSucceeds(sql, false);
      assert.equal(direct, expected, name);
      assert.equal(sqliteExecSucceeds(sql, true), direct, name);
    }
  });

  test("splitting small SQL files matches SQLite execution", () => {
    hegel.test((tc) => {
      const fragments = gs.sampledFrom(["select 1", "select 1.", ";", " ", "\t", "\n", "\v", "\ufeff", "/* c */", "-- c\n", "\u3000"]);
      const sql = tc.draw(gs.arrays(fragments, { maxSize: 8 })).join("");
      assert.equal(sqliteExecSucceeds(sql, true), sqliteExecSucceeds(sql, false), JSON.stringify(sql));
    });
  });

  test("BEGIN TRANSACTION is a statement of its own", () => {
    assert.deepEqual(splitStatements("begin transaction; insert into t values (1); commit;"), ["begin transaction", "insert into t values (1)", "commit"]);
    assert.deepEqual(splitStatements("begin; insert into t values (1); end;"), ["begin", "insert into t values (1)", "end"]);
  });

  test("a CASE expression inside a trigger body does not end it early", () => {
    const trigger = "create trigger t_touch after update on t begin update t set x = case when new.y is null then 1 else 2 end where id = new.id; end";
    assert.deepEqual(splitStatements(`${trigger};`), [trigger]);
    const nested = "create trigger t_touch after update on t begin update t set x = case when new.y is null then case when new.z is null then 1 else 2 end else 3 end where id = new.id; end";
    assert.deepEqual(splitStatements(`${nested};`), [nested]);
  });

  test("an unquoted end identifier inside a trigger body does not end it early", () => {
    const setEnd = "create trigger t_touch after update on t begin update t set x = 1 where end = new.id; end";
    assert.deepEqual(splitStatements(`${setEnd};`), [setEnd]);
    const newEnd = "create trigger t_touch after update on t begin update t set x = new.end where id = new.id; end";
    assert.deepEqual(splitStatements(`${newEnd};`), [newEnd]);
    const caseAndEnd = "create trigger t_touch after update on t begin update t set x = case when new.y is null then 1 else 2 end, end = new.z where id = new.id; end";
    assert.deepEqual(splitStatements(`${caseAndEnd};`), [caseAndEnd]);
    const twoCases = "create trigger t_touch after update on t begin update t set x = case when new.y is null then 1 else 2 end, z = case when new.w is null then 3 else 4 end where id = new.id; end";
    assert.deepEqual(splitStatements(`${twoCases};`), [twoCases]);
  });

  test("a begin-spelled column alias inside a trigger body does not end it early", () => {
    const aliasedBegin = "create trigger t_touch after update on t begin select begin end from t; end";
    assert.deepEqual(splitStatements(`${aliasedBegin};`), [aliasedBegin]);
  });
});

describe("shapes", () => {
  test("leadingComment takes the leading -- lines only", () => {
    assert.equal(leadingComment("-- One order.\n-- Or none.\nselect 1 -- not doc"), "One order.\nOr none.");
    assert.equal(leadingComment("select 1"), "");
  });

  test("created reads the object name", () => {
    assert.deepEqual(created('create table if not exists "orders" (id text)'), { kind: "table", name: "orders" });
    assert.deepEqual(created("create unique index ix on t (a)"), { kind: "index", name: "ix" });
    assert.deepEqual(created("create trigger tr before insert on t begin select 1; end"), { kind: "trigger", name: "tr" });
    assert.equal(created("select 1"), null);
  });

  test("renamedColumn reads the table, source, and target of a column rename", () => {
    hegel.test((tc) => {
      const table = tc.draw(ident);
      const from = tc.draw(ident);
      const to = tc.draw(ident);
      const withColumn = `alter table ${quoteIdent(table)} rename column ${quoteIdent(from)} to ${quoteIdent(to)}`;
      assert.deepEqual(renamedColumn(withColumn), { table, from, to });
      const shortForm = `alter table ${quoteIdent(table)} rename ${quoteIdent(from)} to ${quoteIdent(to)}`;
      assert.deepEqual(renamedColumn(shortForm), { table, from, to });
    });
    assert.equal(renamedColumn("alter table t rename to newname"), null);
    assert.equal(renamedColumn("alter table t add column x text"), null);
    assert.equal(renamedColumn("create table t (id text)"), null);
  });

  test("selectItems splits the outer select list and reads aliases", () => {
    const items = selectItems("with x as (select 1, 2) select o.id, count(*) as n, json_object('a', 1, 'b', (select 2)) as j from orders o, x");
    assert.deepEqual(items!.map((i) => [i.expr, i.alias]), [["o.id", null], ["count(*)", "n"], ["json_object('a', 1, 'b', (select 2))", "j"]]);
    assert.equal(selectItems("insert into t values (1)"), null);
  });

  test("columnRef reads a plain reference", () => {
    assert.deepEqual(columnRef("o.id"), { alias: "o", column: "id" });
    assert.deepEqual(columnRef("status"), { alias: null, column: "status" });
    assert.equal(columnRef("o.id + 1"), null);
  });

  test("aliasMap maps aliases to tables, and subqueries and functions to null", () => {
    const m = aliasMap("select * from orders o left join customers as c on c.id = o.customer_id join (select 1 as x) s on 1 = 1, json_each(:lines) j where o.id = 1");
    assert.deepEqual([...m], [["o", "orders"], ["c", "customers"], ["s", null], ["j", null]]);
    assert.deepEqual([...aliasMap("select * from orders")], [["orders", "orders"]]);
  });

  test("aliasMap maps a schema-qualified source to its table alias", () => {
    hegel.test((tc) => {
      const schema = `s_${tc.draw(ident)}`;
      const table = `t_${tc.draw(ident)}`;
      const alias = `a_${tc.draw(ident)}`;
      const as = tc.draw(gs.booleans()) ? " as" : "";
      assert.deepEqual([...aliasMap(`select * from ${schema}.${table}${as} ${alias}`)], [[alias, table]]);
    });
    assert.deepEqual([...aliasMap("select * from main.orders o")], [["o", "orders"]]);
    assert.deepEqual([...aliasMap("select * from main.orders as o")], [["o", "orders"]]);
    assert.deepEqual([...aliasMap("select * from temp.orders o")], [["o", "orders"]]);
    assert.deepEqual([...aliasMap("select * from warehouse.orders o")], [["o", "orders"]]);
    assert.deepEqual([...aliasMap('select * from "main"."orders" as "o"')], [["o", "orders"]]);
    assert.deepEqual([...aliasMap("select * from [main].[orders] [o]")], [["o", "orders"]]);
    assert.deepEqual([...aliasMap("select * from main.json_each(:rows) j")], [["j", null]]);
  });

  test("aliasMap does not treat IS DISTINCT FROM as a FROM source", () => {
    assert.deepEqual([...aliasMap("select 1 where l.order_id is distinct from o.id")], []);
    assert.deepEqual([...aliasMap("select 1 where l.order_id is not distinct from o.id")], []);
  });

  test("aliasMap does not treat INDEXED BY or NOT INDEXED as an alias", () => {
    assert.deepEqual([...aliasMap("update orders indexed by orders_status set status = :status where orders.id = :id")], [["orders", "orders"]]);
    assert.deepEqual([...aliasMap("update orders not indexed set status = :status where orders.id = :id")], [["orders", "orders"]]);
    assert.deepEqual([...aliasMap("delete from orders indexed by orders_status where orders.id = :id")], [["orders", "orders"]]);
    assert.deepEqual([...aliasMap("delete from orders not indexed where orders.id = :id")], [["orders", "orders"]]);
    assert.deepEqual([...aliasMap("select * from orders indexed by orders_status where orders.id = :id")], [["orders", "orders"]]);
  });

  test("aliasMap self-aliases an INSERT target even with an explicit column list", () => {
    assert.deepEqual([...aliasMap("insert into orders (id, qty) values (:id, :qty) returning id")], [["orders", "orders"]]);
    assert.deepEqual([...aliasMap("insert or replace into orders (id, qty) values (:id, :qty) returning id")], [["orders", "orders"]]);
    assert.deepEqual([...aliasMap("insert into orders values (:id, :qty) returning id")], [["orders", "orders"]]);
  });

  test("paramSites classifies parameters", () => {
    const sites = paramSites("update orders set status = :status, note = :note where id = :id and :qty < qty and customer_id in (select id from customers where name like :name)");
    assert.deepEqual(sites.get("status"), [{ kind: "set", column: "status" }]);
    assert.deepEqual(sites.get("id"), [{ kind: "compare", alias: null, column: "id" }]);
    assert.deepEqual(sites.get("qty"), [{ kind: "compare", alias: null, column: "qty" }]);
    assert.deepEqual(sites.get("name"), [{ kind: "compare", alias: null, column: "name" }]);
    const ins = paramSites("insert into orders (id, customer_id, status) values (:id, :customer_id, 'draft')");
    assert.deepEqual(ins.get("customer_id"), [{ kind: "insert", table: "orders", column: "customer_id" }]);
    const bare = paramSites("select value from json_each(:lines)");
    assert.deepEqual(bare.get("lines"), [{ kind: "json_each", keys: [], scalar: null }]);
    const ignore = paramSites("insert or ignore into orders (id, status) values (:id, 'draft')");
    assert.deepEqual(ignore.get("id"), [{ kind: "insert", table: "orders", column: "id" }]);
    const replace = paramSites("replace into orders (id, status) values (:id, 'draft')");
    assert.deepEqual(replace.get("id"), [{ kind: "insert", table: "orders", column: "id" }]);
    // json_each anywhere: the keys of `value ->> 'k'` in the same scope, each
    // with the column it is compared with, set into, or listed for.
    const bulk = paramSites("update order_lines set price = (select value ->> 'price' from json_each(:lines) where value ->> 'id' = order_lines.id) where order_id = :id and id in (select value ->> 'id' from json_each(:lines))");
    assert.deepEqual(bulk.get("lines"), [
      { kind: "json_each", keys: [{ key: "price", ref: { alias: null, column: "price" } }, { key: "id", ref: { alias: "order_lines", column: "id" } }], scalar: null },
      { kind: "json_each", keys: [{ key: "id", ref: { alias: null, column: "id" } }], scalar: null },
    ]);
    const scalars = paramSites("insert into tags (id, line_id, name) select value, :line_id, 'x' from json_each(:ids)");
    assert.deepEqual(scalars.get("ids"), [{ kind: "json_each", keys: [], scalar: { table: "tags", column: "id" } }]);
  });

  // A FROM list with two table-valued functions requires every `value` to
  // be alias-qualified (SQLite refuses a bare, ambiguous one), so a key
  // qualified with one json_each's own alias must land on that one only,
  // not on a sibling json_each bound to a different parameter -- and a
  // second json_each chained off the first's own element (`o.value ->
  // 'lines'`) must nest its own keys under the key that names it, found
  // from the insert's own column list by position.
  test("paramSites nests a chained json_each's own keys under the key that chains to it, scoped by alias", () => {
    const sql = `insert into order_lines (id, order_id, sku, qty, price)
      select l.value ->> 'id', o.value ->> 'id', l.value ->> 'sku', l.value ->> 'qty', l.value ->> 'price'
      from json_each(:orders) o, json_each(o.value -> 'lines') l`;
    const sites = paramSites(sql);
    assert.deepEqual(sites.get("orders"), [{
      kind: "json_each",
      keys: [
        { key: "id", ref: { table: "order_lines", column: "order_id" } },
        { key: "lines", ref: { nested: [
          { key: "id", ref: { table: "order_lines", column: "id" } },
          { key: "sku", ref: { table: "order_lines", column: "sku" } },
          { key: "qty", ref: { table: "order_lines", column: "qty" } },
          { key: "price", ref: { table: "order_lines", column: "price" } },
        ] } },
      ],
      scalar: null,
    }]);
  });

  test("paramSites keeps non-ASCII alias case distinct in a chained json_each", () => {
    const sql = `insert into dst (outer_value, inner_value, other_value)
      select "Ä".value ->> 'outer', "ä".value ->> 'inner', "ä".value ->> 'other'
      from json_each(:root) "Ä", json_each("Ä".value -> 'child') "ä"`;
    assert.deepEqual(paramSites(sql).get('root'), [{
      kind: 'json_each',
      keys: [
        { key: 'outer', ref: { table: 'dst', column: 'outer_value' } },
        { key: 'child', ref: { nested: [
          { key: 'inner', ref: { table: 'dst', column: 'inner_value' } },
          { key: 'other', ref: { table: 'dst', column: 'other_value' } },
        ] } },
      ],
      scalar: null,
    }]);
  });

  test("paramSites keeps non-ASCII alias case distinct across nested json_each levels", () => {
    const sql = `insert into dst (outer_value, middle_value, inner_value)
      select r.value ->> 'outer', "Ä".value ->> 'middle', "ä".value ->> 'inner'
      from json_each(:root) r,
        json_each(r.value -> 'child') "Ä",
        json_each("Ä".value -> 'grandchild') "ä"`;
    assert.deepEqual(paramSites(sql).get('root'), [{
      kind: 'json_each',
      keys: [
        { key: 'outer', ref: { table: 'dst', column: 'outer_value' } },
        { key: 'child', ref: { nested: [
          { key: 'middle', ref: { table: 'dst', column: 'middle_value' } },
          { key: 'grandchild', ref: { nested: [
            { key: 'inner', ref: { table: 'dst', column: 'inner_value' } },
          ] } },
        ] } },
      ],
      scalar: null,
    }]);
  });

  test("paramSites treats ASCII alias case as the same name in a chained json_each", () => {
    const sql = `insert into dst (outer_value, inner_value)
      select A.value ->> 'outer', a.value ->> 'inner'
      from json_each(:root) A, json_each(A.value -> 'child') a`;
    assert.deepEqual(paramSites(sql).get('root'), [{
      kind: 'json_each',
      keys: [
        { key: 'outer', ref: { table: 'dst', column: 'outer_value' } },
        { key: 'inner', ref: { table: 'dst', column: 'inner_value' } },
        { key: 'child', ref: { nested: [
          { key: 'outer', ref: { table: 'dst', column: 'outer_value' } },
          { key: 'inner', ref: { table: 'dst', column: 'inner_value' } },
          { key: 'child', ref: { nested: [] } },
        ] } },
      ],
      scalar: null,
    }]);
  });

  test("paramSites attributes every row of a multi-row VALUES insert to its column, not only the first row's", () => {
    hegel.test((tc) => {
      const columns = tc.draw(gs.arrays(ident, { minSize: 2, maxSize: 4, unique: true }));
      const columnCount = columns.length;
      const rowCount = tc.draw(gs.integers({ minValue: 1, maxValue: 5 }));
      const rows = Array.from({ length: rowCount }, (_, row) => `(${columns.map((_, col) => `:p${row}_${col}`).join(", ")})`);
      const sql = `insert into t (${columns.join(", ")}) values ${rows.join(", ")}`;
      const sites = paramSites(sql);
      for (let row = 0; row < rowCount; row++) {
        for (let col = 0; col < columnCount; col++) {
          assert.deepEqual(sites.get(`p${row}_${col}`), [{ kind: "insert", table: "t", column: columns[col] }]);
        }
      }
    });
  });

  test("definitions splits columns and constraints", () => {
    const d = definitions(`create table t ("id" text primary key not null, n integer check (n > 0), constraint u unique (n), foreign key (n) references o(id))`)!;
    assert.deepEqual([...d.columns], [["id", "id text primary key not null"], ["n", "n integer check(n > 0)"]]);
    assert.deepEqual(d.constraints, ["constraint u unique(n)", "foreign key(n) references o(id)"]);
  });
});

test("unconditionalMatchAliases finds only a top-level, unqualified <ident> match <expr> conjunct, and gives up on a depth-0 or", () => {
  assert.deepEqual(unconditionalMatchAliases("select rank from f where f match :q"), new Set(["f"]));
  assert.deepEqual(unconditionalMatchAliases("select rank from f where f match :q and body <> ''"), new Set(["f"]));
  assert.deepEqual(unconditionalMatchAliases("select rank from f where rowid = 2 or f match :q"), new Set());
  assert.deepEqual(unconditionalMatchAliases("select rank from f"), new Set());
  assert.deepEqual(unconditionalMatchAliases("select rank from f where (x=1 or x=2) and f match :q"), new Set(["f"]));
  assert.deepEqual(unconditionalMatchAliases("select rank from f where f match :q or (x=1 and y=2)"), new Set());
  assert.deepEqual(unconditionalMatchAliases("select rank from f where not f match :q and body <> ''"), new Set());
});

test('named slots preserve prefixes, repeated slots, and qualified-key collisions', () => {
  assert.deepEqual(namedParams('select :id,@id,$other,:id').names,[':id','@id','other']);
  assert.deepEqual(namedParams('select $id,@id,:$id').names,['$id','@id',':$id']);
  for(const name of [':1',':名前','$id::suffix(key)','@id::suffix(key)',':id$next']) {
    assert.deepEqual(namedParams(`select ${name}`).names,[name.slice(1)]);
  }
  const sites=paramSites('insert into t(a,b,c) select :id,@id,$other');
  assert.deepEqual([...sites].map(([name,sites])=>[name,sites[0]]),[
    [':id',{kind:'insert',table:'t',column:'a'}],['@id',{kind:'insert',table:'t',column:'b'}],['other',{kind:'insert',table:'t',column:'c'}],
  ]);
});
