import { env } from '../../config/env.js';
import { clock } from '../../lib/clock.js';
import { redisCache } from '../../lib/redis.js';

/**
 * SMS provider. Production: MSG91 with the TRAI DLT-registered sender ID and templates (Section 1.2,
 * DEC-19) — NOT WIRED YET: it needs the DLT template IDs and credentials, so it fails and the user sees
 * AUTH-13. Development: messages go to a test inbox in Redis that the web console shows, so OTP flows
 * can be tested without a phone. The inbox is refused in production at boot (config/env.ts).
 */
const OUTBOX = 'dev:sms:outbox';
const FAIL = 'dev:sms:fail';
export type SmsKind = 'OTP' | 'MOBILE_CHANGED';

export async function sendSms(to: string, kind: SmsKind, text: string): Promise<void> {
  if (env.SMS_PROVIDER === 'dev') {
    const r = redisCache();
    if (await r.get(FAIL)) throw new Error('Simulated SMS provider failure (dev tools)');
    await r.multi().lpush(OUTBOX, JSON.stringify({ to, kind, text, at: clock.now().toISOString() })).ltrim(OUTBOX, 0, 49).exec();
    return;
  }
  if (!env.MSG91_AUTH_KEY || !env.MSG91_OTP_TEMPLATE_ID) throw new Error('MSG91 is not configured');
  throw new Error('MSG91 integration pending DLT template registration (DEC-19)');
}

export const devSms = {
  async list(mobile?: string) {
    const items = (await redisCache().lrange(OUTBOX, 0, 49)).map((s) => JSON.parse(s) as { to: string; kind: SmsKind; text: string; at: string });
    return mobile ? items.filter((m) => m.to === mobile) : items;
  },
  clear: () => redisCache().del(OUTBOX),
  async setFailing(fail: boolean) { await (fail ? redisCache().set(FAIL, '1') : redisCache().del(FAIL)); },
  failing: async () => (await redisCache().get(FAIL)) === '1',
};
