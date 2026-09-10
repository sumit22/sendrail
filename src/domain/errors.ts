/**
 * The payload authenticated but is not shaped like anything this provider
 * should be sending. Distinct from a failed authenticity check, which is not an
 * error but a rejection.
 */
export class EmailFeedbackParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EmailFeedbackParseError';
  }
}

/** The mail provider rejected or failed the send. */
export class EmailTransportError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown
  ) {
    super(message);
    this.name = 'EmailTransportError';
  }
}

/**
 * An upstream provider API (e.g. the SES control plane) was unreachable or
 * errored. Surfaced as a 502/503 by callers so read-only consoles degrade
 * gracefully instead of 500ing.
 */
export class ExternalServiceError extends Error {
  constructor(
    readonly service: string,
    message: string,
    readonly cause?: unknown
  ) {
    super(message);
    this.name = 'ExternalServiceError';
  }
}
