// A trigger in a migration file opens with an uppercase BEGIN, whatever
// the declaration wrote: D1's HTTP API keeps a trigger body whole only
// then, and a lowercase one fails `wrangler d1 migrations apply --remote`
// with "incomplete input".
import { test } from "node:test";
import assert from "node:assert/strict";
import { diff, introspect, open } from "../src/build/migration.ts";

const table = `create table notes (id text primary key not null, body text) strict`;

test("the migration writes BEGIN and END uppercase, and leaves the body and its literals alone", () => {
  const trigger = `create trigger notes_guard before insert on notes
  when new.body = 'begin'
  begin
    select raise(abort, 'end');
  end`;
  const plan = diff(introspect(open([table])), introspect(open([table, trigger])));
  assert.equal(plan.kind, "ok");
  if (plan.kind !== "ok") return;
  const [created] = plan.statements;
  assert.equal(created, `CREATE TRIGGER notes_guard before insert on notes
  when new.body = 'begin'
  BEGIN
    select raise(abort, 'end');
  END`);
});

test("a trigger the diff leaves alone is not created again for its case", () => {
  const lower = `create trigger notes_touch after update on notes begin update notes set body = new.body where id = new.id; end`;
  const upper = lower.replace(" begin ", " BEGIN ").replace(" end", " END");
  const plan = diff(introspect(open([table, upper])), introspect(open([table, lower])));
  assert.deepEqual(plan, { kind: "ok", statements: [] });
});
