# Error Handling Pattern

## Design Principles

### Internal vs. surfaced errors

Every error should either be handled internally with a clear recovery strategy, or surfaced to the developer with enough context to act on it. Never swallow errors silently, and never surface errors the developer can't do anything about.

### Internal error handling

- **Isolate handler callbacks**: When the SDK invokes developer-provided callbacks (event listeners, hooks), wrap each in try/catch. One bad handler shouldn't kill internal machinery or prevent other handlers from firing.
- **Define recovery semantics explicitly**: For every internal operation that can fail, decide upfront: retry, degrade, or propagate. Document the choice.
- **Preserve the original error**: When wrapping errors, always attach the original as `cause`. Developers debugging production issues need the full chain.
- **Best-effort operations should be labeled**: If something is fire-and-forget (e.g. cleanup publish on close), comment it as such. Swallowing an error is only acceptable when failure is unrecoverable *and* non-impactful.

### Surfacing errors to developers

- **Typed error taxonomy**: Give errors a `code` field with a finite set of string values developers can `switch` on. Keep the set small (5-10 codes).
- **Distinguish fatal from recoverable**: Make it obvious which errors mean "this instance is broken, create a new one" vs. "this operation failed, try again." Use separate channels (thrown vs. emitted) or a flag — be consistent.
- **Use the right delivery mechanism**:
  - Synchronous method, caller can handle it → throw
  - Async method, caller is awaiting → reject the promise
  - Background failure, no active caller → event emitter (`on('error', ...)`)
  - Per-operation optional notification → callback option (`onError`)
- **Never use more than one mechanism for the same error**: If you emit it, don't also throw it.

### API design

- **Fail fast on invalid input**: Validate at the public API boundary and throw immediately with a clear message.
- **Make the default safe**: If a developer forgets to add an error handler, the SDK should do something reasonable — not silently drop data.
- **Errors at system boundaries, trust internally**: Validate data from the network, user input, and developer-provided callbacks. Don't validate internal state transitions — that's what tests are for.
- **Document error conditions on every public method**: In the type signature where possible, in JSDoc `@throws` where not.

### Common mistakes to avoid

- Wrapping errors that lose context (throwing `new Error("failed")` when you had a good original error).
- Catching too broadly (try/catch around 50 lines where you can't distinguish failure modes).
- Async errors vanishing (unawaited promise rejections in constructors/callbacks).
- Overloading error events (using the same `on('error')` for both auth failures and parse errors without distinguishable codes).
- Retry without backoff or limits (an SDK retrying forever on a 401 is a bug, not resilience).

## Error Type

Use `Ably.ErrorInfo` from the `ably` JS SDK as the sole error type. Do not define a custom error class.

```ts
import * as Ably from 'ably';
```

Constructor signature:

```ts
new Ably.ErrorInfo(message: string, code: number, statusCode: number, cause?: Ably.ErrorInfo)
```

## Error Codes

Define an `ErrorCode` enum in a dedicated `errors.ts` file. Each value is a numeric code.

Existing Ably error codes are defined below:

!`curl -sf https://raw.githubusercontent.com/ably/ably-common/refs/heads/main/protocol/errors.json`

Codes should either exist here or be a custom code in the `104xxx` range. Custom codes in the `104xxx` range are reserved for error cases specific to this SDK. Use reasonable logical groupings — don't create a separate code for every possible failure; group related errors under a shared code when they share the same recovery action. Only introduce a new code if it is of genuine value to distinguish it from an existing code.

**StatusCode derivation**: For codes in the 10000–59999 range, the HTTP statusCode is the first 3 digits (e.g., `40003` → `400`, `104000` → `104` — but for custom `104xxx` codes, use the most appropriate HTTP status code manually, since the 3-digit prefix is not a valid HTTP status). Always pass the correct statusCode as the third argument.

```ts
export enum ErrorCode {
  BadRequest = 40000,
  InvalidArgument = 40003,
  // Custom SDK-specific codes (104xxx range)
  TransportSendFailed = 104000,
  TransportSubscriptionError = 104001,
  // ...
}
```

## Error Message Format

Always lowercase. Pattern: `"unable to <operation>; <reason>"`.

```ts
// Correct
throw new Ably.ErrorInfo('unable to send message; room is not attached', ErrorCode.RoomInInvalidState, 400);
throw new Ably.ErrorInfo('unable to detach room; room is in failed state', ErrorCode.RoomInInvalidState, 400);

// Wrong — do not use these prefixes
"cannot send message"
"failed to send message"
"Could not send message"
```

Dynamic context is allowed in the message:

```ts
throw new Ably.ErrorInfo(
  `unable to create room; invalid room configuration: ${reason}`,
  ErrorCode.InvalidArgument,
  400,
);
```

## Wrapping Errors with Cause

When catching an underlying error and re-throwing, pass the original as the fourth `cause` argument:

```ts
try {
  await channel.attach();
} catch (error) {
  const errInfo = error as Ably.ErrorInfo;
  throw new Ably.ErrorInfo(
    `unable to attach room; ${errInfo.message}`,
    errInfo.code,
    errInfo.statusCode,
    errInfo, // cause
  );
}
```

This preserves the error chain for debugging. You can propagate the original code/statusCode (as above) or assign a new code depending on context.

## Throwing Errors

Throw `Ably.ErrorInfo` directly — do not wrap in `Error`:

```ts
throw new Ably.ErrorInfo('unable to end stream; stream has already ended', ErrorCode.InvalidArgument, 400);
```

For rejected promises where the type system requires `Error`, cast:

```ts
reject(
  new Ably.ErrorInfo(
    'unable to query messages; attachSerial is not defined',
    ErrorCode.ChannelSerialNotDefined,
    500,
  ) as unknown as Error,
);
```

## Testing Errors

Use the custom Vitest matchers in a test helper (`test/helper/expectations.ts`):

| Matcher | Usage |
|---|---|
| `toBeErrorInfo({ code?, statusCode?, message?, cause? })` | Assert a value is an `Ably.ErrorInfo` matching the given fields |
| `toThrowErrorInfo({ code?, statusCode?, message? })` | Assert a sync function throws a matching `Ably.ErrorInfo` |
| `toBeErrorInfoWithCode(code)` | Shorthand — assert value is `Ably.ErrorInfo` with a specific code |
| `toThrowErrorInfoWithCode(code)` | Shorthand — assert sync function throws with a specific code |
| `toBeErrorInfoWithCauseCode(code)` | Assert value is `Ably.ErrorInfo` whose `.cause.code` matches |

The matchers only check the fields you provide — omitted fields are not compared. The `cause` field is checked recursively.
