import type { Request } from 'express';
import type { ClientSession } from 'mongoose';
import { cfgNum } from '../../config/cfg.js';
import { AppError } from '../../lib/errors.js';
import { ageOn } from '../../lib/clock.js';
import { decryptField, encryptField, lookupHash } from '../../lib/crypto.js';
import { masks, nameKey } from '../../lib/fields.js';
import { msg, type MessageId, type MessageParams } from '../../lib/messages.js';
import { isDuplicateKey, withTx } from '../../lib/mongo.js';
import { escapeRegex, pageMeta, pageSize } from '../../lib/pagination.js';
import { accountOf } from '../../middleware/authorize.js';
import { nextNumber } from '../accounts/numbers.js';
import { audit } from '../audit/audit.service.js';
import { Lead } from '../leads/lead.model.js';
import type { AuthContext } from '../rbac/capabilities.js';
import { User } from '../users/user.model.js';
import { Customer, FamilyMember, type CustomerDoc, type FamilyDoc } from './customer.model.js';
import { personKey, personalDataConsent, resetConsents } from './consent.service.js';
import type { CustomerExtras } from './customers.schemas.js';

type FieldErr = { field: string; messageId: MessageId; params?: MessageParams };
const RECORD = 'customer';

// ── Views ────────────────────────────────────────────────────────────────────

export function customerSummary(c: CustomerDoc) {
  return {
    id: c._id, number: c.number, name: c.name, mobile: c.mobile, email: c.email, city: c.address?.city ?? null, status: c.status,
    age: c.dob ? ageOn(c.dob) : null, source: c.source, createdAt: c.createdAt, version: c.version,
  };
}

function customerView(c: CustomerDoc) {
  return {
    ...customerSummary(c),
    dob: c.dob, gender: c.gender, altMobile: c.altMobile, preferredContact: c.preferredContact,
    address: { line1: c.address?.line1 ?? null, line2: c.address?.line2 ?? null, city: c.address?.city ?? null, state: c.address?.state ?? null, pin: c.address?.pin ?? null },
    anniversary: c.anniversary, occupation: c.occupation, notes: c.notes, leadId: c.leadId,
    statusReason: c.statusReason, statusNote: c.statusNote, updatedAt: c.updatedAt,
    // GR-36: masked everywhere; the full value only through the audited reveal.
    identity: { pan: c.identity?.panMasked ?? null, aadhaar: c.identity?.aadhaarMasked ?? null },
  };
}

const familyView = (m: FamilyDoc) => ({
  id: m._id, name: m.name, relationship: m.relationship, dob: m.dob, age: m.dob ? ageOn(m.dob) : null, gender: m.gender,
  anniversary: m.anniversary, mobile: m.mobile, email: m.email, status: m.status, version: m.version,
});

const snapshot = (c: Partial<CustomerDoc>) => ({
  name: c.name, mobile: c.mobile, altMobile: c.altMobile, email: c.email, dob: c.dob, status: c.status, city: c.address?.city,
});

async function loadCustomer(ctx: AuthContext, id: string) {
  const c = await Customer.findOne({ _id: id, accountId: accountOf(ctx) }).lean<CustomerDoc>();
  if (!c) throw AppError.notFound();
  return c;
}

const assertActive = (c: { status: string; name: string }) => {
  if (c.status !== 'ACTIVE') throw new AppError(409, 'INVALID_STATE', 'CU-20', { Customer: c.name });
};

// ── Duplicate rule (Section 7, P-15) ────────────────────────────────────────

export async function findCustomerDuplicates(accountId: string, mobile: string, key: string, excludeId?: string | null) {
  const matches = await Customer.find({ accountId, mobile, status: 'ACTIVE', ...(excludeId ? { _id: { $ne: excludeId } } : {}) }, { number: 1, name: 1, nameKey: 1 }).lean();
  return { exact: matches.find((m) => m.nameKey === key) ?? null, sameMobile: matches.filter((m) => m.nameKey !== key) };
}

function exactDuplicate(m: { _id: string; number: string }) {
  return new AppError(409, 'DUPLICATE', 'CU-02', { 'customer number': m.number }, { customerId: m._id },
    [{ field: 'mobile', messageId: 'CU-02', message: msg('CU-02', { 'customer number': m.number }) }]);
}

/** Exact duplicates are blocked (CU-02); same mobile with another name needs "Save anyway" (CU-03). */
function applyDuplicateRule(d: Awaited<ReturnType<typeof findCustomerDuplicates>>, confirm: string[]) {
  if (d.exact) throw exactDuplicate(d.exact);
  if (d.sameMobile.length && !confirm.includes('CU-03')) {
    const first = d.sameMobile[0]!;
    throw new AppError(409, 'CONFIRMATION_REQUIRED', 'CU-03', { name: first.name, 'customer number': first.number }, {
      warnings: d.sameMobile.map((m) => ({ messageId: 'CU-03', message: msg('CU-03', { name: m.name, 'customer number': m.number }), recordType: 'customer', id: m._id, number: m.number })),
    });
  }
}

export async function duplicateCheck(ctx: AuthContext, q: { mobile: string; name?: string | null; excludeId?: string | null }) {
  const d = await findCustomerDuplicates(accountOf(ctx), q.mobile, q.name ? nameKey(q.name) : '', q.excludeId);
  return { exact: d.exact ? { id: d.exact._id, number: d.exact.number, name: d.exact.name } : null, sameMobile: d.sameMobile.map((m) => ({ id: m._id, number: m.number, name: m.name })) };
}

// ── Create, list, view ───────────────────────────────────────────────────────

function addressFrom(b: CustomerExtras, current?: CustomerDoc['address']) {
  const pick = <K extends keyof CustomerExtras>(k: K, cur: string | null | undefined) => (b[k] !== undefined ? b[k] ?? null : cur ?? null);
  return {
    line1: pick('addressLine1', current?.line1), line2: pick('addressLine2', current?.line2), city: pick('city', current?.city),
    state: pick('state', current?.state), pin: pick('pin', current?.pin),
  };
}

export interface NewCustomer extends CustomerExtras {
  name: string; mobile: string; source?: string; leadId?: string | null; referrerUserId?: string | null; referredByCustomerId?: string | null;
}

/** Saves a customer as ACTIVE with the next CU number. Used by P-15 and by lead conversion (P-14). */
export async function insertCustomer(ctx: AuthContext, b: NewCustomer, session: ClientSession | null) {
  const accountId = accountOf(ctx);
  const number = await nextNumber(accountId, 'customer', session);
  return new Customer({
    accountId, number, name: b.name, nameKey: nameKey(b.name), mobile: b.mobile, altMobile: b.altMobile ?? null, email: b.email ?? null,
    dob: b.dob ?? null, gender: b.gender ?? null, preferredContact: b.preferredContact ?? null, address: addressFrom(b), anniversary: b.anniversary ?? null,
    occupation: b.occupation ?? null, notes: b.notes ?? null, source: b.source ?? 'Direct', leadId: b.leadId ?? null,
    referrerUserId: b.referrerUserId ?? null, referredByCustomerId: b.referredByCustomerId ?? null, createdBy: ctx.userId,
  }).save({ session: session ?? undefined });
}

export async function createCustomer(ctx: AuthContext, b: NewCustomer & { confirm: string[] }, req: Request) {
  const accountId = accountOf(ctx);
  if (b.altMobile && b.altMobile === b.mobile) throw AppError.field('altMobile', 'LD-09');
  applyDuplicateRule(await findCustomerDuplicates(accountId, b.mobile, nameKey(b.name)), b.confirm);
  try {
    const c = await withTx(async (session) => {
      const created = await insertCustomer(ctx, { ...b, source: 'Direct' }, session);
      await audit({ entity: RECORD, entityId: created._id, entityRef: created.number, action: 'CUSTOMER_CREATED', after: snapshot(created) }, { req, session });
      return created;
    });
    return customerView(c.toObject() as CustomerDoc);
  } catch (err) {
    if (isDuplicateKey(err, 'active_customer_exact_dup')) {
      const d = await findCustomerDuplicates(accountId, b.mobile, nameKey(b.name));
      if (d.exact) throw exactDuplicate(d.exact);
    }
    throw err;
  }
}

export async function listCustomers(ctx: AuthContext, q: { page: number; limit?: number; status?: string; search?: string }) {
  const filter: Record<string, unknown> = { accountId: accountOf(ctx) };
  if (q.status) filter.status = q.status;
  if (q.search) {
    const digits = q.search.replace(/\D/g, '');
    const rx = new RegExp(escapeRegex(q.search), 'i');
    filter.$or = [{ name: rx }, { number: rx }, { email: rx }, ...(digits.length >= 4 ? [{ mobile: new RegExp(escapeRegex(digits)) }] : [])];
  }
  const limit = pageSize(q.limit);
  const [items, total] = await Promise.all([
    Customer.find(filter).sort({ createdAt: -1, _id: -1 }).skip((q.page - 1) * limit).limit(limit).lean<CustomerDoc[]>(),
    Customer.countDocuments(filter),
  ]);
  return { items: items.map(customerSummary), meta: pageMeta(q.page, limit, total) };
}

/** Customer detail (P-15 step 4). Tabs for quotations, policies, payments, renewals and documents arrive with their modules. */
export async function getCustomer(ctx: AuthContext, id: string) {
  const c = await loadCustomer(ctx, id);
  const [members, leads, referrer, referredBy, pdc] = await Promise.all([
    FamilyMember.find({ accountId: c.accountId, customerId: id }).sort({ status: 1, createdAt: 1 }).lean<FamilyDoc[]>(),
    Lead.find({ accountId: c.accountId, customerId: id }, { number: 1, status: 1, source: 1, convertedAt: 1 }).sort({ convertedAt: -1 }).lean(),
    c.referrerUserId ? User.findById(c.referrerUserId, { name: 1 }).lean() : null,
    c.referredByCustomerId ? Customer.findOne({ _id: c.referredByCustomerId, accountId: c.accountId }, { number: 1, name: 1 }).lean() : null,
    personalDataConsent(c.accountId, id),
  ]);
  return {
    ...customerView(c),
    referrer: referrer ? { id: referrer._id, name: referrer.name } : null,
    referredBy: referredBy ? { id: referredBy._id, number: referredBy.number, name: referredBy.name } : null,
    leads: leads.map((l) => ({ id: l._id, number: l.number, status: l.status, source: l.source, convertedAt: l.convertedAt })),
    family: members.map(familyView),
    personalDataConsent: pdc,
  };
}

// ── Edit (P-15 step 5) ───────────────────────────────────────────────────────

export async function updateCustomer(ctx: AuthContext, id: string, b: CustomerExtras & { version: number; name?: string | null; mobile?: string | null; confirm: string[] }, req: Request) {
  const c = await loadCustomer(ctx, id);
  assertActive(c);
  if (c.version !== b.version) throw AppError.versionConflict(RECORD, customerView(c));
  const name = b.name ?? c.name;
  const mobile = b.mobile ?? c.mobile;
  const altMobile = b.altMobile !== undefined ? b.altMobile : c.altMobile;
  const email = b.email !== undefined ? b.email : c.email;
  const errs: FieldErr[] = [];
  if (altMobile && altMobile === mobile) errs.push({ field: 'altMobile', messageId: 'LD-09' });
  if (errs.length) throw AppError.fields(errs);

  const mobileChanged = mobile !== c.mobile;
  const emailChanged = !!c.email && email !== c.email;
  if (mobileChanged && !b.confirm.includes('CU-21')) throw new AppError(409, 'CONFIRMATION_REQUIRED', 'CU-21', {}, { warnings: [{ messageId: 'CU-21', message: msg('CU-21') }] });
  if (emailChanged && !b.confirm.includes('CU-22')) throw new AppError(409, 'CONFIRMATION_REQUIRED', 'CU-22', {}, { warnings: [{ messageId: 'CU-22', message: msg('CU-22') }] });
  if (mobileChanged || nameKey(name) !== c.nameKey) applyDuplicateRule(await findCustomerDuplicates(c.accountId, mobile, nameKey(name), id), b.confirm);

  const set: Record<string, unknown> = {
    name, nameKey: nameKey(name), mobile, altMobile: altMobile ?? null, email: email ?? null, address: addressFrom(b, c.address),
  };
  for (const k of ['dob', 'gender', 'preferredContact', 'anniversary', 'occupation', 'notes'] as const) if (b[k] !== undefined) set[k] = b[k];
  try {
    const updated = await withTx(async (session) => {
      const u = await Customer.findOneAndUpdate({ _id: id, accountId: c.accountId, version: b.version }, { $set: set, $inc: { version: 1 } }, { new: true, session }).lean<CustomerDoc>();
      if (!u) throw AppError.versionConflict(RECORD, null);
      if (mobileChanged) await resetConsents(c.accountId, personKey('C', id), ['WHATSAPP', 'SMS'], 'Primary mobile changed', ctx.userId, session);
      if (emailChanged) await resetConsents(c.accountId, personKey('C', id), ['EMAIL'], 'Email changed', ctx.userId, session);
      await audit({ entity: RECORD, entityId: id, entityRef: c.number, action: 'CUSTOMER_UPDATED', before: snapshot(c), after: snapshot(u) }, { req, session });
      return u;
    });
    return customerView(updated);
  } catch (err) {
    if (isDuplicateKey(err, 'active_customer_exact_dup')) {
      const d = await findCustomerDuplicates(c.accountId, mobile, nameKey(name), id);
      if (d.exact) throw exactDuplicate(d.exact);
    }
    throw err;
  }
}

// ── P-19 Deactivate or reactivate ────────────────────────────────────────────

export async function setCustomerStatus(ctx: AuthContext, id: string, active: boolean, b: { version: number; reason?: string | null; note?: string | null }, req: Request) {
  const c = await loadCustomer(ctx, id);
  if (c.version !== b.version) throw AppError.versionConflict(RECORD, customerView(c));
  if ((c.status === 'ACTIVE') === active) throw AppError.invalidState(RECORD, c.status === 'ACTIVE' ? 'active' : 'inactive');
  if (!active) {
    const errs: FieldErr[] = [];
    if (!b.reason) errs.push({ field: 'reason', messageId: 'GEN-01', params: { 'Field label': 'Reason' } });
    if (b.reason === 'Other' && !b.note) errs.push({ field: 'note', messageId: 'GEN-01', params: { 'Field label': 'Note' } });
    if (errs.length) throw AppError.fields(errs);
    // Step 2: open quotations (READY, SHARED) and payments AWAITING_PAYMENT block deactivation (CU-08).
    // Quotations and payments (Sections 11–12) are not built yet, so there is nothing to block on.
  } else {
    const d = await findCustomerDuplicates(c.accountId, c.mobile, c.nameKey, id);
    if (d.exact) throw exactDuplicate(d.exact);
  }
  try {
    const updated = await withTx(async (session) => {
      const u = await Customer.findOneAndUpdate(
        { _id: id, accountId: c.accountId, version: b.version },
        { $set: { status: active ? 'ACTIVE' : 'INACTIVE', statusReason: active ? null : b.reason, statusNote: active ? null : b.note ?? null }, $inc: { version: 1 } },
        { new: true, session },
      ).lean<CustomerDoc>();
      if (!u) throw AppError.versionConflict(RECORD, null);
      await audit({ entity: RECORD, entityId: id, entityRef: c.number, action: active ? 'CUSTOMER_REACTIVATED' : 'CUSTOMER_DEACTIVATED', before: { status: c.status }, after: { status: u.status, reason: b.reason ?? null, note: b.note ?? null } }, { req, session });
      return u;
    });
    return customerView(updated);
  } catch (err) {
    if (isDuplicateKey(err, 'active_customer_exact_dup')) throw AppError.invalidState(RECORD, 'inactive');
    throw err;
  }
}

// ── PAN and Aadhaar (P-15 "Personal data", GR-36, GR-37) ─────────────────────

export async function setIdentity(ctx: AuthContext, id: string, b: { version: number; pan?: string | null; aadhaar?: string | null }, req: Request) {
  const c = await loadCustomer(ctx, id);
  assertActive(c);
  if (c.version !== b.version) throw AppError.versionConflict(RECORD, customerView(c));
  const consent = await personalDataConsent(c.accountId, id);
  if (consent === 'WITHDRAWN') throw new AppError(409, 'CONSENT_REQUIRED', 'CU-30', { Customer: c.name });
  if (consent !== 'GIVEN') throw new AppError(409, 'CONSENT_REQUIRED', 'CU-23', { customer: c.name });
  if (!b.pan && !b.aadhaar) throw AppError.field('pan', 'GEN-01', { 'Field label': 'PAN or Aadhaar number' });

  const set: Record<string, unknown> = {};
  const warnings: Array<{ messageId: MessageId; message: string }> = [];
  if (b.pan) {
    const hash = lookupHash(b.pan);
    Object.assign(set, { 'identity.panEnc': encryptField(b.pan), 'identity.panHash': hash, 'identity.panMasked': masks.pan(b.pan) });
    const other = await Customer.findOne({ accountId: c.accountId, 'identity.panHash': hash, status: 'ACTIVE', _id: { $ne: id } }, { number: 1 }).lean();
    if (other) warnings.push({ messageId: 'CU-29', message: msg('CU-29', { 'customer number': other.number }) });
  }
  if (b.aadhaar) Object.assign(set, { 'identity.aadhaarEnc': encryptField(b.aadhaar), 'identity.aadhaarHash': lookupHash(b.aadhaar), 'identity.aadhaarMasked': masks.aadhaar(b.aadhaar) });

  const updated = await withTx(async (session) => {
    const u = await Customer.findOneAndUpdate({ _id: id, accountId: c.accountId, version: b.version }, { $set: set, $inc: { version: 1 } }, { new: true, session }).lean<CustomerDoc>();
    if (!u) throw AppError.versionConflict(RECORD, null);
    await audit({
      entity: RECORD, entityId: id, entityRef: c.number, action: 'IDENTITY_UPDATED',
      before: { pan: c.identity?.panMasked ?? null, aadhaar: c.identity?.aadhaarMasked ?? null },
      after: { panMasked: u.identity?.panMasked ?? null, aadhaarMasked: u.identity?.aadhaarMasked ?? null },
    }, { req, session });
    return u;
  });
  return { customer: customerView(updated), warnings };
}

/** "Show full number": advisor only, shown for CFG-176, every reveal audited as personal data viewed (CU-25). */
export async function revealIdentity(ctx: AuthContext, id: string, field: 'PAN' | 'AADHAAR', req: Request) {
  const c = await Customer.findOne({ _id: id, accountId: accountOf(ctx) }).select('+identity.panEnc +identity.aadhaarEnc').lean<CustomerDoc>();
  if (!c) throw AppError.notFound();
  const enc = field === 'PAN' ? c.identity?.panEnc : c.identity?.aadhaarEnc;
  if (!enc) throw AppError.notFound();
  await audit({ entity: RECORD, entityId: id, entityRef: c.number, action: 'PERSONAL_DATA_VIEWED', after: { field } }, { req });
  return { field, value: decryptField(enc), maskAfterSeconds: cfgNum('CFG-176') };
}

// ── P-16 Household roster ────────────────────────────────────────────────────

interface MemberInput { name?: string | null; relationship?: string | null; dob?: string | null; gender?: string | null; anniversary?: string | null; mobile?: string | null; email?: string | null }

export async function listFamily(ctx: AuthContext, customerId: string) {
  const c = await loadCustomer(ctx, customerId);
  return (await FamilyMember.find({ accountId: c.accountId, customerId }).sort({ status: 1, createdAt: 1 }).lean<FamilyDoc[]>()).map(familyView);
}

const memberDuplicate = (name: string, relationship: string) => new AppError(409, 'DUPLICATE', 'CU-07', { Name: name, relationship }, undefined,
  [{ field: 'name', messageId: 'CU-07', message: msg('CU-07', { Name: name, relationship }) }]);

async function assertRoom(accountId: string, customerId: string) {
  if ((await FamilyMember.countDocuments({ accountId, customerId, status: 'ACTIVE' })) >= cfgNum('CFG-35')) throw new AppError(409, 'LIMIT_REACHED', 'CU-06');
}

export async function addFamilyMember(ctx: AuthContext, customerId: string, b: MemberInput & { name: string; relationship: string }, req: Request) {
  const c = await loadCustomer(ctx, customerId);
  assertActive(c);
  await assertRoom(c.accountId, customerId);
  const key = nameKey(b.name);
  if (await FamilyMember.exists({ customerId, nameKey: key, relationship: b.relationship, status: 'ACTIVE' })) throw memberDuplicate(b.name, b.relationship);
  try {
    const m = await withTx(async (session) => {
      const created = await new FamilyMember({
        accountId: c.accountId, customerId, name: b.name, nameKey: key, relationship: b.relationship, dob: b.dob ?? null, gender: b.gender ?? null,
        anniversary: b.anniversary ?? null, mobile: b.mobile ?? null, email: b.email ?? null, createdBy: ctx.userId,
      }).save({ session: session ?? undefined });
      await audit({ entity: 'family_member', entityId: created._id, entityRef: c.number, action: 'FAMILY_MEMBER_ADDED', after: { name: created.name, relationship: created.relationship, mobile: created.mobile } }, { req, session });
      return created;
    });
    return { member: familyView(m.toObject() as FamilyDoc), customerName: c.name };
  } catch (err) {
    if (isDuplicateKey(err, 'active_member_dup')) throw memberDuplicate(b.name, b.relationship);
    throw err;
  }
}

async function loadMember(ctx: AuthContext, customerId: string, memberId: string) {
  const c = await loadCustomer(ctx, customerId);
  const m = await FamilyMember.findOne({ _id: memberId, accountId: c.accountId, customerId }).lean<FamilyDoc>();
  if (!m) throw AppError.notFound();
  return { c, m };
}

export async function updateFamilyMember(ctx: AuthContext, customerId: string, memberId: string, b: MemberInput & { version: number }, req: Request) {
  const { c, m } = await loadMember(ctx, customerId, memberId);
  assertActive(c);
  if (m.status !== 'ACTIVE') throw AppError.invalidState('family member', 'inactive');
  if (m.version !== b.version) throw AppError.versionConflict('family member', familyView(m));
  const name = b.name ?? m.name;
  const relationship = b.relationship ?? m.relationship;
  if ((nameKey(name) !== m.nameKey || relationship !== m.relationship)
    && await FamilyMember.exists({ customerId, nameKey: nameKey(name), relationship, status: 'ACTIVE', _id: { $ne: memberId } })) throw memberDuplicate(name, relationship);
  const set: Record<string, unknown> = { name, nameKey: nameKey(name), relationship };
  for (const k of ['dob', 'gender', 'anniversary', 'mobile', 'email'] as const) if (b[k] !== undefined) set[k] = b[k];
  try {
    const updated = await withTx(async (session) => {
      const u = await FamilyMember.findOneAndUpdate({ _id: memberId, version: b.version }, { $set: set, $inc: { version: 1 } }, { new: true, session }).lean<FamilyDoc>();
      if (!u) throw AppError.versionConflict('family member', null);
      // Consent belongs to the exact number or address it was given for (P-17 backend rules).
      if (u.mobile !== m.mobile) await resetConsents(c.accountId, personKey('F', memberId), ['WHATSAPP', 'SMS'], 'Mobile changed', ctx.userId, session);
      if (u.email !== m.email) await resetConsents(c.accountId, personKey('F', memberId), ['EMAIL'], 'Email changed', ctx.userId, session);
      await audit({ entity: 'family_member', entityId: memberId, entityRef: c.number, action: 'FAMILY_MEMBER_UPDATED', before: { name: m.name, relationship: m.relationship, mobile: m.mobile }, after: { name: u.name, relationship: u.relationship, mobile: u.mobile } }, { req, session });
      return u;
    });
    return familyView(updated);
  } catch (err) {
    if (isDuplicateKey(err, 'active_member_dup')) throw memberDuplicate(name, relationship);
    throw err;
  }
}

/** Deactivate (CU-19) stops greetings for the member; activate needs room (CFG-35) and no duplicate. */
export async function setFamilyStatus(ctx: AuthContext, customerId: string, memberId: string, active: boolean, version: number, req: Request) {
  const { c, m } = await loadMember(ctx, customerId, memberId);
  assertActive(c);
  if (m.version !== version) throw AppError.versionConflict('family member', familyView(m));
  if ((m.status === 'ACTIVE') === active) throw AppError.invalidState('family member', m.status === 'ACTIVE' ? 'active' : 'inactive');
  if (active) {
    await assertRoom(c.accountId, customerId);
    if (await FamilyMember.exists({ customerId, nameKey: m.nameKey, relationship: m.relationship, status: 'ACTIVE' })) throw memberDuplicate(m.name, m.relationship);
  }
  const updated = await withTx(async (session) => {
    const u = await FamilyMember.findOneAndUpdate({ _id: memberId, version }, { $set: { status: active ? 'ACTIVE' : 'INACTIVE' }, $inc: { version: 1 } }, { new: true, session }).lean<FamilyDoc>();
    if (!u) throw AppError.versionConflict('family member', null);
    await audit({ entity: 'family_member', entityId: memberId, entityRef: c.number, action: active ? 'FAMILY_MEMBER_ACTIVATED' : 'FAMILY_MEMBER_DEACTIVATED', before: { status: m.status }, after: { status: u.status } }, { req, session });
    return u;
  });
  return familyView(updated);
}

