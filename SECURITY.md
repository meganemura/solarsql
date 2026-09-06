# Security

Report a vulnerability through GitHub's private vulnerability reporting on this repository, from the Security tab.
Do not open a public issue for it.

The report gets an answer within a week. A fix ships as a patch release, and the changelog names the advisory once the fix is out.

The library runs SQL that the application wrote, as string literals in its modules; a parameter is always bound, never interpolated. A report that shows SQL of a module reaching data of another module, or a parameter reaching the SQL text, is in scope.
