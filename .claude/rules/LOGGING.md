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
| `Info` | Operationally significant but expected — status changes, lifecycle events. |
| `Warn` | Not an error yet, but could cause problems — discontinuities detected, unexpected but recoverable states. |
| `Error` | An operation has failed and cannot be automatically recovered. |
| `Silent` | No logging. |

Levels are hierarchical. Setting the level to `Debug` suppresses `Trace` but shows everything else.

## Logger Initialization and Propagation

Create the logger once at the top-level client, then propagate it down via constructor injection. Use `withContext` to add identifying metadata at each layer:

```ts
// Top level — ChatClient
this._logger = makeLogger(options).withContext({
  chatClientNonce: this._nonce,
});

// Passed to child components
this._rooms = new DefaultRooms(realtime, clientIdResolver, this._logger);

// Child adds its own context
this._logger = logger.withContext({ roomName: name, roomNonce: nonce });

// Grandchild adds feature context
this._logger = logger.withContext({ feature: 'agentState' });
```

Context accumulates — a log call from the agent state feature will include `chatClientNonce`, `roomName`, `roomNonce`, and `feature` automatically. Context provided in individual log calls overrides matching keys from the parent.

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
this._logger.trace('RoomLifecycleManager.attach();');

// Successful completion (debug)
this._logger.debug('RoomLifecycleManager.attach(); room attached successfully');

// With context object
this._logger.debug('RoomLifecycleManager.attach(); attaching room', {
  channelState: channel.state,
});

// Decision/branch (debug)
this._logger.debug('RoomLifecycleManager.attach(); room already attached, no-op');

// Warning
this._logger.warn('RoomLifecycleManager._startMonitoringDiscontinuity(); discontinuity detected', {
  reason: stateChange.reason,
});

// Error
this._logger.error('DefaultSubscriptionManager.getBeforeSubscriptionStart(); listener has not been subscribed');
```

## When to Log at Each Level

### Trace — method entry

Every key public or internal method gets a `trace` at entry. This is the baseline for understanding call flow:

```ts
this._logger.trace('Presence.get()', { params });
this._logger.trace('Rooms.get();', { roomName: name });
this._logger.trace('MessageStream.appendText();', { serial: this.serial });
```

### Debug — outcomes and decisions

Log after an operation completes, when taking a branch, or when state changes:

```ts
this._logger.debug('Rooms.get(); returning existing room', { roomName: name, nonce: room.nonce });
this._logger.debug('Rooms.release(); room released', { roomName: name, nonce: existingRoom.nonce });
this._logger.debug('Room.finalizer(); already finalized');
```

### Info — lifecycle events

Operationally significant but not unexpected:

```ts
this._logger.info('room status changed', { ...change });
```

### Warn — potential problems

Not yet an error, but something that could cascade:

```ts
this._logger.warn('RoomLifecycleManager._startMonitoringDiscontinuity(); discontinuity detected', {
  reason: stateChange.reason,
});
```

### Error — failed operations

Log immediately before throwing or rejecting:

```ts
this._logger.error('unable to subscribe to presence; presence events are not enabled');
throw new Ably.ErrorInfo(...);
```

```ts
this._logger.error('ChatApi._doRequest(); failed to make request', {
  url, method, statusCode: response.statusCode,
});
```

## Context Objects

Pass structured data as the second argument, not interpolated into the message string:

```ts
// Good — structured context
this._logger.debug('Rooms.release(); releasing room', { roomName: name, nonce: existingRoom.nonce });

// Bad — data in the message string
this._logger.debug(`Rooms.release(); releasing room ${name} with nonce ${existingRoom.nonce}`);
```

Use context for IDs, counts, states, and parameters. Keep context objects shallow.

## What NOT to Log

- **Ably channel instances** — they are large objects that produce unreadable output and can leak internal state. Log the channel name or state instead.
- **Full message payloads** — log serials or IDs, not content.
- **Sensitive data** — API keys, tokens, credentials.
