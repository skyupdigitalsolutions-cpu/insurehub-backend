import { Schema, model, type InferSchemaType } from 'mongoose';
import { newId } from '../../lib/ids.js';

export const CHANNELS = ['WEBSITE', 'GOOGLE', 'META', 'LINKEDIN'] as const;
export type Channel = (typeof CHANNELS)[number];

/**
 * A connected lead channel. The key is shown once; only a keyed hash is stored, so a webhook finds its connection in one
 * lookup without decrypting anyone's secrets. Rotation keeps the previous key working for CFG-196 days.
 */
const connectionSchema = new Schema(
  {
    _id: { type: String, default: () => newId('cnx') },
    accountId: { type: String, required: true },
    channel: { type: String, enum: CHANNELS, required: true },
    name: { type: String, required: true },
    status: { type: String, enum: ['CONNECTED', 'DISCONNECTED', 'RECONNECT_NEEDED'], default: 'CONNECTED' },
    keyHash: { type: String, default: null }, keyLast4: { type: String, default: null },
    prevKeyHash: { type: String, default: null }, prevKeyUntil: { type: Date, default: null },
    pipelineId: { type: String, default: null },
    createdBy: { type: String, required: true },
    lastLeadAt: { type: Date, default: null },
  },
  { timestamps: true, versionKey: false },
);
connectionSchema.index({ keyHash: 1 }, { unique: true, partialFilterExpression: { keyHash: { $type: 'string' } } });
connectionSchema.index({ prevKeyHash: 1 }, { sparse: true });
connectionSchema.index({ accountId: 1, channel: 1 });
export type ConnectionDoc = InferSchemaType<typeof connectionSchema> & { _id: string; createdAt: Date };
export const Connection = model('CampaignConnection', connectionSchema, 'campaign_connections');

/** A form on a channel, with how its fields map to a lead. Google and website forms are created on their first lead. */
const formSchema = new Schema(
  {
    _id: { type: String, default: () => newId('lfm') },
    accountId: { type: String, required: true },
    connectionId: { type: String, required: true },
    channel: { type: String, enum: CHANNELS, required: true },
    externalId: { type: String, required: true }, // Google form_id, a website form name, or our embed form key
    name: { type: String, required: true },
    campaignName: { type: String, default: null },
    fieldMap: { type: Schema.Types.Mixed, default: {} }, // { externalKey: 'name' | 'mobile' | 'email' | 'city' | 'consent' | 'ignore' }
    fields: { type: Schema.Types.Mixed, default: null }, // our embed form: [{ key, label, type, required }]
    publicKey: { type: String, default: null }, // our embed form's public link key
    pipelineId: { type: String, default: null },
    active: { type: Boolean, default: true },
    seenKeys: { type: [String], default: [] }, // field keys seen in submissions (for the mapping screen)
  },
  { timestamps: true, versionKey: false, minimize: false },
);
formSchema.index({ connectionId: 1, externalId: 1 }, { unique: true });
formSchema.index({ publicKey: 1 }, { unique: true, partialFilterExpression: { publicKey: { $type: 'string' } } });
export type FormDoc = InferSchemaType<typeof formSchema> & { _id: string };
export const LeadForm = model('LeadForm', formSchema, 'lead_forms');

/**
 * Every submission is stored first, exactly as received, then imported. One row per platform lead ID (a database rule),
 * so a repeated webhook never creates a second lead. RECEIVED → IMPORTED | LINKED | SKIPPED | FAILED (retry possible).
 */
const submissionSchema = new Schema(
  {
    _id: { type: String, default: () => newId('sbm') },
    accountId: { type: String, required: true },
    connectionId: { type: String, required: true },
    formId: { type: String, default: null },
    channel: { type: String, enum: CHANNELS, required: true },
    externalId: { type: String, required: true },
    answers: { type: [new Schema({ key: String, label: String, value: String }, { _id: false })], default: [] },
    meta: { type: Schema.Types.Mixed, default: {} }, // campaign/ad IDs, click ID, page URL
    isTest: { type: Boolean, default: false },
    status: { type: String, enum: ['RECEIVED', 'IMPORTED', 'LINKED', 'SKIPPED', 'FAILED'], default: 'RECEIVED' },
    reason: { type: String, default: null },
    leadId: { type: String, default: null }, customerId: { type: String, default: null },
    attempts: { type: Number, default: 0 },
  },
  { timestamps: true, versionKey: false, minimize: false },
);
submissionSchema.index({ connectionId: 1, externalId: 1 }, { unique: true, name: 'one_submission_per_platform_lead' });
submissionSchema.index({ accountId: 1, createdAt: -1 });
submissionSchema.index({ accountId: 1, leadId: 1 });
export type SubmissionDoc = InferSchemaType<typeof submissionSchema> & { _id: string; createdAt: Date };
export const Submission = model('LeadSubmission', submissionSchema, 'lead_submissions');