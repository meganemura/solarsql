// Test harness: load a TypeScript Worker and everything it imports into
// Miniflare. Node strips the types of each file, and the relative imports
// stay as they are, so the library runs in workerd as the source it is.
// Boundary: no bundling beyond following relative imports. A bare specifier
// other than cloudflare:workers is an error.
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { dirname, relative, resolve } from "node:path";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";

export type WorkerModule = { type: "ESModule"; path: string; contents: string };

const importPattern = /(?:^|\n)\s*(?:import|export)\b[^"'\n]*?\bfrom\s*["']([^"']+)["']|(?:^|\n)\s*import\s*["']([^"']+)["']/g;

// The modules of a Worker, with paths relative to `root`.
export function loadWorkerModules(entry: string, root: string): WorkerModule[] {
  const modules = new Map<string, WorkerModule>();
  const visit = (file: string): void => {
    const path = relative(root, file).split("\\").join("/");
    if (modules.has(path)) return;
    const source = readFileSync(file, "utf8");
    const contents = stripTypeScriptTypes(source, { mode: "strip" });
    modules.set(path, { type: "ESModule", path, contents });
    for (const m of source.matchAll(importPattern)) {
      const spec = m[1] ?? m[2];
      if (!spec || spec === "cloudflare:workers") continue;
      if (!spec.startsWith(".")) throw new Error(`${file}: bare import "${spec}" cannot be loaded into the Worker`);
      // A type-only import is erased by stripping, so its file is not needed.
      if (/^\s*import\s+type\b/.test(m[0].trim())) continue;
      visit(resolve(dirname(file), spec));
    }
  };
  visit(entry);
  return [...modules.values()];
}

export function workerMiniflare(entry: string, root: string, options: { durableObjects?: Record<string, string> } = {}): Miniflare {
  const modules = loadWorkerModules(entry, root);
  return new Miniflare(
    convertV4MiniflareOptions({
      modulesRoot: root,
      modules,
      compatibilityDate: "2026-08-28",
      compatibilityFlags: ["nodejs_compat"],
      d1Databases: { DB: "example-db" },
      durableObjects: Object.fromEntries(Object.entries(options.durableObjects ?? {}).map(([binding, className]) => [binding, { className, useSQLite: true }])),
    }),
  );
}
