// Responsibility: print, for the runtime that runs it, the facts that decide
// whether its node:sqlite can stand in for workerd's SQLite: the SQLite
// build, the binding's answers to the calls the node adapter makes, and what
// Engine.fullScans() reports for an EXISTS query.
// Boundary: one process and in-memory databases. From solarsql it imports
// only Engine, which has no runtime check, so the script also runs where
// node() and the CLI refuse to run (Bun, an older Node).
import { DatabaseSync } from "node:sqlite";
import { Engine } from "../src/build/facts.ts";

type Row = Record<string, unknown>;
const EXISTS = "select * from a where exists (select 1 from b where b.x = a.x)";
const db = new DatabaseSync(":memory:");

function failure(e: unknown): string {
  const error = e as { code?: unknown; errcode?: unknown; message?: unknown };
  return `throws code=${String(error.code)} errcode=${String(error.errcode)}: ${String(error.message)}`;
}

function probe(run: () => unknown): unknown {
  try { return run(); } catch (e) { return failure(e); }
}

const runtime = process.versions.bun ? `Bun ${process.versions.bun}` : `Node ${process.versions.node}`;
const report = {
  runtime,
  reportedNode: process.versions.node,
  sqlite: probe(() => db.prepare("select sqlite_version() as version, sqlite_source_id() as source").get()),
  nulText: probe(() => {
    const value = (db.prepare("select 'a' || char(0) || 'b' as v").get() as Row).v as string;
    return { length: value.length, codes: [...value].map(c => c.charCodeAt(0)) };
  }),
  unsafeInteger: probe(() => {
    const value = (db.prepare("select 9007199254740993 as v").get() as Row).v;
    return `${typeof value} ${String(value)}`;
  }),
  namedThenPositional: probe(() => {
    const statement = db.prepare("select :a as a, ? as b");
    statement.setAllowBareNamedParameters(false);
    return statement.all({ ":a": "x" }, "y");
  }),
  savepointRollback: probe(() => {
    db.exec("create table t (id integer primary key)");
    db.exec("savepoint solarsql_transaction");
    const inside = db.isTransaction;
    db.exec("insert into t values (1)");
    db.exec("rollback to solarsql_transaction");
    db.exec("release solarsql_transaction");
    return { inside, after: db.isTransaction, rows: (db.prepare("select count(*) as n from t").get() as Row).n };
  }),
  realThroughJson: probe(() => (db.prepare("select json_array(0.1 + 0.2) as v").get() as Row).v),
  constraintError: probe(() => {
    db.exec("insert into t values (1)");
    db.exec("insert into t values (1)");
    return "no error";
  }),
  raiseAbort: probe(() => {
    db.exec("create table g (name text not null)");
    db.exec("create trigger g_stop before insert on g begin select raise(abort, 'assert failed: stop'); end");
    db.exec("insert into g values ('x')");
    return "no error";
  }),
  existsPlan: probe(() => {
    db.exec("create table a (x integer); create table b (x integer)");
    return (db.prepare(`explain query plan ${EXISTS}`).all() as Row[]).map(r => r.detail);
  }),
  existsFullScans: probe(() => {
    const engine = new Engine(["create table a (x integer) strict", "create table b (x integer) strict"]);
    try { return engine.fullScans(EXISTS); } finally { engine.close(); }
  }),
};
db.close();
console.log(JSON.stringify(report, null, 1));
