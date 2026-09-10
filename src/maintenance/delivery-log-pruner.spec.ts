import { describe, expect, it } from 'vitest';
import { EmailLogStatus } from '../domain/email-log-status';
import { InMemoryDeliveryLogStore } from '../memory/in-memory-stores';
import { DeliveryLogPruner } from './delivery-log-pruner';

describe('DeliveryLogPruner', () => {
  it('deletes rows older than the retention window', async () => {
    const store = new InMemoryDeliveryLogStore();
    const deleteOlderThan = store.deleteOlderThan.bind(store);
    let cutoff: Date | undefined;

    store.deleteOlderThan = async (at: Date) => {
      cutoff = at;
      return deleteOlderThan(at);
    };

    await store.append({
      recipientEmail: 'a@example.com',
      notificationClass: 'welcome',
      status: EmailLogStatus.SENT,
    });

    const deleted = await new DeliveryLogPruner(store, 7).prune();

    // Nothing is a week old yet, so the freshly written row survives.
    expect(deleted).toBe(0);
    expect(cutoff).toBeDefined();
    expect(Date.now() - cutoff!.getTime()).toBeCloseTo(7 * 24 * 60 * 60 * 1000, -4);
  });

  it('clamps a nonsensical retention window to at least a day', async () => {
    const store = new InMemoryDeliveryLogStore();
    let cutoff: Date | undefined;
    store.deleteOlderThan = async (at: Date) => {
      cutoff = at;
      return 0;
    };

    await new DeliveryLogPruner(store).prune(0);

    expect(Date.now() - cutoff!.getTime()).toBeCloseTo(24 * 60 * 60 * 1000, -4);
  });
});
