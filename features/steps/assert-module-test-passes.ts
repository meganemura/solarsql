import { defineStep, runCommand, z } from "nukadoko";
import installPackedSolarsql from "./install-packed-solarsql.ts";

// A child node inherits NODE_TEST_CONTEXT from a runner above it and would
// report there instead of to its stdout, so the variable is removed.
export default defineStep({
  description: "Runs bare `node --test` in the project, as init's next line says, and asserts one test passed and none failed.",
  pattern: "the module's own test passes",
  args: z.object({ project: z.string() }),
  from: { project: [installPackedSolarsql, "project"] },
  mutates: false,
  async run({}, { project }) {
    const { NODE_TEST_CONTEXT: _, ...env } = process.env;
    const result = await runCommand(process.execPath, ["--test"], { cwd: project, env });
    if (result.exitCode !== 0 || !/^ℹ pass 1$/m.test(result.stdout)) throw new Error(`node --test exited ${result.exitCode}:\n${result.stdout}${result.stderr}`);
  },
});
