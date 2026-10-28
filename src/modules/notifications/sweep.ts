import { cfgNum } from '../../config/cfg.js';
import { clock, istTime } from '../../lib/clock.js';
import { logger } from '../../lib/logger.js';
import { Customer } from '../customers/customer.model.js';
import { Lead } from '../leads/lead.model.js';
import { Task, type TaskDoc } from '../tasks/task.model.js';
import { User } from '../users/user.model.js';
import { notify, removeOld } from './notifications.service.js';

/**
 * Runs every minute (server.ts). Safe to run on several API servers at once: every reminder goes through
 * the bell's unique dedupe key, so a repeated or parallel sweep never creates a second item.
 *  - DSH-11: OPEN tasks whose due time is within CFG-34 and still ahead, once per task and due time (AC-P11-2).
 *  - P-10 step 4: bell items older than CFG-72 are removed.
 */
export async function runSweep(now = clock.now()) {
  const soon = new Date(now.getTime() + cfgNum('CFG-34') * 60_000);
  const due = await Task.find({ status: 'OPEN', dueAt: { $gt: now, $lte: soon }, $expr: { $ne: ['$remindedFor', '$dueAt'] } }).limit(500).lean<TaskDoc[]>();
  let reminders = 0;
  for (const t of due) {
    const adv = await User.findOne({ accountId: t.accountId, role: 'ADV' }, { _id: 1 }).lean<{ _id: string }>();
    if (!adv) continue;
    let name = t.title;
    if (t.linkedId) {
      const rec = t.linkedType === 'LEAD' ? await Lead.findById(t.linkedId, { name: 1 }).lean<{ name: string }>() : await Customer.findById(t.linkedId, { name: 1 }).lean<{ name: string }>();
      if (rec) name = rec.name;
    }
    const created = await notify({
      userId: adv._id, accountId: t.accountId, kind: 'TASK_DUE_SOON', messageId: 'DSH-11', params: { name, time: istTime(t.dueAt) },
      dedupeKey: `DSH-11|${t._id}|${new Date(t.dueAt).toISOString()}`, link: { type: 'TASK', id: t._id },
    });
    await Task.updateOne({ _id: t._id, dueAt: t.dueAt }, { $set: { remindedFor: t.dueAt } });
    if (created) reminders++;
  }
  const removed = await removeOld(now);
  return { reminders, removed };
}

let timer: NodeJS.Timeout | undefined;
export function startSweep() {
  timer = setInterval(() => { runSweep().catch((e: Error) => logger.warn({ reason: e.message }, 'Notification sweep failed; next run in a minute')); }, 60_000);
  timer.unref();
}
export function stopSweep() { if (timer) clearInterval(timer); }