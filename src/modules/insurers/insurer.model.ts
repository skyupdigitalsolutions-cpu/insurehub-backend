import { Schema, model, type InferSchemaType } from 'mongoose';
import { newId } from '../../lib/ids.js';

/**
 * Insurance company (P-20). All P-20 fields and states exist now; the catalogue screens and the
 * maker-checker approval (DRAFT → PENDING_APPROVAL → ACTIVE, approved by a different ADM) arrive with
 * Module 8. Until then insurers are created with the development tools (POST /v1/dev/insurers).
 */
export const INSURER_STATUSES = ['DRAFT', 'PENDING_APPROVAL', 'ACTIVE', 'INACTIVE'] as const;
export const INSURER_CATEGORIES = ['Life', 'General', 'Standalone Health'] as const;

const insurerSchema = new Schema(
  {
    _id: { type: String, default: () => newId('ins') },
    name: { type: String, required: true },
    nameKey: { type: String, required: true }, // lowercased: name is unique ignoring case
    shortCode: { type: String, required: true },
    category: { type: String, enum: INSURER_CATEGORIES, required: true },
    irdaiRegNo: { type: String, required: true },
    website: { type: String, default: null },
    paymentDomains: { type: [String], default: [] },
    careNumber: { type: String, default: null },
    careEmail: { type: String, default: null },
    logoFileId: { type: String, default: null },
    status: { type: String, enum: INSURER_STATUSES, default: 'DRAFT' },
    /** Maker-checker (P-20): who made the current draft or change; the approver must be someone else (CAT-05). */
    makerId: { type: String, default: null },
    submittedAt: { type: Date, default: null },
    rejectReason: { type: String, default: null },
    /**
     * An edit to an ACTIVE or INACTIVE insurer waits here until approved; advisors keep the live values meanwhile
     * (AC-P20-3). One pending change at a time (CAT-08). A rejected change keeps its values for editing.
     */
    pendingChange: {
      type: new Schema({
        values: { type: Schema.Types.Mixed, required: true },
        status: { type: String, enum: ['PENDING', 'REJECTED'], required: true },
        makerId: { type: String, required: true },
        at: { type: Date, required: true },
        reason: { type: String, default: null },
      }, { _id: false }),
      default: null,
    },
    approvedBy: { type: String, default: null },
    approvedAt: { type: Date, default: null },
    version: { type: Number, default: 1 },
  },
  { timestamps: true, versionKey: false },
);
insurerSchema.index({ nameKey: 1 }, { unique: true });
insurerSchema.index({ shortCode: 1 }, { unique: true });
insurerSchema.index({ status: 1, name: 1 });

export type InsurerDoc = InferSchemaType<typeof insurerSchema> & { _id: string };
export const Insurer = model('Insurer', insurerSchema, 'insurers');