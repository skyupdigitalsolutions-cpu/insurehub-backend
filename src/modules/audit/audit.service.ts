import type { Request } from 'express';
import type { ClientSession } from 'mongoose';
import { AuditLog } from './audit.model.js';
import { logger } from '../../lib/logger.js';
import { clock } from '../../lib/clock.js';
import { maskMobile } from '../../lib/phone.js';
import type { AuthContext } from '../rbac/capabilities.js';

export interface AuditInput {
  entity: string;
  action: string;
  entityId?: string | null;
  entityRef?: string | null;
  before?: unknown;
  after?: unknown;
  result?: 'SUCCESS' | 'FAILED' | 'REFUSED';
  stepUpId?: string | null;
  /** Override the actor (sign-in events happen before req.auth exists). */
  actor?: { userId: string | null; role: string | null; accountId: string | null; label?: string };
}

const DROP = /^(token|accessToken|refreshToken|code|codeHash|salt|otp|pan|aadhaar|panEnc|aadhaarEnc|panHash|aadhaarHash)$/i;

/** GR-31 / GR-36: no secrets, no full identity numbers, mobile numbers masked. */
export function scrub(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value;
  if (Array.isArray(value)) return value.map(scrub);
  if (typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    if (DROP.test(k)) continue;
    out[k] = /mobile$/i.test(k) && typeof v === 'string' ? maskMobile(v) : scrub(v);
  }
  return out;
}

/**
 * Writes an audit entry (GR-30). Inside a transaction pass the session: the entry is saved together with
 * the change it describes (P-50) and a failure fails the change. Outside one, a failed audit write is
 * logged and does not block the user (sign-in events).
 */
export async function audit(input: AuditInput, opts: { req?: Request; ctx?: AuthContext | null; session?: ClientSession | null } = {}) {
  const ctx = opts.ctx ?? opts.req?.auth ?? null;
  const doc = {
    at: clock.now(),
    accountId: input.actor ? input.actor.accountId : ctx?.accountId ?? null,
    actorUserId: input.actor ? input.actor.userId : ctx?.userId ?? null,
    actorRole: input.actor ? input.actor.role : ctx?.role ?? null,
    actorLabel: input.actor?.label ?? (ctx || input.actor?.userId ? null : 'anonymous'),
    entity: input.entity,
    entityId: input.entityId ?? null,
    entityRef: input.entityRef ?? null,
    action: input.action,
    before: scrub(input.before),
    after: scrub(input.after),
    result: input.result ?? 'SUCCESS',
    requestId: opts.req?.requestId ?? null,
    ip: opts.req?.ip ?? null,
    stepUpId: input.stepUpId ?? null,
  };
  if (opts.session) {
    await AuditLog.create([doc], { session: opts.session });
    return;
  }
  try {
    await AuditLog.create(doc);
  } catch (err) {
    logger.error({ err, action: input.action }, 'Audit write failed');
  }
}
