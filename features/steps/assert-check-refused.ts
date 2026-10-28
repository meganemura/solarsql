import { defineStep, z } from "nukadoko";
import runBuildCheck from "./run-build-check.ts";

// The expected values come from the build reference, not from the check's
// output: exit 1, no file written, and `npx solarsql build` as the recovery.
// The sentence says "fails" and "the build", so observe turns exit 1 and the
// `next:` line into those words, and names what it saw instead when they do
// not hold.
export default defineStep({
  description: "Claims the check exited 1, wrote no file, and names `npx solarsql build` on its `next:` line as the recovery.",
  pattern: "the check fails, names the build as the recovery, and writes nothing",
  args: z.object({
    exitCode: runBuildCheck.returns.shape.exitCode,
    output: runBuildCheck.returns.shape.output,
    written: runBuildCheck.returns.shape.written,
  }),
  from: { exitCode: [runBuildCheck, "exitCode"], output: [runBuildCheck, "output"], written: [runBuildCheck, "written"] },
  observe({}, { exitCode, output }) {
    const next = /^next: (.*)$/m.exec(output)?.[1];
    return {
      outcome: exitCode === 1 ? "fails" : `exits ${exitCode}`,
      recovery: next === "npx solarsql build" ? "the build" : next === undefined ? "no next line" : `next: ${next}`,
    };
  },
  claims: [
    { actual: "outcome", compare: "equal", expected: { literal: "fails" } },
    { actual: "recovery", compare: "equal", expected: { literal: "the build" } },
    { actual: "written", compare: "equal", expected: { literal: [] } },
  ],
});
