/**
 * Automatic reading of Aadhaar, PAN and old-policy documents (P-18 step 5). The BPD names Google Document AI
 * [TO CONFIRM]. With DOCUMENT_READER=none nothing is read: the verify screen opens with empty fields for
 * manual entry, which is the BPD's own fallback for a failed or slow read (DOC-10).
 * Medical reports, PAN and Aadhaar are never sent to AI services (P-18 backend rule); a future reader
 * provider must be a document-reading service, not a general AI model.
 */
import { env } from '../../config/env.js';

export type ReadValues = Record<string, unknown>;

export async function readDocument(_type: string, _bytes: Buffer): Promise<ReadValues | null> {
  switch (env.DOCUMENT_READER) {
    case 'none':
    default:
      return null;
  }
}