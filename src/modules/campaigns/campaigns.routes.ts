import express, { Router } from 'express';
import cors from 'cors';
import { z } from 'zod';
import { authenticate } from '../../middleware/authenticate.js';
import { allow, writable } from '../../middleware/authorize.js';
import { validate } from '../../middleware/validate.js';
import { enumOf, optional, required, shortText } from '../../lib/fields.js';
import { sendData, sendDone } from '../../lib/response.js';
import * as svc from './campaigns.service.js';

const cnx = z.object({ id: z.string().regex(/^cnx_[a-f0-9]{28}$/) });

/** Campaigns (Module 17): the advisor connects channels and maps forms; assistants see the sync log and form answers. */
export function campaignRoutes() {
  const r = Router();
  r.use(authenticate, allow('campaigns.view'));
  const m = [allow('campaigns.manage'), writable] as const;
  r.get('/connections', async (req, res) => sendData(res, await svc.connections(req.auth!)));
  r.post('/connections', ...m, validate({ body: z.object({ channel: required(enumOf(['WEBSITE', 'GOOGLE'] as const)), name: required(shortText()), pipelineId: z.string().max(40).nullable().optional() }).strict() }, { channel: 'Channel', name: 'Name' }), async (req, res) => {
    const out = await svc.connect(req.auth!, req.body, req);
    sendDone(res, out, 'CMP-02', {}, 201);
  });
  r.post('/connections/:id/rotate-key', ...m, validate({ params: cnx }), async (req, res) => sendDone(res, await svc.rotateKey(req.auth!, String(req.params.id), req), 'CMP-03'));
  r.post('/connections/:id/disconnect', ...m, validate({ params: cnx }), async (req, res) => { const out = await svc.setStatus(req.auth!, String(req.params.id), false, req); sendDone(res, out.connection, 'CMP-04', out.params); });
  r.post('/connections/:id/reconnect', ...m, validate({ params: cnx }), async (req, res) => sendData(res, (await svc.setStatus(req.auth!, String(req.params.id), true, req)).connection));
  r.post('/connections/:id/embed-forms', ...m, validate({ params: cnx, body: z.object({ name: required(shortText()), campaignName: optional(shortText()), consentText: optional(z.string().max(300)) }).strict() }, { name: 'Form name' }), async (req, res) =>
    sendData(res, await svc.createEmbedForm(req.auth!, String(req.params.id), req.body, req), 201));
  r.get('/forms', validate({ query: z.object({ connectionId: z.string().max(40).optional() }) }), async (req, res) => sendData(res, await svc.forms(req.auth!, req.query.connectionId ? String(req.query.connectionId) : undefined)));
  r.put('/forms/:id', ...m, validate({ params: z.object({ id: z.string().regex(/^lfm_[a-f0-9]{28}$/) }), body: z.object({ name: optional(shortText()), campaignName: optional(shortText()), fieldMap: z.record(z.string().max(80), z.string().max(20)).optional(), pipelineId: z.string().max(40).nullable().optional(), active: z.boolean().optional() }).strict() }), async (req, res) =>
    sendDone(res, await svc.saveForm(req.auth!, String(req.params.id), req.body, req), 'CMP-06'));
  r.get('/submissions', validate({ query: z.object({ status: z.string().max(20).optional(), channel: z.string().max(20).optional(), connectionId: z.string().max(40).optional() }) }), async (req, res) =>
    sendData(res, await svc.submissions(req.auth!, req.query as Record<string, string>)));
  r.post('/submissions/:id/retry', ...m, validate({ params: z.object({ id: z.string().regex(/^sbm_[a-f0-9]{28}$/) }) }), async (req, res) => sendDone(res, await svc.retry(req.auth!, String(req.params.id), req), 'CMP-05'));
  r.get('/leads/:leadId/answers', validate({ params: z.object({ leadId: z.string().regex(/^led_[a-f0-9]{28}$/) }) }), async (req, res) => sendData(res, await svc.leadAnswers(req.auth!, String(req.params.leadId))));
  return r;
}

/** Platform receivers (no sign-in): authenticated by the connection key. Website posts come from other sites (CORS, no cookies). */
export function hookRoutes() {
  const r = Router();
  r.post('/google', async (req, res) => { const out = await svc.googleHook(req.body ?? {}); sendData(res, { received: true, status: out.submission.status, duplicate: out.duplicate }); });
  r.post('/website', express.urlencoded({ extended: false, limit: '64kb' }), async (req, res) => {
    const key = (req.headers['x-bimayantra-key'] as string | undefined) ?? null;
    const out = await svc.websiteHook(req.body ?? {}, key, req.ip ?? '');
    sendData(res, 'trapped' in out ? { received: true } : { received: true, status: out.submission.status, duplicate: out.duplicate });
  });
  return r;
}
export const websiteCors = cors({ origin: '*', credentials: false, methods: ['POST', 'OPTIONS'], allowedHeaders: ['Content-Type', 'X-Bimayantra-Key'] });

/** Our embeddable website form (public page /f/<key>). */
export function publicFormRoutes() {
  const r = Router();
  const k = z.object({ key: z.string().regex(/^[A-Za-z0-9_-]{12,40}$/) });
  r.get('/:key', validate({ params: k }), async (req, res) => { res.setHeader('X-Robots-Tag', 'noindex'); sendData(res, await svc.publicForm(String(req.params.key))); });
  r.post('/:key', validate({ params: k }), async (req, res) => { const out = await svc.submitPublicForm(String(req.params.key), req.body ?? {}, req.ip ?? ''); sendDone(res, { submitted: true }, 'CMP-07', out.params, 201); });
  return r;
}