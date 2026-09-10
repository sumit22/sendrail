// The trailing `/index.js` is required, not cosmetic. `nodemailer/lib/mail-composer`
// is a directory, and while CommonJS resolves that to its index, ESM does not —
// it throws ERR_UNSUPPORTED_DIR_IMPORT. Without the explicit file the ESM build
// of this package fails at runtime for every consumer, and neither a green build
// nor `attw` reports it; only actually importing the published tarball does.
import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import { OutboundEmail } from '../ports/transport';

/**
 * Compose the RFC 5322 message for an outbound email.
 *
 * Building the MIME ourselves — rather than handing the parts to a provider's
 * simple-send API — is what lets the same rendered message go out over SES or
 * SMTP unchanged, and keeps custom headers (the ref header, List-Unsubscribe)
 * under our control rather than the vendor's.
 */
export async function composeMime(message: OutboundEmail): Promise<Buffer> {
  const composer = new MailComposer({
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

  return composer.compile().build();
}
