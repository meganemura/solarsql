import { defineStep, z } from "nukadoko";
import addColumnAndBuild from "./add-column-and-build.ts";

// A pending migration is not a build failure: the types are written either
// way, and the next line tells the agent what to run.
export default defineStep({
  description: "Asserts the build passed, says a migration is pending, prints the add-column statement, and names `solarsql migration` as the next command.",
  pattern: "the build says a migration that adds the column is pending",
  args: z.object({ exitCode: z.number(), output: z.string(), column: z.string() }),
  from: { exitCode: [addColumnAndBuild, "exitCode"], output: [addColumnAndBuild, "output"], column: [addColumnAndBuild, "column"] },
  mutates: false,
  run({}, { exitCode, output, column }) {
    if (exitCode !== 0) throw new Error(`build exited ${exitCode}:\n${output}`);
    if (!output.includes("migration pending")) throw new Error(`the build did not report a pending migration:\n${output}`);
    if (!output.includes(`alter table main."orders" add column ${column} text`)) throw new Error(`the build did not print the add-column statement:\n${output}`);
    if (!/^next: npx solarsql migration <name>$/m.test(output)) throw new Error(`the build did not name the migration command:\n${output}`);
  },
});
