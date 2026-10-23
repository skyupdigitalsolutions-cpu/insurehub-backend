import type { Request } from 'express';
import type { ClientSession } from 'mongoose';
import { AppError } from '../../lib/errors.js';
import { clock } from '../../lib/clock.js';
import { nameKey } from '../../lib/fields.js';
import { newId } from '../../lib/ids.js';
import { msg, type MessageId, type MessageParams } from '../../lib/messages.js';
import { isDuplicateKey, withTx } from '../../lib/mongo.js';
import { escapeRegex, pageMeta, pageSize } from '../../lib/pagination.js';
import { accountOf } from '../../middleware/authorize.js';
import { Account } from '../accounts/account.model.js';
import { nextNumber } from '../accounts/numbers.js';
import { audit } from '../audit/audit.service.js';
import { Customer } from '../customers/customer.model.js';
import { copyLeadConsents } from '../customers/consent.service.js';
import { customerSummary, insertCustomer } from '../customers/customers.service.js';
import type { CustomerExtras } from '../customers/customers.schemas.js';
import { can, type AuthContext } from '../rbac/capabilities.js';
import { Task } from '../tasks/task.model.js';
import { User } from '../users/user.model.js';
import { Lead, OUTCOME_LABEL, type LeadDoc } from './lead.model.js';
import { CONVERTIBLE, STATUS_LABEL, advisorOnly, allowedMoves, canConvert, canMove, type LeadStatus } from './leadStatus.js';

type FieldErr = { field: string; messageId: MessageId; params?: MessageParams };
const RECORD = 'lead';
const SOURCE_REFERRER = 'Referred by a referrer';
const SOURCE_CLIENT = 'Referred by a client';
const SOURCE_CAMPAIGN = 'Campaign';

// ── Views ────────────────────────────────────────────────────────────────────

function summary(l: LeadDoc, ctx: AuthContext) {
  return {
    id: l._id, number: l.number, pipelineId: l.pipelineId, name: l.name, mobile: l.mobile, source: l.source, priority: l.priority,
    status: l.status, statusLabel: STATUS_LABEL[l.status as LeadStatus], nextFollowUpAt: l.nextFollowUpAt, customerId: l.customerId,
    createdAt: l.createdAt, version: l.version,
    allowedMoves: allowedMoves(l.status as LeadStatus, ctx.role), canConvert: canConvert(l.status as LeadStatus, ctx.role),
  };
}

async function detail(l: LeadDoc, ctx: AuthContext) {
  const userIds = [...new Set([l.createdBy, l.referrerUserId, ...l.stageHistory.map((h) => h.by), ...l.contacts.map((c) => c.by)].filter(Boolean) as string[])];
  const [users, account, referredBy, customer, task] = await Promise.all([
    User.find({ _id: { $in: userIds } }, { name: 1 }).lean(),
    Account.findById(l.accountId, { pipelines: 1 }).lean(),
    l.referredByCustomerId ? Customer.findOne({ _id: l.referredByCustomerId, accountId: l.accountId }, { number: 1, name: 1 }).lean() : null,
    l.customerId ? Customer.findOne({ _id: l.customerId, accountId: l.accountId }, { number: 1, name: 1 }).lean() : null,
    Task.findOne({ linkedId: l._id, kind: 'LEAD_FOLLOW_UP', status: 'OPEN' }, { dueAt: 1, title: 1 }).lean(),
  ]);
  const name = (id?: string | null) => (id ? users.find((u) => u._id === id)?.name ?? null : null);
  return {
    ...summary(l, ctx),
    pipelineName: account?.pipelines.find((p) => p._id === l.pipelineId)?.name ?? null,
    altMobile: l.altMobile, email: l.email, campaign: l.campaign, interests: l.interests, notes: l.notes,
    referrer: l.referrerUserId ? { id: l.referrerUserId, name: name(l.referrerUserId) } : null,
    referredBy: referredBy ? { id: referredBy._id, number: referredBy.number, name: referredBy.name } : null,
    lostReason: l.lostReason, lostNote: l.lostNote, convertedAt: l.convertedAt,
    customer: customer ? { id: customer._id, number: customer.number, name: customer.name } : null,
    createdBy: name(l.createdBy), updatedAt: l.updatedAt,
    followUpTask: task ? { id: task._id, dueAt: task.dueAt, title: task.title } : null,
    // AC-P13-5: the timeline shows every contact and status change in order (newest first here).
    contacts: [...l.contacts].reverse().map((c) => ({ id: c._id, outcome: c.outcome, outcomeLabel: OUTCOME_LABEL[c.outcome as keyof typeof OUTCOME_LABEL], note: c.note, at: c.at, by: name(c.by) })),
    stageHistory: [...l.stageHistory].reverse().map((h) => ({ ...h, fromLabel: h.from ? STATUS_LABEL[h.from as LeadStatus] : null, toLabel: STATUS_LABEL[h.to as LeadStatus], by: name(h.by) })),
  };
}

const snapshot = (l: Partial<LeadDoc>) => ({
  name: l.name, mobile: l.mobile, altMobile: l.altMobile, email: l.email, source: l.source, referrerUserId: l.referrerUserId,
  referredByCustomerId: l.referredByCustomerId, campaign: l.campaign, pipelineId: l.pipelineId, priority: l.priority, status: l.status,
  nextFollowUpAt: l.nextFollowUpAt,
});

async function loadLead(ctx: AuthContext, id: string) {
  const lead = await Lead.findOne({ _id: id, accountId: accountOf(ctx) }).lean<LeadDoc>();
  if (!lead) throw AppError.notFound();
  return lead;
}

async function customerNumber(accountId: string, id: string | null | undefined) {
  return id ? (await Customer.findOne({ _id: id, accountId }, { number: 1 }).lean())?.number ?? '' : '';
}

// ── Rules ────────────────────────────────────────────────────────────────────

export async function findLeadDuplicates(accountId: string, mobile: string, key: string, excludeId?: string | null) {
  const [leads, customers] = await Promise.all([
    Lead.find({ accountId, mobile, isOpen: true, ...(excludeId ? { _id: { $ne: excludeId } } : {}) }, { number: 1, name: 1, nameKey: 1 }).lean(),
    Customer.find({ accountId, mobile, status: 'ACTIVE' }, { number: 1, name: 1 }).lean(),
  ]);
  return { exact: leads.find((l) => l.nameKey === key) ?? null, sameMobile: leads.filter((l) => l.nameKey !== key), customers };
}

const exactDuplicate = (l: { _id: string; number: string }) => new AppError(409, 'DUPLICATE', 'LD-02', { 'lead number': l.number }, { leadId: l._id },
  [{ field: 'mobile', messageId: 'LD-02', message: msg('LD-02', { 'lead number': l.number }) }]);

/** P-12: exact duplicate of an open lead is blocked (LD-02); same mobile, other name (LD-03) and an existing customer (LD-04) are warnings the user can save past. */
function applyDuplicateRule(d: Awaited<ReturnType<typeof findLeadDuplicates>>, confirm: string[]) {
  if (d.exact) throw exactDuplicate(d.exact);
  const warnings = [
    ...d.sameMobile.map((l) => ({ messageId: 'LD-03' as MessageId, params: { name: l.name, 'lead number': l.number }, recordType: 'lead', id: l._id, number: l.number })),
    ...d.customers.map((c) => ({ messageId: 'LD-04' as MessageId, params: { Name: c.name, 'customer number': c.number }, recordType: 'customer', id: c._id, number: c.number })),
  ].filter((w) => !confirm.includes(w.messageId));
  if (!warnings.length) return;
  const first = warnings[0]!;
  throw new AppError(409, 'CONFIRMATION_REQUIRED', first.messageId, first.params, {
    warnings: warnings.map(({ params, ...w }) => ({ ...w, message: msg(w.messageId, params) })),
  });
}

/** Source rules on the final state (P-12): referrer, referring client and campaign belong to their source only. */
async function resolveSource(accountId: string, s: { source: string; referrerId?: string | null; referredByCustomerId?: string | null; campaign?: string | null }) {
  const errs: FieldErr[] = [];
  const out = { source: s.source, referrerUserId: null as string | null, referredByCustomerId: null as string | null, campaign: null as string | null };
  if (s.source === SOURCE_REFERRER) {
    if (!s.referrerId) errs.push({ field: 'referrerId', messageId: 'GEN-01', params: { 'Field label': 'Referrer' } });
    else if (!(await User.exists({ _id: s.referrerId, accountId, role: 'REF', status: 'ACTIVE' }))) errs.push({ field: 'referrerId', messageId: 'VAL-22' });
    else out.referrerUserId = s.referrerId;
  } else if (s.source === SOURCE_CLIENT) {
    // "chosen from the advisor's registered customers only, free text is not allowed"
    if (!s.referredByCustomerId) errs.push({ field: 'referredByCustomerId', messageId: 'GEN-01', params: { 'Field label': 'Referred by client' } });
    else if (!(await Customer.exists({ _id: s.referredByCustomerId, accountId, status: 'ACTIVE' }))) errs.push({ field: 'referredByCustomerId', messageId: 'VAL-22' });
    else out.referredByCustomerId = s.referredByCustomerId;
  } else if (s.source === SOURCE_CAMPAIGN) {
    if (!s.campaign) errs.push({ field: 'campaign', messageId: 'GEN-01', params: { 'Field label': 'Campaign name' } });
    else out.campaign = s.campaign;
  }
  return { out, errs };
}

async function pipelineExists(accountId: string, pipelineId: string) {
  return !!(await Account.exists({ _id: accountId, 'pipelines._id': pipelineId }));
}

/** P-11 / AC-P11-3: a lead has a single open follow-up task; a new date moves it instead of adding another. */
async function setFollowUpTask(l: { _id: string; accountId: string; name: string; number: string; nextFollowUpAt?: Date | null }, by: string, session: ClientSession | null) {
  if (!l.nextFollowUpAt) return;
  const r = await Task.updateOne(
    { linkedId: l._id, kind: 'LEAD_FOLLOW_UP', status: 'OPEN' },
    { $set: { dueAt: l.nextFollowUpAt, title: `Follow up ${l.name} (${l.number})` }, $inc: { version: 1 } },
    { session: session ?? undefined },
  );
  if (r.matchedCount === 0) {
    await new Task({ accountId: l.accountId, kind: 'LEAD_FOLLOW_UP', title: `Follow up ${l.name} (${l.number})`, dueAt: l.nextFollowUpAt, linkedType: 'LEAD', linkedId: l._id, createdBy: by }).save({ session: session ?? undefined });
  }
}
const cancelFollowUpTask = (leadId: string, session: ClientSession | null) =>
  Task.updateMany({ linkedId: leadId, kind: 'LEAD_FOLLOW_UP', status: 'OPEN' }, { $set: { status: 'CANCELLED' }, $inc: { version: 1 } }, { session: session ?? undefined });

// ── Queries ──────────────────────────────────────────────────────────────────

export async function listPipelines(ctx: AuthContext) {
  const accountId = accountOf(ctx);
  const [account, counts] = await Promise.all([
    Account.findById(accountId, { pipelines: 1 }).lean(),
    Lead.aggregate<{ _id: { p: string; s: string }; n: number }>([{ $match: { accountId } }, { $group: { _id: { p: '$pipelineId', s: '$status' }, n: { $sum: 1 } } }]),
  ]);
  return (account?.pipelines ?? []).sort((a, b) => (a.position ?? 0) - (b.position ?? 0)).map((p) => ({
    id: p._id, name: p.name, position: p.position,
    counts: Object.fromEntries(Object.keys(STATUS_LABEL).map((s) => [s, counts.find((c) => c._id.p === p._id && c._id.s === s)?.n ?? 0])),
  }));
}

export async function listLeads(ctx: AuthContext, q: { page: number; limit?: number; pipelineId?: string; status?: string; source?: string; priority?: string; search?: string }) {
  const filter: Record<string, unknown> = { accountId: accountOf(ctx) };
  for (const k of ['pipelineId', 'status', 'source', 'priority'] as const) if (q[k]) filter[k] = q[k];
  if (q.search) {
    const digits = q.search.replace(/\D/g, '');
    const rx = new RegExp(escapeRegex(q.search), 'i');
    filter.$or = [{ name: rx }, { number: rx }, { email: rx }, ...(digits.length >= 4 ? [{ mobile: new RegExp(escapeRegex(digits)) }] : [])];
  }
  const limit = pageSize(q.limit);
  const [items, total] = await Promise.all([
    Lead.find(filter, { stageHistory: 0, contacts: 0 }).sort({ createdAt: -1, _id: -1 }).skip((q.page - 1) * limit).limit(limit).lean<LeadDoc[]>(),
    Lead.countDocuments(filter),
  ]);
  return { items: items.map((l) => summary(l, ctx)), meta: pageMeta(q.page, limit, total) };
}

export const getLead = async (ctx: AuthContext, id: string) => detail(await loadLead(ctx, id), ctx);

/** "When the mobile field loses focus, the duplicate check runs and shows any match under the field." */
export async function duplicateCheck(ctx: AuthContext, q: { mobile: string; name?: string | null; excludeId?: string | null }) {
  const d = await findLeadDuplicates(accountOf(ctx), q.mobile, q.name ? nameKey(q.name) : '', q.excludeId);
  const pick = (r: { _id: string; number: string; name: string }) => ({ id: r._id, number: r.number, name: r.name });
  return { exact: d.exact ? pick(d.exact) : null, sameMobile: d.sameMobile.map(pick), customers: d.customers.map(pick) };
}

// ── P-12 Create ──────────────────────────────────────────────────────────────

interface LeadInput {
  pipelineId: string; name: string; mobile: string; altMobile?: string | null; email?: string | null; source: string; referrerId?: string | null;
  referredByCustomerId?: string | null; campaign?: string | null; interests?: string[]; priority?: string | null; nextFollowUpAt?: Date | null;
  notes?: string | null; confirm: string[];
}

export async function createLead(ctx: AuthContext, b: LeadInput, req: Request) {
  const accountId = accountOf(ctx);
  const errs: FieldErr[] = [];
  if (!(await pipelineExists(accountId, b.pipelineId))) errs.push({ field: 'pipelineId', messageId: 'VAL-22' });
  if (b.altMobile && b.altMobile === b.mobile) errs.push({ field: 'altMobile', messageId: 'LD-09' });
  const src = await resolveSource(accountId, b);
  errs.push(...src.errs);
  if (errs.length) throw AppError.fields(errs);
  const key = nameKey(b.name);
  applyDuplicateRule(await findLeadDuplicates(accountId, b.mobile, key), b.confirm);

  const now = clock.now();
  try {
    const lead = await withTx(async (session) => {
      const number = await nextNumber(accountId, 'lead', session);
      const l = await new Lead({
        accountId, number, pipelineId: b.pipelineId, name: b.name, nameKey: key, mobile: b.mobile, altMobile: b.altMobile ?? null, email: b.email ?? null,
        ...src.out, interests: b.interests ?? [], priority: b.priority ?? 'MEDIUM', nextFollowUpAt: b.nextFollowUpAt ?? null, notes: b.notes ?? null,
        status: 'NEW', isOpen: true, createdBy: ctx.userId, stageHistory: [{ from: null, to: 'NEW', by: ctx.userId, at: now }],
      }).save({ session: session ?? undefined });
      await setFollowUpTask(l, ctx.userId, session);
      await audit({ entity: RECORD, entityId: l._id, entityRef: number, action: 'LEAD_CREATED', after: snapshot(l) }, { req, session });
      return l.toObject() as LeadDoc;
    });
    return detail(lead, ctx);
  } catch (err) {
    if (isDuplicateKey(err, 'open_lead_exact_dup')) {
      const d = await findLeadDuplicates(accountId, b.mobile, key);
      if (d.exact) throw exactDuplicate(d.exact);
    }
    throw err;
  }
}

// ── P-13 Work a lead ─────────────────────────────────────────────────────────

async function assertNotConverted(l: LeadDoc) {
  if (l.status === 'CONVERTED') {
    throw new AppError(409, 'INVALID_STATE', 'LD-08', { 'customer number': await customerNumber(l.accountId, l.customerId) }, { customerId: l.customerId });
  }
}

/** Edit details (P-13 step 4) with the P-12 rules. Source and referrer are locked: only the advisor corrects them, audited. */
export async function updateLead(ctx: AuthContext, id: string, b: Partial<LeadInput> & { version: number; confirm: string[] }, req: Request) {
  const l = await loadLead(ctx, id);
  await assertNotConverted(l);
  if (l.version !== b.version) throw AppError.versionConflict(RECORD, await detail(l, ctx));

  const next = {
    pipelineId: b.pipelineId ?? l.pipelineId, name: b.name ?? l.name, mobile: b.mobile ?? l.mobile,
    altMobile: b.altMobile !== undefined ? b.altMobile : l.altMobile, source: b.source ?? l.source,
    referrerId: b.referrerId !== undefined ? b.referrerId : l.referrerUserId,
    referredByCustomerId: b.referredByCustomerId !== undefined ? b.referredByCustomerId : l.referredByCustomerId,
    campaign: b.campaign !== undefined ? b.campaign : l.campaign,
  };
  const sourceChanged = next.source !== l.source || (next.referrerId ?? null) !== l.referrerUserId
    || (next.referredByCustomerId ?? null) !== l.referredByCustomerId || (next.campaign ?? null) !== l.campaign;
  if (sourceChanged && !can(ctx.role, 'leads.correctSource')) throw AppError.forbidden();

  const errs: FieldErr[] = [];
  if (next.pipelineId !== l.pipelineId && !(await pipelineExists(l.accountId, next.pipelineId))) errs.push({ field: 'pipelineId', messageId: 'VAL-22' });
  if (next.altMobile && next.altMobile === next.mobile) errs.push({ field: 'altMobile', messageId: 'LD-09' });
  const src = sourceChanged ? await resolveSource(l.accountId, next) : null;
  if (src) errs.push(...src.errs);
  if (b.nextFollowUpAt === null && l.status === 'FOLLOW_UP') errs.push({ field: 'nextFollowUpAt', messageId: 'GEN-01', params: { 'Field label': 'Next follow-up' } });
  if (errs.length) throw AppError.fields(errs);
  const key = nameKey(next.name);
  if (l.isOpen && (next.mobile !== l.mobile || key !== l.nameKey)) applyDuplicateRule(await findLeadDuplicates(l.accountId, next.mobile, key, id), b.confirm);

  const set: Record<string, unknown> = { pipelineId: next.pipelineId, name: next.name, nameKey: key, mobile: next.mobile, altMobile: next.altMobile ?? null };
  if (src) Object.assign(set, src.out);
  for (const k of ['email', 'interests', 'priority', 'notes', 'nextFollowUpAt'] as const) if (b[k] !== undefined) set[k] = b[k];
  try {
    const updated = await withTx(async (session) => {
      const u = await Lead.findOneAndUpdate({ _id: id, accountId: l.accountId, version: b.version }, { $set: set, $inc: { version: 1 } }, { new: true, session }).lean<LeadDoc>();
      if (!u) throw AppError.versionConflict(RECORD, null);
      if (b.nextFollowUpAt) await setFollowUpTask(u, ctx.userId, session);
      if (b.nextFollowUpAt === null) await cancelFollowUpTask(id, session);
      await audit({ entity: RECORD, entityId: id, entityRef: l.number, action: 'LEAD_UPDATED', before: snapshot(l), after: snapshot(u) }, { req, session });
      if (sourceChanged) {
        await audit({ entity: RECORD, entityId: id, entityRef: l.number, action: 'LEAD_SOURCE_CORRECTED',
          before: { source: l.source, referrerUserId: l.referrerUserId, referredByCustomerId: l.referredByCustomerId, campaign: l.campaign },
          after: { source: u.source, referrerUserId: u.referrerUserId, referredByCustomerId: u.referredByCustomerId, campaign: u.campaign } }, { req, session });
      }
      return u;
    });
    return detail(updated, ctx);
  } catch (err) {
    if (isDuplicateKey(err, 'open_lead_exact_dup')) {
      const d = await findLeadDuplicates(l.accountId, next.mobile, key, id);
      if (d.exact) throw exactDuplicate(d.exact);
    }
    throw err;
  }
}

/** Change status (P-13 step 3): only the 4.3 moves; FOLLOW_UP needs a date, LOST a reason, reopen a note. */
export async function changeStatus(ctx: AuthContext, id: string, b: { version: number; status: LeadStatus; nextFollowUpAt?: Date | null; lostReason?: string | null; note?: string | null }, req: Request) {
  const l = await loadLead(ctx, id);
  const from = l.status as LeadStatus;
  const to = b.status;
  if (from === 'CONVERTED') throw AppError.invalidState(RECORD, STATUS_LABEL.CONVERTED, { customerId: l.customerId });
  if (l.version !== b.version) throw AppError.versionConflict(RECORD, await detail(l, ctx));
  if (!canMove(from, to)) throw AppError.invalidState(RECORD, STATUS_LABEL[from], { allowed: allowedMoves(from, ctx.role) });
  if (advisorOnly(from, to) && !can(ctx.role, 'leads.loseReopen')) throw AppError.forbidden();

  const reopen = from === 'LOST';
  const errs: FieldErr[] = [];
  if (to === 'FOLLOW_UP' && !b.nextFollowUpAt) errs.push({ field: 'nextFollowUpAt', messageId: 'GEN-01', params: { 'Field label': 'Next follow-up' } });
  if (to === 'LOST' && !b.lostReason) errs.push({ field: 'lostReason', messageId: 'LD-06' });
  if ((to === 'LOST' && b.lostReason === 'Other' && !b.note) || (reopen && !b.note)) errs.push({ field: 'note', messageId: 'GEN-01', params: { 'Field label': 'Note' } });
  if (errs.length) throw AppError.fields(errs);

  const set: Record<string, unknown> = { status: to, isOpen: to !== 'LOST' };
  if (to === 'LOST') Object.assign(set, { lostReason: b.lostReason, lostNote: b.note ?? null, nextFollowUpAt: null });
  else Object.assign(set, { lostReason: null, lostNote: null });
  if (to === 'FOLLOW_UP') set.nextFollowUpAt = b.nextFollowUpAt;
  try {
    const updated = await withTx(async (session) => {
      const u = await Lead.findOneAndUpdate(
        { _id: id, accountId: l.accountId, version: b.version, status: from },
        { $set: set, $inc: { version: 1 }, $push: { stageHistory: { from, to, reason: to === 'LOST' ? b.lostReason : null, note: b.note ?? null, by: ctx.userId, at: clock.now() } } },
        { new: true, session },
      ).lean<LeadDoc>();
      if (!u) throw AppError.versionConflict(RECORD, null);
      if (to === 'FOLLOW_UP') await setFollowUpTask(u, ctx.userId, session);
      if (to === 'LOST') await cancelFollowUpTask(id, session);
      await audit({ entity: RECORD, entityId: id, entityRef: l.number, action: reopen ? 'LEAD_REOPENED' : 'LEAD_STATUS_CHANGED',
        before: { status: from }, after: { status: to, reason: b.lostReason ?? null, note: b.note ?? null, nextFollowUpAt: b.nextFollowUpAt ?? null } }, { req, session });
      return u;
    });
    return { lead: await detail(updated, ctx), messageId: (reopen ? 'LD-07' : 'LD-05') as MessageId, params: { status: STATUS_LABEL[to] } };
  } catch (err) {
    if (isDuplicateKey(err, 'open_lead_exact_dup')) {
      const d = await findLeadDuplicates(l.accountId, l.mobile, l.nameKey, id);
      if (d.exact) throw exactDuplicate(d.exact);
    }
    throw err;
  }
}

/** Log contact (P-13 step 2): outcome required, note optional; added to the timeline with date and time. */
export async function logContact(ctx: AuthContext, id: string, b: { outcome: string; note?: string | null }, req: Request) {
  const l = await loadLead(ctx, id);
  await assertNotConverted(l);
  const contact = { _id: newId('act'), outcome: b.outcome, note: b.note ?? null, at: clock.now(), by: ctx.userId };
  await withTx(async (session) => {
    await Lead.updateOne({ _id: id, accountId: l.accountId }, { $push: { contacts: contact } }, { session: session ?? undefined });
    await audit({ entity: RECORD, entityId: id, entityRef: l.number, action: 'LEAD_CONTACT_LOGGED', after: { outcome: b.outcome, note: b.note ?? null } }, { req, session });
  });
  return getLead(ctx, id);
}

// ── P-14 Convert a lead to a customer ────────────────────────────────────────

/**
 * Exact duplicate of an ACTIVE customer: the only choice is Link (CU-02). Same mobile, other name: the advisor
 * chooses Link or Create new (CU-03). Customer creation or linking, the lead status change, copying source,
 * referrer and consent, and cancelling the follow-up task happen in one transaction.
 */
export async function convertLead(ctx: AuthContext, id: string, b: { version: number; mode: 'CREATE' | 'LINK'; customerId?: string | null; customer?: CustomerExtras; confirm: string[] }, req: Request) {
  const l = await loadLead(ctx, id);
  const from = l.status as LeadStatus;
  if (from === 'CONVERTED') throw AppError.invalidState(RECORD, STATUS_LABEL.CONVERTED, { customerId: l.customerId });
  if (!CONVERTIBLE.includes(from)) throw AppError.invalidState(RECORD, STATUS_LABEL[from]);
  if (l.version !== b.version) throw AppError.versionConflict(RECORD, await detail(l, ctx));

  const matches = await Customer.find({ accountId: l.accountId, mobile: l.mobile, status: 'ACTIVE' }, { number: 1, name: 1, nameKey: 1 }).lean();
  const exact = matches.find((m) => m.nameKey === l.nameKey);
  if (b.mode === 'LINK') {
    if (!b.customerId) throw AppError.field('customerId', 'GEN-01', { 'Field label': 'Customer' });
    if (!matches.some((m) => m._id === b.customerId)) throw AppError.field('customerId', 'VAL-22');
  } else {
    if (exact) {
      throw new AppError(409, 'DUPLICATE', 'CU-02', { 'customer number': exact.number }, { customerId: exact._id, onlyChoice: 'LINK' },
        [{ field: 'mobile', messageId: 'CU-02', message: msg('CU-02', { 'customer number': exact.number }) }]);
    }
    const others = matches.filter((m) => m.nameKey !== l.nameKey);
    if (others.length && !b.confirm.includes('CU-03')) {
      throw new AppError(409, 'CONFIRMATION_REQUIRED', 'CU-03', { name: others[0]!.name, 'customer number': others[0]!.number }, {
        warnings: others.map((m) => ({ messageId: 'CU-03', message: msg('CU-03', { name: m.name, 'customer number': m.number }), recordType: 'customer', id: m._id, number: m.number })),
      });
    }
    const altMobile = b.customer?.altMobile !== undefined ? b.customer.altMobile : l.altMobile;
    if (altMobile && altMobile === l.mobile) throw AppError.field('altMobile', 'LD-09');
  }

  const now = clock.now();
  const out = await withTx(async (session) => {
    let customer;
    if (b.mode === 'CREATE') {
      const extras = b.customer ?? {};
      customer = (await insertCustomer(ctx, {
        ...extras, name: l.name, mobile: l.mobile,
        altMobile: extras.altMobile !== undefined ? extras.altMobile : l.altMobile,
        email: extras.email !== undefined ? extras.email : l.email,
        notes: extras.notes !== undefined ? extras.notes : l.notes,
        source: l.source, leadId: l._id, referrerUserId: l.referrerUserId, referredByCustomerId: l.referredByCustomerId,
      }, session)).toObject();
      await audit({ entity: 'customer', entityId: customer._id, entityRef: customer.number, action: 'CUSTOMER_CREATED', after: { name: customer.name, mobile: customer.mobile, leadId: l._id, source: l.source } }, { req, session });
    } else {
      customer = await Customer.findOne({ _id: b.customerId, accountId: l.accountId }).session(session).lean();
    }
    const u = await Lead.findOneAndUpdate(
      { _id: id, accountId: l.accountId, version: b.version, status: from },
      {
        $set: { status: 'CONVERTED', isOpen: false, customerId: customer!._id, convertedAt: now, nextFollowUpAt: null }, $inc: { version: 1 },
        $push: { stageHistory: { from, to: 'CONVERTED', reason: b.mode === 'CREATE' ? `Customer ${customer!.number} created` : `Linked to customer ${customer!.number}`, note: null, by: ctx.userId, at: now } },
      },
      { new: true, session },
    ).lean<LeadDoc>();
    if (!u) throw AppError.versionConflict(RECORD, null);
    await cancelFollowUpTask(id, session);
    await copyLeadConsents(l.accountId, l._id, customer!._id, ctx.userId, session);
    await audit({ entity: RECORD, entityId: id, entityRef: l.number, action: 'LEAD_CONVERTED', before: { status: from }, after: { status: 'CONVERTED', customerId: customer!._id, customerNumber: customer!.number, outcome: b.mode } }, { req, session });
    return { lead: u, customer: customer! };
  }).catch(async (err) => {
    if (isDuplicateKey(err, 'active_customer_exact_dup')) {
      const m = await Customer.findOne({ accountId: l.accountId, mobile: l.mobile, nameKey: l.nameKey, status: 'ACTIVE' }, { number: 1 }).lean();
      throw new AppError(409, 'DUPLICATE', 'CU-02', { 'customer number': m?.number ?? '' }, { customerId: m?._id, onlyChoice: 'LINK' });
    }
    throw err;
  });

  const params = { 'customer number': out.customer.number, 'lead number': l.number };
  return {
    lead: await detail(out.lead, ctx),
    customer: customerSummary(out.customer as never),
    outcome: b.mode === 'CREATE' ? 'CREATED' : 'LINKED',
    messageId: (b.mode === 'CREATE' ? 'LD-10' : 'LD-11') as MessageId,
    params,
  };
}
