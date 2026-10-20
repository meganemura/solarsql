import { defineStep, z } from "nukadoko";
import installPackedSolarsql from "./install-packed-solarsql.ts";
import { runSolarsql } from "./lib/workspace.ts";

// The file name comes from the command's own `wrote` line, so the step
// follows the numbering solarsql chose.
export default defineStep({
  description: "Runs `solarsql migration add_note`, then `solarsql build` again.",
  pattern: "the agent writes the next migration",
  args: z.object({ project: z.string() }),
  returns: z.object({
    migrationExit: z.number().describe("the migration command's exit code"),
    file: z.string().describe("the migration file the command says it wrote, relative to the project"),
    buildExit: z.number().describe("the second build's exit code"),
    buildOutput: z.string().describe("what the second build printed"),
  }),
  from: { project: [installPackedSolarsql, "project"] },
  mutates: true,
  async run({}, { project }) {
    const migration = await runSolarsql(project, ["migration", "add_note"]);
    const file = /^wrote (migrations\/\S+\.sql)$/m.exec(migration.stdout)?.[1] ?? "";
    const build = await runSolarsql(project, ["build"]);
    return { migrationExit: migration.exitCode, file, buildExit: build.exitCode, buildOutput: `${build.stdout}${build.stderr}` };
  },
});
