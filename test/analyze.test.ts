// Responsibility: verify schema-only adoption across generation, compilation, and execution.
// Boundary: module ownership checks belong to build tests.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { linkSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Engine } from '../src/build/facts.ts';
import { Typer } from '../src/build/typegen.ts';
import { analyzeDatabase, analyzeSchema } from "../src/build/analyze.ts";

const root = resolve(import.meta.dirname, "..");
const library = join(root, "src/index.ts");
const schema = 'create table legacy(n integer, label); create table items(n integer not null, label text) strict;';
const catalog = { legacy: 'select n, label from legacy', items: '-- Original SQL\nselect n, label from items where n = :n;' };

test('schema-only generation preserves SQL and coexists with a direct SQLite driver', t => {
  const dir = mkdtempSync(join(tmpdir(), 'solarsql-analyze-'));
  t.after(() => rmSync(dir, {recursive:true,force:true}));
  symlinkSync(join(root, 'node_modules'), join(dir, 'node_modules'), 'dir');
  writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
  const report = analyzeSchema(schema, catalog, library);
  assert.equal(report.contract.imports, false);
  assert.equal(report.operations[1]!.sql, catalog.items);
  assert.deepEqual(report.operations[1]!.params, [{name:'n',type:'number',encode:false}]);
  writeFileSync(join(dir, 'generated.ts'), report.generated);
  writeFileSync(join(dir, 'consumer.ts'), `
import { queries, type Row, type Params, type SqlValue } from ${JSON.stringify(library)};
import { generated, statements } from './generated.ts';
export const q = queries(generated, statements);
type Equal<A,B> = (<T>()=>T extends A?1:2) extends (<T>()=>T extends B?1:2) ? true : false;
type Assert<T extends true> = T;
export type Legacy = Assert<Equal<Row<typeof q.legacy>, {n:SqlValue;label:SqlValue}>>;
export type Item = Assert<Equal<Row<typeof q.items>, {n:number;label:string|null}>>;
export type Parameter = Assert<Equal<Params<typeof q.items>, {n:number}>>;
`);
  const typed = spawnSync(join(root, 'node_modules/.bin/tsc'), ['--ignoreConfig','--noEmit','--strict','--skipLibCheck','--target','esnext','--module','nodenext','--allowImportingTsExtensions',join(dir,'consumer.ts')], {encoding:'utf8',timeout:30_000});
  assert.equal(typed.status,0,typed.stdout+typed.stderr);
  writeFileSync(join(dir, 'execute.mjs'), `
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { node } from ${JSON.stringify(join(root,'src/node.ts'))};
import { q } from './consumer.ts';
const db = new DatabaseSync(':memory:');
try {
  db.exec(${JSON.stringify(schema)});
  db.exec("insert into legacy values ('not a number', x'00ff'); insert into items values (7, null)");
  assert.equal(q.items.sql, ${JSON.stringify(catalog.items)});
  const adapter = node(db);
  assert.deepEqual(await adapter.all(q.legacy), db.prepare(q.legacy.sql).all().map(row=>({...row})));
  assert.deepEqual(await adapter.all(q.items,{n:7}),[{n:7,label:null}]);
  db.exec("insert into items values (8,'direct driver')");
  assert.deepEqual(await adapter.all(q.items,{n:8}),[{n:8,label:'direct driver'}]);
} finally { db.close(); }
`);
  const executed = spawnSync(process.execPath,[join(dir,'execute.mjs')],{encoding:'utf8',timeout:30_000});
  assert.equal(executed.status,0,executed.stdout+executed.stderr);
});

test('analyze CLI checks freshness without writing and reports query locations', t => {
  const dir = mkdtempSync(join(tmpdir(), 'solarsql-analyze-cli-'));
  t.after(() => rmSync(dir,{recursive:true,force:true}));
  const ddl = join(dir,'schema.sql'), sql = join(dir,'queries.json'), out = join(dir,'generated.ts');
  writeFileSync(ddl,schema);
  writeFileSync(sql,JSON.stringify(catalog));
  const run = (...args:string[]) => {
    const child = spawnSync(process.execPath,[join(root,'src/build/cli.ts'),'analyze',ddl,sql,'--out',out,...args],{encoding:'utf8',timeout:10_000});
    return {status:child.status, report:JSON.parse(child.stdout)};
  };
  assert.equal(run().status,0);
  const before = readFileSync(out,'utf8');
  assert.equal(run('--check').status,0);
  writeFileSync(sql,JSON.stringify({...catalog,count:'select cast(count(*) as integer) as n from items'}));
  const stale = run('--check');
  assert.equal(stale.status,1);
  assert.equal(stale.report.diagnostics[0].code,'GENERATED_STALE');
  assert.equal(readFileSync(out,'utf8'),before);
  writeFileSync(sql,JSON.stringify({broken:'select missing from items'}));
  const failed = run();
  assert.equal(failed.status,1);
  assert.deepEqual(failed.report.diagnostics[0].locations,['queries.broken']);
  assert.equal(readFileSync(out,'utf8'),before);
});

test('schema-only analysis rejects invalid inputs and shares duplicate SQL metadata', () => {
  for (const value of [null, [], {query:1}]) assert.throws(()=>analyzeSchema(schema,value),/JSON object/);
  assert.throws(()=>analyzeSchema('attach database ":memory:" as extra',{}),/CREATE statements/);
  assert.throws(()=>analyzeSchema(schema,{write:'delete from items'}),/SELECT|read/);
  assert.throws(()=>analyzeSchema(schema,{entries:'select n from items'}),/reserved/);
  const same = analyzeSchema(schema,{one:catalog.items,two:catalog.items});
  assert.equal(same.operations.length,2);
  assert.equal(same.generated.match(/params: \{ n: number \}/g)?.length,1);
});

test('database analysis uses existing WAL schema and compiles a caller without copying DDL', t => {
  const dir = mkdtempSync(join(tmpdir(), 'solarsql-existing-'));
  const source = join(dir, 'source.sqlite');
  const db = new DatabaseSync(source);
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  db.exec(`pragma journal_mode=wal;
    create table items(id integer not null, value text) strict;
    create index item_ids on items(id);
    create view visible_items as select id,value from items;
    create table legacy(value);
    create virtual table documents using fts5(value);
    create table audit(value text);
    create trigger audit_items after insert on items begin insert into audit values(new.value); end;
    insert into items values(7,'kept'); insert into legacy values(x'00ff'); insert into documents values('searchable');`);
  const queries = { item: 'select id,value from visible_items where id=:id', legacy: 'select value from legacy', search: "select value from documents where documents match 'searchable'" };
  const before = [readFileSync(source), readFileSync(source + '-wal')];
  const report = analyzeDatabase(source, queries, library);
  assert.equal(report.source.path, realpathSync(source));
  assert.equal(report.source.schemaVersion, db.prepare('pragma schema_version').get()!.schema_version);
  assert.match(report.source.schemaHash, /^[a-f0-9]{64}$/);
  assert.equal(report.operations[0]!.sql, queries.item);
  assert.deepEqual(report.operations[0]!.columns.map(c => c.type), ['number', 'string | null']);
  assert.ok(report.operations[0]!.origins.every(c => c.table === 'items'));
  assert.ok(report.operations[0]!.accesses.some(a => a.table === 'items'));
  assert.deepEqual([readFileSync(source), readFileSync(source + '-wal')], before);
  assert.equal(db.prepare('select count(*) as n from audit').get()!.n, 1);
  symlinkSync(join(root, 'node_modules'), join(dir, 'node_modules'), 'dir');
  writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
  writeFileSync(join(dir, 'generated.ts'), report.generated);
  writeFileSync(join(dir, 'consumer.ts'), `
import { queries, type Row, type SqlValue } from ${JSON.stringify(library)};
import { generated, statements } from './generated.ts';
export const q = queries(generated, statements);
type Equal<A,B> = (<T>()=>T extends A?1:2) extends (<T>()=>T extends B?1:2) ? true : false;
type Assert<T extends true> = T;
export type Item = Assert<Equal<Row<typeof q.item>, {id:number;value:string|null}>>;
export type Legacy = Assert<Equal<Row<typeof q.legacy>, {value:SqlValue}>>;
`);
  const typed = spawnSync(join(root, 'node_modules/.bin/tsc'), ['--ignoreConfig','--noEmit','--strict','--skipLibCheck','--target','esnext','--module','nodenext','--allowImportingTsExtensions',join(dir,'consumer.ts')], {encoding:'utf8',timeout:30_000});
  assert.ifError(typed.error);
  assert.equal(typed.status, 0, typed.stdout + typed.stderr);
  writeFileSync(join(dir, 'execute.mjs'), `
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { node } from ${JSON.stringify(join(root, 'src/node.ts'))};
import { q } from './consumer.ts';
const db = new DatabaseSync(${JSON.stringify(source)});
try {
 const adapter = node(db);
 for (const [name, params] of [['item',{id:7}],['legacy',{}],['search',{}]]) {
   assert.deepEqual(await adapter.all(q[name],params), db.prepare(q[name].sql).all(params).map(row=>({...row})));
 }
 db.exec("insert into items values(8,'direct SQL')");
 assert.deepEqual(await adapter.all(q.item,{id:8}),[{id:8,value:'direct SQL'}]);
} finally {db.close();}
`);
  const executed = spawnSync(process.execPath,[join(dir,'execute.mjs')],{encoding:'utf8',timeout:10_000});
  assert.ifError(executed.error);
  assert.equal(executed.status, 0, executed.stdout + executed.stderr);
});

test('database CLI protects source aliases and companion files and checks current contracts', t => {
  const dir = mkdtempSync(join(tmpdir(), 'solarsql-source-protection-'));
  const source = join(dir, 'source.sqlite');
  const db = new DatabaseSync(source);
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  db.exec('pragma journal_mode=wal; create table items(value text) strict; insert into items values(\'kept\')');
  const catalog = join(dir, 'queries.json');
  writeFileSync(catalog, JSON.stringify({ item: 'select * from items' }));
  const symlink = join(dir, 'source-link.sqlite');
  const hardlink = join(dir, 'source-hardlink.sqlite');
  const journalLink = join(dir, 'journal-link');
  symlinkSync(source, symlink);
  linkSync(source, hardlink);
  symlinkSync(source + '-journal', journalLink);
  const before = [readFileSync(source), readFileSync(source + '-wal')];
  const run = (output: string, ...flags: string[]) => {
    const child = spawnSync(process.execPath, [join(root,'src/build/cli.ts'),'analyze','--database',symlink,catalog,'--out',output,...flags], {encoding:'utf8',timeout:10_000});
    assert.ifError(child.error);
    return { status: child.status, report: JSON.parse(child.stdout) };
  };
  for (const output of [source, symlink, hardlink, catalog, source+'-wal', source+'-shm', source+'-journal', journalLink]) {
    const result = run(output);
    assert.equal(result.status, 1);
    assert.match(result.report.diagnostics[0].message, /must differ/);
    assert.deepEqual([readFileSync(source), readFileSync(source + '-wal')], before);
  }
  const output = join(dir, 'generated.ts');
  const initial = run(output);
  assert.equal(initial.status, 0);
  assert.equal(initial.report.source.kind, 'database');
  assert.equal(run(output, '--check').status, 0);
  const generated = readFileSync(output, 'utf8');
  db.exec('alter table items add column count integer not null default 0');
  const stale = run(output, '--check');
  assert.equal(stale.status, 1);
  assert.notEqual(stale.report.source.schemaHash, initial.report.source.schemaHash);
  assert.equal(stale.report.diagnostics[0].code, 'GENERATED_STALE');
  assert.equal(readFileSync(output, 'utf8'), generated);
});

test('database analysis keeps one schema view while another WAL connection commits', t => {
  const dir = mkdtempSync(join(tmpdir(), 'solarsql-schema-view-'));
  const source = join(dir, 'source.sqlite');
  const writer = new DatabaseSync(source);
  t.after(() => { writer.close(); rmSync(dir, { recursive: true, force: true }); });
  writer.exec('pragma journal_mode=wal; create table items(value text) strict');
  const initial = analyzeDatabase(source, { item: 'select * from items' });
  const prepare = DatabaseSync.prototype.prepare;
  let changed = false;
  // Commit immediately after the reader acquires its schema view. Later facts
  // must describe that same view, even though the writer's schema is newer.
  const mock = t.mock.method(DatabaseSync.prototype, 'prepare', function (this: DatabaseSync, sql: string) {
    const statement = prepare.call(this, sql);
    if (!changed && sql.includes('from sqlite_schema')) {
      const all = statement.all.bind(statement);
      statement.all = () => {
        const rows = all();
        changed = true;
        writer.exec('alter table items add column newer integer');
        return rows;
      };
    }
    return statement;
  });
  const during = analyzeDatabase(source, { item: 'select * from items' });
  mock.mock.restore();
  assert.equal(changed, true);
  assert.equal(during.source.schemaHash, initial.source.schemaHash);
  assert.deepEqual(during.operations[0]!.columns, initial.operations[0]!.columns);
  const after = analyzeDatabase(source, { item: 'select * from items' });
  assert.notEqual(after.source.schemaHash, initial.source.schemaHash);
  assert.deepEqual(after.operations[0]!.columns.map(c => c.name), ['value', 'newer']);
});

test('database analysis preserves arbitrary SQLite values and source bytes', async t => {
  const { test: property } = await import('@hegeldev/hegel');
  const gs = await import('@hegeldev/hegel/generators');
  const dir = mkdtempSync(join(tmpdir(), 'solarsql-preserve-values-'));
  const source = join(dir, 'source.sqlite');
  const db = new DatabaseSync(source);
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  db.exec('create table values_table(value)');
  property(tc => {
    const kind = tc.draw(gs.integers({ minValue: 0, maxValue: 3 }));
    const value = kind === 0 ? null : kind === 1 ? tc.draw(gs.integers()) : kind === 2 ? tc.draw(gs.text({ maxSize: 50 }))
      : new Uint8Array(tc.draw(gs.arrays(gs.integers({ minValue: 0, maxValue: 255 }), { maxSize: 50 })));
    db.exec('delete from values_table');
    db.prepare('insert into values_table values (?)').run(value);
    const bytes = readFileSync(source);
    const row = db.prepare('select value from values_table').get();
    const report = analyzeDatabase(source, { value: 'select value from values_table' });
    assert.equal(report.operations[0]!.columns[0]!.type, 'SqlValue | null');
    assert.deepEqual(readFileSync(source), bytes);
    assert.deepEqual(db.prepare('select value from values_table').get(), row);
  });
});

const rowidSchema = `create table items(id integer primary key, value text) strict;
create table labels(label text primary key not null) strict;
create table shadows(RowId text not null, value text) strict;
create table keyed(id text primary key) without rowid;
create virtual table search using fts5(value);`;

test('row identifiers retain engine output names, shadowing, joins, and wildcard shape', t => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(rowidSchema);
  db.exec(`insert into items values(42,'item'); insert into labels(rowid,label) values(7,'label');
    insert into shadows(_rowid_,RowId,value) values(9,'declared','shadow'); insert into search(rowid,value) values(11,'search');`);
  const cases = [
    ['select rowid from items', ['number'], { id: 42 }],
    ['select _rowid_ as rid, oid as other from labels', ['number','number'], { rid:7, other:7 }],
    ['select RowId, _rowid_ as rid from shadows', ['string','number'], { RowId:'declared', rid:9 }],
    ['select s.rowid as rid from items i left join labels s on s.rowid=i.rowid', ['number | null'], { rid:null }],
    ['select rowid from search', ['number'], { rowid:11 }],
    ['select * from items', ['number | null','string | null'], { id:42,value:'item' }],
    ['select * from shadows natural join items', ['string','string | null','number | null'], undefined],
    ['with r as (select rowid as rid from items) select rid from r', ['number'], { rid:42 }],
  ] as const;
  for (const [sql, types, row] of cases) {
    const report = analyzeSchema(rowidSchema, { query:sql });
    assert.equal(report.operations[0]!.sql, sql);
    assert.deepEqual(report.operations[0]!.columns.map(c => c.type), types, sql);
    assert.deepEqual(report.operations[0]!.columns.map(c => c.name), db.prepare(sql).columns().map(c => c.name), sql);
    const actual = db.prepare(sql).get();
    assert.deepEqual(actual ? {...actual} : undefined, row, sql);
  }
  for (const name of ['rowid','_rowid_','oid']) {
    assert.throws(() => analyzeSchema(rowidSchema, { query:`select ${name} from keyed` }), /no such column/);
  }
});

test('generated row-identifier callers compile with numeric parameters', t => {
  const dir = mkdtempSync(join(tmpdir(),'solarsql-rowid-'));
  t.after(() => rmSync(dir,{recursive:true,force:true}));
  const root = resolve(import.meta.dirname,'..');
  const library = join(root,'src/index.ts');
  const sql = 'select rowid from items where oid=:id';
  const report = analyzeSchema(rowidSchema,{ byId:sql },library);
  writeFileSync(join(dir,'package.json'),'{"type":"module"}');
  writeFileSync(join(dir,'generated.ts'),report.generated);
  writeFileSync(join(dir,'consumer.ts'), `
import { queries, type Row, type Params } from ${JSON.stringify(library)};
import { generated, statements } from './generated.ts';
const q = queries(generated,statements);
type Equal<A,B> = (<T>()=>T extends A?1:2) extends (<T>()=>T extends B?1:2) ? true : false;
type Assert<T extends true> = T;
export type Result = Assert<Equal<Row<typeof q.byId>,{id:number}>>;
export type Input = Assert<Equal<Params<typeof q.byId>,{id:number}>>;
`);
  const result = spawnSync(join(root,'node_modules/.bin/tsc'), ['--ignoreConfig','--noEmit','--strict','--skipLibCheck','--target','esnext','--module','nodenext','--allowImportingTsExtensions',join(dir,'consumer.ts')], {encoding:'utf8',timeout:30_000});
  assert.equal(result.status,0,result.stdout+result.stderr);
});

test('row identifier parameters retain their type in writes', t => {
  const engine = new Engine(['create table items(value text) strict']);
  t.after(() => engine.close());
  const typer = new Typer(engine,new Map());
  for (const sql of ['update items set value=:value where rowid=:id', 'delete from items where oid=:id', 'insert into items(_rowid_,value) values(:id,:value)']) {
    assert.equal(typer.analyze(sql,'').params.find(p => p.name==='id')?.type,'number',sql);
  }
});

test('all unshadowed row-identifier spellings return the stored integer', async t => {
  const { test: property } = await import('@hegeldev/hegel');
  const gs = await import('@hegeldev/hegel/generators');
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec('create table values_table(value)');
  property(tc => {
    const id = tc.draw(gs.integers({minValue:-1_000_000,maxValue:1_000_000}));
    const name = ['rowid','_rowid_','oid','ROWID'][tc.draw(gs.integers({minValue:0,maxValue:3}))]!;
    db.exec('delete from values_table');
    db.prepare('insert into values_table(rowid,value) values(?,null)').run(id);
    const sql = `select ${name} as identifier from values_table where ${name}=:id`;
    const report = analyzeSchema('create table values_table(value)', {query:sql});
    assert.equal(report.operations[0]!.columns[0]!.type,'number');
    assert.equal(report.operations[0]!.params[0]!.type,'number');
    assert.equal(db.prepare(sql).get({id})!.identifier,id);
  });
});
