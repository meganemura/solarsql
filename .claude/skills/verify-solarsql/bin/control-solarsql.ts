#!/usr/bin/env node
// The control CLI for verifying solarsql: one workspace is one long-lived
// instance (a project with this checkout's tarball installed) that an agent
// drives, inspects, and tears down across many calls. Each command is a thin
// layer over lib/workspace.ts. It never touches a directory it did not create:
// every command but launch requires the workspace's marker file.
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { CHECKOUT, applyMigrations, changedFiles, checkoutFingerprint, createProject, installedVersion, packCheckout, projectFiles, runSolarsql } from "../lib/workspace.ts";

const MARKER = "verify-solarsql.json";

interface Marker {
  checkout: string;
  commit: string;
  fingerprint: string;
  version: string;
  node: string;
  tarball: string;
  project: string;
  evidence: string;
  created_at: string;
}

function usage(): never {
  process.stderr.write(
    [
      "usage:",
      "  control-solarsql launch [--root <dir>]          pack this checkout and install it into a new workspace; prints the workspace",
      "  control-solarsql doctor <workspace>             read-only: is this workspace worth driving?",
      "  control-solarsql cli <workspace> -- <args...>   run the installed solarsql in the project; logs to evidence/transcript.jsonl",
      "  control-solarsql database <workspace> <file>    scaffolding: create <file> in the project with every migration applied in order",
      "  control-solarsql snapshot <workspace> <label>   copy the project's files (no node_modules) to evidence/snapshots/; prints what changed",
      "  control-solarsql cleanup <workspace>            remove the project and the tarball; keep evidence/",
      "",
    ].join("\n"),
  );
  process.exit(2);
}

function readMarker(workspace: string): Marker {
  const path = join(workspace, MARKER);
  if (!existsSync(path)) {
    process.stderr.write(`${workspace} has no ${MARKER}; it was not made by control-solarsql launch, so it is not driven or removed\n`);
    process.exit(2);
  }
  return JSON.parse(readFileSync(path, "utf8")) as Marker;
}

async function launch(args: string[]): Promise<void> {
  const rootFlag = args.indexOf("--root");
  const root = rootFlag >= 0 ? resolve(args[rootFlag + 1] ?? usage()) : tmpdir();
  mkdirSync(root, { recursive: true });
  const workspace = mkdtempSync(join(root, "verify-solarsql-"));
  const pack = join(workspace, "pack");
  const evidence = join(workspace, "evidence");
  mkdirSync(pack);
  mkdirSync(evidence);
  const { commit, fingerprint } = await checkoutFingerprint();
  const tarball = await packCheckout(pack);
  const project = await createProject(workspace, tarball);
  const marker: Marker = {
    checkout: CHECKOUT,
    commit,
    fingerprint,
    version: installedVersion(project)!,
    node: process.version,
    tarball,
    project,
    evidence,
    created_at: new Date().toISOString(),
  };
  writeFileSync(join(workspace, MARKER), `${JSON.stringify(marker, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ workspace, ...marker }, null, 2)}\n`);
}

// Ready means usable: the bin starts under this Node (solarsql refuses a Node
// outside its engines range at startup), and the package is this checkout as
// it is now, not as it was when the workspace was packed.
async function doctor(workspace: string): Promise<void> {
  const marker = readMarker(workspace);
  const checks: { name: string; ok: boolean; detail: string }[] = [];
  const version = installedVersion(marker.project);
  checks.push({ name: "installed", ok: version === marker.version, detail: `node_modules/solarsql ${version ?? "missing"}, packed ${marker.version}` });
  const started = version === undefined ? undefined : await runSolarsql(marker.project, ["--version"]);
  checks.push({
    name: "bin-starts",
    ok: started?.exitCode === 0,
    detail: started === undefined ? "not installed" : `${process.version}: ${(started.stdout + started.stderr).trim()}`,
  });
  checks.push({ name: "same-node", ok: process.version === marker.node, detail: `now ${process.version}, packed under ${marker.node}` });
  const now = await checkoutFingerprint();
  checks.push({
    name: "checkout-unchanged",
    ok: now.fingerprint === marker.fingerprint,
    detail: now.fingerprint === marker.fingerprint ? `commit ${marker.commit.slice(0, 12)}` : `src/ or package.json changed since launch (commit ${marker.commit.slice(0, 12)} -> ${now.commit.slice(0, 12)}); launch a new workspace`,
  });
  const ok = checks.every((check) => check.ok);
  process.stdout.write(`${JSON.stringify({ ok, workspace, project: marker.project, checks }, null, 2)}\n`);
  process.exit(ok ? 0 : 1);
}

async function cli(workspace: string, args: string[]): Promise<void> {
  const marker = readMarker(workspace);
  const result = await runSolarsql(marker.project, args);
  appendFileSync(
    join(marker.evidence, "transcript.jsonl"),
    `${JSON.stringify({ at: new Date().toISOString(), argv: ["solarsql", ...args], cwd: marker.project, exit_code: result.exitCode, stdout: result.stdout, stderr: result.stderr })}\n`,
  );
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exit(result.exitCode);
}

// A snapshot is the side effect a command had on disk, the proof a CLI's
// stdout cannot give by itself. Each one lists its changes against the one
// before it, so a sequence of snapshots reads as what each step wrote.
function snapshot(workspace: string, label: string): void {
  const marker = readMarker(workspace);
  const root = join(marker.evidence, "snapshots");
  mkdirSync(root, { recursive: true });
  const earlier = readdirSync(root).sort();
  const name = `${String(earlier.length + 1).padStart(2, "0")}-${label.replace(/[^a-z0-9-]+/gi, "-")}`;
  const files = projectFiles(marker.project);
  const previous = earlier.length === 0 ? new Map<string, string>() : new Map(Object.entries(JSON.parse(readFileSync(join(root, earlier.at(-1)!, "manifest.json"), "utf8")) as Record<string, string>));
  const changes = changedFiles(previous, files);
  const target = join(root, name);
  cpSync(marker.project, join(target, "files"), { recursive: true, filter: (source) => !relative(marker.project, source).split("/").includes("node_modules") });
  writeFileSync(join(target, "manifest.json"), `${JSON.stringify(Object.fromEntries(files), null, 2)}\n`);
  writeFileSync(join(target, "changes.json"), `${JSON.stringify(changes, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ snapshot: target, ...changes }, null, 2)}\n`);
}

function database(workspace: string, file: string): void {
  const marker = readMarker(workspace);
  if (existsSync(join(marker.project, file))) {
    process.stderr.write(`${file} exists; pick a new name, so a database a drive wrote is never overwritten\n`);
    process.exit(2);
  }
  process.stdout.write(`${JSON.stringify({ database: join(marker.project, file), applied: applyMigrations(marker.project, file) }, null, 2)}\n`);
}

function cleanup(workspace: string): void {
  const marker = readMarker(workspace);
  rmSync(marker.project, { recursive: true, force: true });
  rmSync(join(workspace, "pack"), { recursive: true, force: true });
  process.stdout.write(`${JSON.stringify({ removed: [marker.project, join(workspace, "pack")], kept: marker.evidence }, null, 2)}\n`);
}

const [command, ...rest] = process.argv.slice(2);
if (command === "launch") await launch(rest);
else if (command === "doctor" && rest[0]) await doctor(resolve(rest[0]));
else if (command === "cli" && rest[0] && rest[1] === "--") await cli(resolve(rest[0]), rest.slice(2));
else if (command === "database" && rest[0] && rest[1]) database(resolve(rest[0]), rest[1]);
else if (command === "snapshot" && rest[0] && rest[1]) snapshot(resolve(rest[0]), rest[1]);
else if (command === "cleanup" && rest[0]) cleanup(resolve(rest[0]));
else usage();
