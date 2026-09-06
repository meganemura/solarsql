# Releasing

Each step is one command, run from the root, on a clean `main` that CI has passed.

1. Set the version in `package.json` and turn the `(unreleased)` entry of `CHANGELOG.md` into the version and the date.
2. `npm install --package-lock-only` so the lock file carries the version.
3. `npm test` and `npm run typecheck`.
4. `npm pack --dry-run` and read the file list: `src/`, `dist/`, `skills/`, `README.md`, `LICENSE`, `package.json`, and nothing else.
5. Commit as `release: <version>`, tag `v<version>`, push the commit and the tag.
6. `npm publish`. The `prepublishOnly` script builds `dist/` first.
7. A GitHub release from the tag, with the CHANGELOG entry as its text.

`npm publish` and a change of the repository's visibility are the owner's to run.
