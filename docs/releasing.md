# Releasing

Each version step below is one command, run from the root, on a clean `main` that CI has passed.

solarsql is already on npm. Pushing a `v*` tag runs [`.github/workflows/publish.yml`](../.github/workflows/publish.yml). The workflow checks out that tag, installs from the lockfile, builds `dist/`, runs the release checks, and runs `npm publish`. npm authenticates with the GitHub Actions OIDC token for the GitHub Environment `publish`. Provenance is attached because the repository and the package are public. The environment is the human gate: the job waits until it is approved. The workflow stores no `NPM_TOKEN`, and the repository secrets do not keep one.

`dist/` is gitignored. The workflow builds it, then `prepublishOnly` builds it again, and that tree is what is published. The tarball contains `src/`, `dist/`, `skills/`, `README.md`, `CHANGELOG.md`, `LICENSE`, `llms.txt`, and `package.json`.

The trusted publisher and the GitHub Environment `publish` are already configured, as of 2026-09-23. Nothing in this repository creates them. Recreate either only when it is missing, using the values below.

## Trusted publisher

The `solarsql` package already has one GitHub Actions trusted publisher. The fields are case-sensitive:

- Organization or user: `meganemura`
- Repository: `solarsql`
- Workflow filename: `publish.yml` (the filename, including `.yml`)
- Environment name: `publish`
- Allowed action: `npm publish`

A trusted publisher created after 3 September 2026 starts with `npm stage publish` allowed. When recreating this publisher, select `npm publish` as well. The workflow runs `npm publish`.

`package.json` `repository.url` is `git+https://github.com/meganemura/solarsql.git`. npm checks that URL against the workflow repository.

The package already exists, so there is no token bootstrap and no short-lived `NPM_TOKEN`. The Environment `publish` already requires reviewers. Recreate that environment, with required reviewers, only when it is missing.

An approval appears only after a `v*` tag starts `publish.yml` and the job waits on the Environment `publish`. Registering the trusted publisher does not queue an approval.

After a successful OIDC `npm publish`, the package settings can require two-factor authentication and disallow token publishing. That hardening is optional. The trusted publisher keeps working.

## Action SHA pins

`publish.yml` and `ci.yml` pin each `uses:` to a full 40-character commit SHA, with the version in a comment on the same line:

- `actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1`
- `actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0`

The repository has `sha_pinning_required` enabled.

## Bumping miniflare

`miniflare` bundles a workerd build, and `src/build/facts.ts`'s `WORKERD_SQLITE_VERSION` pins the SQLite version that build runs. A `miniflare` bump can move that SQLite version without moving the constant; `test/miniflare/sqlite-version.test.ts` fails when they disagree.

After bumping the `miniflare` dependency: read the pinned workerd tag's `MODULE.bazel` in [cloudflare/workerd](https://github.com/cloudflare/workerd) for the SQLite source archive's `strip_prefix` (its shape is `sqlite-src-NNNNNNN`), look up that number against [sqlite.org's own version history](https://www.sqlite.org/changes.html) or its download page, and set `WORKERD_SQLITE_VERSION` to that version. Then run `npm run test:all`.

## Each version

1. Choose the version by SemVer (before 1.0, a minor version may change the API; `CHANGELOG.md`'s own opening line says so). Set it in `package.json`, then turn `CHANGELOG.md`'s `## Unreleased` heading into `## <version> (<date>)`. Add a `## Unreleased` heading first if none exists.
2. `npm install --package-lock-only` so the lock file carries the version.
3. `npm run test:all` and `npm run typecheck`.
4. `npm pack --dry-run` and read the file list: `src/`, `dist/`, `skills/`, `README.md`, `CHANGELOG.md`, `LICENSE`, `llms.txt`, `package.json`, and nothing else.
5. Commit as `release: <version>`, tag `v<version>`, push the commit and the tag. The tag without the leading `v` is the `package.json` version; the workflow stops when they differ. The tag push starts the workflow.
6. Approve the `publish` environment on that Actions run. The approval is requested when the job waits on that environment, which happens only after the tag starts `publish.yml`. The workflow uses Node 24 on `ubuntu-latest` with the npm registry URL set. It requires Node 24.20 or later on that line and npm 11.5.1 or later. It runs `npm ci`, `npm run build`, a check that the build did not modify tracked files, `npm run typecheck`, and `npm run test:all`, then `npm publish`. `dist/` is gitignored, so the new build output is expected and is what gets packed.
7. A GitHub release from the tag, with that version's CHANGELOG entry as its text. `--notes-file CHANGELOG.md` would paste every version, so extract the section first: `awk '/^## <version>/{f=1;next} /^## /{f=0} f' CHANGELOG.md > notes.md`, then `gh release create v<version> --title v<version> --notes-file notes.md`.

Approving the `publish` environment, and a change of the repository's visibility, are the owner's to run.
When the repository is public, private vulnerability reporting stays on in its Security settings; `SECURITY.md` points there, and the setting exists only for a public repository.
