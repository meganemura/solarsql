# Contributing

Open an issue first, with the SQL or the command that shows the need; a change to the shape of the library starts with an ADR in `docs/adr/`.

A pull request follows the rules in `AGENTS.md`: tests with Hegel where a property exists, comments that say why, no new dependency without the owner's approval, and English in every committed text. `npm test` and `npm run typecheck` pass before review, and CI runs both on Node 24 and 26.

A change written by an agent is reviewed by the same rules. Say in the pull request which tool wrote it.

The usage documentation is the skill in `skills/solarsql/`; a change to a rule changes the reference that states it, and `test/docs.test.ts` keeps the references and the README in step.
