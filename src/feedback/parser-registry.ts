import { EmailFeedbackParser } from './parser';

/**
 * Resolves the feedback adapter for a provider slug.
 *
 * Adding SendGrid alongside SES means writing one class and registering it —
 * no change here, in the processor, or in the controller.
 */
export class EmailFeedbackParserRegistry {
  private readonly byCode = new Map<string, EmailFeedbackParser>();

  constructor(parsers: Iterable<EmailFeedbackParser> = []) {
    for (const parser of parsers) {
      this.byCode.set(parser.providerCode.toLowerCase(), parser);
    }
  }

  /**
   * The adapter for this slug, or null when nothing handles it.
   *
   * Null rather than a throw: the caller is a public webhook endpoint, and an
   * unknown slug is untrusted input, not a programming error.
   */
  get(providerCode: string): EmailFeedbackParser | null {
    return this.byCode.get((providerCode ?? '').trim().toLowerCase()) ?? null;
  }

  /** Registered slugs — for diagnostics and the admin email surfaces. */
  registeredCodes(): string[] {
    return [...this.byCode.keys()];
  }
}
