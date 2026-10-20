# Run a query

`solarsql query <module>.<catalog>.<name> --database <file.sqlite>` runs one catalog query against a SQLite file and prints its rows as one JSON array.

## Sub-features

- `query-rows` prints the rows as JSON, exit 0. Proven by: no scenario.
- `query-params` takes named parameters as `--params '<json>'`, and a missing one exits 2 with the parameter's name. Proven by: no scenario.

## How to get to it (user POV)

- `npx solarsql query <module>.<catalog>.<name> --database <file.sqlite> [--params '{"id":"1"}']`.

## Driving it with control-solarsql

Preconditions:

- A workspace after `C cli <workspace> -- init orders`.
- `C database <workspace> app.sqlite` has created a database with the migrations applied.
- A row inserted into `orders`, for example with `node -e` and `node:sqlite` in the project directory.

- **Rows.** Run `C cli <workspace> -- query orders.ordersQueries.all --database app.sqlite`. Exit code `0`; stdout is a JSON array with the inserted row.
- **Params.** Run `C cli <workspace> -- query orders.ordersQueries.byId --database app.sqlite --params '{"id":"a"}'`. Exit code `0`; stdout is an array with that row.
- **Missing param.** Run the same command without `--params`. Exit code `2`; stderr names `id`.

## Gotchas

- `<catalog>` is the name of the exported `queries(...)` const (`ordersQueries` in init's template), not the word `queries`. The wrong name exits 2 with `no query catalog named`.
- `--database` takes a path relative to the project. A missing file exits 2 with `unable to open database file`; the command does not create it.
- solarsql applies no migration to a local file; `C database` is scaffolding for that step.
