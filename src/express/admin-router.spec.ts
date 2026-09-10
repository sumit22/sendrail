import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { EmailDeliveryStatus } from '../domain/email-delivery-status';
import { EmailLogStatus } from '../domain/email-log-status';
import {
  InMemoryDeliveryLogStore,
  InMemoryReputationStore,
  InMemorySuppressionStore,
} from '../memory/in-memory-stores';
import { createAdminRouter } from './admin-router';

function build(overrides: { authorize?: express.RequestHandler } = {}) {
  const stores = {
    deliveryLog: new InMemoryDeliveryLogStore(),
    reputation: new InMemoryReputationStore(),
    suppression: new InMemorySuppressionStore(),
  };

  const app = express();
  app.use(
    '/admin/email',
    createAdminRouter({
      stores,
      authorize: overrides.authorize ?? ((_req, _res, next) => next()),
    })
  );

  return { app, stores };
}

describe('createAdminRouter', () => {
  it('runs the supplied authorize middleware before every route', async () => {
    const authorize = vi.fn((_req: express.Request, res: express.Response) => {
      res.status(403).json({ error: 'nope' });
    });
    const { app } = build({ authorize: authorize as unknown as express.RequestHandler });

    await request(app).get('/admin/email/logs').expect(403);
    await request(app).get('/admin/email/suppressions').expect(403);
    await request(app).post('/admin/email/suppressions').send({ email: 'a@b.com' }).expect(403);

    expect(authorize).toHaveBeenCalledTimes(3);
  });

  it('lists delivery log rows', async () => {
    const { app, stores } = build();
    await stores.deliveryLog.append({
      recipientEmail: 'a@example.com',
      notificationClass: 'welcome',
      status: EmailLogStatus.SENT,
    });

    const response = await request(app).get('/admin/email/logs').expect(200);

    expect(response.body.total).toBe(1);
    expect(response.body.items[0].recipientEmail).toBe('a@example.com');
  });

  it('zero-fills every status in the stats window', async () => {
    const { app } = build();

    const response = await request(app).get('/admin/email/stats').expect(200);

    expect(Object.keys(response.body.counts).sort()).toEqual(Object.values(EmailLogStatus).sort());
  });

  it('caps pageSize so a client cannot ask for everything', async () => {
    const { app } = build();

    const response = await request(app).get('/admin/email/logs?pageSize=100000').expect(200);

    expect(response.body.items.length).toBeLessThanOrEqual(100);
  });

  it('suppresses an address by hand, lowercased, as a complaint', async () => {
    const { app, stores } = build();

    await request(app)
      .post('/admin/email/suppressions')
      .send({ email: '  Person@Example.COM ', reason: 'replied STOP' })
      .expect(200);

    expect(await stores.suppression.isSuppressed('person@example.com')).toBe(true);
    const page = await stores.suppression.findSuppressedPaginated(1, 10);
    expect(page.items[0].status).toBe(EmailDeliveryStatus.COMPLAINED);
  });

  it('rejects a suppression request with no email', async () => {
    const { app } = build();

    await request(app).post('/admin/email/suppressions').send({}).expect(400);
  });

  it('releases a suppression', async () => {
    const { app, stores } = build();
    await stores.suppression.record('a@example.com', EmailDeliveryStatus.BOUNCED, 'hard', new Date());

    await request(app).post('/admin/email/suppressions/a@example.com/release').expect(200);

    expect(await stores.suppression.isSuppressed('a@example.com')).toBe(false);
  });

  it('reports no SES health when the host is not sending on SES', async () => {
    const { app } = build();

    const response = await request(app).get('/admin/email/overview').expect(200);

    expect(response.body).toEqual({ transport: 'non-ses', health: null });
  });

  it('reports SES health and identity healthiness when a management service is supplied', async () => {
    const app = express();
    app.use(
      '/admin/email',
      createAdminRouter({
        stores: {
          deliveryLog: new InMemoryDeliveryLogStore(),
          reputation: new InMemoryReputationStore(),
          suppression: new InMemorySuppressionStore(),
        },
        authorize: (_req, _res, next) => next(),
        ses: {
          getAccountHealth: async () => ({ productionAccess: true }) as never,
          listSendingIdentities: async () => [
            {
              identity: 'mail.example.com',
              type: 'DOMAIN',
              verifiedForSending: true,
              dkimStatus: 'SUCCESS',
            },
            {
              identity: 'broken.example.com',
              type: 'DOMAIN',
              verifiedForSending: true,
              dkimStatus: 'FAILED',
            },
          ],
        },
      })
    );

    const response = await request(app).get('/admin/email/identities').expect(200);

    expect(response.body.identities.map((i: { healthy: boolean }) => i.healthy)).toEqual([
      true,
      false,
    ]);
  });

  it('rolls reputation up by domain', async () => {
    const { app, stores } = build();
    await stores.reputation.increment('a@example.com', 'bounce', new Date());

    const response = await request(app).get('/admin/email/reputation/domains').expect(200);

    expect(response.body.domains[0]).toMatchObject({ domain: 'example.com', bounce: 1 });
  });
});
