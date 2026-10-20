// Responsibility: decide whether this process may run node() and the CLI
// (ADR 0129, ADR 0145, ADR 0147).
// Boundary: no static node:sqlite import, so a runtime without it loads this file.
export const NODE_RANGE = "^24.20.0 || >=26.7.0";

// The SQLite version this release's pinned workerd builds against (from
// workerd's MODULE.bazel at the pinned tag, strip_prefix sqlite-src-NNNNNNN;
// docs/releasing.md has the read-it-off-the-tag step). runtimeRefusal()
// accepts a newer SQLite, because a newer Node can ship one before the
// pinned workerd does (ADR 0129).
export const WORKERD_SQLITE_VERSION = "3.53.4";

// The first Bun release whose node:sqlite runs WORKERD_SQLITE_VERSION on
// Linux, and the one the Bun CI job runs (ADR 0147). node() accepts it; the
// CLI does not, because the build relies on Node's module loader.
export const BUN_RANGE = ">=1.4.3";

export type RuntimeCaller = "node()" | "cli";

export class UnsupportedRuntimeError extends Error {
  readonly code = "UNSUPPORTED_RUNTIME";
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedRuntimeError";
  }
}

// Bun sets process.versions.node to the Node release it imitates (Bun 1.4.2
// reports 26.3.0), and that number says nothing about its node:sqlite, so
// the runtime's own key decides first. Deno gets the same rule by its key.
const OTHER_RUNTIMES = [["bun", "Bun"], ["deno", "Deno"]] as const;

const REQUIREMENT = `solarsql requires Node ${NODE_RANGE} and node:sqlite on SQLite ${WORKERD_SQLITE_VERSION} or later, the SQLite that workerd runs in the release's tests.`;

const BUN_REQUIREMENT = `node() runs on Node ${NODE_RANGE} or Bun ${BUN_RANGE}, with node:sqlite on SQLite ${WORKERD_SQLITE_VERSION} or later, the SQLite that workerd runs in the release's tests.`;

const SQLITE_FLOOR = numbers(WORKERD_SQLITE_VERSION)!;
const BUN_FLOOR = numbers(BUN_RANGE.slice(2))!;

// Every DatabaseSync in a process links the same SQLite. A fresh in-memory
// connection reads its version without a statement on a caller's database,
// which can be closed or not yet open.
export function linkedSqliteVersion(): string | null {
  // Node before 20.16 and 22.3 has no getBuiltinModule(), and a runtime
  // without node:sqlite gets undefined from it; @types/node admits neither.
  const sqlite = process.getBuiltinModule?.("node:sqlite");
  if (sqlite === undefined) return null;
  try {
    const probe = new sqlite.DatabaseSync(":memory:");
    try {
      return String(probe.prepare("select sqlite_version() as version").get()!.version);
    } finally {
      probe.close();
    }
  } catch {
    return null;
  }
}

// `sqlite` is null when the caller could not read a version from node:sqlite.
export function runtimeRefusal(versions: { readonly node: string; readonly bun?: string; readonly deno?: string }, sqlite: string | null, caller: RuntimeCaller): UnsupportedRuntimeError | null {
  const engine = sqlite === null ? null : numbers(sqlite);
  const runs = engine === null ? "reports no SQLite version" : `runs SQLite ${sqlite}`;
  const other = OTHER_RUNTIMES.find(([key]) => versions[key] !== undefined);
  if (other && other[0] === "bun" && caller === "node()") return bunRefusal(versions.bun!, versions.node, sqlite, engine);
  if (other) {
    const [key, name] = other;
    const refused = key === "bun" ? "The solarsql CLI does not support Bun" : `solarsql does not support ${name}`;
    return new UnsupportedRuntimeError(`${REQUIREMENT} This process runs ${name} ${versions[key]}, which reports Node ${versions.node}, and its node:sqlite ${runs}. ${refused}; run the command with Node.`);
  }
  const node = numbers(versions.node);
  const inRange = node !== null && ((node[0] === 24 && node[1] >= 20) || (node[0] === 26 && node[1] >= 7) || node[0] > 26);
  if (!inRange) {
    return new UnsupportedRuntimeError(`${REQUIREMENT} This process runs Node ${versions.node}, and its node:sqlite ${runs}. Install a Node release in that range.`);
  }
  if (engine === null) {
    return new UnsupportedRuntimeError(`${REQUIREMENT} This process runs Node ${versions.node}, but its node:sqlite reports no SQLite version.`);
  }
  if (compare(engine, SQLITE_FLOOR) < 0) {
    return new UnsupportedRuntimeError(`${REQUIREMENT} This process runs Node ${versions.node}, but its node:sqlite runs SQLite ${sqlite}, older than ${WORKERD_SQLITE_VERSION}. A Node build that links a system SQLite can do this; use an official Node build.`);
  }
  return null;
}

function bunRefusal(bun: string, node: string, sqlite: string | null, engine: [number, number, number] | null): UnsupportedRuntimeError | null {
  const release = numbers(bun);
  if (release === null || compare(release, BUN_FLOOR) < 0) {
    const runs = engine === null ? "reports no SQLite version" : `runs SQLite ${sqlite}`;
    return new UnsupportedRuntimeError(`${BUN_REQUIREMENT} This process runs Bun ${bun}, which reports Node ${node}, and its node:sqlite ${runs}. Install a Bun release in that range, or run with Node.`);
  }
  if (engine === null) {
    return new UnsupportedRuntimeError(`${BUN_REQUIREMENT} This process runs Bun ${bun}, but its node:sqlite reports no SQLite version.`);
  }
  if (compare(engine, SQLITE_FLOOR) < 0) {
    return new UnsupportedRuntimeError(`${BUN_REQUIREMENT} This process runs Bun ${bun}, but its node:sqlite runs SQLite ${sqlite}, older than ${WORKERD_SQLITE_VERSION}. A Bun build that links a system SQLite can do this; run with Node.`);
  }
  return null;
}

function numbers(version: string): [number, number, number] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

function compare(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
  return 0;
}
