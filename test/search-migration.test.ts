// A search table (CREATE VIRTUAL TABLE ... USING fts5) is part of the
// migration diff: created after the tables, dropped and created again
// when its text changes, and its shadow tables are never named. When the
// target schema names exactly one insert trigger with the documented shape
// (schema.md, "Search tables") writing into a created search table, the
// diff also generates the insert that repopulates it from its base table
// (ADR 0118); any other shape leaves a comment instead.
import { test } from "node:test";
import assert from "node:assert/strict";
import { applied, diff, introspect, open, render } from "../src/build/migration.ts";
import { searchFill, splitStatements, triggerInsertTarget } from "../src/build/scan.ts";

const orders = `create table orders (id text primary key not null, note text) strict`;
const searchDDL = `create virtual table order_search using fts5(order_id unindexed, note)`;
const searchDDLv2 = `create virtual table order_search using fts5(order_id unindexed, note, tokenize = 'unicode61')`;
const matchingTrigger = `create trigger order_search_insert after insert on orders begin insert into order_search (order_id, note) values (new.id, new.note); end`;
const beforeMatchingTrigger = `create trigger order_search_insert before insert on orders begin insert into order_search (order_id, note) values (new.id, new.note); end`;
const forEachRowTrigger = `create trigger order_search_insert after insert on orders for each row begin insert into order_search (order_id, note) values (new.id, new.note); end`;
const expressionTrigger = `create trigger order_search_insert after insert on orders begin insert into order_search (order_id, note) values (new.id, upper(new.note)); end`;
const whenTrigger = `create trigger order_search_insert after insert on orders when new.note is not null begin insert into order_search (order_id, note) values (new.id, new.note); end`;
const secondTrigger = `create trigger order_search_insert2 after insert on orders begin insert into order_search (order_id, note) values (new.id, new.note); end`;

const commentLine = `-- order_search starts empty. No single INSERT trigger with only new.<column> values names how to fill it. Add an insert that repopulates it from its base table.`;

const v1 = [orders, searchDDL];
const v2 = [orders, searchDDLv2, matchingTrigger];

test("a new search table with no trigger is created with a comment, and a second diff is empty", () => {
  const plan = diff(introspect(open([orders])), introspect(open(v1)));
  assert.equal(plan.kind, "ok");
  if (plan.kind !== "ok") return;
  assert.deepEqual(plan.statements, [`${commentLine}\n${v1[1]!.replace(/^create virtual table/, "CREATE VIRTUAL TABLE")}`]);
  assert.deepEqual(diff(introspect(open(v1)), introspect(open(v1))), { kind: "ok", statements: [] });
});

test("a changed search table with the documented trigger gets the insert, before the trigger, and the rows survive in orders", () => {
  const plan = diff(introspect(open(v1)), introspect(open(v2)));
  assert.equal(plan.kind, "ok");
  if (plan.kind !== "ok") return;
  assert.deepEqual(
    plan.statements.map((s) => s.split("(")[0]!.trim().toLowerCase()),
    [
      "drop table \"order_search\"",
      "create virtual table order_search using fts5",
      "insert into \"order_search\"",
      "create trigger order_search_insert after insert on orders begin insert into order_search",
    ],
  );
  assert.deepEqual(plan.statements[2], `insert into "order_search" ("order_id", "note") select "id", "note" from "orders"`);
  const db = applied([render(1, "v1", v1).sql, "insert into orders values ('a', 'gift');", "insert into order_search values ('a', 'gift');"]);
  db.exec("begin");
  for (const s of splitStatements(render(2, "v2", plan.statements).sql)) db.exec(s);
  db.exec("commit");
  assert.deepEqual(diff(introspect(db), introspect(open(v2))), { kind: "ok", statements: [] });
  // The insert already restored the pre-existing row before this recount.
  assert.deepEqual({ ...db.prepare("select count(*) as n from order_search").get() }, { n: 1 });
  db.exec("insert into orders values ('b', 'rush')");
  assert.deepEqual(
    db.prepare("select order_id from order_search where order_search match 'rush' order by order_id").all().map((r) => ({ ...r })),
    [{ order_id: "b" }],
  );
});

test("a new search table on a base table that already has rows: the insert is emitted and the rows are searchable after apply", () => {
  const current = [orders];
  const target = [orders, searchDDL, matchingTrigger];
  const plan = diff(introspect(open(current)), introspect(open(target)));
  assert.equal(plan.kind, "ok");
  if (plan.kind !== "ok") return;
  assert.deepEqual(plan.statements[1], `insert into "order_search" ("order_id", "note") select "id", "note" from "orders"`);
  const db = applied([render(1, "v1", current).sql, "insert into orders values ('a', 'gift');"]);
  db.exec("begin");
  for (const s of splitStatements(render(2, "v2", plan.statements).sql)) db.exec(s);
  db.exec("commit");
  assert.deepEqual(
    db.prepare("select order_id from order_search where order_search match 'gift'").all().map((r) => ({ ...r })),
    [{ order_id: "a" }],
  );
  assert.deepEqual(diff(introspect(db), introspect(open(target))), { kind: "ok", statements: [] });
});

test("a trigger outside the shape (an expression other than new.<column>) leaves a comment, no insert", () => {
  const current = [orders];
  const target = [orders, searchDDL, expressionTrigger];
  const plan = diff(introspect(open(current)), introspect(open(target)));
  assert.equal(plan.kind, "ok");
  if (plan.kind !== "ok") return;
  assert.deepEqual(plan.statements[0], `${commentLine}\n${searchDDL.replace(/^create virtual table/, "CREATE VIRTUAL TABLE")}`);
  const db = applied([render(1, "v1", current).sql]);
  db.exec("begin");
  for (const s of splitStatements(render(2, "v2", plan.statements).sql)) db.exec(s);
  db.exec("commit");
  assert.deepEqual({ ...db.prepare("select count(*) as n from order_search").get() }, { n: 0 });
  assert.deepEqual(diff(introspect(db), introspect(open(target))), { kind: "ok", statements: [] });
});

test("a trigger with a WHEN clause leaves a comment", () => {
  const current = [orders];
  const target = [orders, searchDDL, whenTrigger];
  const plan = diff(introspect(open(current)), introspect(open(target)));
  assert.equal(plan.kind, "ok");
  if (plan.kind !== "ok") return;
  assert.equal(plan.statements[0]!.startsWith(commentLine), true);
});

test("two INSERT triggers into the same search table leave a comment", () => {
  const current = [orders];
  const target = [orders, searchDDL, matchingTrigger, secondTrigger];
  const plan = diff(introspect(open(current)), introspect(open(target)));
  assert.equal(plan.kind, "ok");
  if (plan.kind !== "ok") return;
  assert.equal(plan.statements[0]!.startsWith(commentLine), true);
});

test("a search table with no trigger at all leaves a comment", () => {
  const current = [orders];
  const target = [orders, searchDDL];
  const plan = diff(introspect(open(current)), introspect(open(target)));
  assert.equal(plan.kind, "ok");
  if (plan.kind !== "ok") return;
  assert.equal(plan.statements[0]!.startsWith(commentLine), true);
});

test("a removed search table is dropped, and its shadow tables are never named", () => {
  const plan = diff(introspect(open(v1)), introspect(open([orders])));
  assert.deepEqual(plan, { kind: "ok", statements: [`drop table "order_search"`] });
  const s = introspect(open(v1));
  assert.deepEqual([...s.tables.keys()], ["orders"]);
  assert.deepEqual([...s.virtuals.keys()], ["order_search"]);
});

test("searchFill: the documented shape, quoted identifiers, before insert, for each row, and mixed case", () => {
  const expected = { search: "order_search", columns: ["order_id", "note"], sources: ["id", "note"], base: "orders" };
  assert.deepEqual(searchFill(matchingTrigger), expected);
  assert.deepEqual(searchFill(beforeMatchingTrigger), expected);
  assert.deepEqual(searchFill(forEachRowTrigger), expected);
  const quoted = `create trigger "order_search_insert" after insert on "orders" begin insert into "order_search" ("order_id", "note") values (new."id", new."note"); end`;
  assert.deepEqual(searchFill(quoted), expected);
  const mixedCase = `CREATE TRIGGER order_search_insert AFTER INSERT ON orders BEGIN INSERT INTO order_search (order_id, note) VALUES (new.id, new.note); END`;
  assert.deepEqual(searchFill(mixedCase), expected);
});

test("searchFill: an expression, a WHEN clause, INSTEAD OF, and a mismatched count all give null", () => {
  assert.equal(searchFill(expressionTrigger), null);
  assert.equal(searchFill(whenTrigger), null);
  const insteadOf = `create trigger t instead of insert on a_view begin insert into order_search (order_id, note) values (new.id, new.note); end`;
  assert.equal(searchFill(insteadOf), null);
  const mismatchedCount = `create trigger t after insert on orders begin insert into order_search (order_id, note) values (new.id); end`;
  assert.equal(searchFill(mismatchedCount), null);
});

test("triggerInsertTarget: the loose fact used to count candidate triggers, even for a trigger searchFill refuses", () => {
  assert.deepEqual(triggerInsertTarget(matchingTrigger), { search: "order_search", base: "orders" });
  assert.deepEqual(triggerInsertTarget(expressionTrigger), { search: "order_search", base: "orders" });
  assert.equal(triggerInsertTarget(whenTrigger), null);
});

test("a deterministic loop over column-list sizes 1..4: the insert restores every row of the base table", () => {
  for (let n = 1; n <= 4; n++) {
    const cols = Array.from({ length: n }, (_, i) => `c${i}`);
    const base = `create table base_${n} (id integer primary key not null, ${cols.map((c) => `${c} text`).join(", ")}) strict`;
    const searchTable = `create virtual table base_${n}_search using fts5(id unindexed, ${cols.join(", ")})`;
    const trigger = `create trigger base_${n}_search_insert after insert on base_${n} begin insert into base_${n}_search (id, ${cols.join(", ")}) values (new.id, ${cols.map((c) => `new.${c}`).join(", ")}); end`;
    const current = [base];
    const target = [base, searchTable, trigger];
    const plan = diff(introspect(open(current)), introspect(open(target)));
    assert.equal(plan.kind, "ok");
    if (plan.kind !== "ok") continue;
    const values = cols.map((c) => `'${c}-1'`).join(", ");
    const db = applied([render(1, "v1", current).sql, `insert into base_${n} values (1, ${values});`]);
    db.exec("begin");
    for (const s of splitStatements(render(2, "v2", plan.statements).sql)) db.exec(s);
    db.exec("commit");
    assert.deepEqual(
      { ...db.prepare(`select count(*) as n from base_${n} where (select count(*) from base_${n}_search) = (select count(*) from base_${n})`).get() },
      { n: 1 },
    );
  }
});
