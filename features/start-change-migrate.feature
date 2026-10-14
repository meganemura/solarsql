Feature: Start a project, change the schema, and write the next migration

  An agent starts a project from the published package, changes a table,
  and lets the build tell it what to do next: the build says a migration
  is pending and names the statement, the generated types follow the new
  column, and the migration command writes the file.

  Scenario: a new column reaches the generated types and the next migration
    Given an empty ES module project with the packed solarsql installed
    When the agent starts a project with a module named orders
    Then the module's own test passes
    When the agent adds a nullable note column to the orders table, reads it in the list query, and builds
    Then the build says a migration that adds the column is pending
    And the list query's row type has the note as text or null
    When the agent writes the next migration
    Then the migration file adds the column and the build reports the migrations current
