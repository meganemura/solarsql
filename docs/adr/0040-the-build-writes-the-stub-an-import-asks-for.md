# ADR 0040: The build writes the stub an import asks for

Status: accepted (2026-09-10). Extends the first consequence of ADR 0025.

## Context

ADR 0025 commits the generated file, and a build before the first one writes a stub, so the module imports.
The build wrote the stub of each listed module right before it imported that module, and it imported the configuration file before any stub.
Two import graphs failed on a fresh clone with `ERR_MODULE_NOT_FOUND`, in Node's words, at a generated file:
a module with a value import of a module listed after it, and a configuration file that imports a module through its `public.ts`.
The second is a project that lists its modules in the configuration and exports, from the same file, what the application wires up.

## Decision

Before the build imports any module, it writes the stub of every listed module that has no generated file.
The build imports the configuration file first.
When that import fails at a missing generated file with a `module.ts` beside it, the build writes that stub and imports again; the same path twice stops the retry, and Node's error stands.
A stub written this way for a module the configuration does not list is removed, and the build refuses with the entry to add.
A check writes nothing and reports the missing file with the build's own message.

## Why

The import graph of a project belongs to the project.
A rule that the configuration file imports no module would be a rule about a file the build reads for one field, and a fresh clone would still fail on a module order the rule does not cover.
Node names the file it could not find, and a missing generated file has one fix, so the build applies it.
An unlisted module would keep its stub for ever, since no build fills it, and a stub that stays is a generated file that lies.

## Consequences

- A fresh clone builds in any module order, and a configuration file may import a module.
- The retry imports the configuration file once per missing generated file it reaches; the module files import once each.
- The stub the retry writes names `solarsql` as the library, since the configuration has not loaded yet; the build rewrites it with the configured specifier before any module is imported. The import in the stub is type-only, so the specifier plays no part in the import that asked for it.
