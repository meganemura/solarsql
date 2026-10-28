import { defineStep, z } from "nukadoko";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import addColumnAndBuild from "./add-column-and-build.ts";
import installPackedSolarsql from "./install-packed-solarsql.ts";
import writeMigration from "./write-migration.ts";

// The second build is what proves the migration files now reproduce the
// declared schema; the file's text alone would not. The file is read only
// when the migration command exited 0 and wrote the second file, the one
// after init's; otherwise observe names what the command did. "current"
// holds only when the second build exited 0 and said the migrations are
// current.
export default defineStep({
  description:
    "Claims the migration is the second file and adds the new column, and the next build exits 0 and reports the migrations current.",
  pattern: "the migration file adds the column and the build reports the migrations current",
  args: z.object({
    project: installPackedSolarsql.returns.shape.project,
    column: addColumnAndBuild.returns.shape.column,
    migrationExit: writeMigration.returns.shape.migrationExit,
    file: writeMigration.returns.shape.file,
    buildExit: writeMigration.returns.shape.buildExit,
    buildOutput: writeMigration.returns.shape.buildOutput,
  }),
  from: {
    project: [installPackedSolarsql, "project"],
    column: [addColumnAndBuild, "column"],
    migrationExit: [writeMigration, "migrationExit"],
    file: [writeMigration, "file"],
    buildExit: [writeMigration, "buildExit"],
    buildOutput: [writeMigration, "buildOutput"],
  },
  observe({}, { project, migrationExit, file, buildExit, buildOutput }) {
    const second = migrationExit === 0 && file === "migrations/0002_add_note.sql";
    const sql = second ? readFileSync(join(project, file), "utf8") : "";
    return {
      adds: second
        ? [...sql.matchAll(/alter table main\."orders" add column (\w+) text;/g)].map((match) => match[1]!)
        : `the migration command exited ${migrationExit} and wrote ${JSON.stringify(file)}`,
      migrations: buildExit === 0 && buildOutput.includes("migrations are current") ? "current" : `the build exited ${buildExit}: ${buildOutput.trim().split("\n").pop()}`,
    };
  },
  claims: [
    { actual: "adds", compare: "has-item", expected: { from: "column" } },
    { actual: "migrations", compare: "equal", expected: { literal: "current" } },
  ],
});
