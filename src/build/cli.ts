#!/usr/bin/env node
// Responsibility: the command line of solarsql.
//   solarsql build [config]             types, boundaries, migration check
//   solarsql build --check [config]     the same, writing nothing; exit 1 when a file is stale
//   solarsql migration <name> [config]  write the next migration file
// Boundary: printing and exit codes only. build.ts does the work.
import { build, migration } from "./build.ts";
import { BuildError } from "./typegen.ts";

const usage = `usage:
  solarsql build [solarsql.config.ts]
  solarsql build --check [solarsql.config.ts]   writes nothing; exit 1 when a generated file or a migration is stale
  solarsql migration <name> [solarsql.config.ts]`;

// One line of SQL, enough to recognize the statement.
function oneLine(sql: string): string {
  return sql.replace(/\s+/g, " ").trim().slice(0, 100);
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (command === "build") {
    const check = rest.includes("--check");
    const args = rest.filter((a) => a !== "--check");
    const result = await build(args[0] ?? "solarsql.config.ts", { write: !check });
    for (const m of result.modules) {
      console.log(`${m.changed ? (check ? "stale  " : "wrote  ") : "current"} ${m.generatedPath} (${m.entries} statements)`);
      for (const k of m.added) console.log(`  + ${oneLine(k)}`);
      for (const k of m.removed) console.log(`  - ${oneLine(k)}`);
    }
    for (const s of result.scans) {
      console.log(`scan    ${s.module}: ${s.tables.join(", ")} read in full by: ${oneLine(s.sql)}`);
    }
    if (result.index.path !== null && result.index.changed) console.log(`${check ? "stale  " : "wrote  "} ${result.index.path} (the migration files, for a Durable Object)`);
    if (result.migration.reason) {
      console.error(`migration blocked: ${result.migration.reason}`);
      return 1;
    }
    if (result.migration.pending) {
      console.error(`schema changed. Write the migration: solarsql migration <name>`);
      for (const s of result.migration.statements) console.error(`  ${s.replace(/\s+/g, " ").trim()}`);
      return 1;
    }
    if (check && (result.modules.some((m) => m.changed) || result.index.changed)) {
      console.error("generated files are stale. Run: npx solarsql build");
      return 1;
    }
    console.log("migrations are current");
    return 0;
  }
  if (command === "migration") {
    const name = rest[0];
    if (!name) {
      console.error(usage);
      return 2;
    }
    const result = await migration(rest[1] ?? "solarsql.config.ts", name);
    if (result.reason) {
      console.error(`migration blocked: ${result.reason}`);
      return 1;
    }
    console.log(result.filename ? `wrote ${result.filename}` : "nothing to migrate");
    return 0;
  }
  console.error(usage);
  return 2;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e) => {
    if (e instanceof BuildError) console.error(`error: ${e.message}`);
    else console.error(e);
    process.exit(1);
  },
);
