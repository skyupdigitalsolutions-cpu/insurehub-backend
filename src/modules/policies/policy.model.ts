import { Schema, model, type InferSchemaType } from 'mongoose';
import { newId } from '../../lib/ids.js';

/**
 * The policy record (Section 13). P-55 creates it AWAITING_ISSUANCE on submission with a frozen copy of members,
 * declarations and nominees; P-33 (Module 12) records the issued policy on it. CANCELLED if the insurer declines.
 */
const policySchema = new Schema(
  {
    _id: { type: String, default: () => newId('pol') },
    accountId: { type: String, required: true },
    customerId: { type: String, required: true },
    proposalId: { type: String, required: true },
    quotationId: { type: String, required: true },
    status: { type: String, enum: ['AWAITING_ISSUANCE', 'ACTIVE', 'CANCELLED', 'LAPSED', 'EXPIRED', 'RENEWED'], default: 'AWAITING_ISSUANCE' },
    frozen: { type: Schema.Types.Mixed, required: true }, // members, declarations, nominees, product, premium, payment
    version: { type: Number, default: 1 },
  },
  { timestamps: true, versionKey: false, minimize: false },
);
policySchema.index({ accountId: 1, customerId: 1 });
policySchema.index({ proposalId: 1 }, { unique: true });
export type PolicyDoc = InferSchemaType<typeof policySchema> & { _id: string };
export const Policy = model('Policy', policySchema, 'policies');