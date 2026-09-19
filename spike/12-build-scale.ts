// Responsibility: measure `solarsql build` on a generated project of N
// modules and M statements each, so a project past the example's three
// modules has a number to expect.
// Boundary: this experiment prints evidence; it does not change build.ts.
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { build } from "../src/build/build.ts";

const library = resolve(import.meta.dirname, "../src/index.ts");

// One module's files: a table with a text primary key, a text column that
// references the previous module's table when there is one, two more text
// columns, one integer, one real; one index; M/2 queries and M/2 commands.
// Every statement's SQL text is unique within the module, so the build's
// per-statement typing map (keyed by SQL text) sees M distinct entries
// instead of the 3 templates repeating.
export function moduleFiles(i: number, m: number, libraryPath: string = library): string {
  const table = i - 1;
  const tableName = `t${i}`;
  const prevName = i > 0 ? `t${table}` : tableName; // module 0 self-joins: same template, no cross-module read
  const readsAll = i > 0;
  const half = m / 2;

  const createTable = `create table ${tableName} (
    id text primary key not null,
    parent_id text${i > 0 ? ` references t${table}(id)` : ""},
    a text not null,
    b text not null,
    n integer not null,
    r real not null
  ) strict`;
  const createIndex = `create index ${tableName}_parent on ${tableName} (parent_id)`;

  const queryLines: string[] = [];
  for (let j = 0; j < half; j++) {
    const kind = j % 3;
    if (kind === 0) {
      const col = j % 2 === 0 ? "a" : "b";
      queryLines.push(`  q${j}: \`select id, a, b, n, r from ${tableName} where ${col} = :p${j}\`,`);
    } else if (kind === 1) {
      queryLines.push(`  q${j}: \`
    select p.id, p.a as parent_a,
      coalesce(json_group_array(json_object('id', c.id, 'a', c.a)) filter (where c.id is not null), '[]') as children
    from ${prevName} p
    left join ${tableName} c on c.parent_id = p.id
    where p.id = :parent_id${j}
    group by p.id\`,`);
    } else {
      queryLines.push(`  q${j}: \`select id, a, b from ${tableName} order by id limit :limit${j} offset :offset${j}\`,`);
    }
  }

  const commandLines: string[] = [];
  for (let j = 0; j < half; j++) {
    const kind = j % 3;
    if (kind === 0) {
      commandLines.push(`  c${j}: {
    plan: ["insert into ${tableName} (id, parent_id, a, b, n, r) values (:id${j}, :parent_id${j}, :a${j}, :b${j}, :n${j}, :r${j})"],
    returns: "select id, a, b, n, r from ${tableName} where id = :id${j}",
  },`);
    } else if (kind === 1) {
      commandLines.push(`  c${j}: {
    plan: [
      "update ${tableName} set a = :a${j} where id = :id${j}",
      assert("chg_${i}_${j}", "changes() = 1 and ${j} = ${j}"),
    ],
  },`);
    } else {
      commandLines.push(`  c${j}: {
    plan: ["delete from ${tableName} where id = :id${j}"],
  },`);
    }
  }

  return `import { assert, commands, index, queries, table } from ${JSON.stringify(libraryPath)};
import { generated } from "./solarsql.generated.ts";

export const ${tableName} = table(\`${createTable}\`);
export const ${tableName}Index = index(\`${createIndex}\`);

export const ${tableName}Queries = queries(generated, {
${queryLines.join("\n")}
});

export const ${tableName}Commands = commands(generated, {
${commandLines.join("\n")}
});
`;
}

export function moduleConfigEntry(i: number): string {
  return i > 0 ? `{ dir: "./t${i}", readsAll: true }` : `"./t0"`;
}

// Writes a fresh project of N modules and M statements each under `dir`,
// and returns the path of its solarsql.config.ts. `libraryPath` defaults to
// this repository's own src/index.ts (spike/12's own use); a caller that
// copies src/ elsewhere (spike/13's scale starter, so a battery run never
// imports the repository's own source) passes that copy's path instead.
export function writeProject(dir: string, n: number, m: number, libraryPath: string = library): string {
  for (let i = 0; i < n; i++) {
    const moduleDir = join(dir, `t${i}`);
    mkdirSync(moduleDir, { recursive: true });
    writeFileSync(join(moduleDir, "module.ts"), moduleFiles(i, m, libraryPath));
  }
  const configPath = join(dir, "solarsql.config.ts");
  const modules = Array.from({ length: n }, (_, i) => moduleConfigEntry(i)).join(", ");
  writeFileSync(configPath, `export default { modules: [${modules}], migrations: "./migrations", library: ${JSON.stringify(libraryPath)} };\n`);
  return configPath;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

type Row = { n: number; m: number; totalMs: number; moduleMedianMs: number; moduleMaxMs: number; overheadMs: number; entries: number; generatedBytes: number };

async function measure(n: number, m: number): Promise<Row> {
  let last: Row | undefined;
  for (let trial = 0; trial < 2; trial++) {
    const dir = mkdtempSync(join(tmpdir(), "solarsql-build-scale-"));
    try {
      const configPath = writeProject(dir, n, m);
      const result = await build(configPath);
      if (trial === 1) {
        const moduleMs = result.modules.map((mod) => mod.ms);
        const sampleModule = result.modules[Math.min(1, result.modules.length - 1)]!;
        last = {
          n, m,
          totalMs: result.ms,
          moduleMedianMs: median(moduleMs),
          moduleMaxMs: Math.max(...moduleMs),
          overheadMs: result.ms - moduleMs.reduce((sum, ms) => sum + ms, 0),
          entries: sampleModule.entries,
          generatedBytes: statSync(sampleModule.generatedPath).size,
        };
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  return last!;
}

async function main(): Promise<void> {
  const sizes: [number, number][] = [[1, 10], [5, 20], [20, 20], [50, 20], [20, 100]];
  const rows: Row[] = [];
  for (const [n, m] of sizes) rows.push(await measure(n, m));

  const sqlite = String(new DatabaseSync(":memory:").prepare("select sqlite_version() as v").get()!.v);
  console.log(`node ${process.version}, sqlite ${sqlite}`);
  console.log();
  console.log("| N | M | total ms | module ms (median) | module ms (max) | overhead ms | entries/module | generated bytes |");
  console.log("|---|---|---|---|---|---|---|---|");
  for (const row of rows) {
    console.log(`| ${row.n} | ${row.m} | ${row.totalMs} | ${row.moduleMedianMs} | ${row.moduleMaxMs} | ${row.overheadMs} | ${row.entries} | ${row.generatedBytes} |`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
