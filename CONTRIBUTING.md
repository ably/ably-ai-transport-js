# Contributing

## Prerequisites

This repository uses [pnpm](https://pnpm.io/) as its package manager. The exact version is pinned in `package.json` via the `packageManager` field. The simplest way to pick it up is via [Corepack](https://nodejs.org/api/corepack.html), which ships with Node:

```shell
corepack enable
```

After that, `pnpm` is available on your `PATH` and `pnpm install` will use the pinned version automatically. `npm install` is rejected by `devEngines.packageManager` to keep everyone on the same lockfile.

## How to contribute

1. Fork it
2. Create your feature branch (`git checkout -b my-new-feature`)
3. Commit your changes (`git commit -am 'Add some feature'`)
4. Ensure you have added suitable tests and the test suite is passing (`pnpm test`)
5. Push the branch (`git push origin my-new-feature`)
6. Create a new Pull Request

## Running the test suite

To run the unit tests:

```shell
pnpm test
```

To run the integration tests (requires an `ABLY_API_KEY` environment variable):

```shell
pnpm run test:integration
```

## Building

```shell
pnpm run build          # Build all entry points
pnpm run build:core     # Build core entry point only
pnpm run build:react    # Build react entry point only
pnpm run build:vercel   # Build vercel entry point only
pnpm run build:vercel-react  # Build vercel/react entry point only
```

The build uses Vite library mode producing ESM + UMD/CJS bundles with `.d.ts` declarations and sourcemaps in `dist/`.

## Formatting and linting

This repository uses Prettier and ESLint for formatting and linting respectively. The rules are enforced in CI, so please make sure you run the checks before pushing your code:

```shell
pnpm run format:check   # Check for formatting errors
pnpm run lint           # Check for linting errors
pnpm run lint:fix       # Check for linting errors and fix
pnpm run typecheck      # Type check
pnpm run precommit      # Run all checks (format, lint, typecheck)
```

## Release process (Claude Code)

1. Ensure tests pass in CI on `main` and all work intended for this release has landed.
2. Run `/release patch|minor|major` in Claude Code. This creates the release branch, bumps the version in `package.json` and `src/version.ts`, invokes the `/changelog` skill to populate `CHANGELOG.md` with merged PRs since the last tag, commits, and opens the release PR. Those three files are the whole release commit.
3. Review the `### What's Changed` entries in [CHANGELOG.md](./CHANGELOG.md) and adjust if needed.
4. Get the PR reviewed and merge it to `main`.
5. Create a [GitHub release](https://docs.github.com/en/repositories/releasing-projects-on-github/managing-releases-in-a-repository#creating-a-release):
   - Tag: use the version without a `v` prefix (e.g., `0.0.1`).
   - Release title: use a `v` prefix (e.g., `v0.0.1`).
   - Use the "Generate release notes" button to populate the description and edit as needed.
6. Verify the npm publish workflow (`release.yml`) and the CDN publish workflow (`publish.cdn.yml`) both complete successfully.
7. Update the [Ably Changelog](https://changelog.ably.com/) (via [Headway](https://headwayapp.co/)) with the release notes.

## Release process (manual)

1. Ensure tests pass in CI on `main`.
2. Create a new branch for the release (e.g., `release/0.0.1`).
3. Choose the new version following [Semantic Versioning](https://semver.org/) (M.m.p):
   - Major: breaking changes requiring action from consumers.
   - Minor: new functionality or features.
   - Patch: bug fixes requiring no action from consumers.
4. Add a version commit touching only these three files:
   1. Update the `version` field in `package.json`.
   2. Update the `VERSION` constant in `src/version.ts` to match.
   3. Update `CHANGELOG.md` with customer-affecting changes since the last release.

   No lockfile changes: `pnpm-lock.yaml` does not record the package's own version, and the demo apps depend on the SDK through a `link:` specifier.

5. Open a PR, get it reviewed and merged to `main`.
6. Create a [GitHub release](https://docs.github.com/en/repositories/releasing-projects-on-github/managing-releases-in-a-repository#creating-a-release):
   - Tag: use the version without a `v` prefix (e.g., `0.0.1`).
   - Release title: use a `v` prefix (e.g., `v0.0.1`).
   - Use the "Generate release notes" button to populate the description and edit as needed.
7. Verify the npm publish workflow (`release.yml`) and the CDN publish workflow (`publish.cdn.yml`) both complete successfully.
8. Update the [Ably Changelog](https://changelog.ably.com/) (via [Headway](https://headwayapp.co/)) with the release notes.
