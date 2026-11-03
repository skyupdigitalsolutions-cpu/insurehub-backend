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
  // Meta / LinkedIn: sign in, then choose Pages or ad accounts
  r.get('/platforms', async (_req, res) => sendData(res, svc.platformReady()));
  r.post('/oauth/:channel/start', ...m, validate({ params: z.object({ channel: z.enum(['meta', 'linkedin']) }) }), async (req, res) =>
    sendData(res, await svc.oauthStart(req.auth!, String(req.params.channel).toUpperCase() as 'META' | 'LINKEDIN')));
  r.get('/connections/:id/sources', allow('campaigns.manage'), validate({ params: cnx }), async (req, res) => sendData(res, await svc.sources(req.auth!, String(req.params.id))));
  r.put('/connections/:id/sources', ...m, validate({ params: cnx, body: z.object({ ids: z.array(z.string().max(120)).max(100) }).strict() }), async (req, res) =>
    sendDone(res, await svc.saveSources(req.auth!, String(req.params.id), req.body.ids, req), 'CMP-11'));
  r.get('/leads/:leadId/answers', validate({ params: z.object({ leadId: z.string().regex(/^led_[a-f0-9]{28}$/) }) }), async (req, res) => sendData(res, await svc.leadAnswers(req.auth!, String(req.params.leadId))));
  return r;
}

/** Platform receivers (no sign-in): authenticated by the connection key. Website posts come from other sites (CORS, no cookies). */
export function hookRoutes() {
  const r = Router();
  r.post('/google', async (req, res) => { const out = await svc.googleHook(req.body ?? {}); sendData(res, { received: true, status: out.submission.status, duplicate: out.duplicate }); });
  // Meta: subscription check (GET, plain text) and signed lead webhooks
  r.get('/meta', (req, res) => { res.type('text/plain').send(svc.metaVerify(req.query as Record<string, unknown>)); });
  r.post('/meta', async (req, res) => sendData(res, await svc.metaHook(req)));
  // LinkedIn: challenge (GET, JSON) and signed lead notifications
  r.get('/linkedin', (req, res) => { res.json(svc.linkedinChallenge(String(req.query.challengeCode ?? ''))); });
  r.post('/linkedin', async (req, res) => sendData(res, await svc.linkedinHook(req)));
  // The platforms send the browser back here after sign-in; we return it to the Campaigns screen.
  r.get('/oauth/:channel/callback', async (req, res) => {
    const app = process.env.PUBLIC_APP_URL ?? 'http://localhost:5173';
    const channel = String(req.params.channel).toUpperCase();
    if ((channel !== 'META' && channel !== 'LINKEDIN') || req.query.error || !req.query.code) return res.redirect(302, `${app}/?campaigns=cancelled`);
    try { const c = await svc.oauthCallback(channel, String(req.query.code), String(req.query.state ?? '')); res.redirect(302, `${app}/?campaigns=connected&connection=${c._id}`); }
    catch { res.redirect(302, `${app}/?campaigns=error`); }
  });
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