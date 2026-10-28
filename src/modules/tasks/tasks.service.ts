import type { Request } from 'express';
import { clock, istDateTime, istToday } from '../../lib/clock.js';
import { AppError } from '../../lib/errors.js';
import { withTx } from '../../lib/mongo.js';
import { audit } from '../audit/audit.service.js';
import { Customer } from '../customers/customer.model.js';
import { Lead } from '../leads/lead.model.js';
import type { AuthContext } from '../rbac/capabilities.js';
import { Task, type TaskDoc } from './task.model.js';

export const TABS = ['OVERDUE', 'TODAY', 'UPCOMING', 'DONE'] as const;
export interface CreateBody { title: string; dueDate: string; dueTime: string; linkedType?: 'LEAD' | 'CUSTOMER' | null; linkedId?: string | null; notes?: string | null }
export interface EditBody { version: number; title?: string; dueDate?: string; dueTime?: string; notes?: string | null }

/** IST date (YYYY-MM-DD) + time (HH:mm, 24h) → the moment. All task times are IST (P-11). */
export const istMoment = (date: string, time: string) => new Date(`${date}T${time}:00+05:30`);
const istDayBounds = (iso: string) => ({ start: new Date(`${iso}T00:00:00+05:30`), end: new Date(`${iso}T23:59:59.999+05:30`) });

/** AC-P11-1: never in the past. A past date is caught by FLD-06 (VAL-07); today with a past time gets DSH-24. */
function assertFuture(at: Date) {
  if (at.getTime() <= clock.now().getTime()) throw AppError.field('dueTime', 'DSH-24');
}

async function linkName(ctx: AuthContext, type?: string | null, id?: string | null): Promise<{ name: string; status: string } | null> {
  if (!type || !id) return null;
  const r = type === 'LEAD'
    ? await Lead.findOne({ _id: id, accountId: ctx.accountId }, { name: 1, status: 1 }).lean<{ name: string; status: string }>()
    : await Customer.findOne({ _id: id, accountId: ctx.accountId }, { name: 1, status: 1 }).lean<{ name: string; status: string }>();
  return r ? { name: r.name, status: r.status } : null;
}

async function view(ctx: AuthContext, t: TaskDoc) {
  const link = await linkName(ctx, t.linkedType, t.linkedId);
  const now = clock.now();
  return {
    id: t._id, kind: t.kind, title: t.title, dueAt: t.dueAt, dueShown: istDateTime(t.dueAt), status: t.status, notes: t.notes ?? null,
    overdue: t.status === 'OPEN' && t.dueAt < now, version: t.version, doneAt: t.doneAt ?? null,
    // P-11 failure: a deactivated linked record keeps the task and shows the record's status.
    linked: t.linkedType && t.linkedId ? { type: t.linkedType, id: t.linkedId, name: link?.name ?? null, status: link?.status ?? null } : null,
  };
}

async function load(ctx: AuthContext, id: string) {
  const t = await Task.findOne({ _id: id, accountId: ctx.accountId }).lean<TaskDoc>();
  if (!t) throw AppError.notFound();
  return t;
}

/** Tasks page (P-11 step 4): Overdue, Today, Upcoming, Done — with the count of each tab. */
export async function list(ctx: AuthContext, tab: (typeof TABS)[number]) {
  const now = clock.now();
  const today = istDayBounds(istToday());
  const filters: Record<(typeof TABS)[number], Record<string, unknown>> = {
    OVERDUE: { status: 'OPEN', dueAt: { $lt: now } },
    TODAY: { status: 'OPEN', dueAt: { $gte: now, $lte: today.end } },
    UPCOMING: { status: 'OPEN', dueAt: { $gt: today.end } },
    DONE: { status: 'DONE' },
  };
  const base = { accountId: ctx.accountId };
  const [rows, ...counts] = await Promise.all([
    Task.find({ ...base, ...filters[tab] }).sort(tab === 'DONE' ? { doneAt: -1 } : { dueAt: 1 }).limit(200).lean<TaskDoc[]>(),
    ...TABS.map((t) => Task.countDocuments({ ...base, ...filters[t] })),
  ]);
  return { tab, tasks: await Promise.all(rows.map((t) => view(ctx, t))), counts: Object.fromEntries(TABS.map((t, i) => [t, counts[i]])) };
}

/** + Task or Add follow-up on a record (P-11 steps 1–3). */
export async function create(ctx: AuthContext, b: CreateBody, req: Request) {
  const dueAt = istMoment(b.dueDate, b.dueTime);
  assertFuture(dueAt);
  if (b.linkedType && b.linkedId && !(await linkName(ctx, b.linkedType, b.linkedId))) throw AppError.field('linkedId', 'VAL-22');
  const t = await new Task({
    accountId: ctx.accountId, kind: 'GENERAL', title: b.title, dueAt, notes: b.notes ?? null,
    linkedType: b.linkedType ?? null, linkedId: b.linkedId ?? null, createdBy: ctx.userId,
  }).save();
  await audit({ entity: 'task', entityId: t._id, action: 'TASK_CREATED', after: { title: b.title, dueAt, linked: b.linkedId ?? null } }, { req });
  return view(ctx, t.toObject() as TaskDoc);
}

/**
 * Edit title, due date/time or notes. Conditional on the version, so editing a task another tab completed
 * gets GEN-05. A lead's follow-up task moves the lead's follow-up date with it (they are one thing, AC-P11-3).
 */
export async function edit(ctx: AuthContext, id: string, b: EditBody, req: Request) {
  const t = await load(ctx, id);
  if (t.status !== 'OPEN') throw AppError.versionConflict('task', await view(ctx, t));
  const set: Record<string, unknown> = {};
  if (b.title !== undefined) set.title = b.title;
  if (b.notes !== undefined) set.notes = b.notes;
  if (b.dueDate !== undefined || b.dueTime !== undefined) {
    const cur = istDateTime(t.dueAt); // DD-MM-YYYY hh:mm AM
    const date = b.dueDate ?? `${cur.slice(6, 10)}-${cur.slice(3, 5)}-${cur.slice(0, 2)}`;
    const time = b.dueTime ?? to24(cur.slice(11));
    set.dueAt = istMoment(date, time);
    assertFuture(set.dueAt as Date);
  }
  const u = await withTx(async (session) => {
    const r = await Task.findOneAndUpdate({ _id: id, accountId: ctx.accountId, status: 'OPEN', version: b.version }, { $set: set, $inc: { version: 1 } }, { new: true, session: session ?? undefined }).lean<TaskDoc>();
    if (!r) throw AppError.versionConflict('task', null);
    if (set.dueAt && r.kind === 'LEAD_FOLLOW_UP' && r.linkedId) {
      await Lead.updateOne({ _id: r.linkedId, accountId: ctx.accountId }, { $set: { nextFollowUpAt: set.dueAt } }, { session: session ?? undefined });
    }
    await audit({ entity: 'task', entityId: id, action: 'TASK_EDITED', before: { title: t.title, dueAt: t.dueAt }, after: { title: r.title, dueAt: r.dueAt } }, { req, session });
    return r;
  });
  return view(ctx, u);
}

const to24 = (hhmm: string) => {
  const m = /^(\d{1,2}):(\d{2})\s*(AM|PM)$/i.exec(hhmm.trim());
  if (!m) return hhmm;
  let h = Number(m[1]) % 12;
  if (m[3]!.toUpperCase() === 'PM') h += 12;
  return `${String(h).padStart(2, '0')}:${m[2]}`;
};

/** Mark done (DSH-23), Reopen, Cancel (after confirmation on screen). */
export async function setStatus(ctx: AuthContext, id: string, b: { version: number }, to: 'DONE' | 'OPEN' | 'CANCELLED', req: Request) {
  const t = await load(ctx, id);
  const from: Record<typeof to, string[]> = { DONE: ['OPEN'], OPEN: ['DONE'], CANCELLED: ['OPEN'] };
  if (!from[to].includes(t.status)) throw AppError.invalidState('task', t.status);
  const r = await Task.findOneAndUpdate(
    { _id: id, accountId: ctx.accountId, version: b.version, status: { $in: from[to] } },
    { $set: { status: to, doneAt: to === 'DONE' ? clock.now() : null }, $inc: { version: 1 } },
    { new: true },
  ).lean<TaskDoc>();
  if (!r) throw AppError.versionConflict('task', await view(ctx, await load(ctx, id)));
  await audit({ entity: 'task', entityId: id, action: `TASK_${to === 'OPEN' ? 'REOPENED' : to}`, before: { status: t.status }, after: { status: to } }, { req });
  return view(ctx, r);
}

/** Dashboard "Today's tasks" (P-08): OPEN and due today or overdue, oldest due first. */
export async function dueTodayOrOverdue(ctx: AuthContext, limit: number) {
  const end = istDayBounds(istToday()).end;
  const rows = await Task.find({ accountId: ctx.accountId, status: 'OPEN', dueAt: { $lte: end } }).sort({ dueAt: 1 }).limit(limit).lean<TaskDoc[]>();
  return Promise.all(rows.map((t) => view(ctx, t)));
}