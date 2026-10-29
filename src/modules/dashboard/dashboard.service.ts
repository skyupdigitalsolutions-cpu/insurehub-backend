import { cfgNum } from '../../config/cfg.js';
import { istToday } from '../../lib/clock.js';
import { msg } from '../../lib/messages.js';
import { AuditLog } from '../audit/audit.model.js';
import { Customer } from '../customers/customer.model.js';
import { Lead } from '../leads/lead.model.js';
import { getProfile } from '../profile/profile.service.js';
import type { AuthContext } from '../rbac/capabilities.js';
import { dueTodayOrOverdue } from '../tasks/tasks.service.js';

/**
 * Advisor dashboard (P-08). Each widget is its own call scoped to the account, so one failing widget never
 * blanks the page (AC-P08-3). Every count says which list (and filter) it opens (AC-P08-4).
 * Quotations, policies and renewals arrive with their modules; until then they are 0 and not available.
 */
const OPEN_LEAD = ['NEW', 'CONTACTED', 'QUALIFIED', 'FOLLOW_UP'];
const empty = (n: number) => (n === 0 ? { emptyMessageId: 'DSH-04', emptyMessage: msg('DSH-04') } : {});

export async function openLeads(ctx: AuthContext) {
  const count = await Lead.countDocuments({ accountId: ctx.accountId, status: { $in: OPEN_LEAD } });
  return { count, opens: { list: 'LEADS', filter: { status: OPEN_LEAD } }, ...empty(count) };
}

export async function activeCustomers(ctx: AuthContext) {
  const count = await Customer.countDocuments({ accountId: ctx.accountId, status: 'ACTIVE' });
  return { count, opens: { list: 'CUSTOMERS', filter: { status: ['ACTIVE'] } }, ...empty(count) };
}

export const notYet = (list: string, module: number) => async () => ({ count: 0, available: false, arrivesWith: `Module ${module}`, opens: { list, filter: {} } });

const PERIODS = ['THIS_MONTH', 'LAST_3_MONTHS', 'THIS_YEAR'] as const;
export type Period = (typeof PERIODS)[number];
/** Start of the period in IST. */
function periodStart(p: Period): Date {
  const [y, m] = istToday().split('-').map(Number) as [number, number];
  const ist = (yy: number, mm: number) => new Date(`${yy}-${String(mm).padStart(2, '0')}-01T00:00:00+05:30`);
  if (p === 'THIS_YEAR') return ist(y, 1);
  if (p === 'LAST_3_MONTHS') { const back = m - 2; return back >= 1 ? ist(y, back) : ist(y - 1, back + 12); }
  return ist(y, m);
}

/** Lead funnel: leads CREATED in the period, counted by their status now, and how many reached CONVERTED. */
export async function funnel(ctx: AuthContext, period: Period = 'THIS_MONTH') {
  const from = periodStart(period);
  const rows = await Lead.aggregate<{ _id: string; n: number }>([
    { $match: { accountId: ctx.accountId, createdAt: { $gte: from } } },
    { $group: { _id: '$status', n: { $sum: 1 } } },
  ]);
  const by = Object.fromEntries(rows.map((r) => [r._id, r.n]));
  const statuses = ['NEW', 'CONTACTED', 'QUALIFIED', 'FOLLOW_UP', 'CONVERTED', 'LOST'];
  const created = rows.reduce((n, r) => n + r.n, 0);
  return {
    period, periods: PERIODS, from, created, converted: by.CONVERTED ?? 0,
    bars: statuses.map((s) => ({ status: s, count: by[s] ?? 0, opens: { list: 'LEADS', filter: { status: [s], createdFrom: from } } })),
    ...empty(created),
  };
}

export async function todaysTasks(ctx: AuthContext) {
  const tasks = await dueTodayOrOverdue(ctx, cfgNum('CFG-130'));
  return { tasks, opens: { list: 'TASKS', filter: { tab: 'TODAY' } }, ...empty(tasks.length) };
}

/**
 * The last CFG-130 events: records created, status changes, messages sent (P-08). An explicit list, so views,
 * reveals, file reads and sign-ins never appear as activity. Messages sent join with Module 14.
 */
export const ACTIVITY_ACTIONS = [
  'LEAD_CREATED', 'LEAD_STATUS_CHANGED', 'LEAD_REOPENED', 'LEAD_CONVERTED', 'LEAD_CONTACT_LOGGED',
  'CUSTOMER_CREATED', 'CUSTOMER_DEACTIVATED', 'CUSTOMER_REACTIVATED', 'FAMILY_MEMBER_ADDED',
  'DOCUMENT_UPLOADED', 'DOCUMENT_CONFIRMED', 'VEHICLE_ADDED', 'VEHICLE_MARKED_SOLD', 'VEHICLE_REACTIVATED',
  'TASK_CREATED', 'TASK_DONE', 'KYC_SUBMITTED', 'KYC_RESUBMITTED_AFTER_VERIFIED', 'KYC_VERIFIED', 'KYC_REJECTED',
  'INSURER_MAPPING_ADDED', 'ASSISTANT_ADDED',
] as const;
export async function recentActivity(ctx: AuthContext) {
  const rows = await AuditLog.find({ accountId: ctx.accountId, action: { $in: ACTIVITY_ACTIONS }, result: 'SUCCESS' })
    .sort({ at: -1 }).limit(cfgNum('CFG-130'))
    .lean<Array<{ _id: string; entity: string; entityId: string; entityRef?: string | null; action: string; at: Date; actorUserId?: string | null; actorRole?: string | null }>>();
  return {
    events: rows.map((r) => ({ id: r._id, entity: r.entity, entityId: r.entityId, ref: r.entityRef ?? null, action: r.action, at: r.at, byRole: r.actorRole ?? null, byUserId: r.actorUserId ?? null })),
    ...empty(rows.length),
  };
}

/** Profile completion card: hidden (null) at 100%. */
export async function profileCard(ctx: AuthContext) {
  const p = await getProfile(ctx);
  return p.completion.percent >= 100 ? { hidden: true } : { hidden: false, percent: p.completion.percent, missing: p.completion.missing, message: p.completion.message ?? null };
}