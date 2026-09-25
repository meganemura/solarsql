// Responsibility: the two workerd run-time SQLite limits no build-time check
// can catch, in the shape node:sqlite's own DatabaseSync `limits` option
// takes, so a caller sets them once on the connection a node:sqlite test
// runs on.
// Boundary: a data constant only. No DatabaseSync import here, so a caller
// with no SQLite dependency can still import the numbers (the constant this
// module exports is also cited, not reimported, by src/build/facts.ts's own
// WORKERD_LIMITS comment, which explains why its own prepare-time gate
// leaves these two out).
//
// Why these two, and only at run time. cloudflare/workerd sets both on
// every SQLite connection it opens for D1 and a Durable Object
// (src/workerd/util/sqlite.c++:1406-1421 on main as of 2026-09-25, the same
// values at :1380-1387 in the pinned v1.20260828.1). Neither fires at
// prepare time (a LIKE call, or a trigger actually firing, both run only
// once a statement executes), so src/build/facts.ts's own prepare-time gate
// (WORKERD_LIMITS) cannot check them; a build can pass and the same SQL
// still fail on deploy. node:sqlite's own defaults are far looser (LIKE/GLOB
// pattern 50,000 bytes, trigger recursion depth 1,000), so a test on an
// unconfigured connection cannot see the difference either.
//
// Measured (Node 26.7.0, SQLite 3.53.4, through DatabaseSync's own `limits`
// option): a bound 51-byte LIKE pattern fails with "LIKE or GLOB pattern too
// complex" (50 passes); an 11-deep recursive trigger (pragma
// recursive_triggers=on; a trigger re-inserting a row until a depth guard
// stops it) fails with "too many levels of trigger recursion" (10 passes) --
// the same messages Miniflare's D1 and a Durable Object give
// (test/miniflare/node-limits.test.ts pins the match).
//
// The row-size limit is left out on purpose: the candidates measured are
// 2 MiB (Cloudflare's docs), 4 MiB (the pinned workerd release) and 8 MiB +
// 34 bytes (workerd main); a fixed value here would disagree with a
// deployed value in that range until a remote probe settles it.
export const NODE_TEST_LIMITS = {
  likePatternLength: 50,
  triggerDepth: 10,
} as const;
