import { defineStep, z } from "nukadoko";
import { spawnSync } from "node:child_process";
import installPackedSolarsql from "./install-packed-solarsql.ts";

export default defineStep({
  description: "Runs bare `node --test` in the project, as init's next line says, and asserts one test passed and none failed.",
  pattern: "the module's own test passes",
  args: z.object({ project: z.string() }),
  returns: z.object({}),
  from: { project: [installPackedSolarsql, "project"] },
  mutates: false,
  rationale: "A child node inherits NODE_TEST_CONTEXT from a runner above it and would report there instead of to its stdout, so the variable is removed.",
  run({}, { project }) {
    const { NODE_TEST_CONTEXT: _, ...env } = process.env;
    const result = spawnSync(process.execPath, ["--test"], { cwd: project, encoding: "utf8", env });
    if (result.status !== 0 || !/^ℹ pass 1$/m.test(result.stdout)) throw new Error(`node --test exited ${result.status}:\n${result.stdout}${result.stderr}`);
    return {};
  },
});
