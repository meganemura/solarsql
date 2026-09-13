// Responsibility: check project-free discovery through the source CLI.
// Boundary: pack.test.ts applies the same checks to the installed artifact.
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { checkDiscovery } from "./cli-discovery.ts";

test("CLI help and version do not load a project", () => {
  const metadata = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  checkDiscovery([process.execPath, fileURLToPath(new URL("../src/build/cli.ts", import.meta.url))], metadata.version);
});
