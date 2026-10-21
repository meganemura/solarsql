import { defineStep, z } from "nukadoko";
import { createProject } from "./lib/workspace.ts";

// The packed tarball is what a user installs, so the scenario does too: a
// file left out of the package's files list fails here and nowhere else. The
// control CLI's launch runs the same two functions. The tarball comes from
// the packedSolarsql fixture, packed once per run (nukadoko.config.ts).
export default defineStep({
  description:
    "Packs this checkout with `npm pack`, which builds dist/ through prepack, and installs the tarball into an empty scratch project whose package.json has `type: module`.",
  pattern: "an empty ES module project with the packed solarsql installed",
  args: z.object({}),
  returns: z.object({ project: z.string().describe("the scratch project's root, with solarsql in its node_modules") }),
  mutates: true,
  async run({ scratch, packedSolarsql }) {
    return { project: await createProject(scratch.dir("solarsql-scenario-project"), packedSolarsql) };
  },
});
