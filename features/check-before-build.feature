Feature: The build's check refuses a schema edit the build has not seen

  CI and a test hook run `solarsql build --check` to catch a schema edit
  that nobody built. The build reference promises that the check writes
  nothing, exits 1 when a generated file or a migration is behind the
  source, and gives diagnostics with a recovery action.

  Scenario: the check fails on an unbuilt edit and leaves every file as it was
    Given an empty ES module project with the packed solarsql installed
    When the agent starts a project with a module named orders
    And the agent adds a nullable note column to the orders table and reads it in the list query
    And the agent runs the build's check
    Then the check fails, names the build as the recovery, and writes nothing
