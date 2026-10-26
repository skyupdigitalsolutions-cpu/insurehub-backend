import { cfg, isCfgId, type CfgRange } from '../config/cfg.js';
import { env } from '../config/env.js';

/**
 * MESSAGE CATALOGUE (Section 21, NFR-14). Exact wording; a wording change is a document change first.
 * Only the IDs used by the modules built so far are listed. Placeholders in {curly brackets} are filled
 * at run time; {CFG-xx} always shows the live configured value (GR-08).
 */
export const MESSAGES = {
  // ── General (2.6) ──
  'GEN-01': '{Field label} is required.',
  'GEN-02': 'Please correct the {count} highlighted fields.',
  'GEN-03': 'You do not have permission to do this.',
  'GEN-04': 'This action is not allowed because this {record type} is {current status}.',
  'GEN-05': 'Someone changed this {record type} while you were editing. Your changes are not saved yet. Reload the latest version and apply your changes again.',
  'GEN-06': 'This was already submitted. Showing the saved result.',
  'GEN-07': 'Could not reach Bimayantra. Your entries are kept. Check your internet connection and select Retry.',
  'GEN-08': '{Record type} saved.',
  'GEN-09': 'Your session has ended for security. Verify your mobile number to continue. Your entries are kept.',
  'GEN-10': 'You have unsaved changes. Leave this page and lose them?',
  'GEN-11': 'This record does not exist or you do not have access to it.',
  'GEN-12': 'This is taking longer than usual and may still complete. Select Check status before trying again.',
  'GEN-15': 'Too many attempts. Please wait {seconds} seconds and try again.',
  'GEN-17': 'This {record type} was changed or removed by someone else. Showing the latest version.',
  'GEN-19': 'Bimayantra is being updated. Please try again after {time} IST.',
  'GEN-99': 'Something unexpected happened. Please try again. If it happens again, share this reference with support: {errorId}.',

  // ── Field formats (2A) ──
  'VAL-01': 'Enter a 10-digit Indian mobile number starting with 6, 7, 8 or 9.',
  'VAL-02': "Enter a name of {CFG-11} to {CFG-12} characters using letters, spaces, dot (.), apostrophe (') or hyphen (-).",
  'VAL-03': 'Enter a valid email address, for example name@example.com.',
  'VAL-04': 'Enter a valid date in DD-MM-YYYY format.',
  'VAL-17': 'Enter the number exactly as shown on your IRDAI licence or POSP certificate ({CFG-105} letters, digits, - or /).',
  'VAL-18': 'Enter the agent code given by this insurer ({CFG-106} letters, digits, - or /).',
  'VAL-23': 'This file type is not allowed. Upload one of: {allowed types}.',
  'VAL-24': 'This file is larger than {size limit} MB. Upload a smaller file.',
  'VAL-25': 'You can upload up to {CFG-28} files at a time.',
  'VAL-26': 'This file could not be opened. It may be damaged or password-protected.',
  'VAL-27': 'This file did not pass the security check and was not uploaded.',
  'VAL-39': 'Enter a valid 15-character GSTIN, for example 29ABCDE1234F1Z5, or leave it blank.',
  // ── Advisor profile, KYC, insurers (P-05 to P-07) ──
  'PRF-01': 'Profile saved. Your profile is {percent}% complete.',
  'PRF-02': 'Your profile is {percent}% complete. Add {missing items} to finish.',
  'PRF-03': 'To share quotations, first add: {missing items}.',
  'PRF-04': 'KYC submitted for review. We aim to review it within {CFG-125} working days.',
  'PRF-05': 'Your KYC has been verified.',
  'PRF-06': 'Your KYC was not accepted: {reason}. Please correct it and submit again.',
  'PRF-07': 'Changing this will send your KYC for review again. Continue?',
  'PRF-08': '{Insurer} added with agent code {code}.',
  'PRF-09': 'You have already added {insurer}. Edit the existing entry instead.',
  'PRF-10': '{Insurer} is no longer available in Bimayantra. You cannot create new quotations for it.',
  'PRF-11': 'Your agent code for {insurer} expired on {date}. Update it to create new quotations.',
  'PRF-12': 'You will not be able to create new quotations for {insurer}. Existing quotations and policies are not affected. Continue?',
  'PRF-13': 'Your licence validity date has passed. Update your licence details to keep sharing quotations.',
  'PRF-14': 'You must be {CFG-128} or older to use Bimayantra as an advisor.',
  'PRF-16': 'Your IRDAI licence expires on {date}. Renew it and update your profile to keep creating quotations.',
  'PRF-17': 'Your IRDAI licence expired on {date}. You cannot create new quotations until you update your licence details.',
  'PRF-18': '{Insurance type} is not in your authorised categories. Add it in your profile if your licence allows it.',
  'VAL-05': 'Date of birth cannot be in the future.',
  'VAL-06': 'Enter a date of birth within the last {CFG-14} years.',
  'VAL-07': 'Choose today or a later date.',
  'VAL-11': 'Enter a percentage from 0 to 100 with up to 2 decimal places.',
  'VAL-12': 'Enter a whole number from {min} to {max}.',
  'VAL-13': 'Enter an address of 3 to {CFG-15} characters.',
  'VAL-14': 'Enter a city or town name of 2 to {CFG-104} letters.',
  'VAL-15': 'Enter a 6-digit PIN code that does not start with 0.',
  'VAL-16': 'Enter a valid PAN of an individual, for example ABCPE1234F.',
  'VAL-19': 'Enter the {CFG-01}-digit code sent to your mobile.',
  'VAL-21': 'Notes can have up to {CFG-13} characters.',
  'VAL-22': 'Choose an option from the list.',
  'VAL-29': 'Tick this box to continue.',
  'VAL-32': 'Enter a valid time, for example 10:30 AM.',
  'VAL-34': 'Enter {CFG-109} characters.',
  'VAL-35': 'This date cannot be in the future.',
  'VAL-38': 'Enter a valid 12-digit Aadhaar number.',

  // ── Access (Section 5) ──
  'AUTH-01': 'We sent a {CFG-01}-digit code to {masked mobile}. It is valid for {CFG-02} minutes.',
  'AUTH-02': 'The code is incorrect. You have {n} tries left.',
  'AUTH-03': 'This code has expired. Select Resend OTP to get a new code.',
  'AUTH-04': 'Too many wrong tries. For your security, try again after {time} IST.',
  'AUTH-05': 'You can request a new code in {seconds} seconds.',
  'AUTH-06': 'Too many codes were requested for this number. Try again after {time} IST.',
  'AUTH-07': 'You already have an advisor account with this number. You are now logged in.',
  'AUTH-08': 'This number is already used for a different Bimayantra access. Use another mobile number to register as an advisor.',
  'AUTH-09': 'No account uses this number. Check the number, or register as a new advisor.',
  'AUTH-10': 'Your account is suspended. Contact Bimayantra support at {support email}.',
  'AUTH-11': 'Your access has been switched off. Contact the advisor who invited you.',
  'AUTH-12': 'Welcome, {name}. Your access is ready.',
  'AUTH-13': 'We could not send the OTP right now. Please try again in a minute.',
  'AUTH-14': 'This account was closed on {date}. Contact Bimayantra support at {support email}.',
  'AUTH-15': 'Welcome to Bimayantra, {name}. Your {CFG-78}-day free trial has started.',
  'AUTH-16': 'You have logged out.',
  'AUTH-17': 'You were logged out because your account was signed in on another device.',
  'AUTH-18': 'Your session ended after {CFG-07} minutes without activity. Please log in again.',
  'AUTH-19': 'Your SkyUp access has been switched off. Contact a SkyUp Admin.',
  'AUTH-20': 'Your invitation has expired. Ask the advisor to invite you again.',
  'AUTH-21': 'You will be logged out in {CFG-123} minutes because of no activity.',
  'AUTH-22': 'The session on {device} has ended.',
  'AUTH-23': 'Your mobile number is now {masked new number}. Use it from your next login.',
  'AUTH-24': 'This is already your registered number.',
  'AUTH-25': 'This number is already in use. Enter a different number.',
  'AUTH-26': 'Confirm it is you: enter the OTP sent to {masked mobile}.',

  // ── Dashboard and tasks (Section 6) ──
  'DSH-01': 'Could not load this section. Select Retry.',
  'DSH-24': 'Choose a time later than now.',

  // ── Leads (Section 7) ──
  'LD-01': 'Lead {lead number} created.',
  'LD-02': 'An open lead with this name and mobile already exists: {lead number}. Open it instead.',
  'LD-03': 'Another open lead uses this mobile: {name} ({lead number}). Save anyway if this is a different person.',
  'LD-04': '{Name} is already your customer ({customer number}). Open the customer, or save the lead anyway.',
  'LD-05': 'Lead moved to {status}.',
  'LD-06': 'Choose a reason for marking this lead as lost.',
  'LD-07': 'Lead reopened.',
  'LD-08': 'This lead has been converted. Open customer {customer number} instead.',
  'LD-09': 'Alternate mobile must be different from the primary mobile.',
  'LD-10': 'Customer {customer number} created from lead {lead number}.',
  'LD-11': 'Lead {lead number} linked to existing customer {customer number}.',

  // ── Customers (Section 8) ──
  'CU-01': 'Customer {customer number} created.',
  'CU-02': 'A customer with this name and mobile already exists: {customer number}. Open it instead.',
  'CU-03': 'Another customer uses this mobile: {name} ({customer number}). Save anyway if this is a different person.',
  'CU-05': "{Name} added to {customer}'s family.",
  'CU-06': 'A customer can have up to {CFG-35} family members.',
  'CU-07': '{Name} ({relationship}) is already in this family.',
  'CU-08': 'Cancel these open items before deactivating: {list}.',
  'CU-09': '{Customer} is now inactive. Automated messages to this customer and family have stopped.',
  'CU-10': '{Customer} is active again.',
  'CU-11': '{Channel} consent recorded for {name}.',
  'CU-12': '{Channel} consent withdrawn for {name}. No more automated {channel} messages will be sent.',
  'CU-13': 'Add a mobile number for {name} before recording {channel} consent.',
  'CU-14': 'Add an email address for {name} before recording email consent.',
  'CU-19': '{Name} is now inactive. Greetings for them have stopped.',
  'CU-20': '{Customer} is inactive. Reactivate the customer to do this.',
  'CU-21': 'Consent for WhatsApp and SMS belongs to a mobile number. Changing the number removes that consent. Continue?',
  'CU-22': 'Email consent belongs to an email address. Changing the email removes that consent. Continue?',
  'CU-23': "Record {customer}'s consent to store personal data before adding PAN or Aadhaar.",
  'CU-25': 'Showing the full number for {CFG-176} seconds. This view is recorded.',
  'CU-29': 'Another customer ({customer number}) has this PAN. Check the number.',
  'CU-30': '{Customer} has withdrawn consent to store personal data. New identity details and documents cannot be added.',

  // ── Subscription, assistants, SkyUp admin, referrers, support (Sections 16–17) ──
  'SUB-03': 'Your subscription has ended. You can view and export your records, but you cannot create, edit or send anything until you renew.',
  'AST-01': 'Assistant {name} added. They can log in with their mobile number.',
  'AST-02': 'Your plan allows up to {CFG-158} assistants.',
  'AST-03': 'Assistant {name} can no longer log in.',
  'AST-04': 'Assistant users are available on the Premium plan.',
  'ADM-01': '{Name} added as {role}. They can log in with their mobile number.',
  'ADM-02': 'At least one SkyUp Admin must stay active.',
  'ADM-03': 'You cannot disable or change your own access.',
  'REF-02': 'This mobile number already has Bimayantra access. Use a different number.',
  'SUP-03': 'You need a support grant from this advisor to open client details.',
} as const;

export type MessageId = keyof typeof MESSAGES;
export type MessageParams = Record<string, string | number>;

function cfgText(id: string): string | null {
  if (!isCfgId(id)) return null;
  const v = cfg(id);
  if (Array.isArray(v)) return v.join(', ');
  if (typeof v === 'object') return `${(v as CfgRange).min} to ${(v as CfgRange).max}`;
  return String(v);
}

/** The exact text for a message ID with its placeholders filled. Unknown placeholders are left visible. */
export function msg(id: MessageId, params: MessageParams = {}): string {
  const all: MessageParams = { 'support email': env.SUPPORT_EMAIL, ...params };
  return MESSAGES[id].replace(/\{([^}]+)\}/g, (whole, key: string) => {
    if (key in all) return String(all[key]);
    return cfgText(key) ?? whole;
  });
}

export const isMessageId = (v: string): v is MessageId => v in MESSAGES;