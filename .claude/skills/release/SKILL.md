---
name: release
description: Cut a new release - create release branch, bump version in package.json, refresh root and demo lockfiles, regenerate CHANGELOG, and stage for review. Usage: /release patch|minor|major or /release <exact-version>.
allowed-tools: Bash(git checkout *), Bash(git branch *), Bash(git status *), Bash(git diff *), Bash(git add *), Bash(git log *), Bash(npm install *), Bash(npm run *), Bash(rm *), Bash(ls *), Read, Edit, Glob, Grep, Skill, AskUserQuestion
---

# Release: Cut a New Release Branch

Create a `release/NEW_VERSION` branch, bump the version in `package.json`,
refresh lockfiles, regenerate the `CHANGELOG.md` entry for the new version,
and stage everything for review. Do **not** commit — committing and pushing
remain human actions per `CLAUDE.md` workflow rules.

## Step 1: Pre-flight checks

Run in parallel:

1. `git branch --show-current` — must be `main`.
2. `git status --porcelain` — must be empty (clean working tree).
3. `git log -1 --format=%cI main` — show the timestamp of the current tip
   so the user can sanity-check that `main` is up-to-date.

If either of the first two checks fails, stop and tell the user what to
fix. If the current branch is already a `release/*` branch, stop — this
skill only cuts new releases from `main`.

Per `CLAUDE.md`, never run `git fetch`, `git pull`, or `git push` from this
skill. Warn the user that the local `main` may be behind the remote and
should be refreshed manually before continuing. Also remind the user to
verify that CI is green on `main` (per `CONTRIBUTING.md` release step 1)
— this skill does not check CI status.

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

Record the result as `NEW_VERSION` and show the user:

```
Releasing: OLD_VERSION -> NEW_VERSION
```

## Step 4: Create the release branch

```
git checkout -b release/NEW_VERSION
```

If the branch already exists, stop and ask the user to delete it or pick a
different version — never `--force` over an existing branch.

## Step 5: Bump the version in package.json

Use **Edit** to change the `version` field only. Do NOT use `npm version`
— it creates a tag and commit, and we want the human to control both.

## Step 6: Refresh the root lockfile

Run `npm install` at the repo root. This regenerates `package-lock.json`
with the new version.

Watch for unrelated lockfile churn (transitive updates, metadata drift).
If the `git diff package-lock.json` looks unusually large, surface it to
the user before continuing — don't hide it under the version bump.

## Step 7: Refresh demo app lockfiles

Per `CONTRIBUTING.md` release step 4.3, every demo app picks up the new
version:

1. Use **Glob** with pattern `demo/**/package.json` to enumerate demo app
   directories. Filter out any path containing `node_modules/`. Record
   the absolute directory of each match — these are the demo app roots.
2. For each demo app root, in its own **Bash** invocation (one per app,
   because `cd` does not persist between tool calls):
   - `rm -rf <abs-app-dir>/node_modules`
   - `npm install --prefix <abs-app-dir>` — prefer this over
     `cd <abs-app-dir> && npm install` for reliability across shells.
3. Read each demo's `package.json`. If it references `@ably/ai-transport`
   via a `file:` path (e.g. `"file:../.."`), note it in the summary — its
   lockfile will pick up local unpublished code rather than the new
   published version.

If the Glob returns no matches, skip this step.

## Step 8: Regenerate the CHANGELOG entry

Invoke the **changelog** skill via the **Skill** tool with
`skill: "changelog"` and `args: "NEW_VERSION invoked-by-release"`. The
second arg signals the changelog skill that it is being invoked as part
of the release flow so its closing "use `/commit`" advice is suppressed
(see that skill's Step 7).

The changelog skill will:

- Find the previous tag (`OLD_VERSION`).
- Fetch merged PRs since that tag's date via `gh`.
- Format and insert a new `## [NEW_VERSION]` block in `CHANGELOG.md`,
  preserving the intro paragraph above all version blocks.

If the changelog skill reports no PRs found (placeholder `-` bullet),
note this in the final summary and remind the user to fill it in.

**Contract after this step:** `CHANGELOG.md` is modified but not staged.
The working tree also contains the `package.json` edit from Step 5 and
the lockfile changes from Steps 6-7, all unstaged. Step 10 stages them.

## Step 9: Validate

Run `npm run precommit` (format:check + lint + typecheck).

- If it fails on files this skill touched (lockfile formatting, CHANGELOG
  formatting), fix them and re-run.
- If it fails on unrelated files, stop and surface the failure — do not
  paper over pre-existing errors.

## Step 10: Stage and present for review

Stage the files this skill modified:

1. Always stage: `git add package.json package-lock.json CHANGELOG.md`
2. For each demo app directory recorded in Step 7, stage its lockfile
   explicitly using its path — for example
   `git add demo/vercel/react/use-chat/package-lock.json`. Do **not**
   rely on shell globs like `demo/**/package-lock.json` — `**` is not
   reliably expanded without `globstar` and misses nested paths.

Then run `git status` and `git diff --cached --stat`, and show the user:

- `Version: OLD_VERSION -> NEW_VERSION`
- `Branch: release/NEW_VERSION`
- Files staged (from `git diff --cached --stat`)
- CHANGELOG summary: N PRs since OLD_VERSION, or "placeholder bullet
  (fill in manually)"
- Any flags raised earlier (large lockfile diff, file: demo references).

**Do NOT commit.** Per `CLAUDE.md`: "Never commit changes. All changes
must be reviewed by a human before committing." Instruct the user to
review and run `/commit` (or commit manually) to finalise the version
bump.

## Step 11: Post-commit reminder

After presenting the staged changes, remind the user of the remaining
steps from `CONTRIBUTING.md` that are out of scope for this skill:

1. Verify CI is green on `main` before opening the release PR (if not
   already confirmed in Step 1).
2. Commit the staged changes with `/commit`.
3. Open a PR for `release/NEW_VERSION` → `main` and get it reviewed and
   merged.
4. Create a [GitHub release](https://docs.github.com/en/repositories/releasing-projects-on-github/managing-releases-in-a-repository#creating-a-release):
   - Tag: `NEW_VERSION` (no `v` prefix).
   - Title: `vNEW_VERSION`.
   - Use "Generate release notes" to populate the description.
5. Verify the npm publish workflow (`release.yml`) and the CDN publish workflow (`publish.cdn.yml`) both complete successfully.
6. Update the [Ably Changelog](https://changelog.ably.com/) via
   [Headway](https://headwayapp.co/).

## Things to watch for

- **`npm install` side effects.** Transitive dependency updates can
  produce large `package-lock.json` diffs unrelated to the version bump.
  Surface these — do not hide them.
- **Demo apps with `file:` references.** `demo/*/package.json` that
  imports `@ably/ai-transport` via a local path picks up unpublished
  code. Flag it so the user knows the demo isn't exercising the released
  artifact.
- **CLAUDE.md remote policy.** Never run `git push`, `git pull`,
  `git fetch`, or any network-modifying git command.
- **Commit policy.** The skill stages but does not commit. The Python
  reference (`ably-python` PR 677) commits directly — we intentionally
  deviate.
- **Branch already exists.** If `release/NEW_VERSION` already exists
  locally, stop rather than overwriting — the user may have work in
  progress there.
