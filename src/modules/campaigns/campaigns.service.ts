import type { Request } from 'express';
import { createHmac, randomBytes } from 'node:crypto';
import { cfgNum } from '../../config/cfg.js';
import { env } from '../../config/env.js';
import { clock } from '../../lib/clock.js';
import { AppError } from '../../lib/errors.js';
import { msg } from '../../lib/messages.js';
import { isDuplicateKey, withTx } from '../../lib/mongo.js';
import { sourceLabel, type LeadSourceCode } from '../../lib/leadSources.js';
import { normalizeMobile } from '../../lib/phone.js';
import { hitCounter } from '../../lib/rateCounter.js';
import { Account } from '../accounts/account.model.js';
import { nextNumber } from '../accounts/numbers.js';
import { effectiveStatus } from '../accounts/subscription.js';
import { audit } from '../audit/audit.service.js';
import { flagOn, type FlagKey } from '../flags/flags.js';
import { Consent, Customer } from '../customers/customer.model.js';
import { Lead } from '../leads/lead.model.js';
import { notify } from '../notifications/notifications.service.js';
import type { AuthContext } from '../rbac/capabilities.js';
import { Task } from '../tasks/task.model.js';
import { User } from '../users/user.model.js';
import { Connection, LeadForm, Submission, type Channel, type ConnectionDoc, type FormDoc, type SubmissionDoc } from './campaign.model.js';

/** Lead source of an imported lead, by channel (stable codes, lib/leadSources.ts). */
const SOURCE: Record<Channel, LeadSourceCode> = { WEBSITE: 'WEBSITE_FORM', GOOGLE: 'GOOGLE_ADS', META: 'META_ADS', LINKEDIN: 'LINKEDIN_ADS' };
const LABEL: Record<Channel, string> = { WEBSITE: 'Website form', GOOGLE: 'Google Ads', META: 'Meta Ads', LINKEDIN: 'LinkedIn' };
/** Rollout switch per channel (change analysis §7.4 step 8). LinkedIn cannot be connected yet, so it has none. */
const CHANNEL_FLAG: Record<Channel, FlagKey | null> = { WEBSITE: 'campaigns_website', GOOGLE: 'campaigns_google', META: 'campaigns_meta', LINKEDIN: null };
const channelOn = (channel: Channel, accountId: string) => { const f = CHANNEL_FLAG[channel]; return !f || flagOn(f, accountId); };
const FIELDS = ['name', 'first_name', 'last_name', 'mobile', 'email', 'city', 'consent', 'ignore'] as const;
type Answer = { key: string; label: string; value: string };

// ── Keys: shown once, stored as a keyed hash (one lookup, no decrypting anyone's secrets) ──
const hashKey = (k: string) => createHmac('sha256', `${env.WEBHOOK_SECRET}:campaign-keys`).update(k.trim()).digest('hex');
const newKey = (channel: Channel) => `${channel === 'GOOGLE' ? 'byg' : 'byw'}_${randomBytes(24).toString('base64url')}`;
export async function connectionByKey(key: string | undefined | null, channel: Channel) {
  if (!key || key.length < 16 || key.length > 200) return null;
  const h = hashKey(key);
  const c = await Connection.findOne({ channel, status: 'CONNECTED', $or: [{ keyHash: h }, { prevKeyHash: h, prevKeyUntil: { $gt: clock.now() } }] }).lean<ConnectionDoc>();
  return c;
}

const hookUrl = (c: { _id: string; channel: string }) => `${process.env.PUBLIC_API_URL ?? 'http://localhost:4000'}/v1/hooks/${c.channel === 'GOOGLE' ? 'google' : 'website'}`;
const view = (c: ConnectionDoc) => ({ id: c._id, channel: c.channel, name: c.name, status: c.status, keyLast4: c.keyLast4, pipelineId: c.pipelineId, lastLeadAt: c.lastLeadAt, createdAt: c.createdAt, webhookUrl: hookUrl(c) });

/** + Website form / + Google Ads: the key is in the answer once (CMP-02). Meta and LinkedIn connect by sign-in (later). */
export async function connect(ctx: AuthContext, b: { channel: 'WEBSITE' | 'GOOGLE'; name: string; pipelineId?: string | null }, req: Request) {
  if (!channelOn(b.channel, ctx.accountId!)) throw new AppError(409, 'INVALID_STATE', 'CMP-08', { channel: LABEL[b.channel] });
  const key = newKey(b.channel);
  const c = await Connection.create({ accountId: ctx.accountId, channel: b.channel, name: b.name, keyHash: hashKey(key), keyLast4: key.slice(-4), pipelineId: b.pipelineId ?? null, createdBy: ctx.userId });
  await audit({ entity: 'campaign', entityId: c._id, action: 'CAMPAIGN_CONNECTED', after: { channel: b.channel, name: b.name } }, { req });
  return { connection: view(c.toObject() as ConnectionDoc), key };
}
async function loadConn(ctx: AuthContext, id: string) { const c = await Connection.findOne({ _id: id, accountId: ctx.accountId }).lean<ConnectionDoc>(); if (!c) throw AppError.notFound(); return c; }
export async function rotateKey(ctx: AuthContext, id: string, req: Request) {
  const c = await loadConn(ctx, id);
  if (c.channel === 'META' || c.channel === 'LINKEDIN') throw AppError.invalidState('connection', 'connected by sign-in');
  const key = newKey(c.channel as Channel);
  await Connection.updateOne({ _id: id }, { $set: { keyHash: hashKey(key), keyLast4: key.slice(-4), prevKeyHash: c.keyHash, prevKeyUntil: new Date(clock.now().getTime() + cfgNum('CFG-196') * 86_400_000) } });
  await audit({ entity: 'campaign', entityId: id, action: 'CAMPAIGN_KEY_ROTATED' }, { req });
  return { connection: view((await Connection.findById(id).lean<ConnectionDoc>())!), key };
}
export async function setStatus(ctx: AuthContext, id: string, on: boolean, req: Request) {
  const c = await loadConn(ctx, id);
  await Connection.updateOne({ _id: id }, { $set: { status: on ? 'CONNECTED' : 'DISCONNECTED' } });
  await audit({ entity: 'campaign', entityId: id, action: on ? 'CAMPAIGN_RECONNECTED' : 'CAMPAIGN_DISCONNECTED' }, { req });
  return { connection: view((await Connection.findById(id).lean<ConnectionDoc>())!), params: { name: c.name } };
}
export async function connections(ctx: AuthContext) {
  const rows = await Connection.find({ accountId: ctx.accountId }).sort({ createdAt: -1 }).lean<ConnectionDoc[]>();
  const since = new Date(clock.now().getTime() - 30 * 86_400_000);
  return Promise.all(rows.map(async (c) => {
    const counts = await Submission.aggregate<{ _id: string; n: number }>([{ $match: { connectionId: c._id, createdAt: { $gte: since } } }, { $group: { _id: '$status', n: { $sum: 1 } } }]);
    return { ...view(c), last30Days: Object.fromEntries(counts.map((x) => [x._id, x.n])) };
  }));
}

// ── Forms and mapping ──
export async function forms(ctx: AuthContext, connectionId?: string) {
  return LeadForm.find({ accountId: ctx.accountId, ...(connectionId ? { connectionId } : {}) }).sort({ createdAt: -1 }).lean<FormDoc[]>();
}
export async function saveForm(ctx: AuthContext, id: string, b: { name?: string; campaignName?: string | null; fieldMap?: Record<string, string>; pipelineId?: string | null; active?: boolean }, req: Request) {
  const f = await LeadForm.findOne({ _id: id, accountId: ctx.accountId }).lean<FormDoc>();
  if (!f) throw AppError.notFound();
  if (b.fieldMap && Object.values(b.fieldMap).some((v) => !(FIELDS as readonly string[]).includes(v))) throw AppError.field('fieldMap', 'VAL-22');
  await LeadForm.updateOne({ _id: id }, { $set: { ...(b.name ? { name: b.name } : {}), ...(b.campaignName !== undefined ? { campaignName: b.campaignName } : {}), ...(b.fieldMap ? { fieldMap: b.fieldMap } : {}), ...(b.pipelineId !== undefined ? { pipelineId: b.pipelineId } : {}), ...(b.active !== undefined ? { active: b.active } : {}) } });
  await audit({ entity: 'campaign', entityId: id, action: 'CAMPAIGN_FORM_SAVED', after: b }, { req });
  return (await LeadForm.findById(id).lean<FormDoc>())!;
}
/** Our own embeddable website form: fields shown, a public key for the link (no secret in the page). */
export async function createEmbedForm(ctx: AuthContext, connectionId: string, b: { name: string; campaignName?: string | null; consentText?: string | null }, req: Request) {
  const c = await loadConn(ctx, connectionId);
  if (c.channel !== 'WEBSITE') throw AppError.invalidState('connection', c.channel);
  const publicKey = randomBytes(12).toString('base64url');
  const fields = [{ key: 'name', label: 'Your name', type: 'text', required: true }, { key: 'mobile', label: 'Mobile', type: 'tel', required: true }, { key: 'email', label: 'Email', type: 'email', required: false }, { key: 'city', label: 'City', type: 'text', required: false }, { key: 'message', label: 'What are you looking for?', type: 'textarea', required: false }, { key: 'consent', label: b.consentText ?? 'I agree to be contacted by phone and WhatsApp about insurance.', type: 'checkbox', required: true }];
  const f = await LeadForm.create({ accountId: ctx.accountId, connectionId, channel: 'WEBSITE', externalId: `embed:${publicKey}`, name: b.name, campaignName: b.campaignName ?? null, fields, publicKey, fieldMap: { name: 'name', mobile: 'mobile', email: 'email', city: 'city', consent: 'consent' } });
  await audit({ entity: 'campaign', entityId: f._id, action: 'CAMPAIGN_EMBED_FORM_CREATED' }, { req });
  return f.toObject();
}

// ── The import: store first, then map, check, link or create, consent, task, bell ──
const norm = (k: string) => k.toLowerCase().replace(/[^a-z0-9]/g, '');
const AUTO: Record<string, string> = {
  fullname: 'name', name: 'name', yourname: 'name', firstname: 'first_name', lastname: 'last_name',
  phonenumber: 'mobile', phone: 'mobile', mobile: 'mobile', mobilenumber: 'mobile', contact: 'mobile', contactnumber: 'mobile', whatsapp: 'mobile',
  email: 'email', emailaddress: 'email', workemail: 'email', city: 'city', consent: 'consent',
};
function mapAnswers(answers: Answer[], fieldMap: Record<string, string>) {
  const out: Record<string, string> = {};
  for (const a of answers) {
    const to = fieldMap[a.key] ?? AUTO[norm(a.key)];
    if (to && to !== 'ignore' && a.value && !out[to]) out[to] = a.value.trim();
  }
  const name = out.name || [out.first_name, out.last_name].filter(Boolean).join(' ');
  return { name: name.trim(), mobile: out.mobile ? normalizeMobile(out.mobile) : null, email: out.email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(out.email) ? out.email.toLowerCase() : null, city: out.city ?? null, consent: /^(yes|true|1|on|checked|agree|agreed|y)$/i.test(out.consent ?? '') };
}

/** Store first. A repeated platform lead ID returns the stored submission, so the platform's retries never duplicate. */
export async function ingest(conn: ConnectionDoc, b: { externalId: string; formExternalId: string; formName: string; answers: Answer[]; meta?: Record<string, unknown>; isTest?: boolean }) {
  let form = await LeadForm.findOne({ connectionId: conn._id, externalId: b.formExternalId }).lean<FormDoc>();
  if (!form) {
    try { form = (await LeadForm.create({ accountId: conn.accountId, connectionId: conn._id, channel: conn.channel, externalId: b.formExternalId, name: b.formName })).toObject() as FormDoc; }
    catch (e) { if (!isDuplicateKey(e)) throw e; form = (await LeadForm.findOne({ connectionId: conn._id, externalId: b.formExternalId }).lean<FormDoc>())!; }
  }
  const keys = b.answers.map((a) => a.key).filter((k) => !form!.seenKeys.includes(k));
  if (keys.length) await LeadForm.updateOne({ _id: form._id }, { $addToSet: { seenKeys: { $each: keys } } });
  let sub: SubmissionDoc;
  try { sub = (await Submission.create({ accountId: conn.accountId, connectionId: conn._id, formId: form._id, channel: conn.channel, externalId: b.externalId, answers: b.answers, meta: b.meta ?? {}, isTest: !!b.isTest })).toObject() as SubmissionDoc; }
  catch (e) { if (isDuplicateKey(e)) return { submission: (await Submission.findOne({ connectionId: conn._id, externalId: b.externalId }).lean<SubmissionDoc>())!, duplicate: true }; throw e; }
  await Connection.updateOne({ _id: conn._id }, { $set: { lastLeadAt: clock.now() } });
  return { submission: await processSubmission(sub._id), duplicate: false };
}

/** Import one stored submission. Safe to run again (Retry): an IMPORTED or LINKED one is left as it is. */
export async function processSubmission(id: string): Promise<SubmissionDoc> {
  const s = await Submission.findById(id).lean<SubmissionDoc>();
  if (!s || ['IMPORTED', 'LINKED'].includes(s.status)) return s!;
  const done = async (status: string, set: Record<string, unknown> = {}) => (await Submission.findOneAndUpdate({ _id: id }, { $set: { status, ...set }, $inc: { attempts: 1 } }, { new: true }).lean<SubmissionDoc>())!;
  try {
    const [conn, form, acc] = await Promise.all([Connection.findById(s.connectionId).lean<ConnectionDoc>(), s.formId ? LeadForm.findById(s.formId).lean<FormDoc>() : null, Account.findById(s.accountId).lean<{ status: string; subscription: Parameters<typeof effectiveStatus>[0]; pipelines: Array<{ _id: string; position?: number }> }>()]);
    if (!conn || !acc) return done('FAILED', { reason: 'Connection removed' });
    if (s.isTest) return done('SKIPPED', { reason: 'Test lead · not counted' });
    if (form && !form.active) return done('SKIPPED', { reason: 'Form switched off' });
    // Kept as FAILED (not lost): Retry imports it once the channel is switched on for the account.
    if (!channelOn(conn.channel as Channel, s.accountId)) return done('FAILED', { reason: `${LABEL[conn.channel as Channel]} is not switched on for this account` });
    if (acc.status !== 'ACTIVE') return done('FAILED', { reason: acc.status === 'SUSPENDED' ? 'Account suspended' : 'Account closed' });
    if (effectiveStatus(acc.subscription, clock.now()) === 'EXPIRED') return done('FAILED', { reason: 'Account is read-only: renew the plan, then Retry' });
    const m = mapAnswers(s.answers as unknown as Answer[], (form?.fieldMap ?? {}) as Record<string, string>);
    if (!m.mobile) return done('SKIPPED', { reason: 'No valid Indian mobile number in the form' });
    // Duplicates: an open lead or a customer with this mobile is linked, never duplicated
    const open = await Lead.findOne({ accountId: s.accountId, isOpen: true, $or: [{ mobile: m.mobile }, { altMobile: m.mobile }] }, { _id: 1, name: 1 }).lean<{ _id: string; name: string }>();
    if (open) return done('LINKED', { leadId: open._id, reason: 'Already an open lead' });
    const cus = await Customer.findOne({ accountId: s.accountId, $or: [{ mobile: m.mobile }, { altMobile: m.mobile }] }, { _id: 1 }).lean<{ _id: string }>();
    if (cus) return done('LINKED', { customerId: cus._id, reason: 'Already a customer' });
    const pipelineId = form?.pipelineId ?? conn.pipelineId ?? [...acc.pipelines].sort((x, y) => (x.position ?? 0) - (y.position ?? 0))[0]?._id;
    const adv = await User.findOne({ accountId: s.accountId, role: 'ADV' }, { _id: 1 }).lean<{ _id: string }>();
    const name = m.name || `${LABEL[conn.channel as Channel]} lead`;
    const campaign = form?.campaignName ?? (s.meta as { campaignName?: string }).campaignName ?? form?.name ?? null;
    const leadId = await withTx(async (session) => {
      const number = await nextNumber(s.accountId, 'lead', session);
      const now = clock.now();
      const [lead] = await Lead.create([{ accountId: s.accountId, number, pipelineId, name, nameKey: name.toLowerCase().replace(/\s+/g, ' '), mobile: m.mobile, email: m.email,
        source: sourceLabel(SOURCE[conn.channel as Channel]), sourceCode: SOURCE[conn.channel as Channel], campaign, adRef: { channel: conn.channel, connectionId: conn._id, formId: s.formId, externalId: s.externalId, submissionId: s._id },
        notes: m.city ? `City: ${m.city}` : null, status: 'NEW', isOpen: true, createdBy: adv?._id ?? 'SYSTEM', nextFollowUpAt: new Date(now.getTime() + cfgNum('CFG-195') * 60_000),
        stageHistory: [{ from: null, to: 'NEW', by: adv?._id ?? 'SYSTEM', at: now }] }], { session: session ?? undefined });
      if (m.consent) await Consent.create([{ accountId: s.accountId, personKey: `L:${lead!._id}`, channel: 'WHATSAPP', status: 'GIVEN', address: m.mobile, howGiven: conn.channel === 'WEBSITE' ? 'Website form tick' : 'Ad form tick', recordedBy: adv?._id ?? 'SYSTEM', recordedAt: now }], { session: session ?? undefined });
      await Task.create([{ accountId: s.accountId, kind: 'LEAD_FOLLOW_UP', title: `Call ${name} (new ${LABEL[conn.channel as Channel]} lead)`, dueAt: new Date(now.getTime() + cfgNum('CFG-195') * 60_000), linkedType: 'LEAD', linkedId: lead!._id, createdBy: adv?._id ?? null }], { session: session ?? undefined });
      return lead!._id as string;
    });
    if (adv) await notify({ userId: adv._id, accountId: s.accountId, kind: 'AD_LEAD', messageId: 'CMP-01', params: { channel: LABEL[conn.channel as Channel], name }, dedupeKey: `CMP-01|${s._id}`, link: { type: 'LEAD', id: leadId } }).catch(() => undefined);
    return done('IMPORTED', { leadId, reason: null });
  } catch (e) {
    return done('FAILED', { reason: (e as Error).message.slice(0, 200) });
  }
}

export async function retry(ctx: AuthContext, id: string, req: Request) {
  const s = await Submission.findOne({ _id: id, accountId: ctx.accountId }).lean<SubmissionDoc>();
  if (!s) throw AppError.notFound();
  if (!['FAILED', 'SKIPPED', 'RECEIVED'].includes(s.status) || s.isTest) throw AppError.invalidState('submission', s.status);
  await Submission.updateOne({ _id: id }, { $set: { status: 'RECEIVED' } });
  const out = await processSubmission(id);
  await audit({ entity: 'campaign', entityId: id, action: 'CAMPAIGN_SUBMISSION_RETRIED', after: { status: out.status } }, { req });
  return out;
}
/** The sync log (every submission with its outcome and reason). */
export async function submissions(ctx: AuthContext, q: { status?: string; channel?: string; connectionId?: string }) {
  return Submission.find({ accountId: ctx.accountId, ...(q.status ? { status: q.status } : {}), ...(q.channel ? { channel: q.channel } : {}), ...(q.connectionId ? { connectionId: q.connectionId } : {}) }).sort({ createdAt: -1 }).limit(300).lean<SubmissionDoc[]>();
}
/** All form submissions behind a lead (the original import and any later linked ones), answers as submitted. */
export async function leadAnswers(ctx: AuthContext, leadId: string) {
  return (await Submission.find({ accountId: ctx.accountId, leadId }).sort({ createdAt: -1 }).lean<SubmissionDoc[]>()).map((s) => ({ id: s._id, channel: s.channel, status: s.status, at: s.createdAt, answers: s.answers, campaign: (s.meta as { campaignName?: string }).campaignName ?? null }));
}

// ── Receivers ──
/**
 * Google Ads lead form webhook (ported from the previous CRM, with fixes): google_key found by keyed hash; the
 * stable column_id read first (column_name is deprecated); test leads kept but not counted; repeats by lead_id ignored.
 */
export async function googleHook(body: Record<string, unknown>) {
  const conn = await connectionByKey(String(body.google_key ?? ''), 'GOOGLE');
  if (!conn) throw AppError.forbidden();
  const leadId = String(body.lead_id ?? '').slice(0, 200);
  if (!leadId) throw AppError.field('lead_id', 'GEN-01', { 'Field label': 'lead_id' });
  const cols = Array.isArray(body.user_column_data) ? (body.user_column_data as Array<Record<string, unknown>>) : [];
  const answers: Answer[] = cols.slice(0, 100).map((c) => { const key = String(c.column_id ?? c.column_name ?? 'FIELD').slice(0, 80); return { key, label: String(c.column_name ?? key).slice(0, 120), value: String(c.string_value ?? '').slice(0, 2000) }; });
  const formId = String(body.form_id ?? 'google-form');
  return ingest(conn, { externalId: leadId, formExternalId: formId, formName: `Google Ads form ${formId}`, answers, isTest: body.is_test === true || body.is_test === 'true',
    meta: { campaignId: body.campaign_id ?? null, adGroupId: body.adgroup_id ?? null, creativeId: body.creative_id ?? null, gclid: body.gcl_id ?? null } });
}

/** Website webhook (your own form or WordPress): key in X-Bimayantra-Key or the body; per-IP limit; spam trap. */
export async function websiteHook(body: Record<string, unknown>, key: string | null, ip: string) {
  const ipHits = await hitCounter(`web-form:${createHmac('sha256', 'ip').update(ip).digest('hex').slice(0, 24)}`, 3600);
  if (ipHits.count > cfgNum('CFG-194')) throw new AppError(429, 'RATE_LIMITED', 'REF-09');
  const conn = await connectionByKey(key ?? String(body.key ?? body.secret ?? ''), 'WEBSITE');
  if (!conn) throw AppError.forbidden();
  if (body.website) return { trapped: true }; // the invisible spam-trap field: looks accepted, stores nothing
  const answers = toAnswers(body, ['key', 'secret', 'formName', 'form', 'submissionId', 'website', 'pageUrl']);
  const formName = String(body.formName ?? body.form ?? 'Website form').slice(0, 120);
  const externalId = String(body.submissionId ?? `${formName}:${answers.map((a) => a.value).join('|')}:${Math.floor(clock.now().getTime() / 60_000)}`).slice(0, 300); // a double submit in the same minute is one
  return ingest(conn, { externalId, formExternalId: formName, formName, answers, meta: { pageUrl: body.pageUrl ?? null } });
}
function toAnswers(body: Record<string, unknown>, skip: string[]): Answer[] {
  const flat: Record<string, unknown> = { ...body, ...((body.fields && typeof body.fields === 'object') ? (body.fields as Record<string, unknown>) : {}) };
  delete flat.fields;
  return Object.entries(flat).filter(([k, v]) => !skip.includes(k) && v !== null && v !== undefined && typeof v !== 'object').slice(0, 60).map(([k, v]) => ({ key: k.slice(0, 80), label: k.slice(0, 120), value: String(v).slice(0, 2000) }));
}

/** Our embeddable form: the public page reads its fields; submitting needs no secret (per-IP limit and spam trap). */
export async function publicForm(publicKey: string) {
  const f = await LeadForm.findOne({ publicKey, active: true }).lean<FormDoc>();
  const conn = f ? await Connection.findOne({ _id: f.connectionId, status: 'CONNECTED' }).lean<ConnectionDoc>() : null;
  if (!f || !conn) return { valid: false };
  const adv = await User.findOne({ accountId: f.accountId, role: 'ADV' }, { name: 1 }).lean<{ name: string }>();
  return { valid: true, name: f.name, advisorName: adv?.name ?? '', fields: f.fields };
}
export async function submitPublicForm(publicKey: string, body: Record<string, unknown>, ip: string) {
  const ipHits = await hitCounter(`web-form:${createHmac('sha256', 'ip').update(ip).digest('hex').slice(0, 24)}`, 3600);
  if (ipHits.count > cfgNum('CFG-194')) throw new AppError(429, 'RATE_LIMITED', 'REF-09');
  const f = await LeadForm.findOne({ publicKey, active: true }).lean<FormDoc>();
  const conn = f ? await Connection.findOne({ _id: f.connectionId, status: 'CONNECTED' }).lean<ConnectionDoc>() : null;
  if (!f || !conn) throw AppError.notFound();
  const first = String(body.name ?? '').trim().split(' ')[0] ?? '';
  if (body.website) return { params: { 'first name': first } };
  const fields = (f.fields ?? []) as Array<{ key: string; label: string; required: boolean }>;
  for (const x of fields) if (x.required && !String(body[x.key] ?? '').trim()) throw AppError.field(x.key, 'GEN-01', { 'Field label': x.label });
  if (!normalizeMobile(String(body.mobile ?? ''))) throw AppError.field('mobile', 'VAL-01');
  const answers = fields.map((x) => ({ key: x.key, label: x.label, value: String(body[x.key] ?? '').slice(0, 2000) })).filter((a) => a.value);
  await ingest(conn, { externalId: `${publicKey}:${answers.map((a) => a.value).join('|')}:${Math.floor(clock.now().getTime() / 60_000)}`, formExternalId: f.externalId, formName: f.name, answers });
  return { params: { 'first name': first } };
}
void msg;