import { Router } from 'express';
import { z } from 'zod';
import { authenticate } from '../../middleware/authenticate.js';
import { allow } from '../../middleware/authorize.js';
import { validate } from '../../middleware/validate.js';
import { pageMeta, pageQuery, pageSize } from '../../lib/pagination.js';
import { sendData } from '../../lib/response.js';
import { User } from '../users/user.model.js';
import { AuditLog } from './audit.model.js';

const query = z.object({
  ...pageQuery,
  accountId: z.string().regex(/^acc_[a-f0-9]{28}$/).optional(),
  actorUserId: z.string().regex(/^usr_[a-f0-9]{28}$/).optional(),
  entity: z.string().max(40).optional(),
  entityId: z.string().max(60).optional(),
  action: z.string().max(60).optional(),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
});

/**
 * P-50 (view part; CSV export with OTP is not built yet). ADV sees their own account only; ADM sees all;
 * STF sees metadata only (no old/new values). Personal data was masked when the entry was written.
 */
export function auditRoutes() {
  const r = Router();
  r.get('/', authenticate, allow('audit.view'), validate({ query }), async (req, res) => {
    const q = res.locals.query as z.infer<typeof query>;
    const ctx = req.auth!;
    const filter: Record<string, unknown> = {};
    if (ctx.role === 'ADV') filter.accountId = ctx.accountId;
    else if (q.accountId) filter.accountId = q.accountId;
    for (const k of ['actorUserId', 'entity', 'entityId', 'action'] as const) if (q[k]) filter[k] = q[k];
    if (q.from || q.to) filter.at = { ...(q.from ? { $gte: new Date(q.from) } : {}), ...(q.to ? { $lte: new Date(q.to) } : {}) };
    const limit = pageSize(q.limit);
    const [items, total] = await Promise.all([
      AuditLog.find(filter).sort({ at: -1, _id: -1 }).skip((q.page - 1) * limit).limit(limit).lean(),
      AuditLog.countDocuments(filter),
    ]);
    const names = new Map((await User.find({ _id: { $in: [...new Set(items.map((i) => i.actorUserId).filter(Boolean))] } }, { name: 1 }).lean()).map((u) => [u._id, u.name]));
    sendData(res, items.map((i) => ({
      id: String(i._id), at: i.at, accountId: i.accountId, actorUserId: i.actorUserId, actorName: i.actorUserId ? names.get(i.actorUserId) ?? null : i.actorLabel,
      actorRole: i.actorRole, entity: i.entity, entityId: i.entityId, entityRef: i.entityRef, action: i.action, result: i.result, requestId: i.requestId,
      ...(ctx.role === 'STF' ? {} : { before: i.before, after: i.after }),
    })), 200, pageMeta(q.page, limit, total));
  });
  return r;
}
