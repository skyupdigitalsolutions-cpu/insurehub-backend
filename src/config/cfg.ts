import { Schema, model } from 'mongoose';
import { logger } from '../lib/logger.js';

/**
 * CONFIGURATION SERVICE (Section 3.4–3.6, NFR-13: "All CFG values are read from one configuration service").
 *
 * Every business number lives here with the default written in the document. Code never types a number
 * that has a CFG ID; it calls cfg('CFG-xx'). A value changed by a SkyUp Admin (P-49, maker-checker, not yet
 * built) is stored in the config_values table and overrides the default from the next request.
 *
 * Only the values used by the modules built so far are registered. Add each new CFG here, with its
 * documented default, when the module that uses it is built.
 */
/** A min–max pair, for values the document writes as "2 to 200 characters". */
export interface CfgRange { min: number; max: number }
export type CfgValue = number | boolean | string | string[] | number[] | CfgRange | Record<string, number>;
interface CfgDef {
  label: string;
  unit?: 'digits' | 'seconds' | 'minutes' | 'hours' | 'days' | 'working days' | 'days before expiry' | 'characters' | 'years' | 'count' | 'per hour' | 'per minute' | 'MB' | '%';
  value: CfgValue;
  change: 'ADM' | 'Release';
  /** Smallest and largest allowed values for numbers, used when an override is set. */
  range?: [number, number];
}

const DEFS = {
  'CFG-01': { label: 'OTP length', unit: 'digits', value: 6, change: 'Release', range: [4, 8] },
  'CFG-02': { label: 'OTP validity', unit: 'minutes', value: 5, change: 'ADM', range: [1, 30] },
  'CFG-03': { label: 'Wrong OTP tries per code', unit: 'count', value: 5, change: 'ADM', range: [1, 20] },
  'CFG-04': { label: 'Wait before resend', unit: 'seconds', value: 30, change: 'ADM', range: [0, 600] },
  'CFG-05': { label: 'OTP sends per mobile in any 60 minutes', unit: 'count', value: 5, change: 'ADM', range: [1, 100] },
  'CFG-06': { label: 'Lock time after CFG-03 or CFG-05 is reached', unit: 'minutes', value: 30, change: 'ADM', range: [1, 1440] },
  'CFG-07': { label: 'Session ends after no activity for', unit: 'minutes', value: 30, change: 'ADM', range: [3, 1440] },
  'CFG-08': { label: 'Longest session', unit: 'hours', value: 12, change: 'ADM', range: [1, 72] },
  'CFG-09': { label: 'Active sessions per user', unit: 'count', value: 3, change: 'ADM', range: [1, 20] },
  'CFG-10': { label: 'Registration and login requests per IP address per hour', unit: 'per hour', value: 20, change: 'ADM', range: [1, 100000] },
  'CFG-11': { label: 'Shortest name', unit: 'characters', value: 2, change: 'Release' },
  'CFG-12': { label: 'Longest name', unit: 'characters', value: 100, change: 'Release' },
  'CFG-13': { label: 'Longest notes', unit: 'characters', value: 1000, change: 'ADM', range: [100, 10000] },
  'CFG-14': { label: 'Oldest date of birth', unit: 'years', value: 120, change: 'Release' },
  'CFG-15': { label: 'Longest address line', unit: 'characters', value: 150, change: 'Release' },
  'CFG-23': { label: 'Rows per list page', unit: 'count', value: 25, change: 'ADM', range: [5, 200] },
  'CFG-24': { label: 'Search starts after', unit: 'characters', value: 3, change: 'ADM', range: [1, 10] },
  'CFG-33': {
    label: 'Lead lost reasons',
    value: ['Not interested', 'Bought elsewhere', 'Not reachable', 'Not eligible', 'Premium too high', 'Duplicate', 'Other'],
    change: 'ADM',
  },
  'CFG-35': { label: 'Family members per customer', unit: 'count', value: 15, change: 'ADM', range: [1, 100] },
  'CFG-36': {
    label: 'Relationship list',
    value: ['Spouse', 'Son', 'Daughter', 'Father', 'Mother', 'Father-in-law', 'Mother-in-law', 'Brother', 'Sister',
      'Grandfather', 'Grandmother', 'Grandson', 'Granddaughter', 'Other'],
    change: 'ADM',
  },
  'CFG-78': { label: 'Trial length', unit: 'days', value: 7, change: 'ADM', range: [1, 90] },
  'CFG-79': { label: 'Grace after subscription end', unit: 'days', value: 7, change: 'ADM', range: [0, 90] },
  'CFG-83': { label: 'Extra OTP before approve, publish, plan change, configuration change', value: true, change: 'Release' },
  'CFG-99': { label: 'Requests per user per minute', unit: 'per minute', value: 120, change: 'ADM', range: [10, 100000] },
  'CFG-26': { label: 'Allowed file types', value: ['PDF', 'JPG', 'JPEG', 'PNG'], change: 'ADM' },
  'CFG-27': { label: 'Largest file', unit: 'MB', value: 10, change: 'ADM', range: [1, 50] },
  'CFG-28': { label: 'Files per upload', unit: 'count', value: 5, change: 'ADM', range: [1, 20] },
  'CFG-100': { label: 'KYC must be Verified before sharing a quotation', value: false, change: 'ADM' },
  'CFG-105': { label: 'Licence number length', unit: 'characters', value: { min: 3, max: 30 }, change: 'Release' },
  'CFG-106': { label: 'Agent code length', unit: 'characters', value: { min: 2, max: 30 }, change: 'Release' },
  'CFG-124': {
    label: 'Profile completion weights (total 100)',
    value: { Personal: 15, Contact: 20, Professional: 20, Business: 10, KYC: 20, Insurers: 15 },
    change: 'ADM',
  },
  'CFG-125': { label: 'KYC review target', unit: 'working days', value: 2, change: 'ADM', range: [1, 30] },
  'CFG-126': { label: 'Allowed image types (photos, logos)', value: ['JPG', 'JPEG', 'PNG'], change: 'ADM' },
  'CFG-127': { label: 'Largest image', unit: 'MB', value: 2, change: 'ADM', range: [1, 20] },
  'CFG-128': { label: 'Youngest advisor age', unit: 'years', value: 18, change: 'Release' },
  'CFG-129': { label: 'Profile milestones that create a notification', unit: '%', value: [50, 100], change: 'ADM' },
  'CFG-151': { label: 'Most years of experience that can be entered', unit: 'years', value: 60, change: 'Release' },
  'CFG-152': { label: 'Licence expiry warning starts', unit: 'days before expiry', value: 60, change: 'ADM', range: [1, 365] },
  'CFG-104': { label: 'Longest city name', unit: 'characters', value: 60, change: 'Release' },
  'CFG-109': { label: 'Short text length', unit: 'characters', value: { min: 2, max: 200 }, change: 'Release' },
  'CFG-112': { label: 'Longest email address', unit: 'characters', value: 254, change: 'Release' },
  'CFG-115': {
    label: 'Starting insurance types',
    value: ['Health', 'Term Life', 'Life Savings', 'Motor Private Car', 'Motor Two-wheeler', 'Travel', 'Personal Accident', 'Home'],
    change: 'ADM',
  },
  'CFG-122': { label: 'Referrer invitation valid for', unit: 'days', value: 7, change: 'ADM', range: [1, 90] },
  'CFG-123': { label: 'Idle logout warning shown before logout', unit: 'minutes', value: 2, change: 'ADM', range: [1, 30] },
  'CFG-130': { label: 'Items in dashboard task and activity lists', unit: 'count', value: 10, change: 'ADM', range: [1, 100] },
  'CFG-133': {
    label: 'Lead source list',
    value: ['Referred by a client', 'Referred by a referrer', 'Walk-in or personal contact', 'Paid ads', 'Campaign',
      'Social media', 'Website', 'Other'],
    change: 'ADM',
  },
  'CFG-158': { label: 'Assistant users per Premium account', unit: 'count', value: 2, change: 'ADM', range: [0, 50] },
  'CFG-169': { label: 'Lead pipelines created at sign-up', value: ['Health', 'Motor', 'Life and Term', 'Travel', 'Other'], change: 'ADM' },
  'CFG-170': { label: 'Stages in every pipeline', value: ['New', 'Contacted', 'Qualified', 'Follow-up', 'Converted', 'Lost'], change: 'Release' },
  'CFG-173': { label: 'Features included in the trial', value: 'Everything except the dedicated WhatsApp number and automated WhatsApp messages', change: 'ADM' },
  'CFG-176': { label: 'A revealed Aadhaar or PAN is masked again after', unit: 'seconds', value: 30, change: 'ADM', range: [5, 300] },
} satisfies Record<string, CfgDef>;

export type CfgId = keyof typeof DEFS;

/** Values changed from the documented default. Written by P-49 (not yet built) or the dev tools. */
export const ConfigValue = model(
  'ConfigValue',
  new Schema({ _id: String, value: Schema.Types.Mixed, updatedBy: { type: String, default: null } }, { timestamps: true, versionKey: false }),
  'config_values',
);
const overrides = new Map<string, CfgValue>();

export function cfg(id: CfgId): CfgValue {
  return overrides.has(id) ? overrides.get(id)! : DEFS[id].value;
}
export const cfgNum = (id: CfgId) => cfg(id) as number;
export const cfgList = (id: CfgId) => cfg(id) as string[];
export const cfgBool = (id: CfgId) => cfg(id) as boolean;
export const cfgRange = (id: CfgId) => cfg(id) as CfgRange;
export const isCfgId = (id: string): id is CfgId => id in DEFS;

/** Every registered value with its default and current value (shown in the console's test tools). */
export function listCfg() {
  return (Object.entries(DEFS) as Array<[CfgId, CfgDef]>).map(([id, d]) => ({
    id, label: d.label, unit: d.unit ?? null, change: d.change, default: d.value, value: cfg(id), overridden: overrides.has(id),
  }));
}

/** Checks a proposed value has the same shape as the default and sits inside the allowed range. */
export function validateCfgValue(id: CfgId, value: unknown): string | null {
  const d: CfgDef = DEFS[id];
  if (typeof d.value === 'object' && !Array.isArray(d.value)) {
    const v = value as Partial<CfgRange> | null;
    return v && typeof v === 'object' && Number.isInteger(v.min) && Number.isInteger(v.max) && v.min! <= v.max! ? null : 'Must be { min, max } with min ≤ max.';
  }
  if (Array.isArray(d.value)) {
    return Array.isArray(value) && value.length > 0 && value.every((v) => typeof v === 'string' && v.trim()) ? null : 'Must be a non-empty list of text values.';
  }
  if (typeof d.value !== typeof value) return `Must be a ${typeof d.value}.`;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return 'Must be a number.';
    if (d.range && (value < d.range[0] || value > d.range[1])) return `Enter a value from ${d.range[0]} to ${d.range[1]}.`;
  }
  return null;
}

export async function loadConfigOverrides() {
  const rows = await ConfigValue.find().lean<Array<{ _id: string; value: CfgValue }>>();
  overrides.clear();
  for (const r of rows) if (isCfgId(r._id) && validateCfgValue(r._id, r.value) === null) overrides.set(r._id, r.value);
}

let timer: NodeJS.Timeout | undefined;
/** Other API instances pick up a change within 30 seconds; the instance that made it applies it at once. */
export function startConfigRefresh() {
  timer ??= setInterval(() => {
    loadConfigOverrides().catch((err) => logger.warn({ err }, 'Configuration refresh failed; keeping current values'));
  }, 30_000);
  timer.unref();
}
export function stopConfigRefresh() {
  if (timer) clearInterval(timer);
  timer = undefined;
}