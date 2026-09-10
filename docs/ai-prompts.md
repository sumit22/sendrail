# Prompts for AI coding assistants

Copy-paste prompts for integrating sendrail with Claude, Copilot, Cursor or any
other coding agent.

## Why these exist

sendrail's hard parts fail **silently**. An agent working from the type
signatures alone will write code that compiles, passes review, and is wrong in
ways that surface weeks later as reputation damage:

- it will mount the feedback router after `express.json()`, and every real
  bounce will 401 while the endpoint looks healthy;
- it will implement `ReputationStore.increment` as read-modify-write, and lose
  counts under the race between sends and webhooks;
- it will write feedback updates without `WHERE status = 'sent'`, and one bounce
  will rewrite a recipient's whole delivery history;
- it will omit `configurationSetName`, and no feedback will ever arrive at all;
- it will import from the package root and drag the AWS SDK into an SMTP-only
  service.

Each prompt below carries the constraint that prevents its own failure. That is
the point of them — not saving typing.

---

## Paste this first: the context block

Give your agent this before any task prompt. It is the whole set of invariants
in one block.

```
I'm integrating the `sendrail` npm package (email deliverability on AWS SES:
sending, bounce/complaint feedback, suppression, reputation).

Non-negotiable constraints — violating any of these produces a bug that is
invisible in testing and only shows up in production:

1. ENTRY POINTS. Import framework-free code from `sendrail`. SES-specific code
   is `sendrail/ses`, NestJS is `sendrail/nest`, Express routers are
   `sendrail/express`, store contract tests are `sendrail/testing`. Never import
   SES code into a service that does not send via SES — it pulls two AWS SDK
   packages.

2. RAW BODY. SNS signature verification runs over the exact bytes received.
   `JSON.stringify(JSON.parse(body))` is NOT byte-identical and will fail
   verification. Additionally, SNS posts JSON with `Content-Type: text/plain`,
   which `express.json()` skips entirely, leaving neither body nor rawBody.
   Use `createFeedbackRouter` from `sendrail/express` (it installs its own
   parser with `type: () => true`) and mount it BEFORE any global
   `express.json()`. Never re-serialise the parsed body as a fallback.

3. STORE CONTRACTS. If implementing DeliveryLogStore, ReputationStore or
   SuppressionStore:
   - `ReputationStore.increment` MUST be a single atomic upsert
     (`INSERT ... ON CONFLICT ... DO UPDATE SET col = table.col + 1`). Never
     read-modify-write, and never an ORM `upsert` that does find-then-write.
   - `markRecipientFeedback` and `markByProviderMessageId` MUST filter
     `WHERE status = 'sent'`. A row already resolved must never be rewritten.
   - Suppression lookups MUST be case-insensitive; providers lowercase
     addresses in feedback but stored addresses may not be.
   - Store writes are best-effort: swallow errors, never break a send.

4. SES CONFIGURATION SET. Always set `configurationSetName`. Event publishing to
   SNS is configured on the configuration set, so omitting it means zero
   feedback arrives and the suppression list stays silently empty.

5. FAIL CLOSED. Feedback parsers return false rather than throwing when they
   cannot authenticate. Never treat "verification disabled" as "authorized".

6. RESPONSE CODES. The feedback webhook returns 200 for any authenticated,
   well-formed request INCLUDING handshakes and ignored soft bounces. Providers
   disable endpoints that return errors. Only 404 (unknown provider), 401
   (failed authenticity) and 400 (authenticated but malformed) are non-200.

7. ADMIN ROUTER AUTH. `createAdminRouter` requires an `authorize` middleware. It
   exposes recipient-level records and can suppress any address. Never pass a
   no-op outside a local demo.

Read node_modules/sendrail/README.md and node_modules/sendrail/docs/ before
writing code.
```

---

## Task: integrate into an Express app

```
Integrate sendrail into this Express application.

1. Install: `npm install sendrail` plus `@aws-sdk/client-ses @aws-sdk/client-sesv2`
   (optional peers, needed only because we send via SES).

2. Create a composition module that builds, once at startup:
   - the three stores (see the separate store task — use the in-memory ones from
     `sendrail` as a placeholder if the real ones do not exist yet)
   - `createSesTransport({ kind: 'ses', region, configurationSetName })` from
     `sendrail/ses`
   - `EmailAddressValidator` with `mxCheckEnabled: true` in production, false in
     tests
   - `EmailSender` wired with all of the above and a `defaultFrom` on the
     DKIM-signed sending subdomain
   - `EmailFeedbackParserRegistry` containing a `SesFeedbackParser` with
     `snsSignatureVerification: true` and `allowedTopicArns` populated from
     config (one ARN per SES region, split from a comma-separated env var)
   - `EmailFeedbackProcessor`
   - `DeliveryLogPruner`, invoked from a daily job

3. Mount the routers in THIS ORDER — the order is the point:

   app.use('/webhooks/notifications', createFeedbackRouter({ registry, processor }));
   app.use(express.json());
   app.use('/admin/email', createAdminRouter({ stores, ses, authorize: <our auth middleware> }));

   The feedback router must come before the global JSON parser. Do not add any
   body parser in front of it.

4. Use our existing logger by passing an object with log/warn/error — sendrail's
   EmailLogger is structurally compatible, no adapter needed.

Do not add a retry loop. `sender.send()` returns an outcome including FAILED and
the error; the caller decides.
```

---

## Task: integrate into a NestJS app

```
Integrate sendrail into this NestJS application.

1. Register `EmailModule.forRootAsync` from `sendrail/nest`, injecting our
   ConfigService and our three store providers. Set `transport.kind: 'ses'` with
   region and configurationSetName, `validation.mxCheckEnabled: true`, and
   `feedback.snsSignatureVerification: true` with `allowedTopicArns` split from
   a comma-separated env var.

2. Do NOT install @aws-sdk packages unless we actually send via SES. EmailModule
   loads SES lazily, only when transport.kind === 'ses'.

3. The package ships no controllers by design. Write our own:
   - a webhook controller at POST /webhooks/notifications/:provider that builds
     a FeedbackRequest and delegates to `handleFeedbackWebhook` from `sendrail`,
     returning its statusCode and body verbatim. Mark it public — providers sign
     payloads, they do not carry a JWT — and exempt it from rate limiting.
   - an admin controller behind our existing admin role guard, reading the
     stores injected via EMAIL_DELIVERY_LOG_STORE, EMAIL_REPUTATION_STORE,
     EMAIL_SUPPRESSION_STORE and SES_MANAGEMENT_SERVICE.

4. CRITICAL — in main.ts, capture the raw body for the webhook path BEFORE the
   general parser, because NestJS does not do this for you:

   const app = await NestFactory.create(AppModule, { bodyParser: false });
   app.use('/webhooks/notifications', json({
     limit: '1mb',
     type: () => true,                       // SNS posts text/plain; without this you get no body at all
     verify: (req, _res, buf) => { req.rawBody = buf; },
   }));
   app.use(json());

   The controller must read `req.rawBody`, not `req.body`.

Inject tokens from `sendrail/nest`: EMAIL_SENDER, EMAIL_FEEDBACK_REGISTRY,
EMAIL_FEEDBACK_PROCESSOR, EMAIL_DELIVERY_LOG_PRUNER, SES_MANAGEMENT_SERVICE.
```

---

## Task: implement the three stores

```
Implement sendrail's three storage ports against <Postgres / Prisma / Drizzle /
our ORM>.

Start from node_modules/sendrail/docs/schema.sql — it has the tables, the
indexes each access pattern needs, and the two correctness rules as literal SQL.
Match those indexes; the queries assume them.

Implement DeliveryLogStore, ReputationStore and SuppressionStore from
node_modules/sendrail/dist/index.d.ts.

Four rules that a plausible-looking implementation gets wrong, and each of which
fails silently in production:

1. `ReputationStore.increment` MUST be ONE atomic statement:
   INSERT ... ON CONFLICT (email) DO UPDATE SET bounce_count = email_reputation.bounce_count + 1
   Sends and feedback webhooks race on the same row. A find-then-write upsert —
   including Prisma's `upsert` and Drizzle's equivalent — loses increments and
   understates a bad address. Use a raw statement if the ORM cannot express it.

2. `markRecipientFeedback` and `markByProviderMessageId` MUST include
   `WHERE status = 'sent'` and return the number of rows affected. Without the
   predicate, later feedback for the same address rewrites already-resolved
   rows for different messages.

3. Suppression matching MUST be case-insensitive both on write and on read.
   Store lowercased and lowercase the lookup.

4. `increment` and log writes MUST swallow their own errors. A bookkeeping
   failure must never turn a successful send into a failure.

Then verify with the shipped contract suite rather than hand-written tests:

  import { describeSuppressionStoreContract, describeDeliveryLogStoreContract,
           describeReputationStoreContract } from 'sendrail/testing';

  describeReputationStoreContract('PostgresReputationStore', async () => {
    await db.query('TRUNCATE email_reputation');
    return new PostgresReputationStore(db);
  });

The factory must return an EMPTY store and runs before each test. All three
suites must pass — the concurrency test in particular is what catches rule 1.
```

---

## Task: migrate an existing nodemailer or ESP integration

```
Migrate this codebase from <nodemailer directly / SendGrid / Postmark / Resend>
to sendrail on SES.

1. Find every send site and route them all through a single `EmailSender`
   instance. Do not leave a second path that bypasses suppression — one
   unguarded send site defeats the entire suppression list.

2. Replace the provider client with `createSesTransport` from `sendrail/ses`.
   Keep an SMTP transport for local development against Mailpit/MailHog via
   `createEmailTransport({ kind: 'smtp', ... })`.

3. Templates are the caller's job. sendrail takes rendered `html` (and optional
   `text`); if `text` is omitted it derives one from the HTML. Keep our existing
   template layer and pass its output in.

4. Set `notificationClass` on every send to the template or event name. It is
   what lets an operator see WHICH mail is bouncing rather than only that mail
   is.

5. Import any existing suppression list from the old provider into
   SuppressionStore before the first send, and pull SES's own account-level
   suppression list too. Starting empty means re-mailing addresses that already
   bounced, on a brand-new domain, which is the fastest route to enforcement.

6. `sender.send()` returns an outcome and does not throw on provider failure.
   Replace try/catch around sends with a check on `outcome.status`.
```

---

## Task: provision the AWS side

```
Provision AWS for sendrail, following node_modules/sendrail/docs/aws-setup.md.
Produce <Terraform / CDK / an aws-cli script> for:

- an SES email identity on a DEDICATED SUBDOMAIN (mail.<apex>), never the apex,
  with 2048-bit Easy DKIM
- a custom MAIL FROM at bounce-<region>.mail.<apex> — it must be per region,
  because it needs an MX to feedback-smtp.<region>.amazonses.com and a DNS name
  holds only one MX record set
- DNS: three DKIM CNAMEs per region, the MAIL FROM MX and SPF TXT, SPF on the
  sending domain, DMARC at p=none on both the sending subdomain and the apex
- a configuration set with SNS event publishing for Bounce, Complaint and
  Delivery, reputation metrics enabled and TLS required
- an SNS topic per region with an access policy allowing SES to publish
- an IAM policy for the application role granting ses:SendEmail on BOTH the
  identity ARN AND the configuration-set ARN (granting only the identity fails
  every send with AccessDenied), plus ses:GetAccount, ses:GetSendStatistics,
  ses:ListEmailIdentities on "*" and ses:GetEmailIdentity on the identity

Do NOT create the SNS HTTPS subscription in the same apply as everything else.
The application auto-confirms a subscription only for a topic ARN it already
trusts, so it must be deployed with the ARN configured first; otherwise the
subscription sits in PendingConfirmation and silently discards every event.

Do not add MX or SPF records to the apex.

Production access, opt-in region enablement and the DMARC tightening schedule
have no API — leave them out and note them as manual steps.
```

---

## Task: verify the feedback loop actually works

```
Verify sendrail's SES feedback loop end to end in <environment>.

Send to each SES simulator address and assert the resulting state, using the
admin endpoints (GET /admin/email/logs and /admin/email/suppressions):

  success@simulator.amazonses.com   -> delivery event; log row flips to 'delivered'
  bounce@simulator.amazonses.com    -> bounce event; address SUPPRESSED; row 'bounced'
  complaint@simulator.amazonses.com -> complaint event; address SUPPRESSED; row 'complained'

If the bounce address is not on the suppression list afterwards, the loop is
broken — stop and diagnose before any real sending. A silent feedback loop is
worse than not sending at all, because reputation degrades invisibly.

Diagnose in this order:
  - subscription stuck PendingConfirmation -> the app did not have that region's
    ARN in allowedTopicArns when the subscription was created
  - webhook 401 -> signature failed, or the topic is not in the allowlist
  - webhook 404 -> wrong provider slug; the path must end /ses
  - webhook 500 "raw body unavailable" -> a body parser ran before the router
  - sends succeed but nothing ever arrives -> configurationSetName is unset
```

---

## A note on what not to ask for

Do not ask an agent to add a queue, a retry loop, a template engine, a
dashboard, or multi-tenancy "since we're here". Those are deliberate omissions,
documented in the README under **What this is not**, and an agent will happily
build all of them into your application layer where they belong — but they do
not belong in a fork of this package.
