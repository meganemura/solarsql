# Releasing

Each step is one command, run from the root, on a clean `main` that CI has passed.

1. Choose the version by SemVer (before 1.0, a minor version may change the API; `CHANGELOG.md`'s own opening line says so). Set it in `package.json`, then turn `CHANGELOG.md`'s `## Unreleased` heading into `## <version> (<date>)`.
2. `npm install --package-lock-only` so the lock file carries the version.
3. `npm test` and `npm run typecheck`.
4. `npm pack --dry-run` and read the file list: `src/`, `dist/`, `skills/`, `README.md`, `CHANGELOG.md`, `LICENSE`, `package.json`, and nothing else.
5. Commit as `release: <version>`, tag `v<version>`, push the commit and the tag.
6. `npm publish`. The `prepublishOnly` script builds `dist/` first.
7. A GitHub release from the tag, with the CHANGELOG entry as its text.

`npm publish` and a change of the repository's visibility are the owner's to run.
When the repository turns public, turn on private vulnerability reporting in its Security settings; `SECURITY.md` points there, and the setting exists only for a public repository.
