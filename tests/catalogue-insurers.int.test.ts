/**
 * Module 8 Stage 1 — P-20 Manage insurers with maker-checker. Names cite the BPD acceptance checks.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { as, err, login, newMobile, registerAdvisor, resetState, seedAdmin, startTestEnv, stepUp, stopTestEnv } from './helpers.js';
import { User } from '../src/modules/users/user.model.js';
import { normalizeMobile } from '../src/lib/phone.js';
import { Insurer } from '../src/modules/insurers/insurer.model.js';

beforeAll(startTestEnv);
afterAll(stopTestEnv);
beforeEach(resetState);

const fieldIds = (r: { body: { error?: { fields?: Array<{ field: string; messageId: string }> } } }) => Object.fromEntries((r.body.error?.fields ?? []).map((f) => [f.field, f.messageId]));
const body = (extra: object = {}) => ({ name: 'Alpha General Insurance', shortCode: 'alpha-gen', category: 'General', irdaiRegNo: 'IRDAI-123', paymentDomains: ['alphagen.in'], ...extra });

/** Two SkyUp admins (a maker and a checker) and a staff member, each signed in. */
async function people() {
  const a = await seedAdmin();
  const b = await seedAdmin();
  const sm = newMobile();
  await User.create({ accountId: null, role: 'STF', name: 'Meena Staff', mobile: normalizeMobile(sm), status: 'ACTIVE', activatedAt: new Date() });
  const staff = { mobile: sm, ...(await login(sm)) };
  const decide = async (who: { token: string; mobile: string }, path: string, b2: object) => as(who.token).post(path, b2, { 'X-Step-Up-Token': await stepUp(who.token, who.mobile) });
  return { a, b, staff, decide };
}

describe('P-20 insurers', () => {
  it('save draft (CAT-01), submit (CAT-02); fields: code uppercased, bare domain only (CAT-10), phone, https web address', async () => {
    const { staff } = await people();
    const S = as(staff.token);
    const d = await S.post('/admin/insurers', body());
    expect(d.status).toBe(201);
    expect(d.body.meta.message).toBe('Alpha General Insurance saved as draft.');
    expect(d.body.data).toMatchObject({ status: 'DRAFT', shortCode: 'ALPHA-GEN' });
    const bad = await S.post('/admin/insurers', body({ name: 'Beta', shortCode: 'B E', paymentDomains: ['https://beta.in/pay'], website: 'beta.in', careNumber: '12345' }));
    expect(fieldIds(bad)).toMatchObject({ shortCode: 'VAL-33', website: 'VAL-28', careNumber: 'VAL-36' });
    expect(JSON.stringify(bad.body)).toContain('Enter a domain such as insurer.com, without https:// or any path.');
    const ok = await S.post('/admin/insurers', body({ name: 'Beta Life', shortCode: 'BETA', paymentDomains: ['beta.in'], website: 'https://beta.in', careNumber: '1800 123 4567', submit: true }));
    expect(ok.body.meta.message).toBe('Beta Life sent for approval.');
    expect(ok.body.data).toMatchObject({ status: 'PENDING_APPROVAL', careNumber: '18001234567' });
  });

  it('AC-P20-1: a duplicate name (ignoring case) or code is refused (CAT-06, CAT-07)', async () => {
    const { staff } = await people();
    const S = as(staff.token);
    await S.post('/admin/insurers', body());
    expect(fieldIds(await S.post('/admin/insurers', body({ shortCode: 'OTHER' , name: 'ALPHA general insurance' })))).toEqual({ name: 'CAT-06' });
    expect(fieldIds(await S.post('/admin/insurers', body({ name: 'Other' })))).toEqual({ shortCode: 'CAT-07' });
  });

  it('AC-P20-2: the maker cannot approve their own insurer (CAT-05); a different admin approves with OTP (CAT-03)', async () => {
    const { a, b, decide } = await people();
    const d = (await as(a.token).post('/admin/insurers', body({ submit: true }))).body.data;
    const own = await decide(a, `/admin/insurers/${d.id}/approve`, { version: d.version });
    expect(err(own)).toMatchObject({ status: 403, messageId: 'CAT-05' });
    expect(own.body.error.message).toBe('You made this change, so another admin must approve it.');
    const noOtp = await as(b.token).post(`/admin/insurers/${d.id}/approve`, { version: d.version });
    expect(err(noOtp)).toMatchObject({ status: 403, messageId: 'AUTH-26' });
    const ok = await decide(b, `/admin/insurers/${d.id}/approve`, { version: d.version });
    expect(ok.body.meta.message).toBe('Alpha General Insurance approved.');
    expect(ok.body.data.status).toBe('ACTIVE');
  });

  it('staff can make but not approve; two approvers at once: the second gets GEN-04', async () => {
    const { a, b, staff, decide } = await people();
    const d = (await as(staff.token).post('/admin/insurers', body({ submit: true }))).body.data;
    expect(err(await decide(staff, `/admin/insurers/${d.id}/approve`, { version: d.version }))).toMatchObject({ status: 403, messageId: 'GEN-03' });
    // both approvers have their OTP ready and press Approve at the same moment
    const [ta, tb] = [await stepUp(a.token, a.mobile), await stepUp(b.token, b.mobile)];
    const [x, y] = await Promise.all([
      as(a.token).post(`/admin/insurers/${d.id}/approve`, { version: d.version }, { 'X-Step-Up-Token': ta }),
      as(b.token).post(`/admin/insurers/${d.id}/approve`, { version: d.version }, { 'X-Step-Up-Token': tb }),
    ]);
    expect([x.status, y.status].sort()).toEqual([200, 409]);
    expect(err(x.status === 409 ? x : y)).toMatchObject({ messageId: 'GEN-04' });
  });

  it('reject with a reason (CAT-04): back to DRAFT with all values kept; edit and submit again', async () => {
    const { a, staff, decide } = await people();
    const S = as(staff.token);
    const d = (await S.post('/admin/insurers', body({ website: 'https://alphagen.in', submit: true }))).body.data;
    const r = await decide(a, `/admin/insurers/${d.id}/reject`, { version: d.version, reason: 'IRDAI number does not match' });
    expect(r.body.meta.message).toBe('Alpha General Insurance rejected. Reason: IRDAI number does not match');
    expect(r.body.data).toMatchObject({ status: 'DRAFT', website: 'https://alphagen.in', rejectReason: 'IRDAI number does not match' });
    const again = await S.patch(`/admin/insurers/${d.id}`, { version: r.body.data.version, irdaiRegNo: 'IRDAI-124', submit: true });
    expect(again.body.data.status).toBe('PENDING_APPROVAL');
  });

  it('AC-P20-3: an edit to an ACTIVE insurer is not visible to advisors until approved; one pending change at a time (CAT-08)', async () => {
    const { a, b, staff, decide } = await people();
    const d = (await as(a.token).post('/admin/insurers', body({ submit: true }))).body.data;
    const live = (await decide(b, `/admin/insurers/${d.id}/approve`, { version: d.version })).body.data;
    // advisors see it under its live name
    const adv = await registerAdvisor('Asha Rao');
    const seen = async () => ((await as(adv.token).get('/my-insurers/available')).body.data as Array<{ id: string; name: string }>).find((i) => i.id === d.id)?.name;
    expect(await seen()).toBe('Alpha General Insurance');
    const ch = await as(staff.token).patch(`/admin/insurers/${d.id}`, { version: live.version, name: 'Alpha General Insurance Company' });
    expect(ch.body.data).toMatchObject({ status: 'ACTIVE', name: 'Alpha General Insurance', pendingChange: { status: 'PENDING', values: { name: 'Alpha General Insurance Company' } } });
    expect(await seen()).toBe('Alpha General Insurance'); // not visible yet
    expect(err(await as(staff.token).patch(`/admin/insurers/${d.id}`, { version: ch.body.data.version, careNumber: '1800 123 4567' }))).toMatchObject({ status: 409, messageId: 'CAT-08' });
    const queue = (await as(b.token).get('/admin/approvals')).body.data;
    expect(queue.map((q: { what: string; name: string }) => `${q.what}:${q.name}`)).toEqual(['CHANGE:Alpha General Insurance Company']);
    await decide(b, `/admin/insurers/${d.id}/approve`, { version: ch.body.data.version });
    expect(await seen()).toBe('Alpha General Insurance Company');
    expect((await Insurer.findById(d.id).lean())!._id).toBe(d.id); // the ID never changes
  });

  it('AC-P20-4: deactivation asks CAT-09 with the impact, then blocks new mappings; history is kept', async () => {
    const { a, b, decide } = await people();
    const d = (await as(a.token).post('/admin/insurers', body({ submit: true }))).body.data;
    const live = (await decide(b, `/admin/insurers/${d.id}/approve`, { version: d.version })).body.data;
    const adv = await registerAdvisor('Asha Rao');
    const map = await as(adv.token).post('/my-insurers', { insurerId: d.id, agentCode: 'AG-1', declaration: true });
    expect(map.status).toBe(201);
    const ask = await as(a.token).post(`/admin/insurers/${d.id}/deactivate`, { version: live.version });
    expect(err(ask)).toMatchObject({ status: 409, messageId: 'CAT-09' });
    expect(ask.body.error.message).toBe('Deactivating Alpha General Insurance hides 0 products from new quotations and affects 1 advisors. Existing quotations and policies do not change. Continue?');
    const off = await as(a.token).post(`/admin/insurers/${d.id}/deactivate`, { version: live.version, confirm: ['CAT-09'] });
    expect(off.body.data.status).toBe('INACTIVE');
    expect((await as(adv.token).get('/my-insurers')).body.data[0].warnings[0].messageId).toBe('PRF-10'); // mapping kept, shown blocked
    const other = await registerAdvisor('Ravi Kumar');
    expect(fieldIds(await as(other.token).post('/my-insurers', { insurerId: d.id, agentCode: 'AG-2', declaration: true }))).toEqual({ insurerId: 'VAL-22' });
  });

  it('advisors and assistants cannot use the catalogue admin', async () => {
    const adv = await registerAdvisor('Asha Rao');
    expect(err(await as(adv.token).get('/admin/insurers'))).toMatchObject({ status: 403, messageId: 'GEN-03' });
    expect(err(await as(adv.token).post('/admin/insurers', body()))).toMatchObject({ status: 403 });
  });
});