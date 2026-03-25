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

## Formatting and linting

This repository uses Prettier and ESLint for formatting and linting respectively. The rules are enforced in CI, so please make sure you run the checks before pushing your code:

```shell
npm run format:check   # Check for formatting errors
npm run lint           # Check for linting errors
npm run lint:fix       # Check for linting errors and fix
npm run typecheck      # Type check
npm run precommit      # Run all checks (format, lint, typecheck)
```
