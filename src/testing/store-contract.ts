import { describe, expect, it } from 'vitest';
import { EmailDeliveryStatus } from '../domain/email-delivery-status';
import { EmailLogStatus } from '../domain/email-log-status';
import { DeliveryLogEntry, DeliveryLogStore } from '../ports/delivery-log.store';
import { ReputationStore } from '../ports/reputation.store';
import { SuppressionStore } from '../ports/suppression.store';

/**
 * Executable contracts for the three storage ports.
 *
 * sendrail ships no database adapter, so these interfaces are the whole
 * agreement — and several of their clauses are the kind a plausible-looking
 * implementation gets wrong silently: case-insensitive matching, idempotent
 * recording, only ever resolving rows still in SENT, atomic increments. A bug in
 * any of them shows up weeks later as reputation damage, not as a failing
 * request.
 *
 * Call these from your own suite against your own adapter:
 *
 * ```ts
 * import { describeSuppressionStoreContract } from 'sendrail/testing';
 *
 * describeSuppressionStoreContract('PostgresSuppressionStore', async () => {
 *   await db.query('TRUNCATE email_suppressions');
 *   return new PostgresSuppressionStore(db);
 * });
 * ```
 *
 * The factory is called before each test and must return an EMPTY store.
 * Requires `vitest`, which is why this lives behind its own entry point.
 */
export type StoreFactory<T> = () => T | Promise<T>;

export function describeSuppressionStoreContract(
  name: string,
  factory: StoreFactory<SuppressionStore>
): void {
  describe(`${name} — SuppressionStore contract`, () => {
    const at = new Date('2026-01-01T00:00:00.000Z');

    it('reports an unknown address as not suppressed', async () => {
      const store = await factory();

      expect(await store.isSuppressed('nobody@example.com')).toBe(false);
    });

    it('suppresses an address it has recorded', async () => {
      const store = await factory();
      await store.record('a@example.com', EmailDeliveryStatus.BOUNCED, 'hard', at);

      expect(await store.isSuppressed('a@example.com')).toBe(true);
    });

    // Providers normalise addresses to lowercase in feedback events; stored
    // addresses may not be. A case-sensitive store keeps mailing a bounced
    // address whose casing differs.
    it('matches case-insensitively in both directions', async () => {
      const store = await factory();
      await store.record('Mixed@Example.COM', EmailDeliveryStatus.BOUNCED, 'hard', at);

      expect(await store.isSuppressed('mixed@example.com')).toBe(true);
      expect(await store.isSuppressed('MIXED@EXAMPLE.COM')).toBe(true);
    });

    it('is idempotent — re-recording updates the reason without duplicating', async () => {
      const store = await factory();
      await store.record('a@example.com', EmailDeliveryStatus.BOUNCED, 'first', at);
      await store.record('a@example.com', EmailDeliveryStatus.BOUNCED, 'second', at);

      const page = await store.findSuppressedPaginated(1, 10);
      expect(page.total).toBe(1);
      expect(page.items[0].reason).toBe('second');
    });

    it('releases a suppression', async () => {
      const store = await factory();
      await store.record('a@example.com', EmailDeliveryStatus.BOUNCED, 'hard', at);
      await store.release('a@example.com');

      expect(await store.isSuppressed('a@example.com')).toBe(false);
    });

    it('releasing an address it has never seen is a no-op, not an error', async () => {
      const store = await factory();

      await expect(store.release('ghost@example.com')).resolves.not.toThrow();
    });

    it('screens a batch in one call, returning the suppressed subset lowercased', async () => {
      const store = await factory();
      await store.record('bad@example.com', EmailDeliveryStatus.BOUNCED, 'hard', at);

      const found = await store.findSuppressedAmong(['GOOD@example.com', 'Bad@Example.com']);

      expect(found).toEqual(['bad@example.com']);
    });
  });
}

export function describeDeliveryLogStoreContract(
  name: string,
  factory: StoreFactory<DeliveryLogStore>
): void {
  describe(`${name} — DeliveryLogStore contract`, () => {
    const at = new Date('2026-01-01T00:00:00.000Z');

    const entry = (overrides: Partial<DeliveryLogEntry> = {}): DeliveryLogEntry => ({
      recipientEmail: 'a@example.com',
      notificationClass: 'welcome',
      status: EmailLogStatus.SENT,
      ...overrides,
    });

    it('appends and reads back a row', async () => {
      const store = await factory();
      await store.append(entry());

      const page = await store.findPaginated({ page: 1, pageSize: 10 });
      expect(page.total).toBe(1);
      expect(page.items[0].recipientEmail).toBe('a@example.com');
    });

    it('stamps createdAt on append', async () => {
      const store = await factory();
      await store.append(entry());

      const page = await store.findPaginated({ page: 1, pageSize: 10 });
      expect(page.items[0].createdAt).toBeInstanceOf(Date);
    });

    it('filters by status', async () => {
      const store = await factory();
      await store.append(entry({ status: EmailLogStatus.SENT }));
      await store.append(entry({ status: EmailLogStatus.FAILED }));

      const page = await store.findPaginated({
        status: EmailLogStatus.FAILED,
        page: 1,
        pageSize: 10,
      });
      expect(page.total).toBe(1);
    });

    it('resolves a row precisely by provider message id', async () => {
      const store = await factory();
      await store.append(entry({ providerMessageId: 'msg-1' }));

      expect(await store.markByProviderMessageId('msg-1', EmailLogStatus.BOUNCED, at)).toBe(1);
    });

    it('reports 0 for a provider message id on no row', async () => {
      const store = await factory();

      expect(await store.markByProviderMessageId('absent', EmailLogStatus.BOUNCED, at)).toBe(0);
    });

    // The critical clause. A row already resolved must not be rewritten by later
    // feedback for the same address — that is a different message, and
    // recipient-scoped correlation cannot tell them apart.
    it('only resolves rows still in SENT', async () => {
      const store = await factory();
      await store.append(entry({ status: EmailLogStatus.DELIVERED }));

      expect(await store.markRecipientFeedback('a@example.com', EmailLogStatus.BOUNCED, at)).toBe(
        0
      );
    });

    it('resolves every still-SENT row for a recipient', async () => {
      const store = await factory();
      await store.append(entry());
      await store.append(entry());

      expect(await store.markRecipientFeedback('a@example.com', EmailLogStatus.BOUNCED, at)).toBe(
        2
      );
    });

    it('stamps feedbackAt when a row is resolved', async () => {
      const store = await factory();
      await store.append(entry({ providerMessageId: 'msg-1' }));
      await store.markByProviderMessageId('msg-1', EmailLogStatus.BOUNCED, at);

      const page = await store.findPaginated({ page: 1, pageSize: 10 });
      expect(page.items[0].feedbackAt).toEqual(at);
    });

    it('counts by status since a cutoff', async () => {
      const store = await factory();
      await store.append(entry({ status: EmailLogStatus.SENT }));
      await store.append(entry({ status: EmailLogStatus.SENT }));
      await store.append(entry({ status: EmailLogStatus.FAILED }));

      const counts = await store.countByStatusSince(new Date(Date.now() - 60_000));
      expect(counts[EmailLogStatus.SENT]).toBe(2);
      expect(counts[EmailLogStatus.FAILED]).toBe(1);
    });

    it('deletes nothing when every row is newer than the cutoff', async () => {
      const store = await factory();
      await store.append(entry());

      expect(await store.deleteOlderThan(new Date(Date.now() - 60_000))).toBe(0);
    });

    it('deletes rows older than the cutoff', async () => {
      const store = await factory();
      await store.append(entry());

      expect(await store.deleteOlderThan(new Date(Date.now() + 60_000))).toBe(1);
      expect((await store.findPaginated({ page: 1, pageSize: 10 })).total).toBe(0);
    });
  });
}

export function describeReputationStoreContract(
  name: string,
  factory: StoreFactory<ReputationStore>
): void {
  describe(`${name} — ReputationStore contract`, () => {
    const at = new Date('2026-01-01T00:00:00.000Z');

    it('creates the row on first increment', async () => {
      const store = await factory();
      await store.increment('a@example.com', 'sent', at);

      const page = await store.findPaginated({ page: 1, pageSize: 10 });
      expect(page.total).toBe(1);
      expect(page.items[0].sentCount).toBe(1);
    });

    it('accumulates across increments', async () => {
      const store = await factory();
      await store.increment('a@example.com', 'sent', at);
      await store.increment('a@example.com', 'sent', at);
      await store.increment('a@example.com', 'bounce', at);

      const page = await store.findPaginated({ page: 1, pageSize: 10 });
      expect(page.items[0]).toMatchObject({ sentCount: 2, bounceCount: 1 });
    });

    // Concurrent sends and feedback webhooks hit the same row. A
    // read-modify-write implementation loses updates here and silently
    // understates a bad address — the exact number an operator would consult
    // before deciding to stop mailing someone.
    it('does not lose concurrent increments', async () => {
      const store = await factory();

      await Promise.all(
        Array.from({ length: 25 }, () => store.increment('a@example.com', 'sent', at))
      );

      const page = await store.findPaginated({ page: 1, pageSize: 10 });
      expect(page.items[0].sentCount).toBe(25);
    });

    it("stamps lastSentAt for 'sent' and lastEventAt for everything else", async () => {
      const store = await factory();
      await store.increment('a@example.com', 'sent', at);
      await store.increment('b@example.com', 'bounce', at);

      const page = await store.findPaginated({ page: 1, pageSize: 10 });
      const a = page.items.find((r) => r.email === 'a@example.com');
      const b = page.items.find((r) => r.email === 'b@example.com');

      expect(a?.lastSentAt).toEqual(at);
      expect(b?.lastEventAt).toEqual(at);
    });

    it('derives the domain from the address', async () => {
      const store = await factory();
      await store.increment('a@example.com', 'sent', at);

      const page = await store.findPaginated({ page: 1, pageSize: 10 });
      expect(page.items[0].domain).toBe('example.com');
    });

    it('rolls up by domain', async () => {
      const store = await factory();
      await store.increment('a@example.com', 'bounce', at);
      await store.increment('b@example.com', 'bounce', at);

      const rollup = await store.domainRollup(false, 10);
      const row = rollup.find((r) => r.domain === 'example.com');

      expect(row).toMatchObject({ addresses: 2, bounce: 2 });
    });

    it('excludes public mailbox providers when customOnly is set', async () => {
      const store = await factory();
      await store.increment('a@gmail.com', 'bounce', at);
      await store.increment('b@example.com', 'bounce', at);

      const rollup = await store.domainRollup(true, 10);

      expect(rollup.map((r) => r.domain)).toEqual(['example.com']);
    });
  });
}
