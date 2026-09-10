/**
 * The slice of a logger this package uses. Structurally compatible with NestJS
 * `Logger`, pino, console and most others, so a host wires its own without an
 * adapter.
 */
export interface EmailLogger {
  log(message: string, context?: unknown): void;
  warn(message: string, context?: unknown): void;
  error(message: string, context?: unknown): void;
}

/** Discards everything. The default when a host wires no logger. */
export const NULL_LOGGER: EmailLogger = {
  log: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};
