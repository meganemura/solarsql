// The schema edit two scenarios share. The edit is to the text init wrote, so
// a change to that template fails by name instead of producing a schema
// nobody meant.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

function replaceOnce(source: string, from: string, to: string): string {
  if (!source.includes(from)) throw new Error(`module.ts no longer holds ${JSON.stringify(from)}; init's template changed`);
  return source.replace(from, to);
}

export function addNoteColumn(project: string, module: string): string {
  const path = join(project, module, "module.ts");
  let source = readFileSync(path, "utf8");
  source = replaceOnce(source, "check (done in (0, 1))\n", "check (done in (0, 1)),\n    note text\n");
  source = replaceOnce(source, "all: `select id, name, done from orders", "all: `select id, name, done, note from orders");
  writeFileSync(path, source);
  return "note";
}
