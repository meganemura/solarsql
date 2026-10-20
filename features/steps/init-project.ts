import { defineStep, z } from "nukadoko";
import installPackedSolarsql from "./install-packed-solarsql.ts";
import { runSolarsql } from "../../.claude/skills/verify-solarsql/lib/workspace.ts";

// init refuses a project that already has a config, so its exit code is
// checked here rather than in a later step.
export default defineStep({
  description: "Runs `solarsql init orders` in the project, which writes the config, the module, its test, the generated types, and the first migration.",
  pattern: "the agent starts a project with a module named orders",
  args: z.object({ project: z.string() }),
  returns: z.object({ module: z.string().describe("the module's directory, relative to the project") }),
  from: { project: [installPackedSolarsql, "project"] },
  mutates: true,
  async run({}, { project }) {
    const { exitCode, stdout, stderr } = await runSolarsql(project, ["init", "orders"]);
    if (exitCode !== 0) throw new Error(`init exited ${exitCode}:\n${stdout}${stderr}`);
    return { module: "modules/orders" };
  },
});
