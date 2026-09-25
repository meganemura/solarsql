// Responsibility: refuse a Node version whose node:sqlite does not report
// the SQLite build that the release's Miniflare pin uses for D1 and a
// Durable Object (ADR 0129). The range is "^24.20.0 || >=26.7.0": Node 25
// and Node 26.0-26.6 report an older SQLite, and Node 24 below 24.20.0
// truncates TEXT at an embedded NUL and can fail a fresh-clone build.
// Boundary: a pure string-in, string-or-null-out function. No process
// access, so a table of versions can drive the test without spawning Node.
export const NODE_RANGE = "^24.20.0 || >=26.7.0";

export function nodeVersionError(version: string): string | null {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!match) return `solarsql requires Node ${NODE_RANGE}. Node reports an unparseable version "${version}".`;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const accepted = (major === 24 && minor >= 20) || (major >= 26 && !(major === 26 && minor < 7));
  if (accepted) return null;
  return `solarsql requires Node ${NODE_RANGE} (node:sqlite must run the SQLite that the release tests against in Miniflare; remote D1 and deployed Durable Object SQLite versions are not measured). Node reports ${version}.`;
}
