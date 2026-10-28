import { defineStep, z } from "nukadoko";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import initProject from "./init-project.ts";
import installPackedSolarsql from "./install-packed-solarsql.ts";

// The column has no NOT NULL, so the engine reports it nullable and the type
// must say so; a plain `string` would be a type the database does not keep.
// The sentence names the type in SQL words, so observe reads the TypeScript
// type and writes `string` as "text" and `|` as "or".
export default defineStep({
  description: "Reads the module's solarsql.generated.ts and claims the `all` query's row types `note` as `string | null`.",
  pattern: "the list query's row type has the note as text or null",
  args: z.object({ project: installPackedSolarsql.returns.shape.project, module: initProject.returns.shape.module }),
  from: { project: [installPackedSolarsql, "project"], module: [initProject, "module"] },
  observe({}, { project, module }) {
    const generated = readFileSync(join(project, module, "solarsql.generated.ts"), "utf8");
    const row = /"select id, name, done, note from orders order by name": \{\n\s+params: [^\n]*;\n\s+row: \{([^}]*)\};/.exec(generated)?.[1];
    if (row === undefined) return { note: "no row type for the list query" };
    const type = /(?:^|; )note: ([^;]+?)\s*(?:;|$)/.exec(row.trim())?.[1];
    if (type === undefined) return { note: `no note in the row { ${row.trim()} }` };
    return { note: type.split(" | ").map((part) => (part === "string" ? "text" : part)).join(" or ") };
  },
  claims: [{ actual: "note", compare: "equal", expected: { literal: "text or null" } }],
});
