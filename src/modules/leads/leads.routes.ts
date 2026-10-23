import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { allow, writable } from '../../middleware/authorize.js';
import { idempotent } from '../../middleware/idempotency.js';
import { validate } from '../../middleware/validate.js';
import { sendData, sendDone } from '../../lib/response.js';
import { contactBody, convertBody, createLeadBody, duplicateQuery, labels, leadIdParam, listLeadsQuery, statusBody, updateLeadBody } from './leads.schemas.js';
import * as leads from './leads.service.js';

const id = (req: { params: unknown }) => (req.params as { id: string }).id;

export function pipelineRoutes() {
  const r = Router();
  r.get('/', authenticate, allow('leads.work'), async (req, res) => sendData(res, await leads.listPipelines(req.auth!)));
  return r;
}

export function leadRoutes() {
  const r = Router();
  r.use(authenticate, allow('leads.work'));
  r.get('/', validate({ query: listLeadsQuery }), async (req, res) => {
    const { items, meta } = await leads.listLeads(req.auth!, res.locals.query);
    sendData(res, items, 200, meta);
  });
  r.get('/duplicate-check', validate({ query: duplicateQuery }, labels), async (req, res) => sendData(res, await leads.duplicateCheck(req.auth!, res.locals.query)));
  r.post('/', writable, validate({ body: createLeadBody }, labels), idempotent(), async (req, res) => {
    const lead = await leads.createLead(req.auth!, req.body, req);
    sendDone(res, lead, 'LD-01', { 'lead number': lead.number }, 201);
  });
  r.get('/:id', validate({ params: leadIdParam }), async (req, res) => sendData(res, await leads.getLead(req.auth!, id(req))));
  r.patch('/:id', writable, validate({ params: leadIdParam, body: updateLeadBody }, labels), async (req, res) =>
    sendDone(res, await leads.updateLead(req.auth!, id(req), req.body, req), 'GEN-08', { 'Record type': 'Lead' }));
  r.post('/:id/status', writable, validate({ params: leadIdParam, body: statusBody }, labels), idempotent(), async (req, res) => {
    const out = await leads.changeStatus(req.auth!, id(req), req.body, req);
    sendDone(res, out.lead, out.messageId, out.params);
  });
  r.post('/:id/contacts', writable, validate({ params: leadIdParam, body: contactBody }, labels), idempotent(), async (req, res) =>
    sendDone(res, await leads.logContact(req.auth!, id(req), req.body, req), 'GEN-08', { 'Record type': 'Contact' }, 201));
  r.post('/:id/convert', writable, validate({ params: leadIdParam, body: convertBody }, labels), idempotent(), async (req, res) => {
    const out = await leads.convertLead(req.auth!, id(req), req.body, req);
    sendDone(res, { lead: out.lead, customer: out.customer, outcome: out.outcome }, out.messageId, out.params);
  });
  return r;
}
