---
name: release
description: Cut a new release - create the release branch, bump the version in package.json, regenerate the CHANGELOG entry, commit, and open the release PR. Usage: /release patch|minor|major or /release <exact-version>.
allowed-tools: Bash(git checkout *), Bash(git branch *), Bash(git status *), Bash(git diff *), Bash(git add *), Bash(git log *), Bash(git rev-parse *), Bash(git commit *), Bash(git push *), Bash(gh pr create *), Bash(gh pr list *), Bash(gh pr view *), Bash(pnpm run *), Read, Edit, Glob, Grep, Skill, AskUserQuestion
---

# Release: Cut a New Release Branch

A release PR is an **ordinary PR**. It changes exactly two files —
`package.json` and `CHANGELOG.md` — and nothing else. Treat it as the small,
boring change it is: no extra validation ceremony, no CI babysitting, no
narrative.

## Step 1: Pre-flight checks

1. `git status --porcelain` — must be empty (clean working tree).
2. `git rev-parse main origin/main` — the release must be cut from the current
   `origin/main` tip. If the local `main` is behind, branch from `origin/main`
   and say so in one line.

If the working tree is dirty, stop and say what to fix. If the current branch
is already a `release/*` branch, stop — this skill only cuts new releases.

## Step 2: Read the current version

Read `package.json` and extract the `version` field. Record it as
`OLD_VERSION`.

## Step 3: Compute the new version

Interpret `$ARGUMENTS`:

- `patch` — increment third component, e.g. `1.2.3` → `1.2.4`.
- `minor` — increment second component, reset patch, e.g. `1.2.3` → `1.3.0`.
- `major` — increment first component, reset minor and patch, e.g. `1.2.3` → `2.0.0`.
- A literal semver string (e.g. `0.2.0`) — use it as-is. Validate it
  matches `^\d+\.\d+\.\d+(-[\w.]+)?$`.
- Empty — use **AskUserQuestion** with options "patch", "minor", "major",
  "Cancel".

Per `CONTRIBUTING.md`:

- Major: breaking changes requiring consumer action.
- Minor: new functionality or features.
- Patch: bug fixes requiring no consumer action.

## Step 4: Create the release branch

`git checkout -b release/NEW_VERSION <base>`, where `<base>` is the
`origin/main` tip from Step 1.

If `release/NEW_VERSION` already exists, stop and ask the user to delete it or
pick a different version. Never `--force` over it and never reuse it blindly:
it may hold work in progress — a worktree checked out on it, uncommitted edits,
an earlier attempt at this release.

## Step 5: Bump the version

Use **Edit** on:

1. `package.json` — the `version` field. Do NOT use `pnpm version`; it creates
   a tag and a commit, and the human controls both.
2. `src/version.ts` — the `VERSION` constant, which the SDK reports as its
   Ably-Agent string. `test/core/agent.test.ts` fails if the two drift, so
   `pnpm test` catches a half-done bump.

**No lockfile work.** `pnpm-lock.yaml` does not record the package's own
version, so no lockfile changes. Do not run
`pnpm install`, do not delete `node_modules`, and do not stage any lockfile.

## Step 6: Regenerate the CHANGELOG entry

Invoke the **changelog** skill via the **Skill** tool with
`skill: "changelog"` and `args: "NEW_VERSION invoked-by-release"`.

It finds the previous tag, collects the PRs merged since it, and inserts a new
`## [NEW_VERSION]` block above the existing entries. Keep its "Skipped PRs"
output — Step 8 reuses it verbatim for the PR description.

If it reports no PRs found (placeholder `-` bullet), say so and fill the
bullets in before committing.

## Step 7: Commit

Run `pnpm run format` (prettier over the repo — it is EOL-safe on this
checkout even though `format:check` is noisy locally), then stage **only** the
two release files:

```
git add package.json CHANGELOG.md
```

Verify with `git diff --cached --stat` that exactly those two appear, then
commit.

**The commit message is one line:**

```
Release vNEW_VERSION
```

No body. Nothing to explain — the CHANGELOG entry in the same commit is the
explanation. This matches every prior release commit; the repo does not use
conventional-commit prefixes for releases. The only additional line is the
`Co-Authored-By:` trailer.

Never put any of the following in a release commit message: a summary of the
changelog, a list of PRs, or a note that some PR still has to merge or that
the branch has to be rebased. That text becomes permanent history and is
wrong the moment it lands.

## Step 8: Push and open the PR

Push the branch and open the PR against `main`, titled `Release vNEW_VERSION`.
Open it as a draft if the changelog documents a PR that has not merged yet —
silently; the draft state is the signal, no explanatory note in the body.

The body is short. Four paragraphs, in this order:

1. What the PR changes: the version bump in `package.json` and the new
   `CHANGELOG.md` entry. One or two sentences.
2. The headline change in this release. One or two sentences.
3. `PRs included since OLD_VERSION`, split into two labelled lists:
   - **User-facing (in changelog)** — every PR that produced a `CHANGELOG.md`
     bullet. One `#number` per line; add a two-or-three-word parenthetical
     only for the headline and for breaking changes.
   - **Not user-facing (not in changelog)** — every other PR in the window,
     each with a one-word reason (`CI`, `docs`, `test-only`,
     `internal tooling`, `internal refactor`). This is the changelog skill's
     "Skipped PRs" output.

   The union of the two lists is every PR in the window, so nothing is
   silently dropped.

4. Optional, only when true: any change this PR makes beyond the three release
   files — for example an edit to this skill. One or two sentences.

Nothing else goes in the body. No validation report, no test counts, no
merge-order or rebase notes, no "worth your attention" section.

## Step 9: What is left for a human

Report the PR link, then this list, and stop. Do not summarise the diff back —
not the version numbers, not the file list, not what validation ran.

1. Merge the PR.
2. Create a [GitHub release](https://docs.github.com/en/repositories/releasing-projects-on-github/managing-releases-in-a-repository#creating-a-release):
   tag `NEW_VERSION` (no `v` prefix), title `vNEW_VERSION`, description from
   "Generate release notes".
3. The npm (`release.yml`) and CDN (`publish.cdn.yml`) publish workflows fire
   on release publication.
4. Update the [Ably Changelog](https://changelog.ably.com/) via
   [Headway](https://headwayapp.co/).

## Do not

- **Do not watch, poll, or wait for CI** — not on `main`, not on the release
  PR. A version bump plus a markdown edit cannot break the build; if a check
  does fail, a human sees it on the PR and deals with it separately.
- **Do not touch lockfiles or `node_modules`** (see Step 5).
- **Do not run the test suite, typecheck, or lint** for a release. `prettier`
  on the changelog is the only formatting that matters.
- **Do not write memory entries about the release** — not the version, not the
  PR number, not which PRs still need to merge. A release is routine work with
  no durable lesson in it.
- **Do not restate what the user already told you** — if they asked for a
  specific PR to be included, they know it is not merged yet.
