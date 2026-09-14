// Responsibility: exercise a nullable or non-numeric assert predicate against public command results.
// Boundary: callers create the database and decide how to expose results.
import { assert as guard, commands, queries, type Database } from '../src/index.ts';
import { GUARD_DDL } from '../src/runtime/plan.ts';

const insert = 'insert into items(id) values(:id)';
const nullPredicate = 'select null';
const textPredicate = "select 'nope'";
const count = 'select count(*) as n from items';
const generated = {
  [insert]: { params: ['id'], encode: [], json: [], reads: [] },
  [nullPredicate]: { params: [], encode: [], json: [], reads: [] },
  [textPredicate]: { params: [], encode: [], json: [], reads: [] },
  [count]: { params: [], encode: [], json: [], reads: ['items'] },
};
const entries = commands(generated, {
  nullCheck: { plan: [insert, guard('is_confirmed', nullPredicate)] },
  textCheck: { plan: [insert, guard('is_confirmed', textPredicate)] },
});
const reads = queries(generated, { count }).count;

export const ddlStatements = [...GUARD_DDL, 'create table items(id text primary key not null) strict'];
// A D1 test binding is shared across requests in one Miniflare instance, and
// another fixture may have already created the guard table there; the `if
// not exists` form lets this fixture's DDL run a second time on the same
// database (mirrors test/parameter-contract-fixture.ts's sharedDdlStatements).
export const sharedDdlStatements = ddlStatements.map((sql) => sql.replace(/^create (table|trigger) /, 'create $1 if not exists '));
export const ddl = ddlStatements.join(';');

export async function nullPredicateResults(db: Database): Promise<{ results: unknown[]; count: number }> {
  const results = [
    await db.run(entries.nullCheck, { id: 'a' }),
    await db.run(entries.textCheck, { id: 'b' }),
  ];
  const row = await db.first(reads);
  if (typeof row?.n !== 'number') throw Error('The item row count is missing');
  return { results, count: row.n };
}
