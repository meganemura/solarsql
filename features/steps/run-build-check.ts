import { defineStep, z } from "nukadoko";
import { changedFiles, projectFiles, runSolarsql } from "./lib/workspace.ts";
import installPackedSolarsql from "./install-packed-solarsql.ts";

// The files are compared around the command itself, so "writes nothing" is
// measured on disk rather than read from what the check printed.
export default defineStep({
  description: "Runs `solarsql build --check` and lists every project file outside node_modules that the command added, changed, or removed.",
  pattern: "the agent runs the build's check",
  args: z.object({ project: z.string() }),
  returns: z.object({
    exitCode: z.number().describe("the check's exit code"),
    output: z.string().describe("what the check printed"),
    written: z.array(z.string()).describe("files the check added, changed, or removed, relative to the project"),
  }),
  from: { project: [installPackedSolarsql, "project"] },
  mutates: true,
  async run({}, { project }) {
    const before = projectFiles(project);
    const { exitCode, stdout, stderr } = await runSolarsql(project, ["build", "--check"]);
    const { added, changed, removed } = changedFiles(before, projectFiles(project));
    return { exitCode, output: `${stdout}${stderr}`, written: [...added, ...changed, ...removed] };
  },
});
