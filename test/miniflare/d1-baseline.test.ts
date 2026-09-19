// The baseline path for an existing D1 database (migrations.md, "An existing
// D1 database") on Miniflare's D1, not only node:sqlite. This test creates
// the example's tables by raw SQL, the way a database made before solarsql
// would already have them, records the baseline migration as applied by
// inserting into d1_migrations directly (no baseline file runs), applies
// only the later files, and checks the schema against a full replay of
// every file on an empty database.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { D1Harness, type WorkerOk } from "../d1.ts";
import { splitStatements } from "../../src/build/scan.ts";

const migrationsDir = resolve(import.meta.dirname, "../../example/migrations");
const readMigration = (name: string): string => readFileSync(resolve(migrationsDir, name), "utf8");

const baselineFile = readMigration("0001_initial.sql");
const laterFiles = [
  "0002_orders_customer_id.sql",
  "0003_views_and_triggers.sql",
  "0004_search.sql",
  "0005_customer_name_not_empty.sql",
].map(readMigration);

function rows(reply: WorkerOk): Record<string, unknown>[] {
  return (reply.results as { results: Record<string, unknown>[] }).results;
}

// d1_migrations, its own AUTOINCREMENT bookkeeping table (sqlite_sequence),
// and its own index are wrangler's, not the declared schema: only the
// adopted database has them, because only it carries the bookkeeping insert.
async function schemaOf(d1: D1Harness): Promise<Record<string, unknown>[]> {
  const schema = await d1.all(
    "select name, type, sql from sqlite_schema where name not in ('d1_migrations', 'sqlite_sequence', 'sqlite_autoindex_d1_migrations_1') order by name",
  );
  assert.equal(schema.ok, true, JSON.stringify(schema));
  return rows(schema as WorkerOk);
}

describe("the baseline path for an existing D1 database", () => {
  test("adopting a legacy table and applying only the later files matches a full replay", async (t) => {
    const adopted = new D1Harness();
    const replayed = new D1Harness();
    t.after(async () => {
      await adopted.dispose();
      await replayed.dispose();
    });

    // The database as it already exists, made by hand or another tool: the
    // baseline file's own DDL, applied directly, not through solarsql.
    const create = await adopted.batch(splitStatements(baselineFile).map((sql) => ({ sql })));
    assert.equal(create.ok, true, JSON.stringify(create));

    // wrangler's own bookkeeping table (skills/solarsql/references/migrations.md,
    // "An existing D1 database" records its exact schema). The baseline row
    // is recorded as applied; its file never runs.
    const bookkeeping = await adopted.batch([
      {
        sql: `create table d1_migrations(
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT UNIQUE,
          applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
        )`,
      },
      { sql: "insert into d1_migrations (name) values ('0001_initial.sql')" },
    ]);
    assert.equal(bookkeeping.ok, true, JSON.stringify(bookkeeping));

    // Only the files after the baseline apply, the same shape
    // test/miniflare/d1-migration.test.ts applies each file in.
    for (const file of laterFiles) {
      const reply = await adopted.batch(splitStatements(file).map((sql) => ({ sql })));
      assert.equal(reply.ok, true, JSON.stringify(reply));
    }

    // A full replay of every file, from an empty database, in order.
    const full = await replayed.batch(splitStatements(baselineFile).map((sql) => ({ sql })));
    assert.equal(full.ok, true, JSON.stringify(full));
    for (const file of laterFiles) {
      const reply = await replayed.batch(splitStatements(file).map((sql) => ({ sql })));
      assert.equal(reply.ok, true, JSON.stringify(reply));
    }

    assert.deepEqual(await schemaOf(adopted), await schemaOf(replayed));
  });
});
