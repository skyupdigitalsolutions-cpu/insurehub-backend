import type { Role } from '../users/user.model.js';

/**
 * PERMISSION MATRIX (Section 3.2). Roles are fixed; there are no custom roles in v3.2.
 * Routes check a capability, never a role name. "Own" in the matrix = the user's own account,
 * enforced by every query filtering on accountId (GR-20).
 */
export const CAPABILITIES = {
  /** Leads: create, edit, move between stages, convert, log contacts (P-12 to P-14). */
  'leads.work': ['ADV', 'AST'],
  /** Leads: mark lost or reopen (ADV only). */
  'leads.loseReopen': ['ADV'],
  /** Correct a lead's source or referrer after saving (P-12: "only the advisor"). */
  'leads.correctSource': ['ADV'],
  /** Client records, household roster, consent, PAN/Aadhaar entry (P-15 to P-17). */
  'customers.work': ['ADV', 'AST'],
  /** Deactivate or reactivate a customer (P-19; assistants cannot archive). */
  'customers.deactivate': ['ADV'],
  /** Show the full PAN or Aadhaar (GR-36; assistants see masked only). */
  'customers.revealIdentity': ['ADV'],
  /** Own advisor profile: personal, contact, professional and business sections (P-05). */
  'profile.manage': ['ADV'],
  /** Review advisor KYC: verify or reject (P-06). Advisor's own data, not client data: no support grant needed. */
  'kyc.review': ['STF', 'ADM'],
  /** The advisor's insurers and agent codes (P-07). */
  'insurers.manage': ['ADV'],
  /** See accounts flagged because they share an insurer and agent code (P-07, DEC-09). */
  'agentCodes.review': ['STF', 'ADM'],
  /** Upload, view and confirm customer documents (P-18). */
  'documents.work': ['ADV', 'AST'],
  /** Change a document's label (P-18 step 8: ADV only). */
  'documents.relabel': ['ADV'],
  /** A customer's vehicles: add, new photo/RC versions, mark sold (P-54). */
  'vehicles.work': ['ADV', 'AST'],
  /** Manage assistant users (P-53). */
  'assistants.manage': ['ADV'],
  /** Manage SkyUp users (P-48). */
  'staff.manage': ['ADM'],
  /** Audit log: ADV own account; STF metadata only; ADM everything (P-50). */
  'audit.view': ['ADV', 'STF', 'ADM'],
} as const satisfies Record<string, readonly Role[]>;

export type Capability = keyof typeof CAPABILITIES;

/** Capabilities that open client personal data: SkyUp needs a support grant (P-57, GR-39). */
export const CLIENT_DATA = new Set<Capability>(['leads.work', 'leads.loseReopen', 'leads.correctSource', 'customers.work',
  'customers.deactivate', 'customers.revealIdentity']);

export const can = (role: Role, cap: Capability) => (CAPABILITIES[cap] as readonly Role[]).includes(role);
export const capabilitiesOf = (role: Role) => (Object.keys(CAPABILITIES) as Capability[]).filter((c) => can(role, c));

export interface AuthContext {
  userId: string;
  sessionId: string;
  role: Role;
  name: string;
  mobile: string;
  accountId: string | null;
  client: 'WEB' | 'APP';
  /** Effective subscription for account users (null for SkyUp users). */
  subscription: { status: 'TRIAL' | 'ACTIVE' | 'GRACE' | 'EXPIRED'; plan: 'NORMAL' | 'PREMIUM' | null; endsAt: Date } | null;
  /** GR-33: an EXPIRED subscription can view, search and export, but not create, edit or send. */
  readOnly: boolean;
  capabilities: Capability[];
}