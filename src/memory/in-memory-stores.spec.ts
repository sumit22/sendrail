import { beforeEach, describe, expect, it } from 'vitest';
import { EmailDeliveryStatus } from '../domain/email-delivery-status';
import { EmailLogStatus } from '../domain/email-log-status';
import {
  InMemoryDeliveryLogStore,
  InMemoryReputationStore,
  InMemorySuppressionStore,
} from './in-memory-stores';

describe('InMemoryDeliveryLogStore', () => {
  let store: InMemoryDeliveryLogStore;

  beforeEach(async () => {
    store = new InMemoryDeliveryLogStore();
    await store.append({
      recipientEmail: 'a@example.com',
      notificationClass: 'welcome',
      status: EmailLogStatus.SENT,
      providerMessageId: 'ses-1',
    });
    await store.append({
      recipientEmail: 'b@example.com',
      notificationClass: 'order-reminder',
      status: EmailLogStatus.FAILED,
    });
  });

  it('filters by status', async () => {
    const { items, total } = await store.findPaginated({
      status: EmailLogStatus.FAILED,
      page: 1,
      pageSize: 10,
    });

    expect(total).toBe(1);
    expect(items[0].recipientEmail).toBe('b@example.com');
  });

  it('filters by recipient substring, case-insensitively', async () => {
    const { total } = await store.findPaginated({ recipient: 'A@EXAMPLE', page: 1, pageSize: 10 });

    expect(total).toBe(1);
  });

  it('filters by date range', async () => {
    const future = new Date(Date.now() + 60_000);

    await expect(
      store.findPaginated({ from: future, page: 1, pageSize: 10 })
    ).resolves.toMatchObject({
      total: 0,
    });
    await expect(store.findPaginated({ to: future, page: 1, pageSize: 10 })).resolves.toMatchObject(
      {
        total: 2,
      }
    );
  });

  it('paginates, reporting the unpaginated total', async () => {
    const { items, total } = await store.findPaginated({ page: 2, pageSize: 1 });

    expect(total).toBe(2);
    expect(items).toHaveLength(1);
  });

  it('clamps a page below one instead of slicing from a negative offset', async () => {
    await expect(store.findPaginated({ page: 0, pageSize: 10 })).resolves.toMatchObject({
      total: 2,
    });
  });

  it('flips only rows still awaiting feedback', async () => {
    const at = new Date();

    await expect(
      store.markRecipientFeedback('b@example.com', EmailLogStatus.BOUNCED, at)
    ).resolves.toBe(0);
    await expect(
      store.markRecipientFeedback('a@example.com', EmailLogStatus.BOUNCED, at)
    ).resolves.toBe(1);
  });

  it('flips by provider message id', async () => {
    await expect(
      store.markByProviderMessageId('ses-1', EmailLogStatus.DELIVERED, new Date())
    ).resolves.toBe(1);
    await expect(
      store.markByProviderMessageId('nope', EmailLogStatus.DELIVERED, new Date())
    ).resolves.toBe(0);
  });

  it('counts by status since a cutoff', async () => {
    await expect(store.countByStatusSince(new Date(Date.now() - 60_000))).resolves.toEqual({
      sent: 1,
      failed: 1,
    });
    await expect(store.countByStatusSince(new Date(Date.now() + 60_000))).resolves.toEqual({});
  });

  it('clamps a reputation page below one', async () => {
    await expect(store.findPaginated({ page: 0, pageSize: 10 })).resolves.toBeDefined();
  });

  it('prunes by cutoff', async () => {
    await expect(store.deleteOlderThan(new Date(Date.now() - 60_000))).resolves.toBe(0);
    await expect(store.deleteOlderThan(new Date(Date.now() + 60_000))).resolves.toBe(2);
    await expect(store.findPaginated({ page: 1, pageSize: 10 })).resolves.toMatchObject({
      total: 0,
    });
  });
});

describe('InMemoryReputationStore', () => {
  let store: InMemoryReputationStore;
  const at = new Date('2026-08-01T10:00:00.000Z');

  beforeEach(() => {
    store = new InMemoryReputationStore();
  });

  it('accumulates each counter and stamps the right timestamp', async () => {
    await store.increment('a@example.com', 'sent', at);
    await store.increment('a@example.com', 'sent', at);
    await store.increment('a@example.com', 'delivered', at);
    await store.increment('a@example.com', 'bounce', at);
    await store.increment('a@example.com', 'complaint', at);

    const { items } = await store.findPaginated({ page: 1, pageSize: 10 });
    expect(items[0]).toMatchObject({
      email: 'a@example.com',
      domain: 'example.com',
      sentCount: 2,
      deliveredCount: 1,
      bounceCount: 1,
      complaintCount: 1,
      lastSentAt: at,
      lastEventAt: at,
    });
  });

  it('normalises the address before counting', async () => {
    await store.increment('  A@Example.COM ', 'sent', at);

    const { items, total } = await store.findPaginated({ page: 1, pageSize: 10 });
    expect(total).toBe(1);
    expect(items[0].email).toBe('a@example.com');
  });

  it('ignores a blank address', async () => {
    await store.increment('   ', 'sent', at);

    await expect(store.findPaginated({ page: 1, pageSize: 10 })).resolves.toMatchObject({
      total: 0,
    });
  });

  it('orders worst bounce counts first', async () => {
    await store.increment('clean@example.com', 'sent', at);
    await store.increment('bad@example.com', 'bounce', at);
    await store.increment('bad@example.com', 'bounce', at);

    const { items } = await store.findPaginated({ page: 1, pageSize: 10 });
    expect(items[0].email).toBe('bad@example.com');
  });

  it('filters by email substring and by domain', async () => {
    await store.increment('a@one.com', 'sent', at);
    await store.increment('b@two.com', 'sent', at);

    await expect(
      store.findPaginated({ emailSearch: 'A@ONE', page: 1, pageSize: 10 })
    ).resolves.toMatchObject({ total: 1 });
    await expect(
      store.findPaginated({ domain: 'TWO.com', page: 1, pageSize: 10 })
    ).resolves.toMatchObject({ total: 1 });
  });

  it('rolls up by domain', async () => {
    await store.increment('a@shop.com', 'sent', at);
    await store.increment('b@shop.com', 'bounce', at);

    await expect(store.domainRollup(false, 10)).resolves.toEqual([
      { domain: 'shop.com', addresses: 2, sent: 1, delivered: 0, bounce: 1, complaint: 0 },
    ]);
  });

  it('excludes public mailbox providers from the custom-domain rollup', async () => {
    // Their aggregate bounce rate says nothing about our list, and their volume
    // drowns out the domains that do.
    await store.increment('a@gmail.com', 'bounce', at);
    await store.increment('b@shop.com', 'bounce', at);

    await expect(store.domainRollup(true, 10)).resolves.toEqual([
      expect.objectContaining({ domain: 'shop.com' }),
    ]);
    await expect(store.domainRollup(false, 10)).resolves.toHaveLength(2);
  });

  it('honours the rollup limit', async () => {
    await store.increment('a@one.com', 'bounce', at);
    await store.increment('b@two.com', 'bounce', at);

    await expect(store.domainRollup(false, 1)).resolves.toHaveLength(1);
  });
});

describe('InMemorySuppressionStore', () => {
  let store: InMemorySuppressionStore;
  const at = new Date('2026-08-01T10:00:00.000Z');

  beforeEach(() => {
    store = new InMemorySuppressionStore();
  });

  it('suppresses a recorded address, matched case-insensitively', async () => {
    await store.record('Gone@Example.com', EmailDeliveryStatus.BOUNCED, 'Permanent/General', at);

    await expect(store.isSuppressed('  GONE@example.COM ')).resolves.toBe(true);
  });

  it('treats an unknown address as not suppressed', async () => {
    await expect(store.isSuppressed('stranger@example.com')).resolves.toBe(false);
  });

  it('overwrites rather than duplicating on a repeat event', async () => {
    await store.record('a@example.com', EmailDeliveryStatus.BOUNCED, 'first', at);
    await store.record('a@example.com', EmailDeliveryStatus.COMPLAINED, 'second', at);

    const { items, total } = await store.findSuppressedPaginated(1, 10);
    expect(total).toBe(1);
    expect(items[0]).toMatchObject({ status: EmailDeliveryStatus.COMPLAINED, reason: 'second' });
  });

  it('releases a suppression', async () => {
    await store.record('a@example.com', EmailDeliveryStatus.BOUNCED, 'x', at);
    await store.release('A@Example.com');

    await expect(store.isSuppressed('a@example.com')).resolves.toBe(false);
  });

  it('ignores a blank address', async () => {
    await store.record('  ', EmailDeliveryStatus.BOUNCED, 'x', at);

    await expect(store.findSuppressedPaginated(1, 10)).resolves.toMatchObject({ total: 0 });
  });

  it('lists newest suppression first, paginated', async () => {
    await store.record('old@example.com', EmailDeliveryStatus.BOUNCED, 'x', new Date(1000));
    await store.record('new@example.com', EmailDeliveryStatus.BOUNCED, 'x', new Date(2000));

    const { items, total } = await store.findSuppressedPaginated(1, 1);
    expect(total).toBe(2);
    expect(items[0].email).toBe('new@example.com');
  });

  it('clamps a suppression page below one', async () => {
    await store.record('a@example.com', EmailDeliveryStatus.BOUNCED, 'x', at);

    await expect(store.findSuppressedPaginated(0, 10)).resolves.toMatchObject({ total: 1 });
  });

  it('sorts an entry with no timestamp last rather than throwing', async () => {
    await store.record('a@example.com', EmailDeliveryStatus.BOUNCED, 'x', at);

    await expect(store.findSuppressedPaginated(1, 10)).resolves.toMatchObject({ total: 1 });
  });

  it('omits an address whose status is ACTIVE', async () => {
    await store.record('fine@example.com', EmailDeliveryStatus.ACTIVE, 'recovered', at);

    await expect(store.isSuppressed('fine@example.com')).resolves.toBe(false);
    await expect(store.findSuppressedPaginated(1, 10)).resolves.toMatchObject({ total: 0 });
  });
});
