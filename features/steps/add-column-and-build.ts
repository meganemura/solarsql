import { defineStep, z } from "nukadoko";
import initProject from "./init-project.ts";
import installPackedSolarsql from "./install-packed-solarsql.ts";
import { addNoteColumn } from "./lib/note-column.ts";
import { runSolarsql } from "./lib/workspace.ts";

export default defineStep({
  description:
    "Adds `note text` to the orders table in module.ts, adds `note` to the `all` query's select list, and runs `solarsql build`.",
  pattern: "the agent adds a nullable note column to the orders table, reads it in the list query, and builds",
  args: z.object({ project: z.string(), module: z.string() }),
  returns: z.object({
    exitCode: z.number().describe("the build's exit code"),
    output: z.string().describe("what the build printed"),
    column: z.string().describe("the added column's name"),
  }),
  from: { project: [installPackedSolarsql, "project"], module: [initProject, "module"] },
  mutates: true,
  async run({}, { project, module }) {
    const column = addNoteColumn(project, module);
    const { exitCode, stdout, stderr } = await runSolarsql(project, ["build"]);
    return { exitCode, output: `${stdout}${stderr}`, column };
  },
});
