import { defineStep, z } from "nukadoko";
import initProject from "./init-project.ts";
import installPackedSolarsql from "./install-packed-solarsql.ts";
import { addNoteColumn } from "./lib/note-column.ts";

export default defineStep({
  description: "Adds `note text` to the orders table in module.ts and `note` to the `all` query's select list, and builds nothing.",
  pattern: "the agent adds a nullable note column to the orders table and reads it in the list query",
  args: z.object({ project: z.string(), module: z.string() }),
  returns: z.object({ column: z.string().describe("the added column's name") }),
  from: { project: [installPackedSolarsql, "project"], module: [initProject, "module"] },
  mutates: true,
  run({}, { project, module }) {
    return { column: addNoteColumn(project, module) };
  },
});
