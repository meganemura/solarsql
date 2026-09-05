# v1 measurements

Date: 2026-09-06.
These experiments settled the shape of the library before it was written.
Each section gives the command, the output, and the conclusion.
Node 26.7.0, TypeScript 7.0.2, Miniflare 5.20260828.0-alpha with workerd 1.20260828.1.
Nothing here ran against a remote D1 database or a deployed Durable Object.

## 1. A tagged template has no literal type

Question: can the generated types be keyed by the text of a tagged template?

Command:

```
npx tsc --ignoreConfig --noEmit --strict --module nodenext --target esnext spike/tagged/tagged.ts
```

Output:

```
spike/tagged/tagged.ts(7,7): error TS2322: Type 'true' is not assignable to type 'false'.
```

Line 7 asserts that the tagged template gave a literal type, and it did not.
Line 11 asserts the same for a plain string literal through a `const` type parameter, and it passed.

Conclusion: SQL must be a plain string literal. See ADR 0021.

## 2. D1 accepts a named parameter bound by position

Command: `node --test spike/05-d1-named-params-and-do.test.ts`

Output:

```
named+positional: {"ok":true,"results":{...,"results":[{"id":"a","n":1}]}}
numbered:         {"ok":true,"results":{...,"results":[{"id":"a","n":1}]}}
named+object:     {"ok":false,"message":"D1_TYPE_ERROR: Type 'object' not supported for value '[object Object]'"}
do named:         {"ok":true,"rows":[{"id":"a","n":1}]}
```

Conclusion: `:name` in the text with values by position works on D1 and on a Durable Object. See ADR 0022.

## 3. A SQLite Durable Object in Miniflare 5

Same command as section 2.

```
do txn-ok:   {"ok":false,"message":"not authorized to use function: sqlite_version at offset 7: SQLITE_ERROR"}
do txn-fail: {"ok":false,"message":"UNIQUE constraint failed: t.id: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_PRIMARYKEY)","rows":[{"id":"a","n":1}]}
```

`convertV4MiniflareOptions({ durableObjects: { STORE: { className: "Store", useSQLite: true } } })` starts the object.
`transactionSync()` rolled the two inserts of the failed transaction back; the row `a` from the committed transaction stayed.
The Durable Object refuses `sqlite_version()` the way D1 does.

Conclusion: the Durable Object adapter can be tested in Miniflare. Its tests are in `test/example.test.ts`.

## 4. Node does not strip types under node_modules

Question: can the package ship TypeScript source only?

Steps: a package with `"bin": { "x": "./src/cli.ts" }` and `"exports": { ".": "./src/index.ts" }`, `npm pack`, `npm install` of the tarball into another directory, then the bin and an import.

Output, for both:

```
Error [ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING]: Stripping types is currently unsupported for files under node_modules, for "file:///.../node_modules/tsprobe/src/cli.ts"
```

Conclusion: the package ships `src/` and `dist/`, and `exports` points at `dist/`. See ADR 0024.
`test/pack.test.ts` packs the real package, installs it, runs the CLI from `node_modules`, and imports the adapters.

## 5. The phantom type on the generated value

Question: does `queries(generated, {...})` infer the type map from the value, and does a changed SQL string fail at the call site?

Command:

```
npx tsc --ignoreConfig --noEmit --strict --module nodenext --target esnext --noUncheckedIndexedAccess --exactOptionalPropertyTypes spike/phantom/phantom.ts
npx tsc ... spike/phantom/stale.ts
```

Output:

```
phantom.ts: exit 0
stale.ts(28,3): error TS2820: Type '"select id, status, note from orders where id = :id"' is not assignable to type '"select count(*) as n from orders" | "select id, status from orders where id = :id"'. Did you mean '"select id, status from orders where id = :id"'?
```

Conclusion: an optional `__types?: G` member on the generated value carries the map for inference, and the error names the changed string with a suggestion. See ADR 0025.

## 6. The example on both targets

Command: `npm test` (`test/example.test.ts`)

Eighteen cases, nine per target, on the local D1 engine and on a SQLite Durable Object, through the same module code:
a command with `returns`, a plan that inserts a parent and its children from JSON, a JSON aggregation as an array, an assert that passes and then fails by name, an order without lines, a nullable parameter, a failed plan with no partial writes, a report across modules, and a query without parameters.

## 7. The build on the example

Command: `npm test` (`test/build.test.ts`, `test/stale.test.ts`)

The committed generated files and migration files are current.
A schema change is reported with the statements, and `migration` writes `0002_<name>.sql`.
The build refuses a cross-module read, a `changes()` assert out of place, a nullable primary key, and an expression column without a cast, each with one message.
A changed SQL string fails `tsc` at the call site of the copy, and the unedited copy passes.
