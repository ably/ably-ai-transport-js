#!/usr/bin/env bash
#
# SessionStart hook: bootstrap a freshly-created git worktree.
#
# When a session starts inside a linked worktree (as created by `claude
# --worktree`), this initialises submodules and copies the git-ignored
# .env.local files down from the main checkout so the worktree is ready to run.
#
# It is a no-op in the main checkout and on every session after the first: a
# sentinel in the per-worktree git dir (outside the working tree, so never
# committed and unique to each worktree) makes the bootstrap run exactly once.
# It never overwrites an existing file, and always exits 0 so it cannot block a
# session from starting.
set -uo pipefail

# Resolve the worktree root from the hook's working directory.
root="$(git rev-parse --show-toplevel 2>/dev/null)" || exit 0
[ -n "$root" ] || exit 0

# A linked worktree has a .git *file*; the main checkout has a .git *directory*.
# Only linked worktrees get bootstrapped.
[ -f "$root/.git" ] || exit 0

# Run once per worktree. The per-worktree git dir lives under the main repo's
# .git/worktrees/<name>/ — not part of any working tree, so the sentinel is
# private to this worktree and is never checked out or committed.
gitdir="$(git -C "$root" rev-parse --absolute-git-dir 2>/dev/null)" || exit 0
sentinel="$gitdir/claude-worktree-setup.done"
[ -e "$sentinel" ] && exit 0

# The main checkout is the first entry reported by `git worktree list`.
main="$(git -C "$root" worktree list --porcelain | awk '/^worktree /{print $2; exit}')"
[ -n "$main" ] || exit 0
[ "$main" = "$root" ] && exit 0 # defensive: never copy onto ourselves

echo "[worktree-setup] bootstrapping $root" 1>&2

# 1. Initialise submodules in the worktree.
git -C "$root" submodule update --init --recursive 1>&2 ||
  echo "[worktree-setup] submodule update failed (continuing)" 1>&2

# 2. Copy the git-ignored .env.local files from the main checkout to the same
#    relative path in the worktree. Skips a file whose destination already
#    exists or whose parent directory is missing, so nothing is clobbered.
copied=0
while IFS= read -r src; do
  rel="${src#"$main"/}"
  dest="$root/$rel"
  [ -e "$dest" ] && continue
  [ -d "$(dirname "$dest")" ] || continue
  if cp "$src" "$dest"; then
    copied=$((copied + 1))
    echo "[worktree-setup] copied $rel" 1>&2
  fi
done < <(find "$main" -name .env.local -not -path '*/node_modules/*' -not -path '*/.claude/worktrees/*')

touch "$sentinel"

# Report to the user via a clean JSON systemMessage on stdout (stderr above
# carries the detail for `claude --debug`).
printf '{"systemMessage":"Worktree bootstrap: submodules initialised, %d .env.local file(s) copied.","suppressOutput":true}\n' "$copied"
exit 0
