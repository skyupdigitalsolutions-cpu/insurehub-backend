import type { ClientSession } from 'mongoose';
import { cfgNum } from '../../config/cfg.js';
import { clock } from '../../lib/clock.js';
import { AppError } from '../../lib/errors.js';
import { msg, type MessageId, type MessageParams } from '../../lib/messages.js';
import { isDuplicateKey } from '../../lib/mongo.js';
import { Customer } from '../customers/customer.model.js';
import { Lead } from '../leads/lead.model.js';
import type { AuthContext } from '../rbac/capabilities.js';
import { Task } from '../tasks/task.model.js';
import { Notification, type NotificationDoc } from './notification.model.js';

export interface NotifyInput {
  userId: string; accountId: string | null; kind: string; messageId: MessageId; params?: MessageParams;
  dedupeKey: string; link?: { type: NotificationDoc['linkType']; id: string } | null;
}

/** Create a bell item once per dedupe key (AC-P10-2). Returns false when it already existed. */
export async function notify(n: NotifyInput, session: ClientSession | null = null): Promise<boolean> {
  try {
    await new Notification({
      userId: n.userId, accountId: n.accountId, kind: n.kind, messageId: n.messageId, message: msg(n.messageId, n.params ?? {}),
      dedupeKey: n.dedupeKey, linkType: n.link?.type ?? null, linkId: n.link?.id ?? null,
    }).save({ session: session ?? undefined });
    return true;
  } catch (e) {
    if (isDuplicateKey(e, 'one_item_per_event')) return false;
    throw e;
  }
}

/** "99+" above CFG-149 (P-10 step 1). */
const shown = (n: number) => (n > cfgNum('CFG-149') ? `${cfgNum('CFG-149')}+` : String(n));

export async function unreadCount(ctx: AuthContext) {
  const unread = await Notification.countDocuments({ userId: ctx.userId, readAt: null });
  return { unread, shown: shown(unread) };
}

/** The bell list: the user's own items, newest first (P-10 step 2). */
export async function list(ctx: AuthContext, opts: { before?: Date; limit: number }) {
  const rows = await Notification.find({ userId: ctx.userId, ...(opts.before ? { createdAt: { $lt: opts.before } } : {}) })
    .sort({ createdAt: -1 }).limit(opts.limit + 1).lean<NotificationDoc[]>();
  const items = rows.slice(0, opts.limit).map((r) => ({
    id: r._id, messageId: r.messageId, message: r.message, createdAt: r.createdAt, read: !!r.readAt,
    link: r.linkType ? { type: r.linkType, id: r.linkId } : null,
  }));
  return { items, more: rows.length > opts.limit, ...(await unreadCount(ctx)) };
}

/** Is the linked record still visible to this user? Inaccessible links get GEN-11 and leak nothing (AC-P10-4). */
async function linkVisible(ctx: AuthContext, type: string, id: string): Promise<boolean> {
  switch (type) {
    case 'TASK': return !!(await Task.exists({ _id: id, accountId: ctx.accountId }));
    case 'LEAD': return !!(await Lead.exists({ _id: id, accountId: ctx.accountId }));
    case 'CUSTOMER': return !!(await Customer.exists({ _id: id, accountId: ctx.accountId }));
    case 'PROFILE': return id === ctx.accountId;
    case 'KYC_REVIEW': return ctx.role === 'STF' || ctx.role === 'ADM';
    default: return false;
  }
}

/** Select an item: mark it READ, then open its record (P-10 step 3). */
export async function open(ctx: AuthContext, id: string) {
  const n = await Notification.findOne({ _id: id, userId: ctx.userId }).lean<NotificationDoc>();
  if (!n) throw AppError.notFound();
  await Notification.updateOne({ _id: id, readAt: null }, { $set: { readAt: clock.now() } }); // first read time is kept
  if (!n.linkType || !n.linkId) return { link: null, ...(await unreadCount(ctx)) };
  if (!(await linkVisible(ctx, n.linkType, n.linkId))) throw AppError.notFound(); // read, but nothing revealed
  return { link: { type: n.linkType, id: n.linkId }, ...(await unreadCount(ctx)) };
}

export async function readAll(ctx: AuthContext) {
  const r = await Notification.updateMany({ userId: ctx.userId, readAt: null }, { $set: { readAt: clock.now() } });
  return { marked: r.modifiedCount, ...(await unreadCount(ctx)) };
}

/** P-10 step 4: items older than CFG-72 are removed. */
export async function removeOld(now = clock.now()) {
  const before = new Date(now.getTime() - cfgNum('CFG-72') * 86_400_000);
  return (await Notification.deleteMany({ createdAt: { $lt: before } })).deletedCount;
}