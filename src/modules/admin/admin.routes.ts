import { Router } from 'express';
import { z } from 'zod';
import { authenticate } from '../../middleware/authenticate.js';
import { allow, writable } from '../../middleware/authorize.js';
import { idempotent } from '../../middleware/idempotency.js';
import { validate } from '../../middleware/validate.js';
import { date, enumOf, optional, required, shortText } from '../../lib/fields.js';
import { sendData, sendDone } from '../../lib/response.js';
import { requireStepUp } from '../auth/stepUp.js';
import * as svc from './admin.service.js';

const accId = z.object({ id: z.string().regex(/^acc_[a-f0-9]{28}$/) });
const PLAN = enumOf(['NORMAL', 'PREMIUM'] as const);
const CYCLE = enumOf(['MONTHLY', 'YEARLY'] as const);
const gstin = () => z.string().regex(/^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/, { message: 'VAL-39' });
const reason = z.object({ reason: required(shortText()) }).strict();

/** P-47 My plan and billing: works in read-only mode, so an expired account can pay. */
export function billingRoutes() {
  const r = Router();
  r.use(authenticate, allow('billing.manage'));
  r.get('/', async (req, res) => sendData(res, await svc.billing(req.auth!)));
  r.post('/quote', validate({ body: z.object({ plan: required(PLAN), cycle: required(CYCLE), gstin: optional(gstin()) }).strict() }, { gstin: 'GSTIN' }), async (req, res) => sendData(res, await svc.quote(req.auth!.accountId!, req.body.plan, req.body.cycle, req.body.gstin)));
  r.post('/orders', validate({ body: z.object({ plan: required(PLAN), cycle: required(CYCLE), gstin: optional(gstin()) }).strict() }, { gstin: 'GSTIN' }), idempotent(), async (req, res) => sendData(res, await svc.createOrder(req.auth!, req.body, req), 201));
  r.get('/orders/:id', validate({ params: z.object({ id: z.string().regex(/^sor_[a-f0-9]{28}$/) }) }), async (req, res) => sendData(res, await svc.orderStatus(req.auth!, String(req.params.id))));
  r.post('/downgrade', writable, validate({ body: z.object({ confirm: z.boolean().optional() }).strict() }), async (req, res) => sendData(res, await svc.downgrade(req.auth!, !!req.body.confirm, req)));
  return r;
}
/** P-52 export my data: allowed in read-only mode (AC-P52-3). */
export function exportRoutes() {
  const r = Router();
  r.use(authenticate, allow('export.own'));
  r.get('/', async (req, res) => sendData(res, await svc.listExports(req.auth!)));
  r.post('/', validate({ body: z.object({ include: z.array(enumOf(svc.EXPORT_PARTS)).min(1, { message: 'GEN-01' }) }).strict() }, { include: 'What to include' }), async (req, res) => sendDone(res, await svc.requestExport(req.auth!, req.body.include, req), 'ADM-10', {}, 202));
  r.get('/:id/download', validate({ params: z.object({ id: z.string().regex(/^exp_[a-f0-9]{28}$/) }) }), async (req, res) => {
    const { file, bytes } = await svc.downloadExport(req.auth!, String(req.params.id), req);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${file.name.replace(/"/g, '')}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.end(bytes);
  });
  return r;
}
/** P-57 support access: the advisor gives (OTP) and ends; SkyUp opens client records only under a grant. */
export function supportGrantRoutes() {
  const r = Router();
  r.use(authenticate, allow('support.give'));
  r.get('/', async (req, res) => sendData(res, await svc.grants(req.auth!)));
  r.get('/staff', async (_req, res) => sendData(res, await svc.supportStaff()));
  r.post('/', writable, requireStepUp, validate({ body: z.object({ granteeUserId: required(z.string().regex(/^usr_[a-f0-9]{28}$/)), reason: required(shortText()) }).strict() }, { granteeUserId: 'SkyUp person', reason: 'Reason' }), async (req, res) => {
    const out = await svc.giveGrant(req.auth!, req.body, req);
    sendDone(res, out.grant, 'SUP-01', out.params, 201);
  });
  r.post('/:id/end', validate({ params: z.object({ id: z.string().regex(/^sgr_[a-f0-9]{28}$/) }) }), async (req, res) => { await svc.endGrant(req.auth!, String(req.params.id), req); sendDone(res, { ended: true }, 'SUP-02'); });
  return r;
}
export function supportUseRoutes() {
  const r = Router();
  r.use(authenticate, allow('support.use'));
  const p = z.object({ accountId: z.string().regex(/^acc_[a-f0-9]{28}$/) });
  r.get('/:accountId/customers', validate({ params: p }), async (req, res) => sendData(res, await svc.supportCustomers(req.auth!, String(req.params.accountId))));
  r.get('/:accountId/customers/:id', validate({ params: p.extend({ id: z.string().regex(/^cus_[a-f0-9]{28}$/) }) }), async (req, res) => sendData(res, await svc.supportCustomer(req.auth!, String(req.params.accountId), String(req.params.id))));
  return r;
}
/** SkyUp admin: configuration (P-49), accounts (P-51), offline payments (P-47). */
export function adminRoutes() {
  const r = Router();
  r.use(authenticate);
  const chg = z.object({ id: z.string().regex(/^cfc_[a-f0-9]{28}$/) });
  r.get('/config', allow('config.manage'), async (_req, res) => sendData(res, svc.configList()));
  r.get('/config/history', allow('config.manage'), async (_req, res) => sendData(res, await svc.configHistory()));
  r.post('/config/:id/changes', allow('config.manage'), requireStepUp, validate({ params: z.object({ id: z.string().regex(/^CFG-\d{1,3}$/) }), body: z.object({ value: z.unknown(), reason: required(shortText()) }).strict() }, { value: 'Value', reason: 'Reason' }), async (req, res) =>
    sendDone(res, await svc.requestConfigChange(req.auth!, String(req.params.id), req.body.value, req.body.reason, req), 'ADM-06', {}, 201));
  r.post('/config/changes/:id/approve', allow('config.manage'), requireStepUp, validate({ params: chg }), async (req, res) => sendDone(res, await svc.decideConfigChange(req.auth!, String(req.params.id), true, req), 'ADM-06'));
  r.post('/config/changes/:id/reject', allow('config.manage'), validate({ params: chg }), async (req, res) => sendData(res, await svc.decideConfigChange(req.auth!, String(req.params.id), false, req)));
  r.get('/accounts', allow('accounts.admin'), async (_req, res) => sendData(res, await svc.accounts()));
  // Changes #53, #54: subscriptions across advisors with invoice detail; the wallets overview
  r.get('/subscriptions', allow('subscriptions.view'), validate({ query: z.object({ status: z.enum(['ALL', 'TRIAL', 'ACTIVE', 'GRACE', 'EXPIRED']).optional() }) }), async (req, res) =>
    sendData(res, await svc.subscriptions(res.locals.query as { status?: string })));
  r.get('/invoices/:id', allow('subscriptions.view'), validate({ params: z.object({ id: z.string().regex(/^sor_[a-f0-9]{28}$/) }) }), async (req, res) => sendData(res, await svc.invoice(String(req.params.id))));
  r.get('/wallets', allow('wallets.view'), validate({ query: z.object({ filter: z.enum(['ALL', 'LOW', 'EMPTY']).optional() }) }), async (req, res) =>
    sendData(res, await svc.wallets(res.locals.query as { filter?: 'ALL' | 'LOW' | 'EMPTY' })));
  r.post('/accounts/:id/suspend', allow('accounts.admin'), requireStepUp, validate({ params: accId, body: reason }, { reason: 'Reason' }), async (req, res) => { await svc.suspend(req.auth!, String(req.params.id), req.body.reason, req); sendDone(res, { status: 'SUSPENDED' }, 'ADM-07'); });
  r.post('/accounts/:id/reactivate', allow('accounts.admin'), requireStepUp, validate({ params: accId, body: reason }, { reason: 'Reason' }), async (req, res) => { await svc.reactivate(req.auth!, String(req.params.id), req.body.reason, req); sendDone(res, { status: 'ACTIVE' }, 'ADM-08'); });
  r.post('/accounts/:id/close', allow('accounts.admin'), requireStepUp, validate({ params: accId, body: reason }, { reason: 'Reason' }), async (req, res) => { const out = await svc.close(req.auth!, String(req.params.id), req.body.reason, req); sendDone(res, { status: 'CLOSED' }, 'ADM-09', out); });
  r.post('/accounts/:id/offline-payment', allow('accounts.admin'), requireStepUp, validate({ params: accId, body: z.object({ plan: required(PLAN), cycle: required(CYCLE), amount: z.number().positive(), reference: required(shortText()), startDate: optional(date()), replace: z.boolean().optional() }).strict() }, { reference: 'Payment reference', amount: 'Amount' }), async (req, res) =>
    sendData(res, await svc.offlinePayment(req.auth!, String(req.params.id), req.body, req), 201));
  return r;
}
export function subscriptionWebhookRoutes() { const r = Router(); r.post('/', async (req, res) => sendData(res, await svc.subscriptionWebhook(req))); return r; }