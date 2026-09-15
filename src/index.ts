// The package's shared foundations: the utilities, the event emitter, the
// error codes and the logger. The transport and the codec contract are built
// on these and land on top of them.

// Utilities
export type { Stripped } from './utils.js';
export { stripUndefined } from './utils.js';

// Event emitter
export { EventEmitter } from './event-emitter.js';

// Errors
export { ErrorCode, errorInfoIs } from './errors.js';

// Logger
export type { LogContext, Logger, LoggerOptions, LogHandler } from './logger.js';
export { consoleLogger, LogLevel, makeLogger } from './logger.js';
