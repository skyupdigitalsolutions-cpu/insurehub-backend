import { Schema, model, type InferSchemaType } from 'mongoose';
import { newId } from '../../lib/ids.js';
import { STORED_MOBILE } from '../../lib/phone.js';
import { LEAD_STATUSES } from './leadStatus.js';

export const CONTACT_OUTCOMES = ['SPOKE_TO_CUSTOMER', 'NOT_REACHABLE', 'ASKED_TO_CALL_BACK'] as const;
export const OUTCOME_LABEL = { SPOKE_TO_CUSTOMER: 'Spoke to customer', NOT_REACHABLE: 'Not reachable', ASKED_TO_CALL_BACK: 'Asked to call back' } as const;
export const PRIORITIES = ['HIGH', 'MEDIUM', 'LOW'] as const;

/** Stage history: every move with who, when, from, to, reason and note (P-13 backend rules). */
const stageSchema = new Schema(
  { from: { type: String, default: null }, to: { type: String, required: true }, reason: { type: String, default: null },
    note: { type: String, default: null }, by: { type: String, default: null }, at: { type: Date, required: true } },
  { _id: false },
);
/** Contact log (P-13 step 2). */
const contactSchema = new Schema({
  _id: { type: String, default: () => newId('act') },
  outcome: { type: String, enum: CONTACT_OUTCOMES, required: true },
  note: { type: String, default: null },
  at: { type: Date, required: true },
  by: { type: String, required: true },
});

const leadSchema = new Schema(
  {
    _id: { type: String, default: () => newId('led') },
    accountId: { type: String, required: true },
    number: { type: String, required: true },
    pipelineId: { type: String, required: true },
    name: { type: String, required: true },
    nameKey: { type: String, required: true },
    mobile: { type: String, required: true, match: STORED_MOBILE },
    altMobile: { type: String, default: null },
    email: { type: String, default: null },
    source: { type: String, required: true },
    referrerUserId: { type: String, default: null },
    referredByCustomerId: { type: String, default: null },
    campaign: { type: String, default: null },
    interests: { type: [String], default: [] },
    priority: { type: String, enum: PRIORITIES, default: 'MEDIUM' },
    nextFollowUpAt: { type: Date, default: null },
    notes: { type: String, default: null },
    status: { type: String, enum: LEAD_STATUSES, default: 'NEW' },
    isOpen: { type: Boolean, default: true }, // not CONVERTED or LOST; drives the duplicate rule
    lostReason: { type: String, default: null },
    lostNote: { type: String, default: null },
    customerId: { type: String, default: null },
    convertedAt: { type: Date, default: null },
    createdBy: { type: String, required: true },
    stageHistory: { type: [stageSchema], default: [] },
    contacts: { type: [contactSchema], default: [] },
    version: { type: Number, default: 1 },
  },
  { timestamps: true, versionKey: false },
);
leadSchema.index({ accountId: 1, number: 1 }, { unique: true });
// Exact duplicate = same name and mobile in an open lead: a database rule (P-12, GR-12).
leadSchema.index({ accountId: 1, mobile: 1, nameKey: 1 }, { unique: true, partialFilterExpression: { isOpen: true }, name: 'open_lead_exact_dup' });
leadSchema.index({ accountId: 1, createdAt: -1 });
leadSchema.index({ accountId: 1, pipelineId: 1, status: 1 });
leadSchema.index({ accountId: 1, mobile: 1 });

export type LeadDoc = InferSchemaType<typeof leadSchema> & { _id: string; createdAt: Date; updatedAt: Date };
export const Lead = model('Lead', leadSchema, 'leads');
