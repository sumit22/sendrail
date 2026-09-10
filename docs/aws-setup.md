# AWS SES setup and prerequisites

The operational half of sending your own mail: the domain strategy, the DNS
records, the production-access request that gates everything, and the bring-up
order.

sendrail is the application half. None of what follows is specific to this
package — it is what SES requires of anyone — but skipping any of it produces
failures that are **quiet rather than loud**: mail is accepted, then filtered,
and you find out weeks later from a reputation graph.

Read §1 and §4 before you create anything. §4 has a 24–48 hour lead time and
everything else waits on it. §2 and §3 are the local prerequisites — AWS CLI,
profiles, and the IAM policy the application actually needs.

---

## 1. Send from a dedicated subdomain, never the apex

**This is the decision that is expensive to reverse.**

Sender reputation attaches to the domain that DKIM-signs the message. Signing
with your apex puts the reputation earned by every message — and every bounce
and spam complaint it collects — on the same domain that serves your
application, your marketing site, and any staff mailboxes.

The failure mode is not hypothetical. One import of stale addresses, one bad
batch, and receivers start filtering *the apex*. At that point the damage is not
confined to email: reputation systems are domain-scoped, and recovering an apex
is far harder than abandoning a subdomain.

With a dedicated subdomain the blast radius is your outbound mail alone. If
`mail.example.com` is ever burned you rebuild on `mail2.example.com` and the
apex is untouched.

| Domain | Purpose |
| --- | --- |
| `example.com` | App, marketing site, staff mail. **Sends nothing.** |
| `mail.example.com` | The SES identity. DKIM-signs all outbound mail. |
| `bounce.mail.example.com` | Custom MAIL FROM — where bounce returns go. |

The bounce domain sits **under** the sending domain rather than under the apex,
so SPF aligns under DMARC relaxed alignment and the apex never appears in an
envelope header either.

> **Do not add MX or SPF records to your apex to make email work.** The apex MX
> belongs to staff mail (Google Workspace or similar) if that exists. Pointing
> it at SES breaks inbound staff mail, and SES does not need it — bounce returns
> go to the custom MAIL FROM domain.

### From and Reply-To addresses

| Header | Use | Why |
| --- | --- | --- |
| `From` | `noreply@mail.example.com` | Must be **on the DKIM-signed sending domain**, or DMARC alignment fails. This is the address whose domain earns your reputation. |
| `Reply-To` | `support@example.com` | A **real, monitored mailbox**, and it may be on the apex — Reply-To is not DKIM-aligned and does not affect deliverability. |
| Envelope / MAIL FROM | `bounce.mail.example.com` | Set as the custom MAIL FROM on the identity. SES uses it for bounce returns and it is what SPF is checked against. |

Two things worth doing even though nothing enforces them:

- **Set a Reply-To that a human reads.** A `From` of `noreply@` with no working
  reply path trains recipients to hit "spam" instead of replying, and a
  complaint costs far more than an unwanted reply. sendrail passes `replyTo`
  straight through on every send.
- **Set `List-Unsubscribe`** on anything that is not strictly transactional.
  Gmail and Yahoo require one-click unsubscribe for bulk senders, and its
  absence is itself a filtering signal. sendrail passes arbitrary `headers`
  through, so this is a per-send header, not a package feature.

### Separating streams

Transactional and marketing mail earn different complaint rates, and one should
not be able to stop the other. Order confirmations must keep arriving even if a
promotional batch collects complaints.

Start with one identity. When promotional volume becomes material, add a second
sending domain — `news.example.com` with its own configuration set — rather
than raising the complaint rate on the domain carrying your critical mail.
Enable per-configuration-set reputation metrics from the start so the two
streams stay distinguishable later.

---

## 2. Local setup — AWS CLI, profiles and credentials

sendrail never reads credentials itself. It constructs an SES client and lets
the **AWS SDK default provider chain** resolve them, which means anything that
works for `aws` on the command line works for the app.

### Install and verify the CLI

```bash
aws --version          # v2 required; v1 is end-of-life
aws sts get-caller-identity --profile <profile>
```

`get-caller-identity` is the check worth running first: it proves the profile
resolves, the credentials are valid, and tells you **which** account you are
about to change. Most SES setup mistakes are really "wrong account" or "wrong
region" mistakes.

### Named profiles

Keep one profile per account and never put credentials in the app's own config.
`~/.aws/config`:

```ini
[profile example-dev]
region = ap-south-1
output = json

[profile example-prod]
region = ap-south-1
output = json
# Prefer SSO or role assumption over long-lived keys:
sso_session   = example
sso_account_id = 111122223333
sso_role_name  = PowerUserAccess

[sso-session example]
sso_start_url = https://example.awsapps.com/start
sso_region    = ap-south-1
```

```bash
aws sso login --profile example-prod
```

If you must use static keys, they belong in `~/.aws/credentials`, never in a
`.env` that a deploy might copy into an image.

**The region matters more than usual here.** SES identities, configuration sets,
SNS topics and production access are all *per region*, so a command run against
the wrong one silently reports an unconfigured account rather than an error.
Pass `--region` explicitly in anything you write down.

### How the app picks credentials

The SDK's default chain, in order: environment variables → `AWS_PROFILE` from
the shared config → container/instance role. So:

| Where | What to use |
| --- | --- |
| Local development | `AWS_PROFILE=example-dev`, via `aws sso login`. |
| CI | OIDC role assumption. No stored keys. |
| Production (EC2/ECS/EKS/Lambda) | **An instance, task or execution role.** Never static keys — the chain picks the role up with no configuration at all. |

---

## 3. IAM permissions

Two distinct principals need permissions, and they are not the same set.

### The application role

Exactly what sendrail calls, and nothing more. Substitute your account, region,
sending domain and configuration set:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "SendOnTheSendingIdentity",
      "Effect": "Allow",
      "Action": "ses:SendEmail",
      "Resource": [
        "arn:aws:ses:ap-south-1:111122223333:identity/mail.example.com",
        "arn:aws:ses:ap-south-1:111122223333:configuration-set/example-production"
      ]
    },
    {
      "Sid": "ReadAccountHealthForTheAdminConsole",
      "Effect": "Allow",
      "Action": [
        "ses:GetAccount",
        "ses:GetSendStatistics",
        "ses:ListEmailIdentities"
      ],
      "Resource": "*"
    },
    {
      "Sid": "ReadIdentityDkimStatus",
      "Effect": "Allow",
      "Action": "ses:GetEmailIdentity",
      "Resource": "arn:aws:ses:ap-south-1:111122223333:identity/mail.example.com"
    }
  ]
}
```

Notes that save a debugging session:

- **`ses:SendEmail` needs BOTH the identity and the configuration-set ARN.**
  Granting only the identity fails every send with `AccessDenied` the moment
  `configurationSetName` is set — and it always should be, or no feedback is
  published. This is the single commonest IAM mistake here.
- **SESv2 IAM actions still use the `ses:` prefix**, not `sesv2:`. There is no
  `sesv2:` namespace.
- **The account-health reads are account-scoped** and cannot be narrowed;
  `GetAccount`, `GetSendStatistics` and `ListEmailIdentities` take `"*"`. Omit
  this whole statement if you do not mount the admin router — sending does not
  need it, and `GET /admin/email/overview` simply degrades.
- **`ses:GetSendStatistics` is the SES v1 action.** SESv2 exposes no
  account-level bounce and complaint rates at all, which is why the package
  needs both SDK clients.
- **No SNS permission is required.** Confirming an SNS subscription is a plain
  HTTPS GET of the `SubscribeURL`; it is not a signed AWS API call. The app
  needs no `sns:*` at all.
- **Multi-region:** add the identity and configuration-set ARNs for every region
  you send from. An ARN missing here fails every send in that region while the
  others look healthy.

### The operator / Terraform principal

Setting SES up needs far more than running it does — creating identities,
configuration sets, SNS topics, DNS, and reading account state. Use a separate
admin profile for that, and do not extend the application role to cover it. The
application role should never be able to create an identity or delete a topic.

---

## 4. Production access — do this first

**Every new SES account starts in the sandbox**, which means:

- you can only send **to** verified addresses — real recipients get nothing
- 200 messages per 24 hours, 1 message per second

**The sandbox is per region.** A grant in `ap-south-1` does nothing for
`eu-west-1`; each region is a separate ticket, separately reviewed.

No amount of correct DNS gets you out of it. Correct DNS is what gets the
request **approved**.

### Where it goes — there is no "to" address

Production access is not an email. It is raised one of three ways:

| Route | Where |
| --- | --- |
| **Console (recommended)** | SES console → **Account dashboard** → **Request production access** |
| Support case | Support Center → Create case → *Service limit increase* → Service: **SES** |
| API | `aws sesv2 put-account-details --production-access-enabled …` |

Use the console route: it pre-fills the account and region, which removes the
commonest cause of a wasted round-trip.

Expect **24–48 hours**, sometimes longer, and expect to be refused and asked for
detail if the answers are thin.

Check your current state before filing:

```bash
aws sesv2 get-account --region <region> \
  --query '{prod:ProductionAccessEnabled,quota:SendQuota}'
```

### What AWS actually asks

| Their question | What a good answer looks like |
| --- | --- |
| Mail type | Transactional, or Marketing. Answer honestly; the review differs. |
| Website URL | A live site that plainly relates to the mail you describe. |
| What you send | Concrete message types — confirmations, password resets, OTP codes, receipts. Not "notifications". |
| How you got the recipients | The address was supplied by the recipient during sign-up or checkout. Say explicitly that no lists were purchased or scraped. |
| How you handle bounces and complaints | **This is the one that decides the request.** |
| How recipients unsubscribe | Per-user preferences in the app; an unsubscribe link on anything promotional. |

**The bounce/complaint answer decides it**, and it is the question sendrail
exists to let you answer well. Something like:

> SES → SNS → an application webhook with signature verification. Hard bounces
> and complaints suppress the address automatically and permanently, and
> suppressed addresses are refused before the next send rather than retried.
> Per-address bounce and complaint counters and a per-send delivery log are
> retained for operator review.

The point being made is that handling is **automatic**, not a promise to watch a
dashboard. Say so explicitly.

**Ask for the quota you need, not the maximum.** An inflated request from an
account with no sending history invites scrutiny.

### Multiple regions

Send from a region close to your recipients — but file **one region first** and
let it be granted before filing the others. Three simultaneous requests from an
account with no sending history reads worse than one, a refusal is recorded
against you, and once the first region has real bounce and complaint figures
those become the strongest thing later requests can cite.

**Opt-in regions** (`me-central-1`, `ap-east-1`, and others) must be enabled at
the account level before you can configure anything there — the endpoint does
not even resolve until then, and enablement propagates for up to 24 hours:

```bash
aws account enable-region --region-name <region>
aws account get-region-opt-status --region-name <region>   # must be ENABLED, not ENABLING
```

Per-region gotchas that catch people out:

- **DKIM is per region.** Each region issues its own three tokens at distinct
  names, so nine CNAMEs coexist under one sending domain across three regions.
  That is expected, not a duplication bug. Each region verifies independently —
  one succeeding tells you nothing about the others.
- **Custom MAIL FROM must be per region.** It needs an MX pointing at
  `feedback-smtp.<region>.amazonses.com`, and a DNS name holds only one MX
  record set. One shared `bounce.mail.example.com` across regions means all but
  one silently lose SPF alignment. Use `bounce-<region>.mail.example.com`.
- **SPF is not per region.** `include:amazonses.com` already covers every
  region, and a per-region include burns lookups against SPF's hard limit of
  ten for nothing.
- **SNS topics are regional**, which is why sendrail's `allowedTopicArns` is a
  list. A region missing from it has its bounces silently discarded.

### While still in the sandbox

Verify your own address as a recipient (SES console → Identities → Create
identity → Email address) and test against that. The application behaves
identically; only the recipient set is restricted.

---

## 5. The DNS records

All of these are mandatory. Publish them on the **sending subdomain**, not the
apex.

| Type | Name | Value | Why |
| --- | --- | --- | --- |
| CNAME ×3 | `<token>._domainkey.mail.example.com` | `<token>.dkim.amazonses.com` | **DKIM.** Three per region. Mail is unsigned until these resolve. |
| MX | `bounce.mail.example.com` | `10 feedback-smtp.<region>.amazonses.com` | **Custom MAIL FROM.** Bounce returns. |
| TXT | `bounce.mail.example.com` | `"v=spf1 include:amazonses.com ~all"` | **SPF** for the envelope domain. |
| TXT | `mail.example.com` | `"v=spf1 include:amazonses.com ~all"` | SPF for the sending domain. |
| TXT | `_dmarc.mail.example.com` | `"v=DMARC1; p=none; rua=mailto:dmarc@example.com"` | **DMARC.** Start at `p=none`; see §8. |
| TXT | `_dmarc.example.com` | `"v=DMARC1; p=none; rua=mailto:dmarc@example.com"` | Apex DMARC, monitoring only — anti-spoofing for a domain that sends nothing. |

Verify DKIM before sending anything. Usually minutes; allow up to 72 hours:

```bash
aws sesv2 get-email-identity --email-identity mail.example.com --region <region> \
  --query 'DkimAttributes.Status'    # must be SUCCESS
```

Once your app is running, `GET /admin/email/identities` on sendrail's admin
router reports the same thing for every identity, with a `healthy` flag.

---

## 6. Bringing it up, in order

The ordering constraint is not obvious: sendrail auto-confirms an SNS
subscription **only for a topic ARN it has been configured to trust**. Create
the subscription before the app knows the ARN and it sits in
`PendingConfirmation`, silently discarding every event.

1. **Create the identity, publish DNS, create the SNS topic.** No subscription
   yet.

2. **Create a configuration set** with event publishing to that topic for
   `Bounce`, `Complaint` and `Delivery`. Enable reputation metrics and require
   TLS.

   This is the step most easily missed. Event publishing is configured **on the
   configuration set**, so a send that omits `ConfigurationSetName` produces no
   feedback at all — the suppression list stays empty while reputation degrades.

3. **Wait for DKIM `SUCCESS`** in every enabled region.

4. **Configure and deploy the application**, with the topic ARNs in place:

   ```ts
   EmailModule.forRoot({
     transport: {
       kind: 'ses',
       region: 'ap-south-1',
       configurationSetName: 'example-production',
     },
     from: { email: 'noreply@mail.example.com', name: 'Example' },
     stores,
     validation: { mxCheckEnabled: true },
     feedback: {
       snsSignatureVerification: true,
       // One ARN per enabled region. sendrail trusts precisely this set and
       // refuses events from anything else, so a region missing here has its
       // bounces silently discarded and its subscription never confirms.
       allowedTopicArns: [
         'arn:aws:sns:ap-south-1:111122223333:email-feedback',
         'arn:aws:sns:eu-west-1:111122223333:email-feedback',
       ],
     },
   });
   ```

   The app must be **live with these ARNs set** before step 5.

5. **Create the HTTPS subscription** pointing at your webhook
   (`https://example.com/webhooks/notifications/ses`). sendrail confirms it
   automatically. Verify it is a real ARN, not `PendingConfirmation`:

   ```bash
   aws sns list-subscriptions-by-topic --topic-arn <arn>
   ```

6. **Prove the loop closes** with the SES simulator addresses. They exercise the
   real path without touching a real mailbox or costing reputation:

   | Address | Expect |
   | --- | --- |
   | `success@simulator.amazonses.com` | Delivery event; log row flips to `delivered` |
   | `bounce@simulator.amazonses.com` | Bounce event; address suppressed; row `bounced` |
   | `complaint@simulator.amazonses.com` | Complaint event; address suppressed; row `complained` |

   Check `GET /admin/email/logs` and `GET /admin/email/suppressions`.

   **If the bounce address is not suppressed afterwards, the feedback loop is
   not working.** Stop and fix it before real sending. A silent feedback loop is
   worse than no sending, because reputation degrades invisibly.

### Environment variables

**sendrail reads no environment variables.** It takes options; the host maps its
own configuration onto them. That is deliberate — a library that reads `process.env`
cannot be configured twice in one process, and the cold-outreach and transactional
rails in the original application differed only by configuration set.

A conventional mapping, and where each value comes from:

| Variable | Example | Maps to | Source |
| --- | --- | --- | --- |
| `AWS_REGION` | `ap-south-1` | `transport.region` | The region whose identity you verified. |
| `AWS_PROFILE` | `example-prod` | — (SDK chain) | Local only. **Unset in production**, where an instance or task role is used. |
| `MAIL_TRANSPORT` | `ses` \| `smtp` \| `logging` | `transport.kind` | `logging` in tests, `smtp` against a local mail catcher. |
| `MAIL_FROM_EMAIL` | `noreply@mail.example.com` | `from.email` | Must be on the DKIM-signed sending domain (§1). |
| `MAIL_FROM_NAME` | `Example` | `from.name` | The display name in the inbox. |
| `MAIL_REPLY_TO` | `support@example.com` | per-send `replyTo` | A monitored mailbox (§1). |
| `SES_CONFIGURATION_SET` | `example-production` | `transport.configurationSetName` | **Without this there is no feedback at all.** |
| `SES_FEEDBACK_TOPIC_ARNS` | `arn:…:t1,arn:…:t2` | `feedback.allowedTopicArns` | Comma-separated, **one per region**. Split it before passing. |
| `SES_WEBHOOK_SECRET` | — | `feedback.webhookSecret` | Optional fallback for environments with signature checking off. Leave unset in production. |

```ts
feedback: {
  snsSignatureVerification: true,
  allowedTopicArns: (process.env.SES_FEEDBACK_TOPIC_ARNS ?? '')
    .split(',')
    .map((arn) => arn.trim())
    .filter(Boolean),
},
```

Splitting and filtering matters: a trailing comma produces an empty entry, and an
empty string in the allowlist would match an envelope with no `TopicArn` at all.
sendrail filters blanks defensively for exactly this reason, but do not rely on it.

---

## 7. Warming up

A new sending domain has no history, and receivers treat unknown domains
suspiciously. Sending 50,000 messages on day one from a domain that has never
sent is the fastest way to get filtered.

Ramp over roughly two weeks, watching bounce and complaint rates at each step
rather than moving by the calendar:

| Days | Ceiling |
| --- | --- |
| 1–2 | ~50/day, to engaged recipients |
| 3–5 | ~500/day |
| 6–10 | ~5,000/day |
| 11–14 | ~20,000/day |

Transactional mail to people who just took an action is ideal warm-up traffic:
recipients expect it and open it. **Do not backfill historical notifications
into the ramp.**

If bounce rate exceeds 2% or complaint rate 0.05% at any step, stop and find the
cause before continuing.

---

## 8. Staying deliverable

**AWS's thresholds**, reported by `GET /admin/email/overview`:

| Metric | Review | Likely suspension |
| --- | --- | --- |
| Bounce rate | 5% | 10% |
| Complaint rate | 0.1% | 0.5% |

Treat **2% bounce / 0.05% complaint** as your internal alarm. By the time AWS's
threshold trips, the damage is already done.

**Tighten DMARC in stages.** Start at `p=none`, read the aggregate reports, and
move only once they show every legitimate source aligned: `p=none` →
`p=quarantine` → `p=reject`. Skipping to `reject` before the reports are clean
bins your own mail, and the symptom — people not receiving messages — looks like
an application bug.

**Watch for a silently broken DKIM.** Anything other than `SUCCESS` means
receivers are seeing unsigned mail. This is the failure that hurts most, because
nothing errors: mail is accepted, then quietly filtered.
`GET /admin/email/identities` flags it.

**Retention.** The delivery log is pruned (7 days by default); per-address
reputation counters are never pruned, so "how often has this address bounced"
survives long after the individual rows are gone.

---

## 9. Migrating a service that already sends from its apex

Moving to a subdomain is a migration, not a rename, and it costs something: the
new subdomain starts with no reputation and has to be warmed up again. The
apex's accumulated sending history does not transfer.

Pay it anyway. The apex is one bad batch away from permanent damage, and the
cost only grows with volume — the cheapest time to move is always now.

Stage it so mail never stops:

1. **Verify the new identity alongside the old one.** Both can be verified at
   once; nothing changes for existing sends. Publish DKIM, SPF and MAIL FROM for
   `mail.<apex>` as in §5.
2. **Wait for DKIM `SUCCESS`** on the new identity before any traffic moves.
3. **Move low-stakes traffic first** — digests, internal notifications, anything
   whose delayed delivery is survivable. Leave password resets and OTP on the
   warm apex identity.
4. **Ramp per §7**, watching the new subdomain's own rates. Per-configuration-set
   reputation metrics are what keep the two streams separable during the overlap.
5. **Move the rest** once the subdomain has a fortnight of clean sending at
   target volume.
6. **Keep the apex identity verified but idle** for a few weeks. A rollback path
   costs nothing; re-verification under pressure is miserable.
7. **Stop sending from the apex, then publish apex DMARC** at `p=none` and
   tighten as in §8. Once nothing legitimate sends as the apex, a strict policy
   there is pure anti-spoofing benefit.

Do not skip to step 7 and change the From address in one deploy. Mail signed by
a brand-new domain, at full production volume, with no warm-up, is the exact
profile spam filters are built to catch.

---

## 10. Troubleshooting

| Symptom | Cause |
| --- | --- |
| Sends succeed, no feedback ever arrives | `configurationSetName` unset or wrong. Event publishing lives on the configuration set. |
| Subscription stuck `PendingConfirmation` | The app did not have that region's ARN in `allowedTopicArns` when the subscription was created. Fix, deploy, then delete and recreate the subscription. |
| Feedback arrives for one region, not others | A missing ARN in `allowedTopicArns`. sendrail rejects unknown topics by design, so events are dropped and the suppression list merely looks quiet. |
| Webhook returns 401 | Signature verification failed, or the topic is not in the allowlist. sendrail rejects validly-signed events from unexpected topics by design — a stranger's SNS topic must not be able to suppress your addresses. |
| Webhook returns 404 | Wrong provider slug. The path ends `/ses`. |
| Webhook returns 500 "raw body unavailable" | A global body parser consumed the request before the router. Mount `createFeedbackRouter` **before** `express.json()`. |
| Every bounce 401s in production, nothing in dev | SNS posts JSON as `Content-Type: text/plain`, which `express.json()` skips entirely. Use sendrail's Express router, or a parser with `type: () => true`. |
| `AccessDenied` on send | The IAM policy needs **both** the identity and configuration-set ARNs; omitting either fails every send. |
| Mail lands in spam, DKIM `SUCCESS` | Check DMARC alignment (`dig TXT _dmarc.mail.example.com`) and that MAIL FROM resolves. Then check content: image-heavy, link-heavy mail from a cold domain filters regardless of authentication. |
| `MessageRejected: Email address is not verified` | Still in the sandbox — see §4. |

---

## 11. Appendix — copy-paste production access request

Fill the bracketed values and paste. Production access is granted **per account
and per region**, so name both; a request that omits them is one round-trip away
from being asked.

**Subject** (support-case route only — the console form has no subject field):

```
Production access request — transactional email, mail.example.com (account 111122223333, ap-south-1)
```

**Form fields:**

| Field | Value |
| --- | --- |
| Affected account | `111122223333` |
| Region | `ap-south-1` |
| Mail type | Transactional |
| Website URL | `https://example.com` |
| Requested quota | `[the volume you actually need, e.g. 2,500/day, 5/second]` |

**Use case description** — paste from here down:

```
We send transactional email only: [account verification, password resets,
one-time passcodes, order confirmations and receipts]. Every message is
triggered by an action the recipient just took in our application. We send no
marketing or promotional mail from this identity.

Recipients: every address is supplied by the recipient themselves during
sign-up or checkout. We do not purchase, rent or scrape lists, and we do not
import addresses from third parties.

Sending identity: mail.example.com, a dedicated subdomain used only for
application mail. DKIM is verified (2048-bit Easy DKIM), SPF and DMARC are
published, and a custom MAIL FROM is configured at bounce.mail.example.com so
SPF aligns under DMARC.

Bounce and complaint handling is automated, not manual. A configuration set
publishes Bounce, Complaint and Delivery events to an SNS topic, which posts to
an application webhook. The webhook verifies the SNS signature cryptographically
and rejects events from any topic other than our own. Hard bounces and
complaints add the address to a suppression list immediately and permanently,
and every subsequent send checks that list before the message reaches SES, so a
suppressed address is never retried. Soft bounces are deliberately not
suppressed, since SES retries them itself. We retain per-address bounce and
complaint counters and a per-send delivery log for operator review, and monitor
our bounce and complaint rates against the 5% and 0.1% review thresholds.

Unsubscribe: this mail is transactional and service-critical, so it has no bulk
unsubscribe. Recipients control optional notifications from their account
settings, and any promotional mail we send in future will carry a
List-Unsubscribe header and its own sending identity and configuration set.
```

The bounce-handling paragraph is the one the reviewer weighs. It is specific,
and it describes a mechanism rather than an intention — that is the difference
between a grant and a request for more detail.

Two things not to do: do not write "urgent" or "please expedite" (it changes
nothing and reads poorly), and do not ask for the maximum quota when you need a
small one.
