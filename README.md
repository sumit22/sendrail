# sendrail

Email deliverability on your own AWS SES account: sending, delivery feedback,
suppression and reputation. No third-party ESP.

## Why this exists

Using SendGrid, Postmark or Resend means renting someone else's sending
reputation and paying per message for the privilege. Sending on SES directly is
cheaper and gives you your own domain reputation — but it hands you the work the
ESP was doing: you now have to know when an address bounced, stop mailing it,
and be able to prove what you sent.

That work is what this package is. Take the three moving parts away and SES is
just an SMTP endpoint that will eventually get your account suspended.

## What it costs

The pitch for SES is arithmetic. Sending is billed per message with no plan,
no seat count and no feature tiers:

| Monthly volume | Amazon SES | SendGrid (list plan) | Difference |
| --- | --- | --- | --- |
| 10,000 | ~$1 | ~$20 | ~$19/mo |
| 50,000 | ~$5 | ~$20 | ~$15/mo |
| 100,000 | ~$10 | ~$35 | ~$25/mo |
| 500,000 | ~$50 | ~$250 | ~$200/mo |
| 1,000,000 | ~$100 | ~$450 | ~$350/mo |

SES is **$0.10 per 1,000 messages**, plus $0.12/GB for attachment data and an
optional ~$25/month if you take a dedicated IP. SendGrid is plan-based, so you
pay for the tier you fit into rather than what you send, and features like
dedicated IPs, extra teammates and longer log retention sit on higher tiers.

> **Verify before quoting these.** Both vendors change pricing, and SendGrid's
> plan boundaries move. The figures above are approximate list prices intended
> to show the *shape* of the difference — per-message versus per-plan — not to
> be a quote.

### Be honest about where this matters

**Below roughly 50,000 messages a month, the saving is not the reason to do
this.** Twenty dollars a month is less than an hour of engineering time. If
someone tells you a small team should move to SES to save $19/month, they are
selling you a project that costs more than it saves.

The saving becomes real at volume, because it is the *shape* that differs: SES
scales linearly at a rate that stays flat, while plan pricing steps upward and
each step tends to bundle capabilities you did not ask for. At a million
messages a month you are keeping ~$4,000 a year, and it keeps scaling.

### What actually helps a small company

Three things, roughly in order of how much they matter:

1. **You own the reputation, not a vendor.** Domain reputation earned on
   `mail.example.com` is an asset that belongs to you. Leave an ESP and you
   leave it behind; the next provider starts you cold. This is the argument that
   holds at every volume, including small.

2. **No pricing cliff between you and your users.** Plan-based billing means an
   unusually good month can push you into a tier renegotiation. Per-message
   billing simply costs slightly more that month, so growth never forces a
   procurement conversation.

3. **The cost is proportional at the bottom.** A pre-revenue product sending
   2,000 messages a month pays about twenty cents. Most plan-based providers
   have a floor, and free tiers come with sending limits and branding that get
   awkward exactly when you start to matter.

### The cost that is not on the bill

SES gives you an API and nothing else. Everything an ESP was quietly doing —
knowing an address bounced, refusing to mail it again, proving what you sent,
watching whether AWS is about to throttle you — becomes yours. Built badly, that
work costs far more than the subscription it replaced: a suppression list that
does not work gets your account put under enforcement, and enforcement costs
revenue, not dollars.

**That work is what this package is**, which is the only reason the arithmetic
above is worth acting on. Budget the setup honestly anyway: a dedicated
subdomain, DNS authentication, a production-access request with a 24–48 hour
lead time, and a two-week warm-up ramp before full volume. See
[`docs/aws-setup.md`](docs/aws-setup.md).

## What this is not

Not a SendGrid clone. These omissions are deliberate rather than unfinished:

- **No HTTP API** beyond two optional, mountable Express routers.
- **No dashboard or UI.** The admin router returns JSON; render it yourself.
- **No multi-tenancy.** One sending account, one suppression list.
- **No template engine.** You hand it rendered HTML.
- **No queue, scheduler or retry loop.** A send returns its outcome; the caller
  decides what to do about it.

## Install

```bash
npm install sendrail
```

`nodemailer` and `html-to-text` come with it. Everything else is an **optional
peer dependency** you install only if you use it:

| Entry point | What it holds | Optional peers |
| --- | --- | --- |
| `sendrail` | domain, ports, validation, the send path, the feedback loop, retention pruning, in-memory stores, SMTP + logging transports | — |
| `sendrail/ses` | SES transport, SES account health, the SES/SNS feedback parser and signature verifier | `@aws-sdk/client-ses`, `@aws-sdk/client-sesv2` |
| `sendrail/nest` | `EmailModule` for NestJS | `@nestjs/common` |
| `sendrail/express` | mountable feedback + admin routers | `express` |
| `sendrail/testing` | executable store contracts | `vitest` |

The core pulls **neither AWS nor NestJS nor Express**. An SMTP-only consumer
resolves `nodemailer` and `html-to-text` and nothing else, and a NestJS host on
SMTP never installs the AWS SDK — `EmailModule` reaches SES through a lazy
import taken only when `transport.kind === 'ses'`. CI asserts all of this
against a real install of the packed tarball, because a green build does not
catch an eagerly-hoisted `require`.

## What it does

**Outbound** — `EmailSender` runs two gates before a message reaches the
provider, both there to protect sending reputation rather than the recipient:

1. **Hard address validation** — RFC syntax, a known-disposable domain list, and
   a real mail host (MX, with the RFC 5321 §5.1 fallback to A). A malformed or
   tampered address never reaches SES, so it never becomes a bounce. The DNS
   check **fails open**: a resolver hiccup must not silently drop legitimate
   mail.
2. **Suppression** — an address SES has already told us is dead or hostile.
   Retrying it damages reputation, and a bad enough rate puts the whole account
   under enforcement.

Both refusals are recorded as `SUPPRESSED` rows rather than dropped silently —
"we chose not to send this" is an answer operators need, and a gap in the log is
not one. A provider failure is recorded as `FAILED` and **returned, not
thrown**: the caller decides whether to retry, and the reason is durably written
down first.

**Inbound** — `POST /webhooks/notifications/:provider` → adapter → processor:

```
SES ──▶ SNS topic ──▶ your webhook ──▶ SesFeedbackParser ──▶ EmailFeedbackProcessor
                                        (vendor-shaped)        (vendor-free)
                                                                    │
                                            ┌───────────────────────┼──────────────────┐
                                            ▼                       ▼                  ▼
                                       suppression            reputation          delivery log
```

The parser proves authenticity and normalises the payload. The processor decides
what a bounce _does_. Nothing downstream of the parser knows SES exists.

**Oversight** — `SesManagementService` reads account health (production access,
enforcement status, quota headroom, bounce/complaint rates against AWS's 5% /
0.1% thresholds) and per-identity DKIM status, so a silently-broken DKIM
surfaces before deliverability visibly tanks.

## SES-first, not provider-neutral

This package sends on Amazon SES. The seams for a second provider are real and
load-bearing — `EmailFeedbackParser` + `EmailFeedbackParserRegistry` for
inbound, `EmailTransport` for outbound, already carrying three implementations —
and adding one costs a parser class, a transport class and a registration, with
nothing in the domain changing.

But every adapter shipped here is SES, and `SesManagementService` has no
provider-neutral equivalent at all: account health is an SES concept. So the
package claims **SES-first with room to grow**, and does not claim neutrality.
If you need Postmark or Mailgun today, this is not that package.

### Roadmap

Provider-agnostic configuration — "bring SES or Azure, configure, send" — is the
direction. The transport and feedback seams are ready for it: Azure
Communication Services Email maps cleanly onto both, and its Event Grid
`SubscriptionValidation` handshake plays the same role as SNS's
`SubscriptionConfirmation`.

The piece that is **not** ready is account health. `SesAccountHealth` is shaped
around AWS's sandbox, enforcement status and reputation thresholds, and has no
equivalent elsewhere. Generalising it means either an optional
`AccountHealthProvider` port that most providers do not implement, or accepting
that the admin `overview` endpoint returns `null` off SES — which is already
what it does on any non-SES transport.

## Usage

### Plain TypeScript

Every class is a plain constructor:

```ts
import {
  EmailSender,
  EmailAddressValidator,
  InMemoryDeliveryLogStore,
  InMemoryReputationStore,
  InMemorySuppressionStore,
  LoggingEmailTransport,
} from 'sendrail';

const sender = new EmailSender({
  transport: new LoggingEmailTransport(),
  validator: new EmailAddressValidator({ mxCheckEnabled: true }),
  suppression: new InMemorySuppressionStore(),
  deliveryLog: new InMemoryDeliveryLogStore(),
  reputation: new InMemoryReputationStore(),
  defaultFrom: { email: 'noreply@example.com', name: 'Example' },
});

const outcome = await sender.send({ to: 'someone@example.com', subject: 'Hi', html: '<p>Hello</p>' });
```

To send over SES, build the transport from the `ses` entry point:

```ts
import { createSesTransport } from 'sendrail/ses';

const transport = createSesTransport({
  kind: 'ses',
  region: 'ap-south-1',
  configurationSetName: 'example-delivery',
});
```

### Express

```ts
import express from 'express';
import { EmailFeedbackParserRegistry, EmailFeedbackProcessor } from 'sendrail';
import { createAdminRouter, createFeedbackRouter } from 'sendrail/express';

const app = express();

// MUST come before any global express.json().
app.use('/webhooks/notifications', createFeedbackRouter({ registry, processor }));

app.use(express.json());

app.use('/admin/email', createAdminRouter({
  stores,
  ses,
  authorize: requireAdmin,   // required — this surface exposes recipient data
}));
```

**The raw body is not optional.** Signature verification runs over the literal
bytes the provider signed, and `JSON.stringify(JSON.parse(body))` is not
byte-identical to them. Worse, SNS posts JSON under
`Content-Type: text/plain; charset=UTF-8`, which `express.json()`'s default
matcher **skips entirely** — leaving neither `body` nor `rawBody`, so every
genuine bounce 401s while the endpoint looks healthy and the suppression list
quietly stays empty.

`createFeedbackRouter` therefore installs its own parser with `type: () => true`:
mounting the router is what makes it correct. If a global `express.json()` got
there first, it answers 500 rather than pretending to verify.

`createAdminRouter`'s `authorize` is a **required** option. The surface exposes
recipient-level delivery records and can suppress or release any address; a
forgotten guard should be a type error, not a silent hole.

### NestJS

```ts
EmailModule.forRootAsync({
  imports: [ConfigModule, MyStoresModule],
  inject: [ConfigService, MyDeliveryLogStore, MyReputationStore, MySuppressionStore],
  useFactory: (config, deliveryLog, reputation, suppression) => ({
    transport: {
      kind: 'ses',
      region: config.get('AWS_REGION'),
      configurationSetName: config.get('SES_CONFIGURATION_SET'),
    },
    from: { email: 'noreply@example.com', name: 'Example' },
    stores: { deliveryLog, reputation, suppression },
    validation: { mxCheckEnabled: true },
    feedback: {
      snsSignatureVerification: true,
      allowedTopicArns: [config.get('SES_FEEDBACK_TOPIC_ARN')],
    },
  }),
});
```

Then inject `EMAIL_SENDER`, `EMAIL_FEEDBACK_REGISTRY`, `EMAIL_FEEDBACK_PROCESSOR`,
`EMAIL_DELIVERY_LOG_PRUNER` or `SES_MANAGEMENT_SERVICE`.

The module deliberately provides **no controllers**. Webhook and admin routes
need the host's own auth decorators and route conventions, so the host owns them
and injects what it needs — that is what keeps the package usable in an app
whose guards look nothing like anyone else's. For the webhook, call
`handleFeedbackWebhook` from a controller of your own; `examples/nestjs` shows
it in about twenty lines, including the raw-body capture NestJS needs.

## Using this with an AI assistant

[`docs/ai-prompts.md`](docs/ai-prompts.md) has copy-paste prompts for Claude,
Copilot, Cursor and friends: a context block carrying every invariant, plus task
prompts for Express and NestJS integration, implementing the three stores,
migrating off another provider, provisioning AWS, and verifying the feedback
loop.

They exist because this package's hard parts fail *silently*. An agent working
from the type signatures alone will mount the webhook behind `express.json()`,
implement `increment` as read-modify-write, and omit the configuration set —
all of which compile, pass review, and surface weeks later as reputation
damage. Each prompt carries the constraint that prevents its own failure.

## Examples

Two runnable apps, both on the logging transport and in-memory stores, so they
start with no AWS account and no database:

```bash
pnpm --filter sendrail-example-express build && pnpm --filter sendrail-example-express start
pnpm --filter sendrail-example-nestjs  build && pnpm --filter sendrail-example-nestjs  start
```

## Storage is yours

The package assumes no ORM, no schema, not even a database. It defines three
ports and ships in-memory implementations:

| Port | Holds | Lifetime |
| --- | --- | --- |
| `SuppressionStore` | Addresses we must not mail | Permanent |
| `DeliveryLogStore` | One row per send attempt | Pruned (7d default) |
| `ReputationStore` | Per-address sent/delivered/bounced/complained | Never pruned |

**[`docs/schema.sql`](docs/schema.sql) is the reference PostgreSQL schema** —
the three tables, the indexes their access patterns need, and the two rules
below written as actual SQL.

Two constraints an adapter must honour:

- **`ReputationStore.increment` must be a single atomic upsert**
  (`INSERT … ON CONFLICT DO UPDATE`). Sends and feedback webhooks race on the
  same row; an ORM's find-then-write `upsert` loses increments. It must also
  swallow its own errors — a lost counter must not break a send.
- **`markRecipientFeedback` / `markByProviderMessageId` must only touch rows
  still in `SENT`.** A row already resolved must not be rewritten by later
  feedback for the same address — that is a different message, and
  recipient-scoped correlation cannot tell them apart.

`InMemory*Store` is for tests and for a host that has not decided where the
tables live yet. Everything is lost on restart, and a suppression list that
forgets is worse than useless — wire real stores before sending real mail.

### Testing your adapter

Those clauses are exactly the kind a plausible-looking implementation gets wrong
silently. `sendrail/testing` exports the contract as an executable suite:

```ts
import { describeSuppressionStoreContract } from 'sendrail/testing';

describeSuppressionStoreContract('PostgresSuppressionStore', async () => {
  await db.query('TRUNCATE email_suppressions');
  return new PostgresSuppressionStore(db);
});
```

The factory runs before each test and must return an empty store. There are
equivalents for the other two ports. Requires `vitest`.

## AWS setup

**Full guide: [`docs/aws-setup.md`](docs/aws-setup.md)** — AWS CLI and profile
setup, the exact IAM policy the app needs, production access per region, the
mandatory DNS records, From/Reply-To, environment variables, the bring-up order,
the warm-up ramp, troubleshooting, and a copy-paste production-access request.

The three things that matter most, because each fails quietly:

1. **Production access is a support ticket with a 24–48 hour lead time, per
   region.** Every new SES account starts in a sandbox that can only send to
   verified addresses. Request it early — correct DNS is what gets the request
   approved, not what avoids needing it.

2. **Send from a dedicated subdomain, never the apex.** Reputation attaches to
   the domain that DKIM-signs the message. Signing with your apex puts every
   bounce and spam complaint on the domain that also serves your app and your
   staff mailboxes, and that damage is far harder to recover from than
   abandoning a subdomain. Sign with `mail.example.com`, put the custom MAIL
   FROM at `bounce.mail.example.com` so SPF aligns under DMARC, and keep the
   apex out of envelope headers entirely.

3. **Event publishing is configured on the configuration set.** A send that
   omits `configurationSetName` produces no feedback at all — the suppression
   list stays empty while reputation degrades. This is the single most commonly
   missed step.

SNS opens with a `SubscriptionConfirmation` handshake. Auto-confirmation
requires `allowedTopicArns` to match: the signature is verified first, so
authenticity is not the question — the allowlist answers *which* topic, so a
validly-signed confirmation from a stranger's topic cannot subscribe you to a
feed they control. Unset leaves the subscription pending for an operator, which
is the safe default.

## What is deliberately dropped

- **Soft bounces** (`bounceType !== 'Permanent'`). SES retries these itself;
  suppressing on them cuts off recipients whose mailbox was briefly full.
- **`DeliveryDelay`** and other informational events.

Transient outcomes are not representable in `EmailFeedbackType` at all, so a new
adapter cannot accidentally start suppressing on them.

## Sending over SMTP

`SmtpEmailTransport` exists for local development against a mail catcher
(Mailpit/MailHog) and for hosts relaying through their own MTA. It is not the
production path: SMTP returns no provider message id that feedback can be
correlated against — the RFC Message-ID is yours, not SES's, and never appears
on a feedback event. Rows sent that way can only be matched by recipient.

## Testing

```bash
pnpm test        # with coverage gates
pnpm test:fast   # without
```

`test` enforces coverage thresholds (90% statements / lines / functions, 85%
branches) so the gate is real rather than decorative.

The two pre-send gates, the SNS signature check and the feedback normalisation
are the parts worth reading first: a regression in any of them is silent, and
shows up as reputation damage weeks later rather than a failed request.

## Licence

MIT
