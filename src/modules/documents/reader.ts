/**
 * Automatic reading of Aadhaar, PAN and old policies (P-18 step 5).
 *
 * google: Google Document AI's plain OCR processor turns the image into text; our own parsers (parsers.ts)
 * find the fields. No generative-AI extractor is used: P-18 forbids PAN and Aadhaar in AI requests.
 * The processor's location decides where images are processed: use asia-south1 (Mumbai), see OPEN-QUESTIONS Q33.
 */
import { v1 } from '@google-cloud/documentai';
import { env } from '../../config/env.js';
import { parseFor, type Parsed } from './parsers.js';

export const readerEnabled = () => env.DOCUMENT_READER !== 'none';

let client: InstanceType<typeof v1.DocumentProcessorServiceClient> | null = null;
function google() {
  client ??= new v1.DocumentProcessorServiceClient({
    apiEndpoint: `${env.DOCUMENT_AI_LOCATION}-documentai.googleapis.com`, // regional endpoint: processing stays in that region
    ...(env.DOCUMENT_AI_KEY_FILE ? { keyFilename: env.DOCUMENT_AI_KEY_FILE } : {}),
  });
  return client;
}

/** Plain OCR text of one file. */
export async function ocrText(bytes: Buffer, mimeType: string): Promise<string> {
  const name = `projects/${env.DOCUMENT_AI_PROJECT_ID}/locations/${env.DOCUMENT_AI_LOCATION}/processors/${env.DOCUMENT_AI_PROCESSOR_ID}`;
  // One call: at most 30 seconds and one retry. Google's default retries for minutes, and the user is waiting
  // on the check screen; a failure just means manual entry (DOC-10).
  const [result] = await google().processDocument(
    { name, rawDocument: { content: bytes.toString('base64'), mimeType }, skipHumanReview: true },
    { timeout: 30_000, maxRetries: 1 },
  );
  return result.document?.text ?? '';
}

/** Text and the fields found in it; null when no reader is set up. */
export async function readDocument(type: string, bytes: Buffer, mimeType: string): Promise<{ text: string; values: Parsed } | null> {
  if (env.DOCUMENT_READER === 'none') return null;
  const text = await ocrText(bytes, mimeType);
  return { text, values: parseFor(type, text) };
}