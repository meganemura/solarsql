import { defineStep, z } from "nukadoko";
import addColumnAndBuild from "./add-column-and-build.ts";

// A pending migration is not a build failure: the types are written either
// way, and the next line tells the agent what to run. So "pending" holds only
// when the build exited 0, said the migration is pending, and named
// `solarsql migration` as the next command; otherwise observe names what the
// build did. The columns come from the add-column statements the build
// printed, and the claim compares them with the column the edit added.
export default defineStep({
  description:
    "Claims the build exited 0, says a migration is pending, names `solarsql migration` as the next command, and prints an add-column statement for the new column.",
  pattern: "the build says a migration that adds the column is pending",
  args: z.object({
    exitCode: addColumnAndBuild.returns.shape.exitCode,
    output: addColumnAndBuild.returns.shape.output,
    column: addColumnAndBuild.returns.shape.column,
  }),
  from: { exitCode: [addColumnAndBuild, "exitCode"], output: [addColumnAndBuild, "output"], column: [addColumnAndBuild, "column"] },
  observe({}, { exitCode, output }) {
    const said = output.includes("migration pending");
    const next = /^next: npx solarsql migration <name>$/m.test(output);
    return {
      migration: exitCode === 0 && said && next ? "pending" : `build exited ${exitCode}, ${said ? "said" : "did not say"} a migration is pending, ${next ? "named" : "did not name"} the migration command`,
      adds: [...output.matchAll(/alter table main\."orders" add column (\w+) text/g)].map((match) => match[1]!),
    };
  },
  claims: [
    { actual: "migration", compare: "equal", expected: { literal: "pending" } },
    { actual: "adds", compare: "has-item", expected: { from: "column" } },
  ],
});
