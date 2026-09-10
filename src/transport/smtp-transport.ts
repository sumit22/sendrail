import { createTransport, Transporter } from 'nodemailer';
import { EmailTransportError } from '../domain/errors';
import { EmailTransport, OutboundEmail, SendResult } from '../ports/transport';

export interface SmtpTransportOptions {
  host: string;
  port: number;
  user?: string;
  pass?: string;
  /** Defaults to implicit TLS on port 465, STARTTLS elsewhere. */
  secure?: boolean;
  /**
   * Builds the underlying transporter. Defaults to nodemailer's; overridden in
   * tests so the field mapping can be asserted without opening a socket.
   */
  createTransport?: (options: SmtpTransportOptions) => Transporter;
}

/**
 * Plain SMTP, for local development against a catcher (Mailpit/MailHog) and as
 * an escape hatch for hosts that relay through their own MTA.
 *
 * Not the production path. SMTP gives no provider message id we can correlate
 * feedback against — the RFC Message-ID here is ours, not SES's, and never
 * appears on a feedback event. Delivery-log rows sent this way can only be
 * matched by recipient.
 */
export class SmtpEmailTransport implements EmailTransport {
  readonly name = 'smtp';

  private readonly transporter: Transporter;

  constructor(options: SmtpTransportOptions) {
    this.transporter = (options.createTransport ?? defaultCreateTransport)(options);
  }

  async send(message: OutboundEmail): Promise<SendResult> {
    try {
      const info = await this.transporter.sendMail({
        from: message.from.name
          ? { name: message.from.name, address: message.from.email }
          : message.from.email,
        to: message.to,
        cc: message.cc,
        bcc: message.bcc,
        replyTo: message.replyTo,
        subject: message.subject,
        html: message.html,
        text: message.text,
        headers: message.headers,
      });

      return { providerMessageId: info.messageId };
    } catch (error) {
      throw new EmailTransportError(
        `SMTP rejected the message: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }
}

function defaultCreateTransport(options: SmtpTransportOptions): Transporter {
  return createTransport({
    host: options.host,
    port: options.port,
    secure: options.secure ?? options.port === 465,
    auth: options.user && options.pass ? { user: options.user, pass: options.pass } : undefined,
  });
}
