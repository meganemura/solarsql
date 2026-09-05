// Test harness: load the TypeScript Worker and everything it imports into
// Miniflare. A relative import is followed as it is. A bare import is
// resolved through the package's exports map with the import condition,
// and its files are loaded too. node: and cloudflare: specifiers stay
// external, workerd provides them.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";

export type WorkerModule = { type: "ESModule"; path: string; contents: string };

// An import or re-export with its specifier. The class excludes ';' so a
// match never spans two statements, and allows newlines inside braces.
const importPattern = /(?:^|\n)[ \t]*(?:import|export)\b[^"'`;]*?\bfrom\s*["']([^"']+)["']|(?:^|\n)[ \t]*import\s*["']([^"']+)["']/g;

function pick(entry: unknown): string | undefined {
  if (typeof entry === "string") return entry;
  if (Array.isArray(entry)) {
    for (const e of entry) {
      const r = pick(e);
      if (r) return r;
    }
    return undefined;
  }
  if (entry && typeof entry === "object") {
    const e = entry as Record<string, unknown>;
    for (const condition of ["import", "default"]) {
      if (condition in e) {
        const r = pick(e[condition]);
        if (r) return r;
      }
    }
  }
  return undefined;
}

function resolveBare(spec: string, from: string): string {
  const m = /^((?:@[^/]+\/)?[^/]+)(\/.*)?$/.exec(spec);
  if (!m) throw new Error(`${from}: cannot parse the specifier "${spec}"`);
  const name = m[1]!;
  const key = `.${m[2] ?? ""}`;
  for (let dir = dirname(from); ; dir = dirname(dir)) {
    const pkgDir = join(dir, "node_modules", name);
    const pkgFile = join(pkgDir, "package.json");
    if (existsSync(pkgFile)) {
      const pkg = JSON.parse(readFileSync(pkgFile, "utf8")) as { exports?: unknown; module?: string; main?: string };
      let target: string | undefined;
      if (typeof pkg.exports === "string") target = key === "." ? pkg.exports : undefined;
      else if (pkg.exports && typeof pkg.exports === "object") {
        const map = pkg.exports as Record<string, unknown>;
        const hasSubpaths = Object.keys(map).some((k) => k.startsWith("."));
        target = hasSubpaths ? pick(map[key]) : key === "." ? pick(map) : undefined;
      } else if (key === ".") target = pkg.module ?? pkg.main;
      if (!target) throw new Error(`${from}: "${spec}" has no import entry in ${pkgFile}`);
      return resolve(pkgDir, target);
    }
    if (dirname(dir) === dir) throw new Error(`${from}: package "${name}" not found`);
  }
}

// The modules of a Worker, with paths relative to `root`.
export function loadWorkerModules(entry: string, root: string): WorkerModule[] {
  const modules = new Map<string, WorkerModule>();
  const visit = (file: string): void => {
    const path = relative(root, file).split("\\").join("/");
    if (modules.has(path)) return;
    const source = readFileSync(file, "utf8");
    const entry: WorkerModule = { type: "ESModule", path, contents: file.endsWith(".ts") ? stripTypeScriptTypes(source, { mode: "strip" }) : source };
    modules.set(path, entry);
    for (const m of source.matchAll(importPattern)) {
      const spec = m[1] ?? m[2];
      if (!spec || spec.startsWith("node:") || spec.startsWith("cloudflare:")) continue;
      // A type-only import is erased by stripping, so its file is not needed.
      if (/^(?:import|export)\s+type\b/.test(m[0].trim())) continue;
      if (spec.startsWith(".")) {
        visit(resolve(dirname(file), spec));
        continue;
      }
      // workerd knows no node_modules: the bare specifier becomes the
      // relative path of the file the package's exports map names.
      const target = resolveBare(spec, file);
      let rel = relative(dirname(file), target).split("\\").join("/");
      if (!rel.startsWith(".")) rel = `./${rel}`;
      entry.contents = entry.contents.split(`"${spec}"`).join(`"${rel}"`).split(`'${spec}'`).join(`'${rel}'`);
      visit(target);
    }
  };
  visit(entry);
  return [...modules.values()];
}

export function workerMiniflare(entry: string, root: string): Miniflare {
  return new Miniflare(
    convertV4MiniflareOptions({
      modulesRoot: root,
      modules: loadWorkerModules(entry, root),
      compatibilityDate: "2026-08-28",
      compatibilityFlags: ["nodejs_compat"],
      d1Databases: { DB: "app-db" },
    }),
  );
}

// The statements of a migration file. Statements end with ';' at the end of
// a line; a trigger body (begin ... end) stays one statement.
export function splitStatements(sql: string): string[] {
  const body = sql.replace(/^[ \t]*--[^\n]*\n?/gm, "");
  const out: string[] = [];
  let buffer = "";
  let inTrigger = false;
  for (const piece of body.split(/;[ \t]*(?:\n|$)/)) {
    if (piece.trim() === "") continue;
    buffer = buffer === "" ? piece : `${buffer};\n${piece}`;
    if (/\bcreate\s+trigger\b/i.test(piece)) inTrigger = true;
    if (inTrigger && !/\bend\s*$/i.test(piece)) continue;
    out.push(buffer.trim());
    buffer = "";
    inTrigger = false;
  }
  if (buffer.trim() !== "") out.push(buffer.trim());
  return out;
}

type D1Like = { prepare(sql: string): unknown; batch(statements: unknown[]): Promise<unknown> };

// Apply the migration files in name order, one batch per file, the way
// wrangler applies them.
export async function applyMigrations(db: D1Like, dir: string): Promise<void> {
  for (const name of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    const statements = splitStatements(readFileSync(join(dir, name), "utf8"));
    await db.batch(statements.map((s) => db.prepare(s)));
  }
}
