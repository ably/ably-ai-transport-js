# Contributing

## How to contribute

1. Fork it
2. Create your feature branch (`git checkout -b my-new-feature`)
3. Commit your changes (`git commit -am 'Add some feature'`)
4. Ensure you have added suitable tests and the test suite is passing (`npm test`)
5. Push the branch (`git push origin my-new-feature`)
6. Create a new Pull Request

## Running the test suite

To run the unit tests:

```shell
npm test
```

To run the integration tests (requires an `ABLY_API_KEY` environment variable):

```shell
npm run test:integration
```

## Building

```shell
npm run build          # Build all entry points
npm run build:core     # Build core entry point only
npm run build:react    # Build react entry point only
npm run build:vercel   # Build vercel entry point only
npm run build:vercel-react  # Build vercel/react entry point only
```

The build uses Vite library mode producing ESM + UMD/CJS bundles with `.d.ts` declarations and sourcemaps in `dist/`.

## Formatting and linting

This repository uses Prettier and ESLint for formatting and linting respectively. The rules are enforced in CI, so please make sure you run the checks before pushing your code:

```shell
npm run format:check   # Check for formatting errors
npm run lint           # Check for linting errors
npm run lint:fix       # Check for linting errors and fix
npm run typecheck      # Type check
npm run precommit      # Run all checks (format, lint, typecheck)
```

## Release process

1. Ensure tests pass in CI on `main`.
2. Create a new branch for the release (e.g., `release/0.0.1`).
3. Choose the new version following [Semantic Versioning](https://semver.org/) (M.m.p):
   - Major: breaking changes requiring action from consumers.
   - Minor: new functionality or features.
   - Patch: bug fixes requiring no action from consumers.
4. Add a version commit with the following changes:
   1. Update the `version` field in `package.json`.
   2. Run `npm install` at the repo root to update `package-lock.json`.
   3. Delete `node_modules` in each app under `demo/` and run `npm install` there to pick up the new version.
   4. Update `CHANGELOG.md` with customer-affecting changes since the last release.
5. Open a PR, get it reviewed and merged to `main`.
6. Create a [GitHub release](https://docs.github.com/en/repositories/releasing-projects-on-github/managing-releases-in-a-repository#creating-a-release):
   - Tag: use the version without a `v` prefix (e.g., `0.0.1`).
   - Release title: use a `v` prefix (e.g., `v0.0.1`).
   - Use the "Generate release notes" button to populate the description and edit as needed.
7. Verify the npm publish workflow (`release.yml`) completes successfully.
8. Update the [Ably Changelog](https://changelog.ably.com/) (via [Headway](https://headwayapp.co/)) with the release notes.
