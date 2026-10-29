import { cfgNum } from '../../config/cfg.js';
import { AppError } from '../../lib/errors.js';
import { msg } from '../../lib/messages.js';
import { Customer, FamilyMember } from '../customers/customer.model.js';
import { Lead } from '../leads/lead.model.js';
import type { AuthContext } from '../rbac/capabilities.js';

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Global search (P-09). Only inside the advisor's account. Matches any part of a name (ignoring case), an
 * email, a reference number (LD-, CU-; QT-, CQ-, PL- arrive with their modules), and CFG-132+ digits anywhere
 * in a mobile number (stored as +91XXXXXXXXXX). Inactive records are included and labelled with their status.
 * Results come in the P-09 group order, up to CFG-25 in total.
 */
export async function search(ctx: AuthContext, raw: string) {
  const text = raw.trim();
  const min = cfgNum('CFG-24');
  if (text.length < min) throw AppError.field('q', 'DSH-02', { 'CFG-24': min }); // AC-P09-1
  const total = cfgNum('CFG-25');
  const acc = { accountId: ctx.accountId };
  const like = new RegExp(escape(text), 'i');
  const digits = text.replace(/[\s-]/g, '');
  const mobile = /^\+?\d+$/.test(digits) && digits.replace(/^\+/, '').length >= cfgNum('CFG-132')
    ? [{ mobile: new RegExp(escape(digits.replace(/^\+/, ''))) }] : [];
  const anyOf = (extra: object[] = []) => ({ $or: [{ name: like }, { email: like }, { number: like }, ...mobile, ...extra] });

  const [leads, customers, family] = await Promise.all([
    Lead.find({ ...acc, ...anyOf() }, { number: 1, name: 1, mobile: 1, status: 1 }).sort({ updatedAt: -1 }).limit(total + 1).lean(),
    Customer.find({ ...acc, ...anyOf() }, { number: 1, name: 1, mobile: 1, status: 1 }).sort({ updatedAt: -1 }).limit(total + 1).lean(),
    FamilyMember.find({ ...acc, $or: [{ name: like }, ...mobile] }, { name: 1, relationship: 1, customerId: 1, status: 1 }).limit(total + 1).lean(),
  ]);
  const familyCustomers = new Map((await Customer.find({ _id: { $in: family.map((f) => f.customerId) }, ...acc }, { name: 1, number: 1 }).lean()).map((c) => [c._id, c]));

  const groups = [
    { group: 'LEADS', items: leads.map((l) => ({ type: 'LEAD', id: l._id, title: l.name, subtitle: `${l.number} · ${mask(l.mobile)}`, status: l.status, open: { type: 'LEAD', id: l._id } })) },
    { group: 'CUSTOMERS', items: customers.map((c) => ({ type: 'CUSTOMER', id: c._id, title: c.name, subtitle: `${c.number} · ${mask(c.mobile)}`, status: c.status, open: { type: 'CUSTOMER', id: c._id } })) },
    // A family member opens their customer's Family tab (P-09 step 4).
    { group: 'FAMILY_MEMBERS', items: family.map((f) => {
      const c = familyCustomers.get(f.customerId);
      return { type: 'FAMILY_MEMBER', id: f._id, title: f.name, subtitle: `${f.relationship} of ${c?.name ?? ''} (${c?.number ?? ''})`, status: f.status, open: { type: 'CUSTOMER', id: f.customerId, tab: 'family' } };
    }) },
    { group: 'QUOTATIONS', items: [] as unknown[], available: false }, // Module 10
    { group: 'POLICIES', items: [] as unknown[], available: false }, // Module 12 (AC-P09-4 there)
  ];
  // Up to CFG-25 in total, filled in group order; "See all" shows when a group was cut.
  let left = total;
  const out = groups.map((g) => {
    const shown = g.items.slice(0, Math.max(0, left));
    left -= shown.length;
    return { group: g.group, items: shown, more: g.items.length > shown.length, ...(g.available === false ? { available: false } : {}) };
  });
  const count = out.reduce((n, g) => n + g.items.length, 0);
  return { text, groups: out, count, ...(count === 0 ? { messageId: 'DSH-03', message: msg('DSH-03', { text }) } : {}) };
}

/** Results never show a full mobile number in the list: last 4 digits only. */
const mask = (m: string) => `XXXXXX${m.slice(-4)}`;