// Responsibility: a copy of src/ and example/ that keeps their relative
// layout, so example/solarsql.config.ts's "../src/index.ts" import and each
// module's "../../../src/index.ts" stay valid inside the copy.
// Boundary: this file only copies; a caller edits, builds, or runs tsc on
// its own copy and owns its cleanup (rmSync or onTestFinished).
import { cpSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");

export function copyExample(dir: string = mkdtempSync(join(tmpdir(), "solarsql-"))): string {
  cpSync(join(root, "src"), join(dir, "src"), { recursive: true });
  cpSync(join(root, "example"), join(dir, "example"), { recursive: true });
  // The copy is an ES module project, like the repository. The build's
  // "next:" line names `npm test`; a copy with no test script turns that
  // line into a failed command instead of the file-not-found error that
  // `node --test` gives on an empty test/ (spike/13-agent-battery's starter
  // is this function plus bin shims, so this script covers it too).
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "solarsql-copy", private: true, type: "module", scripts: { test: "node --test" } }),
  );
  writeFileSync(
    join(dir, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        target: "esnext",
        module: "nodenext",
        strict: true,
        exactOptionalPropertyTypes: true,
        noUncheckedIndexedAccess: true,
        noEmit: true,
        allowImportingTsExtensions: true,
        erasableSyntaxOnly: true,
        verbatimModuleSyntax: true,
        skipLibCheck: true,
        types: ["node"],
        typeRoots: [join(root, "node_modules", "@types")],
      },
      include: ["src", "example"],
    }),
  );
  return dir;
}
