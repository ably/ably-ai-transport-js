---
name: rebase
description: Rebase current branch onto another branch, resolving conflicts at each step
allowed-tools: Bash(git branch *), Bash(git log *), Bash(git status *), Bash(git rebase *), Bash(git add *), Bash(git diff *), Bash(git show *), Bash(grep *), Read, Edit, Grep, Glob, AskUserQuestion
---

# Rebase: Rebase and Resolve Conflicts

Rebase the current branch onto a target branch, resolving merge
conflicts at each step until the rebase completes.

## Step 1: Gather context

Run these commands to understand the state:

1. `git branch --show-current` to identify the current branch
2. `git log --oneline main..HEAD` to see the commits that will be rebased
3. `git status` to check for uncommitted changes (never use `-uall` flag)

If there are uncommitted changes, warn the user and stop — rebase
requires a clean working tree.

Determine the **target branch**:
- If the user specified a branch (e.g. `/rebase main`), use that.
- Otherwise, default to `main`.

## Step 2: Start the rebase

Run `git rebase <target>`. If it completes without conflicts, report
success and show `git log --oneline <target>..HEAD`.

If conflicts occur, proceed to Step 3.

## Step 3: Resolve conflicts

For each conflicting step:

1. Run `grep -rn "^<<<<<<< " <file>` on each conflicted file to locate
   all conflict markers.
2. **Read each conflict region** in context (the surrounding code, not
   just the markers) to understand what both sides intended.
3. Resolve by choosing the correct combination:
   - **Keep HEAD (ours):** The current branch's version is correct,
     typically when HEAD contains a superset of the incoming changes.
   - **Keep incoming (theirs):** The target branch's version is correct.
   - **Merge both:** Both sides made independent changes that should
     coexist. Combine them, ensuring no duplication.
   - **Rewrite:** Neither side is complete on its own — synthesize the
     correct result from both.
4. Use the **Edit** tool to remove conflict markers and write the
   resolved content. Never leave `<<<<<<<`, `=======`, or `>>>>>>>`
   markers in the file.
5. After resolving all conflicts in a file, verify no markers remain:
   `grep -c "^<<<<<<< \|^=======\|^>>>>>>>" <file>`
6. Stage resolved files: `git add <files>`
7. Continue: `git rebase --continue`

If new conflicts appear in the next commit, repeat Step 3.

## Conflict resolution principles

- **Understand intent, not just lines.** Read enough context to know
  what each side was trying to do. A mechanical "pick left/right" often
  produces broken code.
- **The target branch is authoritative for its own changes.** If the
  target branch refactored an API, the rebased commits must adapt to
  that API — not revert it.
- **The current branch is authoritative for its own features.** New
  code from the current branch should be preserved, but adapted to fit
  any structural changes from the target.
- **Watch for signature changes.** If the target branch added a
  required parameter to a constructor, interface, or function, ensure
  all call sites in the rebased commits include it.
- **Don't fix unrelated issues.** Only resolve the conflict — don't
  refactor, clean up, or "improve" surrounding code during the rebase.

## Step 4: Report

After the rebase completes, show:

1. `git log --oneline <target>..HEAD` — the rebased commit history
2. A brief summary of how many commits were rebased, how many had
   conflicts, and what was resolved.
