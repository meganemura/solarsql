// Responsibility: parse the narrow, versioned permission for an automatic
// destructive migration. Boundary: this file does not compare schemas; the
// migration diff rejects an intent that does not match the actual removal.
import { readFileSync } from "node:fs";
import type { DropIntent, Rename } from "./migration.ts";
import { BuildError } from "./build-error.ts";

export type MigrationIntent = { drops: DropIntent[]; renames: Rename[] };

// A weaker gate here (loosening the null, typeof, or array check) cannot be
// observed from a JSON-parsed value: object()'s cast lets a primitive or an
// array through as if it were the record, but Object.keys() of that value
// never contains a name the checks below expect (a string yields its index
// keys, a number or boolean yields none, an array yields its indices), so
// the exact-key check, a truthiness check, or a later named-property check
// still rejects it the same way.
function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

// Every caller already requires each expected key present and correctly
// typed on its own, so only an extra, unexpected key still needs rejecting.
function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every(key => keys.includes(key));
}

function fail(path: string, message: string): never {
  throw new BuildError(`Invalid migration intent ${path}: ${message}`);
}

export function parseMigrationIntent(text: string, path = "intent"): MigrationIntent {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return fail(path, "the file must contain JSON.");
  }
  const root = object(value);
  if (!root || !exactKeys(root, ["drops", "renames", "version"]) || root.version !== 1 || !Array.isArray(root.drops) || !Array.isArray(root.renames)) {
    return fail(path, 'use exactly {"version":1,"drops":[],"renames":[]}.');
  }
  const drops: DropIntent[] = [];
  for (const [index, value] of root.drops.entries()) {
    const drop = object(value);
    if (!drop || typeof drop.kind !== "string" || typeof drop.table !== "string" || drop.table.length === 0) {
      return fail(path, `drops[${index}] must name a table or column.`);
    }
    if (drop.kind === "table" && exactKeys(drop, ["kind", "table"])) {
      drops.push({ kind: "table", table: drop.table });
    } else if (drop.kind === "column" && typeof drop.column === "string" && drop.column.length > 0 && exactKeys(drop, ["column", "kind", "table"])) {
      drops.push({ kind: "column", table: drop.table, column: drop.column });
    } else {
      return fail(path, `drops[${index}] has an unknown or incomplete object shape.`);
    }
  }
  const renames: Rename[] = [];
  for (const [index, value] of root.renames.entries()) {
    const rename = object(value);
    if (!rename || typeof rename.table !== "string" || typeof rename.from !== "string" || typeof rename.to !== "string" || rename.table.length === 0 || rename.from.length === 0 || rename.to.length === 0 || !exactKeys(rename, ["from", "table", "to"])) {
      return fail(path, `renames[${index}] must have string table, from, and to values.`);
    }
    renames.push({ table: rename.table, from: rename.from, to: rename.to });
  }
  return { drops, renames };
}

export function readMigrationIntent(path: string): MigrationIntent {
  try {
    // Dropping this encoding cannot be observed: readFileSync then returns
    // a Buffer, and JSON.parse converts a non-string argument through
    // Buffer's own toString(), whose default encoding is also utf8.
    return parseMigrationIntent(readFileSync(path, "utf8"), path);
  } catch (error) {
    if (error instanceof BuildError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    return fail(path, `cannot read the file (${message}).`);
  }
}
