---
name: commit
description: Generate a commit message for the current staged changes and commit
disable-model-invocation: true
allowed-tools: Bash(git diff *), Bash(git status), Bash(git commit *), Bash(git log *), Bash(curl *), AskUserQuestion
---

# Commit Staged Changes

Generate a high-quality commit message for the currently staged changes, present it
for approval, then commit.

## Step 1: Gather context

Run these commands to understand the staged changes:

1. `git diff --cached --stat` to see which files are staged
2. `git diff --cached` to see the full diff
3. `git status` to check overall state (never use -uall flag)

If there are no staged changes, tell the user and stop.

## Step 2: Determine the intent

Determine the **intent** of the change from the diff. If the intent is
not clear from the code alone, use AskUserQuestion to ask the user to
clarify the purpose of the change before writing the message.

## Step 3: Generate the commit message

Write a commit message following ALL of the guidance below. Where the
project-specific guidance conflicts with the general guidance, the
project-specific guidance takes precedence.

### General commit guidance

!`curl -sf https://raw.githubusercontent.com/ably/engineering/refs/heads/main/best-practices/commits.md`

### Project-specific guidance (takes precedence)

- If the commit refers to a Jira ticket, do NOT include the ticket ID
  in the summary line. Instead, add it on its own line at the end of
  the body in square brackets (e.g. `[PUB-123]`).
- Always include a component prefix indicating what area the change
  relates to (see below).
- Keep the body concise. Explain **what** changed and **why**, not
  just restate the diff. Focus on motivation and approach.
  A short body of 1-3 sentences is usually sufficient.
- Further paragraphs come after blank lines.
  - Bullet points are okay, too
  - Typically a hyphen (-) is used for the bullet, followed by a
    single space
  - Use a hanging indent
- If the diff includes test changes, summarize what the tests cover.
- Keep the message concise — omit the body entirely if the summary
  alone is sufficient for a trivial change.

### Project-specific component prefixes

The component prefix is derived from the file paths in the diff. Examples:
- `codec:` `codec/vercel:` `transport:` `transport/vercel:`
- `docs:` `docs/concepts:`
- `test/unit:`
- `test/integration:`
- `project:`

If changes span multiple unrelated components, pick the most significant
one or use a broader prefix.

## Step 4: Present the message

Show the complete commit message to the user in a fenced code block.

Then ask: **"Do you want to commit with this message, edit it, or cancel?"**

## Step 5: Act on the response

- **Accept / looks good / yes**: Run the commit using a heredoc:
  ```
  git commit -m "$(cat <<'EOF'
  <the message>
  EOF
  )"
  ```
- **Edit**: The user will provide a revised message or describe changes.
  Apply their edits and show the updated message for confirmation again
  (return to Step 3).
- **Cancel**: Do nothing.

After a successful commit, run `git log -1` to confirm.
