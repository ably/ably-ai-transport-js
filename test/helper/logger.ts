/** Shared silent logger for unit tests. */

import { LogLevel, makeLogger } from '../../src/logger.js';

/** A logger that emits nothing — the default for unit tests. */
export const silentLogger = makeLogger({ logLevel: LogLevel.Silent });
