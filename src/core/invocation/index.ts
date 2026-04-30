export type { InvocationConstructor, InvocationData } from './invocation.js';
// Re-export `Invocation` as a value: TypeScript carries the interface type
// through the same name so callers can write both `: Invocation` and
// `Invocation.fromJSON(...)`.
export { Invocation } from './invocation.js';
