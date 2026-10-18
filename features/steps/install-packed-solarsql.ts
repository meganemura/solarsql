import { defineStep, runCommand, z } from "nukadoko";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

// The packed tarball is what a user installs, so the scenario does too: a
// file left out of the package's files list fails here and nowhere else. The
// package has no runtime dependencies, so the install reads no registry.
export default defineStep({
  description:
    "Packs this checkout with `npm pack`, which builds dist/ through prepack, and installs the tarball into an empty scratch project whose package.json has `type: module`.",
  pattern: "an empty ES module project with the packed solarsql installed",
  args: z.object({}),
  returns: z.object({ project: z.string().describe("the scratch project's root, with solarsql in its node_modules") }),
  mutates: true,
  async run({ scratch }) {
    const packs = scratch.dir("solarsql-scenario-pack");
    const pack = await runCommand("npm", ["pack", "--silent", "--pack-destination", packs], { cwd: ROOT });
    if (pack.exitCode !== 0) throw new Error(`npm pack exited ${pack.exitCode}:\n${pack.stdout}${pack.stderr}`);
    const tarball = join(packs, pack.stdout.trim().split("\n").pop()!);
    if (!existsSync(tarball)) throw new Error(`npm pack wrote no tarball: ${pack.stdout}`);
    const project = join(scratch.dir("solarsql-scenario-project"), "app");
    mkdirSync(project);
    writeFileSync(join(project, "package.json"), JSON.stringify({ name: "app", private: true, type: "module" }));
    const install = await runCommand("npm", ["install", "--silent", "--no-audit", "--no-fund", tarball], { cwd: project });
    if (install.exitCode !== 0) throw new Error(`npm install exited ${install.exitCode}:\n${install.stdout}${install.stderr}`);
    return { project };
  },
});
