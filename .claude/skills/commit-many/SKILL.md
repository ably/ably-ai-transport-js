---
name: commit-many
description: Stage and commit all uncommitted changes as a series of logical, well-ordered commits
allowed-tools: Skill
---

# Commit Many: Split Changes into Logical Commits

This skill runs the shared `ably-skills:git-commit-many` workflow, with the
project-specific override below.

## Project-specific override

The shared skill delegates each individual commit to `/git-commit`. In this
repository, delegate to the local `commit` skill (`/commit`) instead, so the
project's commit-message conventions (component prefixes, Jira ticket
placement) are applied to every commit in the series.

## Run the shared workflow

Invoke the `ably-skills:git-commit-many` skill with the Skill tool and follow
its steps in full (gather context, plan the commits, execute the plan with
selective line staging), substituting `/commit` for `/git-commit` wherever it
delegates the per-commit message generation.
