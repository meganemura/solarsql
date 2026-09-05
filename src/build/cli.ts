#!/usr/bin/env node
// Responsibility: the command line of solarsql.
//   solarsql build [config]             types, boundaries, migration check
//   solarsql migration <name> [config]  write the next migration file
// Boundary: printing and exit codes only. build.ts does the work.
import { build, migration } from "./build.ts";
import { BuildError } from "./typegen.ts";

const usage = `usage:
  solarsql build [solarsql.config.ts]
  solarsql migration <name> [solarsql.config.ts]`;

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (command === "build") {
    const result = await build(rest[0] ?? "solarsql.config.ts");
    for (const m of result.modules) {
      console.log(`${m.changed ? "wrote  " : "current"} ${m.generatedPath} (${m.entries} statements)`);
    }
    if (result.migration.reason) {
      console.error(`migration blocked: ${result.migration.reason}`);
      return 1;
    }
    if (result.migration.pending) {
      console.error(`schema changed. Write the migration: solarsql migration <name>`);
      for (const s of result.migration.statements) console.error(`  ${s.replace(/\s+/g, " ").trim()}`);
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
