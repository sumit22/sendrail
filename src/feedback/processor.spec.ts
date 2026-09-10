import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EmailDeliveryStatus } from '../domain/email-delivery-status';
import { EmailFeedbackType } from '../domain/email-feedback-type';
import { EmailLogStatus } from '../domain/email-log-status';
import {
  InMemoryDeliveryLogStore,
  InMemoryReputationStore,
  InMemorySuppressionStore,
} from '../memory/in-memory-stores';
import { EmailFeedbackProcessor } from './processor';

describe('EmailFeedbackProcessor', () => {
  let deliveryLog: InMemoryDeliveryLogStore;
  let reputation: InMemoryReputationStore;
  let suppression: InMemorySuppressionStore;
  let processor: EmailFeedbackProcessor;

  beforeEach(async () => {
    deliveryLog = new InMemoryDeliveryLogStore();
    reputation = new InMemoryReputationStore();
    suppression = new InMemorySuppressionStore();
    processor = new EmailFeedbackProcessor({ deliveryLog, reputation, suppression });

    await deliveryLog.append({
      recipientEmail: 'gone@example.com',
      notificationClass: 'order-confirmation',
      status: EmailLogStatus.SENT,
      providerMessageId: 'ses-msg-1',
    });
  });

  it('suppresses the address, counts the bounce and flips the log row', async () => {
    const at = new Date('2026-08-01T10:00:00.000Z');

    const applied = await processor.processAll([
      {
        type: EmailFeedbackType.BOUNCED,
        recipientEmail: 'gone@example.com',
        reason: 'Permanent/General',
        occurredAt: at,
        providerMessageId: 'ses-msg-1',
      },
    ]);

    expect(applied).toBe(1);
    await expect(suppression.isSuppressed('gone@example.com')).resolves.toBe(true);

    const { items } = await deliveryLog.findPaginated({ page: 1, pageSize: 10 });
    expect(items[0]).toMatchObject({ status: EmailLogStatus.BOUNCED, feedbackAt: at });

    const reputationRows = await reputation.findPaginated({ page: 1, pageSize: 10 });
    expect(reputationRows.items[0]).toMatchObject({ bounceCount: 1 });
  });

  it('correlates on the provider message id, not the recipient', async () => {
    // Several messages to one address can be in flight at once. Marking by
    // recipient would flip all of them to this one message's outcome.
    await deliveryLog.append({
      recipientEmail: 'gone@example.com',
      notificationClass: 'order-reminder',
      status: EmailLogStatus.SENT,
      providerMessageId: 'ses-msg-2',
    });

    await processor.process({
      type: EmailFeedbackType.BOUNCED,
      recipientEmail: 'gone@example.com',
      providerMessageId: 'ses-msg-2',
    });

    const { items } = await deliveryLog.findPaginated({ page: 1, pageSize: 10 });
    const byMessageId = new Map(items.map((row) => [row.providerMessageId, row.status]));

    expect(byMessageId.get('ses-msg-2')).toBe(EmailLogStatus.BOUNCED);
    expect(byMessageId.get('ses-msg-1')).toBe(EmailLogStatus.SENT);
  });

  it('falls back to the recipient when the provider returned no message id', async () => {
    // Sends that went out over SMTP echo no id back, so recipient scope is the
    // only correlation available.
    await processor.process({
      type: EmailFeedbackType.BOUNCED,
      recipientEmail: 'gone@example.com',
    });

    const { items } = await deliveryLog.findPaginated({ page: 1, pageSize: 10 });
    expect(items[0].status).toBe(EmailLogStatus.BOUNCED);
  });

  it('falls back to the recipient when the message id matches nothing', async () => {
    await processor.process({
      type: EmailFeedbackType.BOUNCED,
      recipientEmail: 'gone@example.com',
      providerMessageId: 'ses-msg-from-a-pruned-row',
    });

    const { items } = await deliveryLog.findPaginated({ page: 1, pageSize: 10 });
    expect(items[0].status).toBe(EmailLogStatus.BOUNCED);
  });

  it('falls back to the recipient when the precise update throws', async () => {
    vi.spyOn(deliveryLog, 'markByProviderMessageId').mockRejectedValue(new Error('deadlock'));

    await processor.process({
      type: EmailFeedbackType.BOUNCED,
      recipientEmail: 'gone@example.com',
      providerMessageId: 'ses-msg-1',
    });

    const { items } = await deliveryLog.findPaginated({ page: 1, pageSize: 10 });
    expect(items[0].status).toBe(EmailLogStatus.BOUNCED);
  });

  it('does not suppress on a delivery', async () => {
    await processor.process({
      type: EmailFeedbackType.DELIVERED,
      recipientEmail: 'gone@example.com',
    });

    await expect(suppression.isSuppressed('gone@example.com')).resolves.toBe(false);

    const { items } = await deliveryLog.findPaginated({ page: 1, pageSize: 10 });
    expect(items[0].status).toBe(EmailLogStatus.DELIVERED);
  });

  it('records a complaint under its own status', async () => {
    await processor.process({
      type: EmailFeedbackType.COMPLAINED,
      recipientEmail: 'gone@example.com',
      reason: 'feedbackId=fb-1; type=abuse',
    });

    const { items } = await suppression.findSuppressedPaginated(1, 10);
    expect(items[0]).toMatchObject({
      status: EmailDeliveryStatus.COMPLAINED,
      reason: 'feedbackId=fb-1; type=abuse',
    });
  });

  it('counts only the events it applied', async () => {
    const applied = await processor.processAll([
      { type: EmailFeedbackType.DELIVERED, recipientEmail: 'gone@example.com' },
      { type: EmailFeedbackType.DELIVERED, recipientEmail: '   ' },
    ]);

    expect(applied).toBe(1);
  });

  it('applies nothing for an empty batch', async () => {
    await expect(processor.processAll([])).resolves.toBe(0);
  });

  it('falls back to the feedback type when the provider gave no reason', async () => {
    await processor.process({
      type: EmailFeedbackType.BOUNCED,
      recipientEmail: 'gone@example.com',
    });

    const { items } = await suppression.findSuppressedPaginated(1, 10);
    expect(items[0].reason).toBe(EmailFeedbackType.BOUNCED);
  });

  it('stamps receipt time when the provider gave no timestamp', async () => {
    const before = Date.now();

    await processor.process({
      type: EmailFeedbackType.BOUNCED,
      recipientEmail: 'gone@example.com',
    });

    const { items } = await suppression.findSuppressedPaginated(1, 10);
    expect(items[0].suppressedAt!.getTime()).toBeGreaterThanOrEqual(before);
  });

  it('ignores an empty provider message id as if none were supplied', async () => {
    await processor.process({
      type: EmailFeedbackType.BOUNCED,
      recipientEmail: 'gone@example.com',
      providerMessageId: '',
    });

    const { items } = await deliveryLog.findPaginated({ page: 1, pageSize: 10 });
    expect(items[0].status).toBe(EmailLogStatus.BOUNCED);
  });

  it('ignores an event with a blank recipient', async () => {
    await expect(
      processor.process({ type: EmailFeedbackType.BOUNCED, recipientEmail: '   ' })
    ).resolves.toBe(false);
  });

  it('still suppresses when the reputation and log writes fail', async () => {
    // Suppression is the one with teeth. Bookkeeping failing after it must not
    // undo it, and must not stop the event being reported as applied.
    vi.spyOn(reputation, 'increment').mockRejectedValue(new Error('counter down'));
    vi.spyOn(deliveryLog, 'markRecipientFeedback').mockRejectedValue(new Error('log down'));
    vi.spyOn(deliveryLog, 'markByProviderMessageId').mockRejectedValue(new Error('log down'));

    const applied = await processor.process({
      type: EmailFeedbackType.BOUNCED,
      recipientEmail: 'gone@example.com',
      reason: 'Permanent/General',
    });

    expect(applied).toBe(true);
    await expect(suppression.isSuppressed('gone@example.com')).resolves.toBe(true);
  });

  it('keeps going when the suppression write fails', async () => {
    vi.spyOn(suppression, 'record').mockRejectedValue(new Error('store down'));

    await expect(
      processor.process({ type: EmailFeedbackType.BOUNCED, recipientEmail: 'gone@example.com' })
    ).resolves.toBe(true);

    const { items } = await deliveryLog.findPaginated({ page: 1, pageSize: 10 });
    expect(items[0].status).toBe(EmailLogStatus.BOUNCED);
  });
});
