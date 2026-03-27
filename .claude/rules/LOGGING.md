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

| Level | When to use |
|---|---|
| `Trace` | Routine operations — entry point of every key method. The most verbose level. |
| `Debug` | Useful for debugging but superfluous in normal operation — successful completions, state transitions, decision points. |
| `Info` | Operationally significant but expected — transport open/close, lifecycle events. |
| `Warn` | Not an error yet, but could cause problems — unexpected but recoverable states. |
| `Error` | An operation has failed and cannot be automatically recovered. |
| `Silent` | No logging. |

Levels are hierarchical. Setting the level to `Debug` suppresses `Trace` but shows everything else.

## Logger Initialization and Propagation

Create the logger once at the top-level transport, then propagate it down via constructor injection. Use `withContext` to add identifying metadata at each layer:

```ts
// Top level — ClientTransport
this._logger = (options.logger ?? makeLogger({ logLevel: LogLevel.Silent })).withContext({
  component: 'ClientTransport',
});

// Passed to child components
this._turnManager = new DefaultTurnManager(channel, this._logger);

// Child adds its own context
this._logger = logger?.withContext({ component: 'TurnManager' });

// Server transport — optional logger
this._logger = options.logger?.withContext({ component: 'ServerTransport' });
```

Context accumulates — a log call from TurnManager will include the parent's context plus `component: 'TurnManager'` automatically. Context provided in individual log calls overrides matching keys from the parent.

## Custom Log Handler

The logger delegates to a `LogHandler` function. A default `consoleLogger` is provided, but users can supply their own:

```ts
type LogHandler = (message: string, level: LogLevel, context?: LogContext) => void;
```

The default console logger formats as:

```
[2026-03-19T12:00:00.000Z] DEBUG ably-ai-transport: <message>, context: {"key":"value"}
```

## Message Format

Log messages follow the pattern `ClassName.methodName(); <description>`:

```ts
// Method entry (trace)
this._logger.trace('ClientTransport.send();');

// Successful completion (debug)
this._logger.debug('DefaultTurnManager.startTurn(); turn started', { turnId });

// With context object
this._logger.debug('Tree.upsert(); promoting serial', { msgId, serial });

// Decision/branch (debug)
this._logger.debug('Tree.upsert(); inserting new node', { msgId, parentId, forkOf });

// Warning
this._logger.warn('DefaultDecoderCore.decode(); unexpected message action', {
  action, serial: message.serial,
});

// Error
this._logger.error('DefaultServerTransport(); subscribe failed');
```

## When to Log at Each Level

### Trace — method entry

Every key public or internal method gets a `trace` at entry. This is the baseline for understanding call flow:

```ts
this._logger.trace('ClientTransport.send();');
this._logger.trace('ClientTransport.regenerate();', { messageId });
this._logger.trace('DefaultEncoderCore.publishDiscrete();', { name: payload.name });
this._logger.trace('DefaultDecoderCore.decode();', { action, serial: message.serial, name: message.name });
```

### Debug — outcomes and decisions

Log after an operation completes, when taking a branch, or when state changes:

```ts
this._logger.debug('DefaultTurnManager.startTurn(); turn started', { turnId });
this._logger.debug('DefaultTurnManager.endTurn(); turn ended', { turnId, reason });
this._logger.debug('StreamRouter.closeStream(); closing stream', { turnId });
this._logger.debug('Tree.select();', { msgId, index });
```

### Info — lifecycle events

Operationally significant but not unexpected:

```ts
this._logger.info('ClientTransport.close();');
```

### Warn — potential problems

Not yet an error, but something that could cascade:

```ts
this._logger.warn('DefaultDecoderCore.decode(); unrecognized message name', {
  name: message.name, serial: message.serial,
});
```

### Error — failed operations

Log immediately before throwing or rejecting. Also use when a developer-provided callback throws:

```ts
this._logger.error('DefaultServerTransport(); subscribe failed');
```

```ts
this._logger?.error('DefaultDecoderCore._invokeOnStreamUpdate(); callback threw', { error });
```

## Context Objects

Pass structured data as the second argument, not interpolated into the message string:

```ts
// Good — structured context
this._logger.debug('DefaultTurnManager.endTurn(); turn ended', { turnId, reason });

// Bad — data in the message string
this._logger.debug(`DefaultTurnManager.endTurn(); turn ${turnId} ended with reason ${reason}`);
```

Use context for IDs, counts, states, and parameters. Keep context objects shallow.

## What NOT to Log

- **Ably channel instances** — they are large objects that produce unreadable output and can leak internal state. Log the channel name or state instead.
- **Full message payloads** — log serials or IDs, not content.
- **Sensitive data** — API keys, tokens, credentials.
