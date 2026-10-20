import { defineStep, z } from "nukadoko";
import runBuildCheck from "./run-build-check.ts";

// The expected values come from the build reference, not from the check's
// output: exit 1, no file written, and `npx solarsql build` as the recovery.
export default defineStep({
  description: "Asserts the check exited 1, wrote no file, and names `npx solarsql build` as the recovery.",
  pattern: "the check fails, names the build as the recovery, and writes nothing",
  args: z.object({ exitCode: z.number(), output: z.string(), written: z.array(z.string()) }),
  from: { exitCode: [runBuildCheck, "exitCode"], output: [runBuildCheck, "output"], written: [runBuildCheck, "written"] },
  mutates: false,
  run({}, { exitCode, output, written }) {
    if (exitCode !== 1) throw new Error(`the check exited ${exitCode}:\n${output}`);
    if (written.length > 0) throw new Error(`the check wrote ${written.join(", ")}`);
    if (!output.includes("npx solarsql build")) throw new Error(`the check names no recovery:\n${output}`);
  },
});
