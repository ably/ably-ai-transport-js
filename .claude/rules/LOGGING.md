# Logging Pattern

## Logger Interface

The SDK defines a `Logger` interface with five log levels plus a `withContext` method for creating child loggers with persistent context:

```ts
interface Logger {
  trace(message: string, context?: LogContext): void;
  debug(message: string, context?: LogContext): void;
  info(message: string, context?: LogContext): void;
  warn(message: string, context?: LogContext): void;
  error(message: string, context?: LogContext): void;
  withContext(context: LogContext): Logger;
}

type LogContext = Record<string, any>;
```

## Log Levels

| Level    | When to use                                                                                                            |
| -------- | ---------------------------------------------------------------------------------------------------------------------- |
| `Trace`  | Routine operations — entry point of every key method. The most verbose level.                                          |
| `Debug`  | Useful for debugging but superfluous in normal operation — successful completions, state transitions, decision points. |
| `Info`   | Operationally significant but expected — session open/close, lifecycle events.                                         |
| `Warn`   | Not an error yet, but could cause problems — unexpected but recoverable states.                                        |
| `Error`  | An operation has failed and cannot be automatically recovered.                                                         |
| `Silent` | No logging.                                                                                                            |

Levels are hierarchical. Setting the level to `Debug` suppresses `Trace` but shows everything else.

## Logger Initialization and Propagation

Create the logger once at the top-level session, then propagate it down via constructor injection. Use `withContext` to add identifying metadata at each layer:

```ts
// Top level — a transport always resolves a logger, defaulting to Silent
this._logger = (options.logger ?? makeLogger({ logLevel: LogLevel.Silent })).withContext({
  component: 'ClientTransport',
});

// Passed to child components
this._runManager = new DefaultRunManager(channel, this._logger);

// Child adds its own context
this._logger = logger?.withContext({ component: 'RunManager' });

// The agent transport does the same — a top-level transport never takes an
// optional logger. Only sub-components take `logger?` and pass it down.
const logger = (options.logger ?? makeLogger({ logLevel: LogLevel.Silent })).withContext({
  component: 'AgentTransport',
});
```

Context accumulates — a log call from RunManager will include the parent's context plus `component: 'RunManager'` automatically. Context provided in individual log calls overrides matching keys from the parent.

## Custom Log Handler

The logger delegates to a `LogHandler` function. A default `consoleLogger` is provided, but users can supply their own:

```ts
type LogHandler = (message: string, level: LogLevel, context?: LogContext) => void;
```

`src/core/transport/run-manager.ts` is the reference implementation to copy
from; the examples below are deliberately generic so they cannot drift against
a rename.

The default console logger formats as:

```
[2026-03-19T12:00:00.000Z] DEBUG ably-ai-transport: <message>, context: {"key":"value"}
```

## Message Format

Log messages follow the pattern `ClassName.methodName(); <description>`:

```ts
// Method entry (trace)
this._logger.trace('DefaultFoo.bar();');

// Successful completion (debug)
this._logger.debug('DefaultFoo.doThing(); thing done', { thingId });

// With context object
this._logger.debug('DefaultFoo.bar(); promoting serial', { msgId, serial });

// Decision/branch (debug)
this._logger.debug('DefaultFoo.bar(); taking the resume path', { runId, reason });

// Warning
this._logger.warn('DefaultFoo.bar(); unexpected message action', {
  action,
  serial: message.serial,
});

// Error
this._logger.error('DefaultFoo(); subscribe failed');
```

## When to Log at Each Level

- **Trace** — at the entry of every key public or internal method. The
  baseline for understanding call flow.
- **Debug** — after an operation completes, when taking a branch, or when state
  changes.
- **Info** — operationally significant but expected lifecycle events
  (session open/close).
- **Warn** — not yet an error, but something that could cascade.
- **Error** — immediately before throwing or rejecting, and when a
  developer-provided callback throws (e.g. `callback threw`, with the error in
  context).

## Context Objects

Pass structured data as the second argument, not interpolated into the message string:

```ts
// Good — structured context
this._logger.debug('DefaultRunManager.endRun(); run ended', { runId, reason });

// Bad — data in the message string
this._logger.debug(`DefaultRunManager.endRun(); run ${runId} ended with reason ${reason}`);
```

Use context for IDs, counts, states, and parameters. Keep context objects shallow.

## What NOT to Log

- **Ably channel instances** — they are large objects that produce unreadable output and can leak internal state. Log the channel name or state instead.
- **Full message payloads** — log serials or IDs, not content.
- **Sensitive data** — API keys, tokens, credentials.
