import express, { RequestHandler, Router } from 'express';
import { EmailDeliveryStatus } from '../domain/email-delivery-status';
import { EmailLogStatus } from '../domain/email-log-status';
import { DeliveryLogStore } from '../ports/delivery-log.store';
import { ReputationStore } from '../ports/reputation.store';
import { SuppressionStore } from '../ports/suppression.store';
import { isIdentityHealthy } from '../ses/ses-account-health';
import type { SesManagementService } from '../ses/ses-management.service';

const DEFAULT_MAX_PAGE_SIZE = 100;
const MAX_WINDOW_DAYS = 90;

export interface AdminRouterOptions {
  stores: {
    deliveryLog: DeliveryLogStore;
    reputation: ReputationStore;
    suppression: SuppressionStore;
  };
  /**
   * Required, not optional, and deliberately so.
   *
   * This surface exposes recipient-level delivery records and can suppress or
   * release any address. An optional guard is one a host forgets, and the
   * resulting hole is invisible until someone finds it. Making it a required
   * argument turns "forgot the guard" from a silent vulnerability into a type
   * error. Pass an explicit no-op only for a local example.
   */
  authorize: RequestHandler;
  /** Omit on any host not sending through SES — there is no account to report on. */
  ses?: SesManagementService | null;
  maxPageSize?: number;
}

/**
 * Mountable admin API over the delivery log, suppressions and reputation — the
 * "our own ESP dashboard" data, without a dashboard.
 *
 * Read/write JSON only. There is no UI in this package and there is not going to
 * be one; a host renders these however it likes.
 */
export function createAdminRouter(options: AdminRouterOptions): Router {
  const { deliveryLog, reputation, suppression } = options.stores;
  const ses = options.ses ?? null;
  const maxPageSize = options.maxPageSize ?? DEFAULT_MAX_PAGE_SIZE;

  const router = Router();
  router.use(express.json());
  router.use(options.authorize);

  const wrap =
    (handler: (req: express.Request, res: express.Response) => Promise<void>): RequestHandler =>
    (req, res, next) => {
      handler(req, res).catch(next);
    };

  /**
   * SES account sending health. Null when this environment is not sending on
   * SES — there is no account to report on, which is an answer, not an error.
   */
  router.get(
    '/overview',
    wrap(async (_req, res) => {
      if (!ses) {
        res.json({ transport: 'non-ses', health: null });
        return;
      }
      res.json({ transport: 'ses', health: await ses.getAccountHealth() });
    })
  );

  /**
   * Sending identities with verification and DKIM status — what surfaces a
   * silently-broken DKIM before deliverability visibly tanks.
   */
  router.get(
    '/identities',
    wrap(async (_req, res) => {
      if (!ses) {
        res.json({ identities: [] });
        return;
      }
      const identities = await ses.listSendingIdentities();
      res.json({
        identities: identities.map((identity) => ({
          ...identity,
          healthy: isIdentityHealthy(identity),
        })),
      });
    })
  );

  /** What we actually sent, by outcome, over the window. */
  router.get(
    '/stats',
    wrap(async (req, res) => {
      const windowDays = clamp(Number(req.query.days) || 30, 1, MAX_WINDOW_DAYS);
      const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);
      const byStatus = await deliveryLog.countByStatusSince(since);

      // Emit every known status, zero-filled, so the client renders a stable shape.
      const counts: Record<string, number> = {};
      for (const status of Object.values(EmailLogStatus)) {
        counts[status] = byStatus[status] ?? 0;
      }

      res.json({
        windowDays,
        total: Object.values(counts).reduce((sum, n) => sum + n, 0),
        counts,
      });
    })
  );

  router.get(
    '/logs',
    wrap(async (req, res) => {
      res.json(
        await deliveryLog.findPaginated({
          status: parseLogStatus(str(req.query.status)),
          recipient: str(req.query.recipient),
          from: parseDate(str(req.query.from)),
          to: parseDate(str(req.query.to)),
          page: clamp(Number(req.query.page) || 1, 1, Number.MAX_SAFE_INTEGER),
          pageSize: clamp(Number(req.query.pageSize) || 25, 1, maxPageSize),
        })
      );
    })
  );

  router.get(
    '/suppressions',
    wrap(async (req, res) => {
      res.json(
        await suppression.findSuppressedPaginated(
          clamp(Number(req.query.page) || 1, 1, Number.MAX_SAFE_INTEGER),
          clamp(Number(req.query.pageSize) || 25, 1, maxPageSize)
        )
      );
    })
  );

  /**
   * Suppress an address by hand.
   *
   * Provider feedback fills this list automatically, but not every opt-out
   * arrives as a machine-readable event — a recipient who replies "STOP" lands
   * in a human's mailbox. Without this an operator reading such a reply cannot
   * honour it, which turns a courteous opt-out into the spam complaint it was
   * offered instead of.
   *
   * Recorded as COMPLAINED rather than BOUNCED: the address works, the person
   * asked us to stop, and that is permanent.
   */
  router.post(
    '/suppressions',
    wrap(async (req, res) => {
      const body = req.body as { email?: unknown; reason?: unknown } | undefined;
      const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
      if (email === '') {
        res.status(400).json({ error: 'email is required' });
        return;
      }

      const reason =
        typeof body?.reason === 'string' && body.reason.trim() !== ''
          ? body.reason.trim()
          : 'Manual opt-out recorded by an administrator';

      await suppression.record(email, EmailDeliveryStatus.COMPLAINED, reason, new Date());

      res.json({ suppressed: email });
    })
  );

  /**
   * Lift a suppression — an operator's "this mailbox is fixed, try again". A
   * deliberate escape hatch: a hard bounce from a mailbox that has since been
   * restored is otherwise permanent.
   */
  router.post(
    '/suppressions/:email/release',
    wrap(async (req, res) => {
      // Express 5 types a route param as string | string[]; an address never
      // arrives as an array, but narrowing beats asserting.
      const raw = req.params.email;
      const email = (Array.isArray(raw) ? (raw[0] ?? '') : raw).toLowerCase();
      await suppression.release(email);
      res.json({ released: email });
    })
  );

  router.get(
    '/reputation',
    wrap(async (req, res) => {
      res.json(
        await reputation.findPaginated({
          emailSearch: str(req.query.email),
          domain: str(req.query.domain),
          page: clamp(Number(req.query.page) || 1, 1, Number.MAX_SAFE_INTEGER),
          pageSize: clamp(Number(req.query.pageSize) || 25, 1, maxPageSize),
        })
      );
    })
  );

  /**
   * Reputation rolled up by recipient domain, worst bounce counts first.
   *
   * `customOnly` excludes the public mailbox providers, whose aggregate bounce
   * rate says nothing about our list and whose volume drowns out the domains
   * that do.
   */
  router.get(
    '/reputation/domains',
    wrap(async (req, res) => {
      res.json({
        domains: await reputation.domainRollup(
          req.query.customOnly !== 'false',
          clamp(Number(req.query.limit) || 25, 1, maxPageSize)
        ),
      });
    })
  );

  return router;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function parseLogStatus(value: string | null): EmailLogStatus | null {
  const statuses = Object.values(EmailLogStatus) as string[];
  return value && statuses.includes(value) ? (value as EmailLogStatus) : null;
}

function parseDate(value: string | null): Date | null {
  if (!value) {
    return null;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}
