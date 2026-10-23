import { Schema, model, type InferSchemaType } from 'mongoose';
import { newId } from '../../lib/ids.js';
import { STORED_MOBILE } from '../../lib/phone.js';

export const GENDERS = ['MALE', 'FEMALE', 'TRANSGENDER', 'PREFER_NOT_TO_SAY'] as const;
export const PREFERRED_CONTACTS = ['WHATSAPP', 'PHONE_CALL', 'EMAIL'] as const;
export const DEACTIVATION_REASONS = ['Moved to another advisor', 'Not reachable', 'Deceased', 'Duplicate record', 'Other'] as const;

/** Customer (P-15). PAN and Aadhaar are encrypted field by field and never selected unless asked for (GR-36). */
const customerSchema = new Schema(
  {
    _id: { type: String, default: () => newId('cus') },
    accountId: { type: String, required: true },
    number: { type: String, required: true },
    name: { type: String, required: true },
    nameKey: { type: String, required: true },
    dob: { type: String, default: null }, // YYYY-MM-DD, no time zone (GR-25)
    gender: { type: String, enum: [...GENDERS, null], default: null },
    mobile: { type: String, required: true, match: STORED_MOBILE },
    altMobile: { type: String, default: null },
    email: { type: String, default: null },
    preferredContact: { type: String, enum: [...PREFERRED_CONTACTS, null], default: null },
    address: {
      line1: { type: String, default: null }, line2: { type: String, default: null }, city: { type: String, default: null },
      state: { type: String, default: null }, pin: { type: String, default: null },
    },
    anniversary: { type: String, default: null },
    occupation: { type: String, default: null },
    source: { type: String, default: 'Direct' },
    leadId: { type: String, default: null },
    referrerUserId: { type: String, default: null },
    referredByCustomerId: { type: String, default: null },
    notes: { type: String, default: null },
    status: { type: String, enum: ['ACTIVE', 'INACTIVE'], default: 'ACTIVE' },
    statusReason: { type: String, default: null },
    statusNote: { type: String, default: null },
    identity: {
      panEnc: { type: String, default: null, select: false },
      panHash: { type: String, default: null },
      panMasked: { type: String, default: null },
      aadhaarEnc: { type: String, default: null, select: false },
      aadhaarHash: { type: String, default: null },
      aadhaarMasked: { type: String, default: null },
    },
    createdBy: { type: String, required: true },
    version: { type: Number, default: 1 },
  },
  { timestamps: true, versionKey: false },
);
customerSchema.index({ accountId: 1, number: 1 }, { unique: true });
// Exact duplicate = same name and mobile as an ACTIVE customer (Section 7 rule, P-15).
customerSchema.index({ accountId: 1, mobile: 1, nameKey: 1 }, { unique: true, partialFilterExpression: { status: 'ACTIVE' }, name: 'active_customer_exact_dup' });
customerSchema.index({ accountId: 1, createdAt: -1 });
customerSchema.index({ accountId: 1, mobile: 1 });
customerSchema.index({ accountId: 1, 'identity.panHash': 1 });

export type CustomerDoc = InferSchemaType<typeof customerSchema> & { _id: string; createdAt: Date; updatedAt: Date };
export const Customer = model('Customer', customerSchema, 'customers');

/** Household roster (P-16). A member never becomes a nominee or insured person automatically. */
const familySchema = new Schema(
  {
    _id: { type: String, default: () => newId('fam') },
    accountId: { type: String, required: true },
    customerId: { type: String, required: true },
    name: { type: String, required: true },
    nameKey: { type: String, required: true },
    relationship: { type: String, required: true },
    dob: { type: String, default: null },
    gender: { type: String, enum: [...GENDERS, null], default: null },
    anniversary: { type: String, default: null },
    mobile: { type: String, default: null },
    email: { type: String, default: null },
    status: { type: String, enum: ['ACTIVE', 'INACTIVE'], default: 'ACTIVE' },
    createdBy: { type: String, required: true },
    version: { type: Number, default: 1 },
  },
  { timestamps: true, versionKey: false },
);
familySchema.index({ customerId: 1, nameKey: 1, relationship: 1 }, { unique: true, partialFilterExpression: { status: 'ACTIVE' }, name: 'active_member_dup' });
familySchema.index({ accountId: 1, customerId: 1, status: 1 });
export type FamilyDoc = InferSchemaType<typeof familySchema> & { _id: string; createdAt: Date; updatedAt: Date };
export const FamilyMember = model('FamilyMember', familySchema, 'family_members');

export const CONSENT_CHANNELS = ['WHATSAPP', 'EMAIL', 'SMS', 'PERSONAL_DATA'] as const;
export type ConsentChannel = (typeof CONSENT_CHANNELS)[number];
export const HOW_GIVEN = ['Told me in person or by phone', 'Signed form', 'Replied on WhatsApp', 'Ticked on referral form'] as const;

/**
 * Consent (P-17): one current record per person and channel, with every change kept in history.
 * personKey is 'C:<customer id>', 'F:<family member id>' or 'L:<lead id>' (copied to the customer on P-14).
 * PERSONAL_DATA is the customer's consent to store identity numbers and documents (GR-37).
 */
const consentChangeSchema = new Schema(
  {
    from: { type: String, default: null }, to: { type: String, required: true }, address: { type: String, default: null },
    howGiven: { type: String, default: null }, note: { type: String, default: null },
    source: { type: String, enum: ['USER', 'SYSTEM', 'LEAD_CONVERSION'], required: true },
    by: { type: String, default: null }, at: { type: Date, required: true },
  },
  { _id: false },
);
const consentSchema = new Schema(
  {
    _id: { type: String, default: () => newId('con') },
    accountId: { type: String, required: true },
    personKey: { type: String, required: true },
    customerId: { type: String, default: null },
    channel: { type: String, enum: CONSENT_CHANNELS, required: true },
    status: { type: String, enum: ['NOT_RECORDED', 'GIVEN', 'WITHDRAWN'], required: true },
    address: { type: String, default: null }, // the exact mobile or email it was given for
    howGiven: { type: String, default: null },
    termsVersion: { type: String, default: null },
    recordedBy: { type: String, default: null },
    recordedAt: { type: Date, required: true },
    history: { type: [consentChangeSchema], default: [] },
    version: { type: Number, default: 1 },
  },
  { versionKey: false },
);
consentSchema.index({ accountId: 1, personKey: 1, channel: 1 }, { unique: true });
consentSchema.index({ accountId: 1, customerId: 1 });
export type ConsentDoc = InferSchemaType<typeof consentSchema> & { _id: string };
export const Consent = model('Consent', consentSchema, 'consents');
