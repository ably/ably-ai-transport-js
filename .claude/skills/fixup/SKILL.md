---
name: fixup
description: Create fixup or amend commits against existing PR commits for staged or unstaged changes
allowed-tools: Bash(git diff *), Bash(git status *), Bash(git log *), Bash(git show *), Bash(git add *), Bash(git commit *), AskUserQuestion
---

# Fixup: Fold Changes into Existing PR Commits

Selectively stage uncommitted changes and create `fixup!` or `amend!`
commits targeting the appropriate existing commits in the current PR branch.

## Step 1: Gather context

Run these commands to understand the state:

1. `git log --oneline main..HEAD` to list all PR commits
2. `git diff --stat` and `git diff --cached --stat` to see all changes
3. `git diff` and `git diff --cached` to see the full diffs
4. `git status` to check overall state (never use `-uall` flag)

If there are no changes, tell the user and stop.

## Step 2: Match changes to commits

For each changed file (or hunk, if a file has changes belonging to
different commits), determine which commit **on the current branch**
(from `git log --oneline main..HEAD`) it should be folded into.
Never target commits that are not on the current branch. Consider:

- The file paths and which branch commits originally touched them
- The nature of the change (does it refine, fix, or extend the original commit?)
- Whether the change alters the **intent** of the original commit enough
  that its commit message should be updated

Use `git show --stat <sha>` to inspect individual branch commits as
needed to match changes to their targets. If a change does not clearly
belong to any existing branch commit, ask the user how to handle it.

## Step 3: Choose fixup vs amend

For each target commit, decide:

- **`fixup!`** — the change refines the commit but the original message
  is still accurate. This is the common case.
- **`amend!`** — the change alters what the commit does such that the
  commit message should be reworded. The amend commit message should be
  the full replacement message for the target commit.

## Step 4: Present the plan

Show a table mapping each change (file or hunk) to its target commit
and whether it will be a fixup or amend. For amend commits, show the
proposed replacement message.

Use **AskUserQuestion** to ask: "Proceed, adjust, or cancel?" with those
three options.

## Step 5: Execute

For each target commit (in log order, oldest first):

1. Stage the relevant files or hunks: `git add <files>` (use
   `git add -p` only if hunks within a single file target different
   commits)
2. Create the commit:
   - For fixup: `git commit --fixup=<sha>`
   - For amend: use a heredoc message starting with `amend! <original summary line>`,
     followed by a blank line and the full replacement message body
3. Verify with `git log --oneline -1`

After all commits are created, show the full PR log:
`git log --oneline main..HEAD`

Remind the user they can run `git rebase -i --autosquash main` to fold
the fixup/amend commits into place.
