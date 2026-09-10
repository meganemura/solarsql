// Responsibility: `solarsql init <module>`, the first minute of a project.
// It writes the configuration, one module in the three-file shape (ADR
// 0033) with a placeholder table, a query catalog, two commands, and a test
// on node:sqlite, then runs the first build and writes the first migration,
// so the user sees the whole loop once before touching anything.
// Boundary: nothing here is a Worker. No wrangler configuration, no
// package.json, no worker.ts: wrangler's own init owns those, and the README
// says how to wire an adapter. Nothing is ever overwritten.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { build, migration } from "./build.ts";
import { BuildError, brandName } from "./typegen.ts";

export type InitResult = { written: string[]; migration: string | null; notice: string | null };

// The module name is the table name and the directory name, as typed.
const namePattern = /^[a-z][a-z0-9_]*$/;

export async function init(module: string, dir = "."): Promise<InitResult> {
  if (!namePattern.test(module)) throw new BuildError(`module name must match [a-z][a-z0-9_]*: ${module}`);
  const root = resolve(dir);
  const config = join(root, "solarsql.config.ts");
  const moduleDir = join(root, "modules", module);
  const files: [string, string][] = [
    [config, configTemplate(module)],
    [join(moduleDir, "module.ts"), moduleTemplate(module)],
    [join(moduleDir, "public.ts"), publicTemplate(module)],
    [join(moduleDir, "module.test.ts"), testTemplate(module)],
  ];
  const tsconfig = join(root, "tsconfig.json");
  if (!existsSync(tsconfig)) files.push([tsconfig, tsconfigTemplate]);
  for (const [path] of files) {
    if (existsSync(path)) throw new BuildError(`${relative(root, path) || path} exists. init is for a project without one; add a module by hand, as the README shows.`);
  }
  // The first migration is the first file of its directory. A directory that
  // exists holds another project's history, wrangler's or an earlier one.
  const migrations = join(root, "migrations");
  if (existsSync(migrations)) throw new BuildError(`migrations/ exists. init writes the first migration; a project with a history adds a module by hand, as the README shows.`);
  mkdirSync(moduleDir, { recursive: true });
  for (const [path, text] of files) writeFileSync(path, text);
  await build(config);
  const first = await migration(config, "initial");
  const written = [...files.map(([p]) => p), join(moduleDir, "solarsql.generated.ts"), join(root, "migrations", "index.ts")];
  if (first.filename) written.push(join(root, "migrations", first.filename));
  return { written: written.map((p) => relative(root, p)), migration: first.filename, notice: notice(root) };
}

// Node runs a .ts file as an ES module when package.json says so, or when
// there is no package.json and the syntax decides. A "commonjs" package
// refuses the import syntax of the files written here.
function notice(root: string): string | null {
  const path = join(root, "package.json");
  if (!existsSync(path)) return null;
  const pkg = JSON.parse(readFileSync(path, "utf8")) as { type?: string };
  return pkg.type === "commonjs" ? `package.json says "type": "commonjs"; set it to "module" so node runs the .ts files` : null;
}

// order_lines -> orderLines, for the exported catalogs.
function camel(name: string): string {
  return name.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

function configTemplate(module: string): string {
  return `import { config } from "solarsql";

export default config({
  modules: ["./modules/${module}"],
  migrations: "./migrations",
});
`;
}

function moduleTemplate(module: string): string {
  const c = camel(module);
  return `import { assert, commands, queries, table } from "solarsql";
import { generated } from "./solarsql.generated.ts";

// A placeholder to replace with your own table. Every table is STRICT and
// has a primary key; \`done\` shows a CHECK that becomes a type.
export const ${c} = table(\`
  create table ${module} (
    id text primary key not null,
    name text not null,
    done integer not null default 0 check (done in (0, 1))
  ) strict
\`);

export const ${c}Queries = queries(generated, {
  byId: \`select id, name, done from ${module} where id = :id\`,
  all: \`select id, name, done from ${module} order by name\`,
});

export const ${c}Commands = commands(generated, {
  create: {
    plan: ["insert into ${module} (id, name) values (:id, :name)"],
    returns: "select id, name, done from ${module} where id = :id",
  },
  finish: {
    // The assert fails as a value when the row was already done, and the
    // whole command rolls back.
    plan: [
      "update ${module} set done = 1 where id = :id and done = 0",
      assert("was_open", "changes() = 1"),
    ],
    returns: "select id, name, done from ${module} where id = :id",
  },
});
`;
}

function publicTemplate(module: string): string {
  const c = camel(module);
  return `// What other modules may use from ${module}: the id type, the queries, and
// the commands. Tables stay private; another module reads them through here.
export type { ${brandName(module)} } from "./solarsql.generated.ts";
export { ${c}Queries, ${c}Commands } from "./module.ts";
`;
}

function testTemplate(module: string): string {
  const c = camel(module);
  const id = brandName(module);
  return `// The module on node:sqlite, in-process: the migration files apply, then
// the commands and the queries run as they do on D1 and on a Durable Object.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { newId } from "solarsql";
import { migrate, node } from "solarsql/node";
import { migrations } from "../../migrations/index.ts";
import { ${c}Commands, ${c}Queries, type ${id} } from "./public.ts";

test("create, then finish once", async () => {
  const raw = new DatabaseSync(":memory:");
  migrate(raw, migrations);
  const db = node(raw);
  const id = newId<${id}>();
  assert.deepEqual(await db.run(${c}Commands.create, { id, name: "first" }), { ok: true, rows: [{ id, name: "first", done: 0 }], changes: 1 });
  assert.equal((await db.run(${c}Commands.finish, { id })).ok, true);
  assert.deepEqual(await db.run(${c}Commands.finish, { id }), { ok: false, kind: "assert", assert: "was_open" });
  assert.deepEqual(await db.all(${c}Queries.all), [{ id, name: "first", done: 1 }]);
});
`;
}

// Node's type stripping needs the .ts extension on a relative import, and
// tsc accepts that with allowImportingTsExtensions under noEmit.
const tsconfigTemplate = `{
  "compilerOptions": {
    "target": "esnext",
    "module": "nodenext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noEmit": true,
    "allowImportingTsExtensions": true,
    "erasableSyntaxOnly": true,
    "verbatimModuleSyntax": true,
    "skipLibCheck": true,
    "types": ["node"]
  },
  "include": ["**/*.ts"],
  "exclude": ["node_modules"]
}
`;
