import { Schema, model } from 'mongoose';
import { logger } from '../../lib/logger.js';

/**
 * FEATURE SWITCHES for behaviour that changes rules the API already enforces (Backend Change Analysis §5.3, §9.1).
 * The old path keeps working until a SkyUp Admin switches the new one on, and web and mobile read the same value
 * (GET /v1/flags), so both change together.
 *
 *  - GLOBAL switches are one value for the whole platform (SkyUp's own approval rules).
 *  - ACCOUNT switches have a platform default and an optional value per advisor account (rolling out per account).
 *
 * Every switch is registered here with its default; code never checks a name that is not in this list. A switch is
 * removed from the code once its old path is deleted.
 *
 * Reads are synchronous from memory. The instance that saves a change reloads at once; other instances within
 * 30 seconds (the same rule as configuration values).
 */
export type FlagScope = 'GLOBAL' | 'ACCOUNT';
interface FlagDef { scope: FlagScope; default: boolean; description: string; ref: string }

export const FLAGS = {
  skyup_direct_publish: {
    scope: 'GLOBAL', default: false, ref: 'Change analysis §9.1, rows 33–47',
    description: 'SkyUp changes go live at once with OTP and audit: no second-admin approval for insurers, templates, products, corrections, message templates and configuration.',
  },
  quotation_accept_requires_payment: {
    scope: 'ACCOUNT', default: false, ref: 'Change #11, §5.2',
    description: 'Mark accepted is refused until the quotation has a PAID payment.',
  },
  payment_skips_auto_accept: {
    scope: 'ACCOUNT', default: false, ref: 'Change #11, §2.8 (pending decision)',
    description: 'Recording a payment no longer moves the quotation to ACCEPTED; the advisor marks it accepted separately.',
  },
  campaigns_website: {
    scope: 'ACCOUNT', default: true, ref: 'Change #1, §7.4 step 8',
    description: 'Website forms (embed, webhook, WordPress) can be connected and their submissions imported.',
  },
  campaigns_google: {
    scope: 'ACCOUNT', default: true, ref: 'Change #1, §7.4 step 8',
    description: 'Google Ads lead forms can be connected and their leads imported.',
  },
  campaigns_meta: {
    scope: 'ACCOUNT', default: false, ref: 'Change #1, §7.4 step 8',
    description: 'Meta Ads lead forms can be connected and their leads imported (needs Meta app review).',
  },
} as const satisfies Record<string, FlagDef>;

export type FlagKey = keyof typeof FLAGS;
export const FLAG_KEYS = Object.keys(FLAGS) as FlagKey[];
export const isFlagKey = (k: string): k is FlagKey => k in FLAGS;
export const flagDef = (k: FlagKey): FlagDef => FLAGS[k];

/** The platform value of a switch (the default until an Admin sets it). */
export const GlobalFlag = model(
  'GlobalFlag',
  new Schema({ _id: String, enabled: { type: Boolean, required: true }, reason: { type: String, required: true }, updatedBy: { type: String, required: true } }, { timestamps: true, versionKey: false }),
  'feature_flags',
);
/** An account's own value of an ACCOUNT switch. _id = `${flag}|${accountId}`. */
const accountFlagSchema = new Schema(
  { _id: String, flag: { type: String, required: true }, accountId: { type: String, required: true }, enabled: { type: Boolean, required: true }, reason: { type: String, required: true }, updatedBy: { type: String, required: true } },
  { timestamps: true, versionKey: false },
);
accountFlagSchema.index({ flag: 1, accountId: 1 }, { unique: true });
accountFlagSchema.index({ accountId: 1 });
export const AccountFlag = model('AccountFlag', accountFlagSchema, 'account_feature_flags');

const globals = new Map<FlagKey, boolean>();
const perAccount = new Map<string, boolean>(); // `${flag}|${accountId}`

/** The value in force: the account's own value, else the platform value, else the default. */
export function flagOn(key: FlagKey, accountId?: string | null): boolean {
  if (accountId && FLAGS[key].scope === 'ACCOUNT') {
    const own = perAccount.get(`${key}|${accountId}`);
    if (own !== undefined) return own;
  }
  return globals.get(key) ?? FLAGS[key].default;
}

/** Every switch as it applies to this account (or platform-wide for SkyUp users): what clients read. */
export const effectiveFlags = (accountId?: string | null) => Object.fromEntries(FLAG_KEYS.map((k) => [k, flagOn(k, accountId)])) as Record<FlagKey, boolean>;

export async function loadFlags() {
  const [g, a] = await Promise.all([
    GlobalFlag.find().lean<Array<{ _id: string; enabled: boolean }>>(),
    AccountFlag.find().lean<Array<{ flag: string; accountId: string; enabled: boolean }>>(),
  ]);
  globals.clear();
  perAccount.clear();
  for (const r of g) if (isFlagKey(r._id)) globals.set(r._id, r.enabled);
  for (const r of a) if (isFlagKey(r.flag) && FLAGS[r.flag].scope === 'ACCOUNT') perAccount.set(`${r.flag}|${r.accountId}`, r.enabled);
}

let timer: NodeJS.Timeout | undefined;
export function startFlagRefresh() {
  timer ??= setInterval(() => {
    loadFlags().catch((err) => logger.warn({ err }, 'Feature switch refresh failed; keeping current values'));
  }, 30_000);
  timer.unref();
}
export function stopFlagRefresh() {
  if (timer) clearInterval(timer);
  timer = undefined;
}