import { Router } from 'express';
import { z } from 'zod';
import { ConfigValue, isCfgId, listCfg, loadConfigOverrides, validateCfgValue } from '../../config/cfg.js';
import { AppError } from '../../lib/errors.js';
import { clock, istDateTime } from '../../lib/clock.js';
import { normalizeMobile } from '../../lib/phone.js';
import { redisCache } from '../../lib/redis.js';
import { sendData } from '../../lib/response.js';
import { OtpLock } from '../auth/otp.model.js';
import { devSms } from '../auth/sms.js';

/**
 * TEST TOOLS — mounted only when DEV_TOOLS=true, which the API refuses in production (config/env.ts).
 * They let the web console test OTP flows without a phone, move the clock (NFR-13) to test expiry and
 * read-only mode, and change CFG values without the P-49 maker-checker flow.
 */
export function devRoutes() {
  const r = Router();

  r.get('/sms', async (req, res) => {
    const mobile = typeof req.query.mobile === 'string' ? normalizeMobile(req.query.mobile) ?? undefined : undefined;
    sendData(res, { failing: await devSms.failing(), messages: await devSms.list(mobile) });
  });
  r.delete('/sms', async (_req, res) => { await devSms.clear(); sendData(res, { cleared: true }); });
  r.post('/sms/failing', async (req, res) => { await devSms.setFailing(req.body?.failing === true); sendData(res, { failing: await devSms.failing() }); });

  const clockView = () => ({ offsetMs: clock.offsetMs(), now: clock.now(), ist: istDateTime(clock.now()) });
  r.get('/clock', (_req, res) => sendData(res, clockView()));
  r.post('/clock', (req, res) => {
    const b = z.object({ offsetMs: z.number().int().optional(), advanceMinutes: z.number().optional(), reset: z.boolean().optional() }).parse(req.body ?? {});
    if (b.reset) clock.setOffset(0);
    if (b.offsetMs !== undefined) clock.setOffset(b.offsetMs);
    if (b.advanceMinutes) clock.setOffset(clock.offsetMs() + Math.round(b.advanceMinutes * 60_000));
    sendData(res, clockView());
  });

  r.get('/config', (_req, res) => sendData(res, listCfg()));
  r.put('/config/:id', async (req, res) => {
    const id = String(req.params.id);
    if (!isCfgId(id)) throw AppError.notFound();
    const problem = validateCfgValue(id, req.body?.value);
    if (problem) throw new AppError(400, 'VALIDATION_FAILED', 'GEN-99', { errorId: problem });
    await ConfigValue.updateOne({ _id: id }, { $set: { value: req.body.value, updatedBy: 'dev-tools' } }, { upsert: true });
    await loadConfigOverrides();
    sendData(res, listCfg().find((c) => c.id === id));
  });
  r.delete('/config/:id', async (req, res) => {
    await ConfigValue.deleteOne({ _id: String(req.params.id) });
    await loadConfigOverrides();
    sendData(res, listCfg());
  });

  /** Clears per-IP/per-user counters and OTP locks, so a test run can start clean. */
  r.post('/reset-limits', async (_req, res) => {
    const keys = await redisCache().keys('rl:*');
    if (keys.length) await redisCache().del(...keys);
    const locks = await OtpLock.deleteMany({});
    sendData(res, { counters: keys.length, otpLocks: locks.deletedCount });
  });
  return r;
}
