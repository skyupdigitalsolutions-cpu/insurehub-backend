import { Router } from 'express';
import { z } from 'zod';
import { authenticate } from '../../middleware/authenticate.js';
import { allow, writable } from '../../middleware/authorize.js';
import { idempotent } from '../../middleware/idempotency.js';
import { validate } from '../../middleware/validate.js';
import { agentCode, confirmations, declaration, optional, recordId, required, todayOrLater, version } from '../../lib/fields.js';
import { sendData, sendDone } from '../../lib/response.js';
import * as svc from './myInsurers.service.js';
import { Insurer } from './insurer.model.js';

const labels = { insurerId: 'Insurer', agentCode: 'Agent code', validUntil: 'Code valid until', appointmentLetterFileId: 'Appointment letter', declaration: 'Declaration', version: 'Version' };
const idParam = z.object({ id: z.string().regex(/^map_[a-f0-9]{28}$/) });

const addBody = z.object({
  insurerId: required(recordId('ins')),
  agentCode: required(agentCode()),
  validUntil: optional(todayOrLater()),
  appointmentLetterFileId: optional(recordId('fil')),
  declaration: required(declaration()),
}).strict();
const editBody = z.object({
  version: required(version()),
  agentCode: agentCode().optional(), // cannot be cleared: it is required
  validUntil: optional(todayOrLater()),
  appointmentLetterFileId: optional(recordId('fil')),
}).strict();

/** Advisor: Settings → My insurers (P-07). */
export function myInsurersRoutes() {
  const r = Router();
  r.use(authenticate, allow('insurers.manage'));
  r.get('/', async (req, res) => sendData(res, await svc.listMine(req.auth!)));
  r.get('/available', validate({ query: z.object({ q: z.string().max(100).optional() }) }), async (req, res) =>
    sendData(res, await svc.available(req.auth!, req.query.q ? String(req.query.q) : undefined)));
  r.post('/', writable, validate({ body: addBody }, labels), idempotent(), async (req, res) => {
    const out = await svc.add(req.auth!, req.body, req);
    sendDone(res, out.view, 'PRF-08', out.params, 201);
  });
  r.patch('/:id', writable, validate({ params: idParam, body: editBody }, labels), async (req, res) =>
    sendData(res, await svc.edit(req.auth!, String(req.params.id), req.body, req)));
  r.post('/:id/deactivate', writable, validate({ params: idParam, body: z.object({ version: required(version()), confirm: confirmations() }).strict() }, labels), async (req, res) =>
    sendData(res, await svc.deactivate(req.auth!, String(req.params.id), req.body, req)));
  r.post('/:id/activate', writable, validate({ params: idParam, body: z.object({ version: required(version()) }).strict() }, labels), async (req, res) =>
    sendData(res, await svc.activate(req.auth!, String(req.params.id), req.body, req)));
  return r;
}

/**
 * The insurer catalogue as a pick list (name and status only), for forms that name an insurer outside the
 * advisor's own list, such as an old policy (P-18). ACTIVE first. Full catalogue screens: P-20 (Module 8).
 */
export function insurerCatalogueRoutes() {
  const r = Router();
  r.use(authenticate, allow('documents.work'));
  r.get('/', async (_req, res) => {
    const list = await Insurer.find({ status: { $in: ['ACTIVE', 'INACTIVE'] } }, { name: 1, category: 1, status: 1 }).sort({ status: 1, name: 1 }).lean();
    sendData(res, list.map((i) => ({ id: i._id, name: i.name, category: i.category, status: i.status })));
  });
  return r;
}

/** SkyUp: accounts sharing an insurer and agent code (DEC-09 [TO CONFIRM]). */
export function agentCodeFlagRoutes() {
  const r = Router();
  r.use(authenticate, allow('agentCodes.review'));
  r.get('/', async (_req, res) => sendData(res, await svc.sharedCodeFlags()));
  return r;
}