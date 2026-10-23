import { Schema, model, type InferSchemaType } from 'mongoose';
import { newId } from '../../lib/ids.js';

/**
 * Task (P-11): OPEN → DONE | CANCELLED; DONE → OPEN. Leads keep a single open follow-up task
 * (P-12, P-13, AC-P11-3). The Tasks page, reminders (SYS-07) and general tasks arrive with Section 6.
 */
const taskSchema = new Schema(
  {
    _id: { type: String, default: () => newId('tsk') },
    accountId: { type: String, required: true },
    kind: { type: String, enum: ['GENERAL', 'LEAD_FOLLOW_UP'], required: true },
    title: { type: String, required: true },
    dueAt: { type: Date, required: true },
    status: { type: String, enum: ['OPEN', 'DONE', 'CANCELLED'], default: 'OPEN' },
    linkedType: { type: String, enum: ['LEAD', 'CUSTOMER', null], default: null },
    linkedId: { type: String, default: null },
    notes: { type: String, default: null },
    createdBy: { type: String, default: null },
    version: { type: Number, default: 1 },
  },
  { timestamps: true, versionKey: false },
);
taskSchema.index({ linkedId: 1 }, { unique: true, partialFilterExpression: { kind: 'LEAD_FOLLOW_UP', status: 'OPEN' }, name: 'one_open_lead_follow_up' });
taskSchema.index({ accountId: 1, status: 1, dueAt: 1 });
export type TaskDoc = InferSchemaType<typeof taskSchema> & { _id: string };
export const Task = model('Task', taskSchema, 'tasks');
