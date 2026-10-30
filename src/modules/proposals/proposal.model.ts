import { Schema, model, type InferSchemaType } from 'mongoose';
import { newId } from '../../lib/ids.js';

/**
 * P-55 proposal: DRAFT → SUBMITTED → (DECLINED). Members are locked from the quotation; declarations and nominees
 * belong to this proposal and its policy only (backend rule).
 */
const proposalSchema = new Schema(
  {
    _id: { type: String, default: () => newId('prp') },
    accountId: { type: String, required: true },
    quotationId: { type: String, required: true },
    revision: { type: Number, required: true },
    customerId: { type: String, required: true },
    number: { type: String, required: true }, // PR-YYYYMM-NNNNN
    status: { type: String, enum: ['DRAFT', 'SUBMITTED', 'DECLINED'], default: 'DRAFT' },
    members: { type: Schema.Types.Mixed, default: [] }, // locked (PRP-06)
    questions: { type: [String], default: [] },
    declarations: { type: Schema.Types.Mixed, default: [] },
    nominees: { type: Schema.Types.Mixed, default: [] },
    declineReason: { type: String, default: null },
    policyId: { type: String, default: null },
    submittedAt: { type: Date, default: null }, submittedBy: { type: String, default: null },
    createdBy: { type: String, required: true },
    version: { type: Number, default: 1 },
  },
  { timestamps: true, versionKey: false, minimize: false },
);
/** One open proposal per quotation (P-55 precondition). */
proposalSchema.index({ quotationId: 1 }, { unique: true, partialFilterExpression: { status: { $eq: 'DRAFT' } }, name: 'one_draft_per_quotation' });
proposalSchema.index({ accountId: 1, number: 1 }, { unique: true });
export type ProposalDoc = InferSchemaType<typeof proposalSchema> & { _id: string; updatedAt: Date };
export const Proposal = model('Proposal', proposalSchema, 'proposals');