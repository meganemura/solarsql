# v3 measurements

The measurements of v3. Each section names the experiment, gives the numbers, and says what stays open.

## 1. The same task, given to fresh agents, on solarsql and on Drizzle

Date: 2026-09-06. Kit: `spike/09-agent-comparison/`. Results: `spike/09-agent-comparison/results/2026-09-06/`.

### Question

Does a coding agent that starts from an empty context add a command with a business rule with less work, or with fewer mistakes, on solarsql than on Drizzle?

### Setup

Two starter projects share one schema (customers, orders, order_lines; the status check allows draft, confirmed, and cancelled), one Worker step contract, one Miniflare harness, and one visible test file with 10 tests. The solarsql starter is the example of this repository, installed from the packed tarball. The Drizzle starter is the same Worker written with `drizzle-orm@0.45.2` and its D1 driver, with the tables declared in `schema.ts`. Both starters hold a `confirm` step with its rule inside the write: an UPDATE with the condition in its WHERE clause, followed on solarsql by an assert on `changes() = 1`.

Each run is one agent with an empty context, Claude Sonnet 5, and the same task text: add a `cancel` step; only a confirmed order cancels; a draft, a cancelled, or a missing order gets `{ refused: "not_confirmed" }` and no change; reply with the order; add a test; `npm test` and `npm run typecheck` must pass; read nothing outside the project; use no web; add no dependency. Three runs per arm, all six at once.

The metrics were written down before the first run. The hidden test file has 6 tests; with no cancel step, both starters pass 1 of them.

### Results

| run | tool calls | files read | of which under node_modules | `solarsql --help` | `solarsql build` | test runs | typecheck runs | errors | hidden tests | rule placement | output tokens | total tokens |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| drizzle-1 | 12 | 8 | 0 | | | 1 | 1 | 0 | 6 of 6 | in the write | 1,168 | 64,236 |
| drizzle-2 | 9 | 6 | 0 | | | 1 | 1 | 0 | 6 of 6 | in the write | 958 | 61,897 |
| drizzle-3 | 12 | 8 | 0 | | | 1 | 1 | 0 | 6 of 6 | in the write | 500 | 62,127 |
| solarsql-1 | 25 | 15 | 2 | 0 | 1 | 1 | 1 | 0 | 6 of 6 | in the write | 4,420 | 76,294 |
| solarsql-2 | 23 | 13 | 2 | 1 | 1 | 1 | 1 | 0 | 6 of 6 | in the write | 2,062 | 73,063 |
| solarsql-3 | 23 | 15 | 2 | 1 | 1 | 1 | 1 | 0 | 6 of 6 | in the write | 3,433 | 78,318 |

"Files read" counts distinct files the agent opened through the Read tool or through `cat`, `sed`, `head`, or `grep` in the shell; `metrics.py` computes it from the transcript. "Output tokens" is the sum over the agent's messages; "total tokens" is what the harness reported for the run. Wall time was 83 to 85 seconds for Drizzle and 158 to 179 seconds for solarsql. The six runs shared one machine, so read the wall times as the load of one machine, and lean on tool calls and tokens.

Every run stayed inside its directory and used no web.

### Reading

The outcome is the same on both arms. Every run passed all six hidden tests, put the rule inside the UPDATE, and ran the tests and the typecheck once each, with both green the first time.

The cost differs. A solarsql run made about twice the tool calls, read about twice the files, and used 18 to 25 percent more total tokens. The transcripts show where the extra work went:

- The library. Two solarsql runs read the README of the package (210 lines), and one searched `src/index.ts` of the package for the result type. All three read the package's `package.json`. The Drizzle runs read nothing under node_modules.
- The CLI. Two solarsql runs ran `solarsql --help`. All three ran `solarsql build` once, and then searched the generated file for the new entry.
- The structure. One solarsql module is five files (schema, queries, commands, public, and the generated types), and every solarsql run read all five plus `reports/queries.ts`. The change touched three files on solarsql and two on Drizzle.

The AGENTS.md of each starter points at the README of its library. The solarsql runs followed the pointer. The Drizzle runs left it alone, because the training data supplies Drizzle. That is the real condition of a new library, and the extra reading above is its price on a task where reading buys nothing further.

Both starters show a `confirm` written with the rule inside the write, and all six runs copied that shape. The rule-placement metric therefore separated nothing here. That is a property of this design.

### What this does not show

Three runs per arm give a direction. The task left the mechanisms that the design of solarsql rests on untouched:

- Every run kept the existing statements as they were, so the stale-type check had nothing to catch.
- Every plan had one write, so the abort of a plan after a first write never came up.
- Every command stayed inside one module, so the boundary check had nothing to catch.

### Conclusion

On a one-statement command whose shape the project already shows, solarsql gives the same result as Drizzle at about twice the reading. The claim that an agent makes fewer mistakes on solarsql needs a task where a mistake is possible: a write of several statements under a business rule, a change to an existing statement, or a read across a module boundary. That is the next experiment, and its discriminating test must be written down before the first run.

## 2. A write of several statements under a business rule, on solarsql and on Drizzle

Date: 2026-09-06. Kit: `spike/09-agent-comparison/exp2/`. Results: `spike/09-agent-comparison/results/2026-09-06-exp2/`.

### Question

When the command has to write two tables under one business rule, where do fresh agents put the rule on each library, and does the placement show in a test?

This is a confirmatory design. The task was chosen because the two libraries differ on it by construction: a solarsql plan aborts on an assert, and a D1 batch under Drizzle runs every statement it is given. The expectation was written down before the first run: solarsql runs put the rule inside the plan; Drizzle runs either run the restock without a guard (fails the second-cancel test) or write the order first and the stock second in two round trips (fails the over-the-cap test).

### Setup

The two starters of section 1, plus an inventory table (sku, qty, with `check (qty >= 0 and qty <= 100)`) on both arms, with `setStock` and `stock` steps and one more visible test (11 green on both). In the solarsql arm the table lives in the orders module, because a plan writes only the tables of its own module (ADR 0008). Neither starter shows a write of several statements under a condition: `place` has two statements and no condition, and `confirm` has one statement with a condition.

The task: a `cancel` step that sets a confirmed order to cancelled and adds each line's qty to the inventory row of its sku; a draft, a cancelled, or a missing order gets `{ refused: "not_confirmed" }` and no change; a restock over the cap gets `{ refused: "restock_failed" }` and no change, the order included. Same model (Claude Sonnet 5), three runs per arm, all six at once, same constraints as section 1.

Six hidden tests, in order: a cancel restocks; a second cancel is refused and restocks nothing; a draft is refused and stays draft; an unknown id is refused; a restock over the cap is refused and the order stays confirmed; the same order cancels once the shelf has room. With no cancel step, both starters pass 0 of 6.

The rule-placement rubric, from the diff: A, one atomic unit in which the restock cannot run when the order update matched no row, and a failed restock leaves the order confirmed; B, one batch with an unguarded restock; C, two or more round trips, with or without a compensating write; D, a read in JavaScript decides, then unconditional writes.

### Results

| run | tool calls | files read | of which under node_modules | `solarsql build` | test runs | typecheck runs | failed checks | hidden tests | rule placement | total tokens |
|---|---|---|---|---|---|---|---|---|---|---|
| drizzle-1 | 16 | 13 | 6 | | 2 | 2 | 0 | 6 of 6 | D with B | 87,999 |
| drizzle-2 | 23 | 14 | 5 | | 2 | 2 | 0 | 6 of 6 | D with B | 96,332 |
| drizzle-3 | 21 | 13 | 5 | | 2 | 3 | 0 | 6 of 6 | D with B | 93,392 |
| solarsql-1 | 26 | 20 | 7 | 1 | 1 | 2 | 0 | 6 of 6 | A | 106,818 |
| solarsql-2 | 29 | 16 | 2 | 1 | 2 | 2 | 0 | 6 of 6 | A | 110,628 |
| solarsql-3 | 35 | 27 | 12 | 1 | 1 | 1 | 0 | 6 of 6 | A | 120,422 |

"Failed checks" counts the test runs and the typecheck runs that did not pass, read from the transcripts; every check passed the first time on every run, and the second runs were re-verification. The `bash_errors` field of `metrics.jsonl` counts three shell errors across the runs: `git status` in a directory without git, twice, and one shell glob. Every run stayed inside its directory and used no web. Wall time was 395 to 488 seconds for Drizzle and 318 to 394 seconds for solarsql, with the six runs on one machine.

The three solarsql runs wrote one plan each. One wrote the order update first, then `assert("not_confirmed", "changes() = 1")`, then the restock, and mapped the `check` failure of the restock to `restock_failed`. Two wrote two asserts first, `not_confirmed` as an EXISTS on the order and `restock_failed` as a NOT EXISTS over the lines grouped by sku joined to inventory, and then the two updates.

The three Drizzle runs wrote the same shape: a SELECT of the order's status in JavaScript that returns `not_confirmed` when it is anything other than confirmed, then one `db.batch` with the order update (its WHERE repeats `status = 'confirmed'`) and one restock UPDATE per line or per sku, with no guard on the restocks. Two runs let the CHECK constraint refuse the over-the-cap case and mapped the thrown error to `restock_failed`; one run read the inventory in JavaScript and refused before the batch, with the CHECK as a backstop. All three wrote in a comment that a D1 batch runs every statement it is given, so a zero-row order update would not stop the restocks, and that the read before the batch is the guard. Against the pre-registered rubric, this shape is B's batch with unguarded restocks and D's read in front, and the read is what carries it past the second-cancel test; the table writes it as "D with B".

### The window

The pre-registered tests run one request at a time, and shape D passes them. The gap between the read and the batch is a window: a second cancel that reads the order in that window sees it confirmed, and its restocks run even though its order update matches no row.

A post-hoc test, written after the six diffs were read, sends three cancel requests for one order at the same time and expects one success and one restock (`exp2/race.test.ts`, five rounds on a fresh database each). Every run of both arms passed all five rounds: on the local runtime, one request's read and batch complete before the next request's read. A copy of the drizzle-1 run with a 50 millisecond pause after its read failed all five rounds, with the stock at 16 instead of 12: the three restocks all ran, and one order update matched. A copy of the solarsql-1 run with the same pause before its one `db.run` passed all five rounds, because a plan has no read to widen away from its write. The window is real, and the local runtime keeps it narrow. On a remote D1, each call is a network round trip, so the window is wider; that is a claim, and the remote measurement is the owner's.

### Reading

On the pre-registered tests the outcome is the same on both arms, for the second time. The placement of the rule differs on every run: the solarsql runs put every rule inside the one atomic unit, and the Drizzle runs put the precondition in a read before one batch whose restocks carry no guard. The Drizzle runs knew the limitation of a D1 batch, wrote it down, and chose the read, and none of the three wrote about the window it leaves.

The expectation was wrong about which shape the Drizzle runs would choose. It named B and C; all three chose D with B, and that shape passes every sequential test. The tests of this experiment separate A from B and from C, and they pass D as they pass A. The post-hoc race test separates D from A once the window is wide enough.

The cost gap of section 1 stays: a solarsql run made 1.3 to 1.6 times the tool calls, read 1.2 to 1.9 times the files, and used 15 to 29 percent more total tokens. This time both arms read the library: the Drizzle runs read five or six `.d.ts` files of drizzle-orm for the batch and the D1 session, and the solarsql runs read the README and, in two runs, the source of the package; one run read the whole `src/build/` to learn what an assert may contain.

### What this does not show

Three runs per arm give a direction. The task exercised the plan abort and left the stale-type check and the boundary check untouched. The race test is post-hoc, and its five passing rounds per run say that the local runtime serialized the requests, and nothing about a remote D1.

### Conclusion

When one command writes two tables under a business rule, fresh agents on solarsql express the rule inside the atomic unit every time, and fresh agents on Drizzle over D1 express it in a read before the write every time, with a window that the sequential tests cannot open and a 50 millisecond pause opens on every round. The reading cost of solarsql stays at about 1.5 times the tool calls and about 1.2 times the tokens. The next measurement that would change a decision is the width of the window on a remote D1.
