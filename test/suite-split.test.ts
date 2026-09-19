// Responsibility: keeps the three-way test split honest. `npm test` runs
// "test/*.test.ts" (one level) so an agent iterating on the scanner pays
// neither a child-process nor a Miniflare startup cost; `npm run test:all`
// adds "test/**/*.test.ts" for test/slow/ (spawned tsc/npm pack/CLI
// processes, and rehearse()'s on-disk backup) and test/miniflare/ (workerd).
// If a Miniflare-backed file lands back at the top level or in test/slow/,
// or a fast file picks up one of the known slow mechanisms, this test
// catches it before the split's time saving quietly erodes.
// Boundary: this test only reads source text for the marker imports below;
// it does not run the other files. Membership in test/slow/ is a judgment
// by measured time, recorded in AGENTS.md, not something this file derives;
// the check here only stops the known slow mechanisms (Miniflare,
// ../cli-discovery.ts, rehearse() itself) from drifting back into the fast
// set, and stops Miniflare from drifting into test/slow/.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const testDir = dirname(fileURLToPath(import.meta.url));

const usesMiniflare = (source: string): boolean =>
  /(?:from|import\()\s*["']miniflare["']/.test(source) ||
  /(?:from|import\()\s*["']\.\.?\/(?:d1|worker)\.ts["']/.test(source);

const usesCliDiscovery = (source: string): boolean =>
  /(?:from|import\()\s*["']\.\.?\/cli-discovery\.ts["']/.test(source);

const usesRehearse = (source: string): boolean =>
  /import\s*\{[^}]*\brehearse\b[^}]*\}\s*from\s*["'][^"']*\/rehearse\.ts["']/.test(source);

const listTestFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".test.ts"))
    .map((e) => e.name);

const topLevelTestFiles = listTestFiles(testDir);

const miniflareDir = join(testDir, "miniflare");
const miniflareTestFiles = listTestFiles(miniflareDir);

const slowDir = join(testDir, "slow");
const slowTestFiles = listTestFiles(slowDir);

test("every file under test/miniflare/ imports Miniflare, directly or through d1.ts/worker.ts", () => {
  for (const name of miniflareTestFiles) {
    const source = readFileSync(join(miniflareDir, name), "utf8");
    assert.ok(usesMiniflare(source), `${name} is in test/miniflare/ but has no Miniflare import`);
  }
});

test("no file under test/slow/ imports Miniflare; that belongs in test/miniflare/", () => {
  for (const name of slowTestFiles) {
    const source = readFileSync(join(slowDir, name), "utf8");
    assert.ok(!usesMiniflare(source), `${name} is in test/slow/ but imports Miniflare`);
  }
});

test("no file directly under test/ imports Miniflare, d1.ts, worker.ts, cli-discovery.ts, or calls rehearse()", () => {
  for (const name of topLevelTestFiles) {
    const source = readFileSync(join(testDir, name), "utf8");
    assert.ok(!usesMiniflare(source), `${name} is in the fast set but imports Miniflare`);
    assert.ok(!usesCliDiscovery(source), `${name} is in the fast set but imports cli-discovery.ts`);
    assert.ok(!usesRehearse(source), `${name} is in the fast set but calls rehearse()`);
  }
});
