import { defineStep, z } from "nukadoko";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import addColumnAndBuild from "./add-column-and-build.ts";
import initProject from "./init-project.ts";
import installPackedSolarsql from "./install-packed-solarsql.ts";

export default defineStep({
  description: "Reads the module's solarsql.generated.ts and asserts the `all` query's row has the new column typed `string | null`.",
  pattern: "the list query's row type has the note as text or null",
  args: z.object({ project: z.string(), module: z.string(), column: z.string() }),
  returns: z.object({}),
  from: { project: [installPackedSolarsql, "project"], module: [initProject, "module"], column: [addColumnAndBuild, "column"] },
  mutates: false,
  rationale: "The column has no NOT NULL, so the engine reports it nullable and the type must say so; a plain `string` would be a type the database does not keep.",
  run({}, { project, module, column }) {
    const generated = readFileSync(join(project, module, "solarsql.generated.ts"), "utf8");
    const entry = new RegExp(`"select id, name, done, ${column} from orders order by name": \\{\\n\\s+params: \\{\\};\\n\\s+row: \\{([^}]*)\\};`).exec(generated);
    if (entry === null) throw new Error(`the generated file has no entry for the list query:\n${generated}`);
    if (!entry[1]!.includes(`${column}: string | null`)) throw new Error(`the list query's row is {${entry[1]}}`);
    return {};
  },
});
