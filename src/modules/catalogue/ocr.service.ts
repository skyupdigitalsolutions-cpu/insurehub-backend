import type { Request } from 'express';
import { Schema, model, type InferSchemaType } from 'mongoose';
import { cfgBool, cfgNum } from '../../config/cfg.js';
import { clock } from '../../lib/clock.js';
import { AppError } from '../../lib/errors.js';
import { newId } from '../../lib/ids.js';
import { logger } from '../../lib/logger.js';
import { audit } from '../audit/audit.service.js';
import { ocrPages, readerEnabled } from '../documents/reader.js';
import { assertOwnFile, open as openFile } from '../files/files.service.js';
import { notify } from '../notifications/notifications.service.js';
import type { AuthContext } from '../rbac/capabilities.js';
import { ProductVersion, type ProductVersionDoc } from './product.model.js';
import { TemplateVersion, type TemplateDoc } from './types.model.js';

/**
 * P-23 brochure reading. A job reads the brochure and SUGGESTS a value per template feature; nothing reaches the draft
 * without a reviewer's decision (AC-P23-1). OCR reads features only, never premiums. The raw text and every decision
 * are kept. QUEUED → PROCESSING → REVIEW_REQUIRED → REVIEWED, or FAILED (the draft unchanged, AC-P23-3).
 */
const row = new Schema({
  key: String, name: String, dataType: String,
  found: { type: Boolean, default: false }, value: { type: String, default: null }, confidence: { type: Number, default: 0 }, page: { type: Number, default: null },
  decision: { type: String, enum: ['ACCEPT', 'EDIT', 'IGNORE', 'NOT_STATED', null], default: null }, editedValue: { type: String, default: null },
}, { _id: false });
const jobSchema = new Schema(
  {
    _id: { type: String, default: () => newId('ocr') },
    versionId: { type: String, required: true },
    productId: { type: String, required: true },
    fileId: { type: String, required: true },
    status: { type: String, enum: ['QUEUED', 'PROCESSING', 'REVIEW_REQUIRED', 'REVIEWED', 'FAILED'], default: 'QUEUED' },
    startedBy: { type: String, required: true },
    startedAt: { type: Date, required: true },
    rows: { type: [row], default: [] },
    rawText: { type: String, default: null, select: false }, // kept for audit
    error: { type: String, default: null },
    reviewedBy: { type: String, default: null },
    applied: { type: Number, default: 0 },
  },
  { timestamps: true, versionKey: false },
);
type JobDoc = InferSchemaType<typeof jobSchema> & { _id: string };
export const OcrJob = model('OcrJob', jobSchema, 'ocr_jobs');

type Feature = TemplateDoc['features'][number];
type Page = { number: number; text: string; confidence: number };

/** Turn found text into the feature's value (as text for review). */
export function extract(dataType: string, rest: string, featureName = ''): string | null {
  const s = rest.replace(/\s+/g, ' ').trim();
  if (!s) return null;
  if (dataType === 'Yes/No') {
    if (/\b(not covered|excluded|not available|not included|no)\b/i.test(s)) return 'No';
    if (/\b(covered|included|available|yes)\b/i.test(s)) return 'Yes';
    return null;
  }
  if (dataType === 'Amount in ₹') { const m = /(?:₹|rs\.?|inr)?\s*([\d,]+(?:\.\d+)?)/i.exec(s); return m ? m[1]!.replace(/,/g, '') : null; }
  if (dataType === 'Percentage') { const m = /(\d+(?:\.\d+)?)\s*%/.exec(s); return m ? m[1]! : null; }
  if (['Months', 'Days', 'Years'].includes(dataType)) {
    const m = /(\d+(?:\.\d+)?)\s*(months?|days?|years?|yrs?)/i.exec(s);
    if (!m) return null;
    const n = Number(m[1]); const unit = m[2]!.toLowerCase();
    const months = unit.startsWith('y') ? n * 12 : unit.startsWith('d') ? n / 30 : n;
    const out = dataType === 'Months' ? months : dataType === 'Years' ? months / 12 : months * 30;
    return String(Math.round(out * 100) / 100);
  }
  if (dataType === 'Number') { const m = /(\d+(?:\.\d+)?)/.exec(s); return m ? m[1]! : null; }
  void featureName;
  return s.slice(0, 200);
}

/** Find each feature on the pages: the line naming it (or all its main words), value from the rest of that line or the next. */
export function matchFeatures(features: Feature[], pages: Page[]) {
  return features.map((f) => {
    const words = f.name.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 3);
    let best: { value: string; confidence: number; page: number } | null = null;
    for (const pg of pages) {
      const lines = pg.text.split(/\r?\n/);
      lines.forEach((line, i) => {
        if (best) return;
        const low = line.toLowerCase();
        const exact = low.includes(f.name.toLowerCase());
        if (!exact && !(words.length && words.every((w) => low.includes(w)))) return;
        const after = exact ? line.slice(low.indexOf(f.name.toLowerCase()) + f.name.length) : line;
        const value = extract(f.dataType, after.replace(/^[\s:–-]+/, ''), f.name) ?? extract(f.dataType, lines[i + 1] ?? '', f.name);
        if (value !== null) best = { value, confidence: Math.round(pg.confidence * (exact ? 1 : 0.8) * 100) / 100, page: pg.number };
      });
      if (best) break;
    }
    const b = best as { value: string; confidence: number; page: number } | null;
    return { key: f.key, name: f.name, dataType: f.dataType, found: !!b, value: b?.value ?? null, confidence: b?.confidence ?? 0, page: b?.page ?? null, decision: null, editedValue: null };
  });
}

const threshold = () => cfgNum('CFG-37') / 100;
const flagged = (r: { found: boolean; confidence: number }) => !r.found || r.confidence < threshold();
const view = (j: JobDoc) => ({
  id: j._id, versionId: j.versionId, fileId: j.fileId, status: j.status, startedAt: j.startedAt, error: j.error, applied: j.applied, threshold: cfgNum('CFG-37'),
  rows: j.rows.map((r) => ({ ...r, flagged: flagged(r), ...(r.found ? {} : { messageId: 'OCR-08' }) })),
});

/** Pages in a PDF (P-23: more than CFG-30 is refused with OCR-04). Images are one page. */
export function pageCount(bytes: Buffer, mime: string) {
  if (mime !== 'application/pdf') return 1;
  return (bytes.toString('latin1').match(/\/Type\s*\/Page(?![s\w])/g) ?? []).length || 1;
}

async function draftOf(vid: string) {
  const v = await ProductVersion.findById(vid).lean<ProductVersionDoc>();
  if (!v) throw AppError.notFound();
  if (v.status !== 'DRAFT') throw AppError.invalidState('product version', v.status.replace('_', ' '));
  return v;
}

/** Brochure → Read with OCR (OCR-01). Running it again on the same file reuses the open job. */
export async function start(ctx: AuthContext, vid: string, fileId: string, req: Request) {
  if (!cfgBool('CFG-102') || !readerEnabled()) throw new AppError(409, 'INVALID_STATE', 'OCR-07');
  const v = await draftOf(vid);
  await assertOwnFile(ctx, fileId, 'BROCHURE', 'fileId');
  const open = await OcrJob.findOne({ versionId: vid, fileId, status: { $in: ['QUEUED', 'PROCESSING', 'REVIEW_REQUIRED'] } }).lean<JobDoc>();
  if (open) return view(open);
  const { file, bytes } = await openFile(ctx, fileId, req);
  if (pageCount(bytes, file.mime) > cfgNum('CFG-30')) throw AppError.field('fileId', 'OCR-04', { 'CFG-30': cfgNum('CFG-30') }); // AC-P23-4
  const job = await OcrJob.create({ versionId: vid, productId: v.productId, fileId, startedBy: ctx.userId, startedAt: clock.now() });
  await audit({ entity: 'ocrJob', entityId: job._id, action: 'OCR_STARTED', after: { versionId: vid, fileId } }, { req });
  run(job._id, v.templateId, bytes, file.mime, ctx);
  return view(job.toObject() as JobDoc);
}

/** Try again after FAILED: a new job on the same file. */
export async function retry(ctx: AuthContext, jobId: string, req: Request) {
  const j = await OcrJob.findById(jobId).lean<JobDoc>();
  if (!j) throw AppError.notFound();
  if (j.status !== 'FAILED') throw AppError.invalidState('OCR job', j.status);
  return start(ctx, j.versionId, j.fileId, req);
}

/** The background job (GR-26): never awaited by the request; CFG-38 limit; failure leaves the draft unchanged. */
function run(jobId: string, templateId: string, bytes: Buffer, mime: string, ctx: AuthContext) {
  void (async () => {
    const tell = (messageId: 'OCR-02' | 'OCR-03', params = {}) => notify({ userId: ctx.userId, accountId: null, kind: messageId === 'OCR-02' ? 'OCR_DONE' : 'OCR_FAILED', messageId, params, dedupeKey: `${messageId}|${jobId}` }).catch(() => undefined);
    try {
      await OcrJob.updateOne({ _id: jobId }, { $set: { status: 'PROCESSING' } });
      const limit = new Promise<never>((_, fail) => setTimeout(() => fail(new Error('OCR time limit (CFG-38) reached')), cfgNum('CFG-38') * 60_000).unref());
      const read = await Promise.race([ocrPages(bytes, mime), limit]);
      const tpl = await TemplateVersion.findById(templateId, { features: 1 }).lean<TemplateDoc>();
      const rows = matchFeatures(tpl?.features ?? [], read.pages);
      // The bell item first, then the status: whoever sees REVIEW_REQUIRED can already find OCR-02 in the bell.
      await OcrJob.updateOne({ _id: jobId }, { $set: { rows, rawText: read.text } });
      await tell('OCR-02', { n: rows.filter((r) => r.found).length, m: rows.filter(flagged).length });
      await OcrJob.updateOne({ _id: jobId }, { $set: { status: 'REVIEW_REQUIRED' } });
    } catch (e) {
      logger.warn({ jobId, reason: (e as Error).message }, 'Brochure OCR failed (OCR-03)');
      await tell('OCR-03'); // the bell item first, then FAILED (same reason as above)
      await OcrJob.updateOne({ _id: jobId }, { $set: { status: 'FAILED', error: (e as Error).message } }).catch(() => undefined);
    }
  })();
}

export async function latest(vid: string) {
  const j = await OcrJob.findOne({ versionId: vid }).sort({ createdAt: -1 }).lean<JobDoc>();
  return j ? view(j) : null;
}

/** Decisions per row: Accept, Edit (with the typed value), Ignore, Not stated. */
export async function decide(ctx: AuthContext, jobId: string, decisions: Array<{ key: string; decision: 'ACCEPT' | 'EDIT' | 'IGNORE' | 'NOT_STATED'; value?: string | null }>) {
  const j = await OcrJob.findById(jobId).lean<JobDoc>();
  if (!j) throw AppError.notFound();
  if (j.status !== 'REVIEW_REQUIRED') throw AppError.invalidState('OCR job', j.status);
  const rows = j.rows.map((r) => {
    const d = decisions.find((x) => x.key === r.key);
    if (!d) return r;
    if (d.decision === 'ACCEPT' && !r.found) throw AppError.field(`rows.${r.key}`, 'OCR-08');
    if (d.decision === 'EDIT' && !(d.value ?? '').trim()) throw AppError.field(`rows.${r.key}`, 'GEN-01', { 'Field label': String(r.name ?? r.key ?? '') });
    return { ...r, decision: d.decision, editedValue: d.decision === 'EDIT' ? d.value!.trim() : null };
  });
  await OcrJob.updateOne({ _id: jobId, status: 'REVIEW_REQUIRED' }, { $set: { rows } });
  return view({ ...j, rows } as JobDoc);
}

/** "Accept all above CFG-37": only found, high-confidence rows without a decision (AC-P23-2). */
export async function acceptHigh(ctx: AuthContext, jobId: string) {
  const j = await OcrJob.findById(jobId).lean<JobDoc>();
  if (!j) throw AppError.notFound();
  if (j.status !== 'REVIEW_REQUIRED') throw AppError.invalidState('OCR job', j.status);
  const rows = j.rows.map((r) => (!r.decision && !flagged(r) ? { ...r, decision: 'ACCEPT' as const } : r));
  await OcrJob.updateOne({ _id: jobId }, { $set: { rows } });
  return view({ ...j, rows } as JobDoc);
}

function typedValue(dataType: string, text: string): unknown {
  if (dataType === 'Yes/No') return /^(yes|y|true|covered)$/i.test(text.trim());
  if (dataType === 'Text') return text.trim();
  const n = Number(text.replace(/[₹,%\s]/g, ''));
  return Number.isFinite(n) ? n : text.trim();
}

/**
 * Apply to draft (OCR-06): accepted and edited values, and Not stated, go into the DRAFT's features, each marked as
 * read by OCR and checked by the reviewer. Every highlighted row needs a decision first (OCR-05).
 */
export async function apply(ctx: AuthContext, jobId: string, req: Request) {
  const j = await OcrJob.findById(jobId).lean<JobDoc>();
  if (!j) throw AppError.notFound();
  if (j.status !== 'REVIEW_REQUIRED') throw AppError.invalidState('OCR job', j.status);
  if (j.rows.some((r) => flagged(r) && !r.decision)) throw new AppError(400, 'VALIDATION_FAILED', 'OCR-05');
  const v = await draftOf(j.versionId);
  const set: Record<string, unknown> = {};
  let n = 0;
  for (const r of j.rows) {
    if (!r.decision || r.decision === 'IGNORE') continue;
    const value = r.decision === 'NOT_STATED' ? { notStated: true } : { value: typedValue(r.dataType ?? 'Text', (r.decision === 'EDIT' ? r.editedValue : r.value) ?? ''), page: r.page ?? null };
    set[`data.features.${r.key}`] = value;
    set[`ocrMarks.${r.key}`] = { jobId, checkedBy: ctx.name };
    n++;
  }
  const u = await ProductVersion.updateOne({ _id: v._id, status: 'DRAFT', rev: v.rev }, { $set: set, $inc: { rev: 1 } });
  if (!u.modifiedCount && n) throw AppError.versionConflict('product version', null);
  await OcrJob.updateOne({ _id: jobId }, { $set: { status: 'REVIEWED', reviewedBy: ctx.userId, applied: n } });
  await audit({ entity: 'ocrJob', entityId: jobId, action: 'OCR_APPLIED', after: { versionId: v._id, applied: n, decisions: j.rows.map((r) => ({ key: r.key, decision: r.decision })) } }, { req });
  return { job: view((await OcrJob.findById(jobId).lean<JobDoc>())!), params: { n } };
}