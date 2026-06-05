---
name: changelog
description: Generate CHANGELOG.md entries for a new version from merged PRs since the last release tag. Use standalone to refresh entries, or invoked by the release skill.
allowed-tools: Bash(git tag *), Bash(git log *), Bash(gh pr list *), Bash(date *), Read, Edit, AskUserQuestion
---

# Changelog: Generate CHANGELOG.md Entries

Generate a `CHANGELOG.md` entry for a new version by summarising merged PRs
since the last release tag. Insert the entry at the top of the existing
changelog. Do not commit — leave the change staged for review.

## Step 1: Determine the target version and invocation mode

Parse `$ARGUMENTS`:

- First token, if it looks like semver (e.g. `0.2.0`), is `NEW_VERSION`.
- If the literal token `invoked-by-release` appears anywhere in the args,
  set `INVOKED_BY_RELEASE = true`. This suppresses the trailing
  "use `/commit`" reminder in Step 7 because the calling `release` skill
  will present its own summary.

If no semver is present in `$ARGUMENTS`, read the `version` field from
`package.json`. Use **AskUserQuestion** to ask whether to generate
entries for that version or a different one. Options:
"Use <package.json version>", "Enter a different version", "Cancel".

## Step 2: Find the previous release tag

Run `git tag --list --sort=-v:refname` and pick the first tag that is not
equal to `NEW_VERSION`. Tags in this repo are unprefixed (e.g. `0.0.1`, not
`v0.0.1`) — see `CONTRIBUTING.md`.

- If no tags exist, treat "since" as the full history and note this in the
  summary so the user knows.
- Record the chosen tag as `OLD_VERSION`.

## Step 3: Get the tag date

Run `git log <OLD_VERSION> --format="%aI" -1` to get the ISO-8601 date of
the last release. Skip if no previous tag exists.

## Step 4: Fetch merged PRs since the tag

Prefer the server-side `--search` filter so `gh` handles the date
comparison — this avoids fragile string comparisons across ISO-8601
variants (`+00:00` vs `Z`):

```
gh pr list --state merged --base main \
  --search "merged:>=<OLD_TAG_DATE>" \
  --json number,title,mergedAt,body --limit 200
```

Use the date portion only (`YYYY-MM-DD`) from the tag date — `gh`'s
search syntax accepts it. Then, as a belt-and-braces check, also drop
any PR whose `mergedAt` timestamp converts to a `Date` earlier than the
tag's timestamp.

If no previous tag exists, omit the `--search` flag and include all
entries returned by `gh pr list`.

## Step 5: Format entries

For each PR, produce a bullet:

```
- <summary> [#NUMBER](https://github.com/ably/ably-ai-transport-js/pull/NUMBER)
```

Summary guidance:

- Derive from the PR title, refined by the PR body if the title is terse
  or cryptic.
- Strip conventional-commit prefixes (`feat:`, `fix:`, `chore:`,
  `refactor:`, `docs:`, scoped variants like `fix(transport):`, etc.) and
  rewrite into sentence case.
- Keep it to one short sentence focused on user-visible impact.
- **Never reference internal-only artifacts.** The changelog is read by end
  users of the published package, who have no access to internal trackers.
  Strip and never emit: Jira ticket or epic ids (e.g. `AIT-815`),
  specification point ids (e.g. `AIT-CT2a` for this SDK, or `RSA*` / `RTL*`
  -style points from the general Ably spec), RFC / DR / design-doc ids
  (e.g. `AITDR-011`, `AITRFC-014`), internal Slack threads, standup notes,
  or any other internal process reference. These routinely appear in
  branch-style PR titles (e.g. `Refactor/ait 815 codec split`) — describe
  the user-visible change instead. The only references that belong are the
  PR link (`[#NUMBER]`), public API names, exported types, and on-the-wire
  message / header names.
- Skip pure CI, lint, formatting, or internal-refactor PRs **if** there
  are substantive user-facing entries. If the release contains only
  internal work, keep the entries so the section is not empty.

If the filtered PR list is empty, emit a single placeholder bullet `-` and
warn the user at the end to fill it in manually.

## Step 6: Insert into CHANGELOG.md

Read `CHANGELOG.md`. Locate the **first existing `## [` version entry**
and insert the new block immediately before it. This keeps the intro
paragraph ("This contains only the most important...") above all version
blocks, where it belongs.

If no `## [` entry exists yet (unlikely — the repo has `0.0.1` already),
append the new block to end-of-file.

Compute today's date by running `date -u +%Y-%m-%d` (format matches the
existing `0.0.1` entry's `(2026-03-27)` style). Use this as `TODAY`.

Block to insert:

```
## [NEW_VERSION](https://github.com/ably/ably-ai-transport-js/tree/NEW_VERSION) (TODAY)

[Full Changelog](https://github.com/ably/ably-ai-transport-js/compare/OLD_VERSION...NEW_VERSION)

### What's Changed

<BULLETS>

```

Notes:

- The existing `0.0.1` entry is a one-line prose blurb with no
  `[Full Changelog]` or `### What's Changed`. That is an artifact of it
  being the seed release (no predecessor). From `0.0.2` onward, the
  structured template above is correct — do not try to mimic the prose
  style of the seed entry.
- If `OLD_VERSION` is unknown (no prior tag at all), omit the
  `[Full Changelog]` line rather than generating a broken compare link.
- Preserve the blank line between version blocks.

Use the **Edit** tool for this, not Write — the file already exists and
Edit keeps the rest intact. A safe `old_string` anchor is the literal
text of the first `## [` heading line (e.g. `## [0.0.1]`...); place the
new block before it.

## Step 7: Summarise for the user

Print:

- The inserted block verbatim.
- The PR count included and the version range
  (`OLD_VERSION` → `NEW_VERSION`).
- **Skipped PRs**, with the reason for each. Group by reason:
  - `CI / tooling` — GitHub Actions, release workflow, scripts.
  - `Lint / format` — prettier, eslint, formatting-only.
  - `Internal refactor` — no user-visible impact.
  - `Other` — anything else you chose to exclude.

  Format each as `- #NUMBER <original title> — <reason>`. If no PRs were
  skipped, print "No PRs skipped."

  This gives the user a chance to override the filter and pull any
  skipped PR back into the `### What's Changed` list before the release
  PR is opened.

- If a placeholder `-` was used (no substantive PRs found), a reminder
  to fill in the `### What's Changed` bullets before merging.

If `INVOKED_BY_RELEASE` is true (Step 1), **stop here** — the calling
`release` skill will present its own staging summary and commit
instructions. Do not print a `/commit` reminder.

Otherwise, remind the user that `CHANGELOG.md` is modified but not
staged. Per `CLAUDE.md`, committing is a human action — use `/commit`
(or commit manually) after review.

## Things to watch for

- **No internal references.** The entry must contain no Jira `AIT-*`
  ticket/epic ids, `AIT-*` / `RSA*`-style spec points, `AITDR-*` /
  `AITRFC-*` RFC/DR documents, Slack links, or standup references — only
  public PR links and public API / wire names. Branch-style PR titles
  (`Refactor/ait 815 ...`) carry the ticket id; strip it.
- **Describe the NET change since the last release, not intermediate PR
  states.** Across a release with many incremental PRs a symbol can be
  added then removed, or renamed then renamed again. Summarise each entry
  against the net diff from the previous tag to HEAD
  (`git diff <OLD_VERSION> HEAD -- <public entry points>`), not the cited
  PR's own before/after. Drop any entry whose subject was both introduced
  AND removed within the release window (net-zero for an upgrading user),
  and ensure every renamed/removed symbol name matches HEAD rather than a
  superseded mid-release name. The same applies to bug fixes: only list a
  fix if the bug affected functionality that already shipped in the
  previous release.
- **Conventional-commit prefix stripping.** "fix(transport): stop leaking
  stream controller" should become "Stop leaking stream controller", not
  retain the prefix or scope.
- **Draft/closed PRs.** `--state merged` excludes drafts by definition,
  but double-check the response for anomalies (e.g. reverted work) before
  listing them.
- **Very large PR bodies.** Do not paste PR body text into the changelog
  — distil to one sentence.
- **Case sensitivity of tags.** Tags here are `0.0.1`, not `v0.0.1`.
  Never add a `v` prefix when referencing them.
