import { defineStep, z } from "nukadoko";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import addColumnAndBuild from "./add-column-and-build.ts";
import installPackedSolarsql from "./install-packed-solarsql.ts";
import writeMigration from "./write-migration.ts";

export default defineStep({
  description: "Asserts the migration is the second file and holds the add-column statement, and the next build reports the migrations current.",
  pattern: "the migration file adds the column and the build reports the migrations current",
  args: z.object({
    project: z.string(),
    column: z.string(),
    migrationExit: z.number(),
    file: z.string(),
    buildExit: z.number(),
    buildOutput: z.string(),
  }),
  returns: z.object({}),
  from: {
    project: [installPackedSolarsql, "project"],
    column: [addColumnAndBuild, "column"],
    migrationExit: [writeMigration, "migrationExit"],
    file: [writeMigration, "file"],
    buildExit: [writeMigration, "buildExit"],
    buildOutput: [writeMigration, "buildOutput"],
  },
  mutates: false,
  rationale: "The second build is what proves the migration files now reproduce the declared schema; the file's text alone would not.",
  run({}, { project, column, migrationExit, file, buildExit, buildOutput }) {
    if (migrationExit !== 0) throw new Error(`migration exited ${migrationExit}`);
    if (file !== "migrations/0002_add_note.sql") throw new Error(`expected migrations/0002_add_note.sql, got ${JSON.stringify(file)}`);
    const sql = readFileSync(join(project, file), "utf8");
    if (!sql.includes(`alter table main."orders" add column ${column} text;`)) throw new Error(`the migration does not add ${column}:\n${sql}`);
    if (buildExit !== 0 || !buildOutput.includes("migrations are current")) throw new Error(`the build after the migration says:\n${buildOutput}`);
    return {};
  },
});
