-- Reference schema for the three sendrail store ports (PostgreSQL).
--
-- sendrail ships no ORM, no migrations and no SQL adapter — a host implements
-- SuppressionStore, DeliveryLogStore and ReputationStore against whatever it
-- already runs. This file exists so "implement this interface" is not a cliff:
-- it is the shape those three interfaces were designed against, including the
-- indexes that make their documented access patterns work.
--
-- Adapt the types freely. The two rules at the bottom are not adaptable.
--
-- To check your implementation against the real contract, run the executable
-- suite in `sendrail/testing` against it.


-- Addresses we must not mail. Permanent — never pruned.
CREATE TABLE email_suppressions (
    id            BIGSERIAL PRIMARY KEY,
    -- Stored lowercased. Provider feedback normalises addresses; lookups must
    -- too, or a bounced address with different casing keeps receiving mail.
    email         VARCHAR(255) NOT NULL UNIQUE,
    -- 'active' | 'bounced' | 'complained'
    status        VARCHAR(32)  NOT NULL DEFAULT 'active',
    -- The provider's diagnostic, kept verbatim for operator triage. Never parsed.
    reason        TEXT,
    suppressed_at TIMESTAMPTZ  NOT NULL,
    created_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- Serves findSuppressedPaginated(), newest suppression first.
CREATE INDEX email_suppressions_status_suppressed_at_idx
    ON email_suppressions (status, suppressed_at DESC);


-- One outbound send attempt, per recipient. Pruned on a retention window.
CREATE TABLE email_delivery_logs (
    id                  BIGSERIAL PRIMARY KEY,
    recipient_email     VARCHAR(255) NOT NULL,
    -- What kind of mail this was — a template name or event key. This is what
    -- lets an operator see which mail is bouncing, not merely that mail is.
    notification_class  VARCHAR(255) NOT NULL,
    template            VARCHAR(255),
    subject             VARCHAR(500),
    -- 'sent' | 'delivered' | 'bounced' | 'complained' | 'failed' | 'suppressed'
    status              VARCHAR(32)  NOT NULL,
    -- The SES message id, when sending over the API. This is the correlation key
    -- the feedback webhook uses to flip exactly this row. Null under SMTP, which
    -- never echoes an id back.
    provider_message_id VARCHAR(255),
    error_message       TEXT,
    -- When terminal feedback landed. Null until it does.
    feedback_at         TIMESTAMPTZ,
    created_at          TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- Serves markRecipientFeedback(), which only ever touches SENT rows.
CREATE INDEX email_delivery_logs_recipient_status_idx
    ON email_delivery_logs (recipient_email, status);
-- Serves markByProviderMessageId(), the precise correlation.
CREATE INDEX email_delivery_logs_provider_message_id_idx
    ON email_delivery_logs (provider_message_id);
-- Serves countByStatusSince().
CREATE INDEX email_delivery_logs_status_idx
    ON email_delivery_logs (status);
-- Serves findPaginated() (newest first) and deleteOlderThan() (the pruner).
CREATE INDEX email_delivery_logs_created_at_idx
    ON email_delivery_logs (created_at DESC);


-- Per-address reputation. The durable half of the feedback record — NEVER
-- pruned, which is what makes "how often has this address bounced" outlive the
-- individual log rows.
CREATE TABLE email_reputation (
    id              BIGSERIAL PRIMARY KEY,
    email           VARCHAR(255) NOT NULL UNIQUE,
    domain          VARCHAR(255) NOT NULL,
    sent_count      INTEGER      NOT NULL DEFAULT 0,
    delivered_count INTEGER      NOT NULL DEFAULT 0,
    bounce_count    INTEGER      NOT NULL DEFAULT 0,
    complaint_count INTEGER      NOT NULL DEFAULT 0,
    last_sent_at    TIMESTAMPTZ,
    last_event_at   TIMESTAMPTZ,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- Serves domainRollup().
CREATE INDEX email_reputation_domain_idx ON email_reputation (domain);
CREATE INDEX email_reputation_bounce_count_idx ON email_reputation (bounce_count DESC);


-- ---------------------------------------------------------------------------
-- RULE 1: ReputationStore.increment MUST be a single atomic upsert.
--
-- Sends and feedback webhooks race on the same row. An ORM's find-then-write
-- `upsert` is two statements and loses increments under that race, which
-- silently understates a bad address — the exact number an operator consults
-- before deciding to stop mailing someone.
--
-- The contract suite's "does not lose concurrent increments" test fails on a
-- read-modify-write implementation.
-- ---------------------------------------------------------------------------
INSERT INTO email_reputation (email, domain, bounce_count, last_event_at, updated_at)
VALUES ($1, $2, 1, $3, now())
ON CONFLICT (email) DO UPDATE
   SET bounce_count  = email_reputation.bounce_count + 1,
       last_event_at = EXCLUDED.last_event_at,
       updated_at    = now();

-- Swap the column per ReputationCounter: sent_count / delivered_count /
-- bounce_count / complaint_count. The 'sent' counter stamps last_sent_at;
-- every other counter stamps last_event_at.


-- ---------------------------------------------------------------------------
-- RULE 2: feedback updates MUST only touch rows still in 'sent'.
--
-- A row already resolved must not be rewritten by later feedback for the same
-- address: that is a different message, and recipient-scoped correlation cannot
-- tell them apart. Without the status predicate, one bounce rewrites the whole
-- delivery history for that recipient.
-- ---------------------------------------------------------------------------

-- markByProviderMessageId() — precise, and tried FIRST.
UPDATE email_delivery_logs
   SET status = $2, feedback_at = $3
 WHERE provider_message_id = $1
   AND status = 'sent';

-- markRecipientFeedback() — the fallback, for sends that echoed no id (SMTP).
-- Only reached when the precise update matched nothing, because several
-- messages to one address can be in flight at once and this flips all of them.
UPDATE email_delivery_logs
   SET status = $2, feedback_at = $3
 WHERE recipient_email = $1
   AND status = 'sent';
