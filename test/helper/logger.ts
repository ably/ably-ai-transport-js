/** Shared loggers for unit tests. */

import { type Logger, LogLevel, makeLogger } from '../../src/logger.js';

/** A logger that emits nothing — the default for unit tests. */
export const silentLogger = makeLogger({ logLevel: LogLevel.Silent });

/**
 * A logger that records the messages it is asked to log at `level` and above.
 * @param level - The lowest level it records.
 * @returns The logger, and the messages it recorded, in order.
 */
export const recordingLogger = (level: LogLevel): { logger: Logger; messages: string[] } => {
  const messages: string[] = [];
  const logger = makeLogger({
    logLevel: level,
    logHandler: (message: string) => {
      messages.push(message);
    },
  });
  return { logger, messages };
};
