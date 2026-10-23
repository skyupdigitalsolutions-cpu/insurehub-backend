import { Schema, model, type InferSchemaType } from 'mongoose';
import { newId } from '../../lib/ids.js';

/**
 * Account = one advisor's private space (tenant, Section 1.6). Subscription, wallet, empty advisor
 * profile, lead pipelines and reference-number counters are embedded, so P-01 creates the whole
 * account in a single document write (plus the advisor's user record).
 */
const pipelineSchema = new Schema({ _id: { type: String, required: true }, name: { type: String, required: true }, position: Number });

const accountSchema = new Schema(
  {
    _id: { type: String, default: () => newId('acc') },
    status: { type: String, enum: ['ACTIVE', 'SUSPENDED', 'CLOSED'], default: 'ACTIVE' },
    statusReason: { type: String, default: null },
    closedAt: { type: Date, default: null },
    subscription: {
      // P-01: TRIAL with no plan chosen. P-47 sets NORMAL or PREMIUM.
      plan: { type: String, enum: ['NORMAL', 'PREMIUM', null], default: null },
      status: { type: String, enum: ['TRIAL', 'ACTIVE', 'GRACE', 'EXPIRED'], required: true },
      startsAt: { type: Date, required: true },
      endsAt: { type: Date, required: true },
    },
    wallet: { balancePaise: { type: Number, default: 0, min: 0 } },
    profile: {
      kycStatus: { type: String, enum: ['NOT_SUBMITTED', 'PENDING_REVIEW', 'VERIFIED', 'REJECTED'], default: 'NOT_SUBMITTED' },
      completionPct: { type: Number, default: 0 },
      termsVersion: { type: String, required: true },
      termsAcceptedAt: { type: Date, required: true },
    },
    pipelines: { type: [pipelineSchema], default: [] },
    counters: { lead: { type: Number, default: 0 }, customer: { type: Number, default: 0 } },
    version: { type: Number, default: 1 },
  },
  { timestamps: true, versionKey: false },
);

export type AccountDoc = InferSchemaType<typeof accountSchema> & { _id: string };
export const Account = model('Account', accountSchema, 'accounts');
