// The scanner reads SQL text without a grammar. Properties: the tokens join
// back into the input, a named parameter inside a string literal is not a
// parameter, and statements split at top-level semicolons only.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { aliasMap, columnRef, created, definitions, leadingComment, namedParams, paramSites, selectItems, splitStatements, tokenize } from "../src/build/scan.ts";

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
      const expected = statements.map((s) => s.replace(/ \/\* block; comment \*\/$/, ""));
      assert.deepEqual(splitStatements(file), expected);
    });
  });

  test("BEGIN TRANSACTION is a statement of its own", () => {
    assert.deepEqual(splitStatements("begin transaction; insert into t values (1); commit;"), ["begin transaction", "insert into t values (1)", "commit"]);
    assert.deepEqual(splitStatements("begin; insert into t values (1); end;"), ["begin", "insert into t values (1)", "end"]);
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

  test("paramSites classifies parameters", () => {
    const sites = paramSites("update orders set status = :status, note = :note where id = :id and :qty < qty and customer_id in (select id from customers where name like :name)");
    assert.deepEqual(sites.get("status"), [{ kind: "set", column: "status" }]);
    assert.deepEqual(sites.get("id"), [{ kind: "compare", alias: null, column: "id" }]);
    assert.deepEqual(sites.get("qty"), [{ kind: "compare", alias: null, column: "qty" }]);
    assert.deepEqual(sites.get("name"), [{ kind: "compare", alias: null, column: "name" }]);
    const ins = paramSites("insert into orders (id, customer_id, status) values (:id, :customer_id, 'draft')");
    assert.deepEqual(ins.get("customer_id"), [{ kind: "insert", table: "orders", column: "customer_id" }]);
    const other = paramSites("select value from json_each(:lines)");
    assert.deepEqual(other.get("lines"), [{ kind: "other" }]);
  });

  test("definitions splits columns and constraints", () => {
    const d = definitions(`create table t ("id" text primary key not null, n integer check (n > 0), constraint u unique (n), foreign key (n) references o(id))`)!;
    assert.deepEqual([...d.columns], [["id", "id text primary key not null"], ["n", "n integer check(n > 0)"]]);
    assert.deepEqual(d.constraints, ["constraint u unique(n)", "foreign key(n) references o(id)"]);
  });
});
