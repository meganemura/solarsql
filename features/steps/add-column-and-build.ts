import { defineStep, z } from "nukadoko";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import initProject from "./init-project.ts";
import installPackedSolarsql from "./install-packed-solarsql.ts";
import { runSolarsql } from "./solarsql-cli.ts";

function replaceOnce(source: string, from: string, to: string): string {
  if (!source.includes(from)) throw new Error(`module.ts no longer holds ${JSON.stringify(from)}; init's template changed`);
  return source.replace(from, to);
}

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
  rationale: "The edit is to the text init wrote, so a change to that template fails this step by name instead of producing a schema nobody meant.",
  run({}, { project, module }) {
    const path = join(project, module, "module.ts");
    let source = readFileSync(path, "utf8");
    source = replaceOnce(source, "check (done in (0, 1))\n", "check (done in (0, 1)),\n    note text\n");
    source = replaceOnce(source, "all: `select id, name, done from orders", "all: `select id, name, done, note from orders");
    writeFileSync(path, source);
    const { exitCode, stdout } = runSolarsql(project, ["build"]);
    return { exitCode, output: stdout, column: "note" };
  },
});
