import { defineStep, z } from "nukadoko";
import { createProject, packCheckout } from "../../.claude/skills/verify-solarsql/lib/workspace.ts";

// The packed tarball is what a user installs, so the scenario does too: a
// file left out of the package's files list fails here and nowhere else. The
// control CLI's launch runs the same two functions.
export default defineStep({
  description:
    "Packs this checkout with `npm pack`, which builds dist/ through prepack, and installs the tarball into an empty scratch project whose package.json has `type: module`.",
  pattern: "an empty ES module project with the packed solarsql installed",
  args: z.object({}),
  returns: z.object({ project: z.string().describe("the scratch project's root, with solarsql in its node_modules") }),
  mutates: true,
  async run({ scratch }) {
    const tarball = await packCheckout(scratch.dir("solarsql-scenario-pack"));
    return { project: await createProject(scratch.dir("solarsql-scenario-project"), tarball) };
  },
});
