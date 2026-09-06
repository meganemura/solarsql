// The skill is the usage documentation (ADR 0038), and this keeps it honest:
// every reference is linked from SKILL.md, every relative link under skills/
// and in the README resolves, and every message fragment in build.md's
// table appears in the source of the build.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const skill = join(root, "skills/solarsql");

const links = (file: string): string[] => [...readFileSync(file, "utf8").matchAll(/\]\(([^)#\s]+)(?:#[^)]*)?\)/g)].map((m) => m[1]!).filter((l) => !/^[a-z]+:/.test(l));

test("every reference is linked from SKILL.md", () => {
  const linked = new Set(links(join(skill, "SKILL.md")));
  for (const f of readdirSync(join(skill, "references"))) assert.ok(linked.has(`references/${f}`), `${f} is not linked from SKILL.md`);
});

test("every relative link in the skill and the README resolves", () => {
  const files = [join(root, "README.md"), join(skill, "SKILL.md"), ...readdirSync(join(skill, "references")).map((f) => join(skill, "references", f))];
  for (const file of files) {
    for (const link of links(file)) assert.ok(existsSync(resolve(dirname(file), link)), `${file}: ${link} does not resolve`);
  }
});

test("every message fragment in build.md appears in the source of the build", () => {
  const source = readdirSync(join(root, "src/build")).map((f) => readFileSync(join(root, "src/build", f), "utf8")).join("\n");
  const table = readFileSync(join(skill, "references/build.md"), "utf8").split("## Messages")[1]!.split("\n## ")[0]!;
  const fragments = [...table.matchAll(/^\| `([^`]+)`/gm)].map((m) => m[1]!);
  assert.ok(fragments.length >= 20, `only ${fragments.length} fragments`);
  for (const fragment of fragments) {
    // A placeholder in the table (x, t, c, m, o, p, a, v) stands for a `${...}` in the source; the fixed words must appear.
    const words = fragment.split(/\s+/).filter((w) => w.length > 3 && /^[a-z_()]+[.:,]?$/i.test(w) && !["with", "which", "into", "from"].includes(w));
    for (const word of words) assert.ok(source.includes(word.replace(/[.:,]$/, "")), `build.md: "${fragment}": "${word}" is not in src/build`);
  }
});
