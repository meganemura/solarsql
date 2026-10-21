import { defineStep, z } from "nukadoko";
import { runSolarsql } from "./lib/workspace.ts";
import installPackedSolarsql from "./install-packed-solarsql.ts";

// The files are compared around the command itself, so "writes nothing" is
// measured on disk rather than read from what the check printed. nukadoko's
// runCommand walks the project before and after the command and returns the
// difference; node_modules is not walked, and a walk it could not finish is
// a failure here rather than an empty list.
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
    const { exitCode, stdout, stderr, files } = await runSolarsql(project, ["build", "--check"]);
    if (files === undefined) throw new Error("nukadoko did not measure the files the check changed");
    if ("unmeasured" in files) throw new Error(`nukadoko could not measure the files the check changed: ${files.unmeasured}`);
    return { exitCode, output: `${stdout}${stderr}`, written: [...files.added, ...files.changed, ...files.removed] };
  },
});
