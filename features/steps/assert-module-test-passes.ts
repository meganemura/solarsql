import { defineStep, runCommand, z } from "nukadoko";
import installPackedSolarsql from "./install-packed-solarsql.ts";

// A child node inherits NODE_TEST_CONTEXT from a runner above it and would
// report there instead of to its stdout, so the variable is removed. Running
// the test is the reading: it writes nothing in the project. The sentence
// says "passes", so observe turns exit 0 with one passing test into that
// word, and names the exit code and the counts otherwise.
export default defineStep({
  description: "Runs bare `node --test` in the project, as init's next line says, and claims it exited 0 with one test passed.",
  pattern: "the module's own test passes",
  args: z.object({ project: installPackedSolarsql.returns.shape.project }),
  from: { project: [installPackedSolarsql, "project"] },
  async observe({}, { project }) {
    const { NODE_TEST_CONTEXT: _, ...env } = process.env;
    const result = await runCommand(process.execPath, ["--test"], { cwd: project, env });
    const count = (name: string) => new RegExp(`^ℹ ${name} (\\d+)$`, "m").exec(result.stdout)?.[1] ?? "?";
    const passed = result.exitCode === 0 && count("pass") === "1";
    return { test: passed ? "passes" : `exits ${result.exitCode} with ${count("pass")} passed and ${count("fail")} failed` };
  },
  claims: [{ actual: "test", compare: "equal", expected: { literal: "passes" } }],
});
