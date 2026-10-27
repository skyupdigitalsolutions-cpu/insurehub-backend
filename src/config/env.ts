import { z } from 'zod';

const csv = z
  .string()
  .default('')
  .transform((v) => v.split(',').map((s) => s.trim()).filter(Boolean));

const bool = z.enum(['true', 'false']).transform((v) => v === 'true');

/** A 32-byte key given as base64 (generate with: node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"). */
const key32 = z
  .string()
  .refine((v) => Buffer.from(v, 'base64').length === 32, 'must be 32 bytes, base64-encoded');

/**
 * Infrastructure settings only. Business numbers (OTP length, session limits, page size…) are CFG
 * values (Section 3.4) and live in src/config/cfg.ts, never here.
 */
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  API_PREFIX: z.string().default('/v1'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  MONGO_URI: z.string().min(1),
  // Multi-record writes (P-01, P-14, P-19 …) run in one transaction when MongoDB is a replica set.
  // A standalone server (typical local install) falls back to ordered writes; production refuses to start.
  MONGO_REQUIRE_TRANSACTIONS: bool.optional(),
  REDIS_CACHE_URL: z.string().min(1),
  REDIS_QUEUE_URL: z.string().min(1),

  JWT_ACCESS_SECRET: z.string().min(32),
  JWT_REFRESH_SECRET: z.string().min(32),
  JWT_ACCESS_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  JWT_ISSUER: z.string().default('bimayantra-api'),
  JWT_AUDIENCE: z.string().default('bimayantra-clients'),

  // Web sessions travel in HttpOnly cookies (P-02 backend rules). Secure must be true outside local development.
  COOKIE_SECURE: bool.default('true'),
  COOKIE_DOMAIN: z.string().optional(),

  // OTP hashing pepper and PAN/Aadhaar field encryption (NFR-07). In production these come from the
  // managed key service; the env var is how the key reaches the process.
  OTP_PEPPER: z.string().min(32),
  PII_ENCRYPTION_KEY: key32,
  PII_HASH_KEY: key32,

  // SMS provider for OTP. 'dev' keeps messages in a test inbox (non-production only); 'msg91' is the
  // confirmed provider (Section 1.2) and needs its DLT template and credentials.
  SMS_PROVIDER: z.enum(['dev', 'msg91']).default('dev'),
  MSG91_AUTH_KEY: z.string().optional(),
  MSG91_OTP_TEMPLATE_ID: z.string().optional(),

  // Test tools: SMS inbox, test clock, configuration overrides (NFR-13). Never on in production.
  DEV_TOOLS: bool.default('false'),
  // Private file storage (KYC documents, photos, logos, PDFs).
  //   local      = files on this server's disk; development only.
  //   cloudinary = Cloudinary "authenticated" (private) raw assets. Decision Q29: Cloudinary for all files,
  //                pending confirmation that storage is in India and legal review (IRDAI CS Guidelines 2023).
  FILE_STORAGE: z.enum(['local', 'cloudinary']).default('local'),
  FILE_STORAGE_DIR: z.string().default('./storage'),
  /** P-18 automatic reading of Aadhaar, PAN and old policies. The BPD names Google Document AI [TO CONFIRM];
   *  until confirmed, none = the verify screen opens empty for manual entry (the BPD's own DOC-10 fallback). */
  DOCUMENT_READER: z.enum(['none']).default('none'),
  CLOUDINARY_CLOUD_NAME: z.string().optional(),
  CLOUDINARY_API_KEY: z.string().optional(),
  CLOUDINARY_API_SECRET: z.string().optional(),
  /** Folder inside the Cloudinary account; keep development and production apart. */
  CLOUDINARY_FOLDER: z.string().regex(/^[a-z0-9_/-]+$/).default('bimayantra-dev'),
  /** Regional API host if Cloudinary assigns one (for example https://api-ap.cloudinary.com). */
  CLOUDINARY_UPLOAD_PREFIX: z.string().url().optional(),

  TERMS_VERSION: z.string().default('2026-10-v1'),
  SUPPORT_EMAIL: z.string().email().default('support@bimayantra.in'),

  CORS_ORIGINS: csv,
  REQUEST_BODY_LIMIT: z.string().default('100kb'),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  // Fail fast at boot: a misconfigured API must never start serving traffic.
  console.error('Invalid environment configuration:', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

const e = parsed.data;
const fatal = (msg: string) => {
  console.error(msg);
  process.exit(1);
};
if (e.JWT_ACCESS_SECRET === e.JWT_REFRESH_SECRET) fatal('JWT_ACCESS_SECRET and JWT_REFRESH_SECRET must be different.');
if (e.PII_ENCRYPTION_KEY === e.PII_HASH_KEY) fatal('PII_ENCRYPTION_KEY and PII_HASH_KEY must be different.');
if (e.FILE_STORAGE === 'cloudinary' && !(e.CLOUDINARY_CLOUD_NAME && e.CLOUDINARY_API_KEY && e.CLOUDINARY_API_SECRET)) {
  fatal('FILE_STORAGE=cloudinary needs CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY and CLOUDINARY_API_SECRET.');
}
if (e.NODE_ENV === 'production') {
  if (e.SMS_PROVIDER === 'dev') fatal('SMS_PROVIDER=dev is not allowed in production.');
  if (e.DEV_TOOLS) fatal('DEV_TOOLS must be false in production.');
  if (e.FILE_STORAGE === 'local') fatal('FILE_STORAGE=local keeps files on one server disk and is not allowed in production. Use FILE_STORAGE=cloudinary.');
  if (e.CLOUDINARY_FOLDER.endsWith('-dev')) fatal('CLOUDINARY_FOLDER must be a production folder (not "-dev") in production.');
  if (!e.COOKIE_SECURE) fatal('COOKIE_SECURE must be true in production.');
}

export const env = { ...e, MONGO_REQUIRE_TRANSACTIONS: e.MONGO_REQUIRE_TRANSACTIONS ?? e.NODE_ENV === 'production' };
export type Env = typeof env;