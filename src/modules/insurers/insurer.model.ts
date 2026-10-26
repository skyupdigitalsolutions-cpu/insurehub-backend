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
    version: { type: Number, default: 1 },
  },
  { timestamps: true, versionKey: false },
);
insurerSchema.index({ nameKey: 1 }, { unique: true });
insurerSchema.index({ shortCode: 1 }, { unique: true });
insurerSchema.index({ status: 1, name: 1 });

export type InsurerDoc = InferSchemaType<typeof insurerSchema> & { _id: string };
export const Insurer = model('Insurer', insurerSchema, 'insurers');