// The operations that drive solarsql the way a user does: pack this checkout,
// install the tarball into a project of its own, run the installed bin. The
// control CLI and the nukadoko steps both import these, so an operation an
// agent tried by hand is the same code a scenario runs.
// It knows nothing of nukadoko's fixtures: a caller hands it directories. Its
// processes go through nukadoko's runCommand, which a step's record measures
// and which runs unmeasured anywhere else.
import { runCommand } from "nukadoko";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

export const CHECKOUT = fileURLToPath(new URL("../../../..", import.meta.url));

export interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

// npm pack builds dist/ through prepack, so the tarball is what a user would
// install from this checkout, files list included.
export async function packCheckout(destination: string): Promise<string> {
  const pack = await runCommand("npm", ["pack", "--silent", "--pack-destination", destination], { cwd: CHECKOUT });
  if (pack.exitCode !== 0) throw new Error(`npm pack exited ${pack.exitCode}:\n${pack.stdout}${pack.stderr}`);
  const tarball = join(destination, pack.stdout.trim().split("\n").pop()!);
  if (!existsSync(tarball)) throw new Error(`npm pack wrote no tarball: ${pack.stdout}`);
  return tarball;
}

// The package has no runtime dependencies, so the install reads no registry.
export async function createProject(parent: string, tarball: string): Promise<string> {
  const project = join(parent, "app");
  mkdirSync(project);
  writeFileSync(join(project, "package.json"), JSON.stringify({ name: "app", private: true, type: "module" }));
  const install = await runCommand("npm", ["install", "--silent", "--no-audit", "--no-fund", tarball], { cwd: project });
  if (install.exitCode !== 0) throw new Error(`npm install exited ${install.exitCode}:\n${install.stdout}${install.stderr}`);
  return project;
}

// The installed bin entry, not this checkout's source: what runs is what the
// package ships. A child node inherits NODE_TEST_CONTEXT from a test runner
// above it and would report there, so the variable is removed.
export async function runSolarsql(project: string, args: string[]): Promise<CliResult> {
  const manifest = JSON.parse(readFileSync(join(project, "node_modules/solarsql/package.json"), "utf8")) as { bin: { solarsql: string } };
  const { NODE_TEST_CONTEXT: _, ...env } = process.env;
  const result = await runCommand(process.execPath, [join(project, "node_modules/solarsql", manifest.bin.solarsql), ...args], { cwd: project, env });
  return { exitCode: result.exitCode ?? 1, stdout: result.stdout, stderr: result.stderr };
}

export function installedVersion(project: string): string | undefined {
  const path = join(project, "node_modules/solarsql/package.json");
  if (!existsSync(path)) return undefined;
  return (JSON.parse(readFileSync(path, "utf8")) as { version: string }).version;
}

// What the tarball was built from. The commit alone misses an uncommitted
// edit to src/, which is the usual state while an agent works.
export async function checkoutFingerprint(): Promise<{ commit: string; fingerprint: string }> {
  const commit = (await runCommand("git", ["rev-parse", "HEAD"], { cwd: CHECKOUT })).stdout.trim();
  const paths = ["src", "package.json", "skills", "llms.txt"];
  const tracked = await runCommand("git", ["ls-files", "-s", "--", ...paths], { cwd: CHECKOUT });
  const changed = await runCommand("git", ["diff", "HEAD", "--", ...paths], { cwd: CHECKOUT });
  const untracked = await runCommand("git", ["ls-files", "--others", "--exclude-standard", "--", ...paths], { cwd: CHECKOUT });
  const fingerprint = createHash("sha256").update(tracked.stdout).update(changed.stdout).update(untracked.stdout).digest("hex").slice(0, 16);
  return { commit, fingerprint };
}

// Every file of a project but node_modules, by content hash: the side effect a
// command had on disk, which its stdout cannot prove by itself.
export function projectFiles(dir: string, base = dir): Map<string, string> {
  const files = new Map<string, string>();
  for (const name of readdirSync(dir).sort()) {
    if (name === "node_modules") continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) for (const [file, hash] of projectFiles(path, base)) files.set(file, hash);
    else files.set(relative(base, path), createHash("sha256").update(readFileSync(path)).digest("hex"));
  }
  return files;
}

export function changedFiles(before: Map<string, string>, after: Map<string, string>): { added: string[]; changed: string[]; removed: string[] } {
  return {
    added: [...after.keys()].filter((file) => !before.has(file)),
    changed: [...after.keys()].filter((file) => before.has(file) && before.get(file) !== after.get(file)),
    removed: [...before.keys()].filter((file) => !after.has(file)),
  };
}

// A database the migrations reached, in file order, as the precondition for
// a query. This is verification scaffolding: solarsql applies nothing itself
// (wrangler applies migrations to D1), so it stands in for that step.
export function applyMigrations(project: string, file: string): string[] {
  const database = new DatabaseSync(join(project, file));
  const applied = readdirSync(join(project, "migrations")).filter((name) => name.endsWith(".sql")).sort();
  try {
    for (const name of applied) database.exec(readFileSync(join(project, "migrations", name), "utf8"));
  } finally {
    database.close();
  }
  return applied;
}
