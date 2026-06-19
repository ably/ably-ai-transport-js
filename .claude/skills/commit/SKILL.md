---
name: commit
description: Generate a commit message for the current staged changes and commit
allowed-tools: Skill, Bash(git diff *), Bash(git status), AskUserQuestion
---

# Commit Staged Changes

This skill runs the shared `ably-skills:git-commit` workflow, with the
project-specific additions below layered on top.

## Step 1: Note the project-specific guidance

These rules are specific to this repository. They take precedence over the
general guidance in the shared skill when writing the commit message:

- **Jira tickets**: do NOT include the ticket ID in the summary line.
  Add it on its own line at the end of the body in square brackets
  (e.g. `[PUB-123]`).
- **Component prefix**: begin the summary with a lowercase prefix naming
  the architectural area the change relates to, followed by `: ` and a
  lowercase, imperative description. For example,
  `transport: extract shared session lifecycle helpers`. The prefix names the
  area, not the file path.
  - Primary areas: `codec:`, `transport:`, `react:`, `vercel:`, `docs:`,
    `demos:`, `shared:`, `project:`.
  - For a change scoped to a single sub-component, name it directly instead
    of the broad area — e.g. `tree:`, `view:`, `clientSession:`,
    `agentSession:`, `runManager:`, `chatTransport:`.
  - Compose when a change is specific to one layer of an area:
    `vercel codec:`.
  - Repository tooling uses a path-style prefix: `claude/skills:`,
    `claude/rules:`.

  If changes span multiple unrelated areas, pick the most significant one or
  use a broader prefix.

## Step 2: Run the shared workflow

Invoke the `ably-skills:git-commit` skill with the Skill tool and follow its
steps in full (gather context, determine intent, generate message, present,
confirm, commit), applying the project-specific rules above when writing the
message.
