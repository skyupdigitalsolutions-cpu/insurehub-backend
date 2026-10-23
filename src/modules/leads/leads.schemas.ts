import { z } from 'zod';
import {
  confirmations, editable, email, enumOf, futureDateTime, lists, mobile, notes, oneOf, optional, personName, recordId, required, shortText, version,
} from '../../lib/fields.js';
import { pageQuery } from '../../lib/pagination.js';
import { customerExtrasBody } from '../customers/customers.schemas.js';
import { CONTACT_OUTCOMES, PRIORITIES } from './lead.model.js';
import { LEAD_STATUSES } from './leadStatus.js';

export const labels = {
  pipelineId: 'Pipeline', name: 'Lead name', mobile: 'Primary mobile', altMobile: 'Alternate mobile', email: 'Email', source: 'Source',
  referrerId: 'Referrer', referredByCustomerId: 'Referred by client', campaign: 'Campaign name', interests: 'Insurance interest',
  priority: 'Priority', nextFollowUpAt: 'Next follow-up', notes: 'Notes', status: 'New status', lostReason: 'Lost reason', note: 'Note',
  outcome: 'Outcome', mode: 'Conversion', customerId: 'Customer', version: 'Version',
};

const interests = () => z.array(oneOf(lists.insuranceTypes)).max(20);

/** P-12 fields. Referrer / Referred by client / Campaign are required by source (checked in the service). */
export const createLeadBody = z.object({
  pipelineId: required(recordId('pip')),
  name: required(personName()),
  mobile: required(mobile()),
  altMobile: optional(mobile()),
  email: optional(email()),
  source: required(oneOf(lists.leadSources)),
  referrerId: optional(recordId('usr')),
  referredByCustomerId: optional(recordId('cus')),
  campaign: optional(shortText()),
  interests: interests().optional(),
  priority: optional(enumOf(PRIORITIES)),
  nextFollowUpAt: optional(futureDateTime()),
  notes: optional(notes()),
  confirm: confirmations(),
});

export const updateLeadBody = z.object({
  version: required(version()),
  pipelineId: editable(recordId('pip')),
  name: editable(personName()),
  mobile: editable(mobile()),
  altMobile: optional(mobile()),
  email: optional(email()),
  source: editable(oneOf(lists.leadSources)),
  referrerId: optional(recordId('usr')),
  referredByCustomerId: optional(recordId('cus')),
  campaign: optional(shortText()),
  interests: interests().optional(),
  priority: editable(enumOf(PRIORITIES)),
  nextFollowUpAt: optional(futureDateTime()),
  notes: optional(notes()),
  confirm: confirmations(),
});

export const statusBody = z.object({
  version: required(version()),
  status: required(enumOf(LEAD_STATUSES.filter((s) => s !== 'CONVERTED'))),
  nextFollowUpAt: optional(futureDateTime()),
  lostReason: optional(oneOf(lists.lostReasons)),
  note: optional(notes()),
});

export const contactBody = z.object({ outcome: required(enumOf(CONTACT_OUTCOMES)), note: optional(notes()) });

/** P-14: "Link to existing" or "Create new customer", with the extra customer fields of the form. */
export const convertBody = z.object({
  version: required(version()),
  mode: required(enumOf(['CREATE', 'LINK'] as const)),
  customerId: optional(recordId('cus')),
  customer: customerExtrasBody.optional(),
  confirm: confirmations(),
});

export const leadIdParam = z.object({ id: z.string().regex(/^led_[a-f0-9]{28}$/) });
export const listLeadsQuery = z.object({
  ...pageQuery,
  pipelineId: recordId('pip').optional(),
  status: enumOf(LEAD_STATUSES).optional(),
  source: z.string().max(60).optional(),
  priority: enumOf(PRIORITIES).optional(),
  search: z.string().trim().max(100).optional(),
});
export const duplicateQuery = z.object({ mobile: required(mobile()), name: optional(personName()), excludeId: optional(recordId('led')) });
