/**
 * Module 8 Stage 2 — P-21 Insurance types and feature templates. Names cite the BPD acceptance checks.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { as, err, login, newMobile, registerAdvisor, resetState, seedAdmin, startTestEnv, stepUp, stopTestEnv } from './helpers.js';
import { User } from '../src/modules/users/user.model.js';
import { normalizeMobile } from '../src/lib/phone.js';
import { TemplateVersion } from '../src/modules/catalogue/types.model.js';

beforeAll(startTestEnv);
afterAll(stopTestEnv);
beforeEach(resetState);

const fieldIds = (r: { body: { error?: { fields?: Array<{ field: string; messageId: string }> } } }) => Object.fromEntries((r.body.error?.fields ?? []).map((f) => [f.field, f.messageId]));
const FEATURES = [
  { name: 'Room rent limit', group: 'Limits and sub-limits', dataType: 'Amount in ₹', requiredToPublish: true },
  { name: 'Pre-existing disease waiting period', group: 'Waiting periods', dataType: 'Months', requiredToPublish: true },
];
const AGE = { name: 'Age of eldest', kind: 'BAND', source: 'Age of the eldest insured person', bands: [{ from: 18, to: 35 }, { from: 36, to: 45 }, { from: 46, to: 60 }] };
const ZONE = { name: 'Zone', kind: 'VALUE', source: 'Asked in the quotation', values: ['Zone A', 'Zone B'] };

async function people() {
  const a = await seedAdmin();
  const b = await seedAdmin();
  const sm = newMobile();
  await User.create({ accountId: null, role: 'STF', name: 'Meena Staff', mobile: normalizeMobile(sm), status: 'ACTIVE', activatedAt: new Date() });
  const staff = { mobile: sm, ...(await login(sm)) };
  const decide = async (who: { token: string; mobile: string }, path: string, body: object) => as(who.token).post(path, body, { 'X-Step-Up-Token': await stepUp(who.token, who.mobile) });
  const health = async (token: string) => ((await as(token).get('/admin/types')).body.data as Array<{ id: string; name: string; activeTemplate: unknown; openTemplate: { id: string } | null; version: number }>).find((t) => t.name === 'Health')!;
  return { a, b, staff, decide, health };
}

/** Staff drafts a Health template with the given rows; returns the draft after saving. */
async function draft(staff: { token: string }, typeId: string, rows: object) {
  const d = (await as(staff.token).post(`/admin/types/${typeId}/templates`, {})).body.data;
  const saved = await as(staff.token).put(`/admin/templates/${d.id}`, { rev: d.rev, features: [], factors: [], questions: [], ...rows });
  return saved.body.data ?? saved.body;
}

describe('P-21 insurance types and feature templates', () => {
  it('the starting types (CFG-115) are there; + Type adds one; a duplicate name is refused (GEN-04)', async () => {
    const { a } = await people();
    const names = ((await as(a.token).get('/admin/types')).body.data as Array<{ name: string }>).map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(['Health', 'Term Life']));
    const created = await as(a.token).post('/admin/types', { name: 'Pet' });
    expect(created.status).toBe(201);
    expect(created.body.data.template).toMatchObject({ number: 1, status: 'DRAFT' });
    const dup = await as(a.token).post('/admin/types', { name: 'pet' });
    expect(err(dup)).toMatchObject({ status: 409, messageId: 'GEN-04' });
    expect(dup.body.error.message).toBe('This action is not allowed because this insurance type is already in the catalogue.');
  });

  it('submit needs at least one feature (CAT-12) and one rating factor (CAT-30)', async () => {
    const { staff, health } = await people();
    const d = await draft(staff, (await health(staff.token)).id, {});
    const r = await as(staff.token).post(`/admin/templates/${d.id}/submit`, { rev: d.rev });
    expect(fieldIds(r)).toEqual({ features: 'CAT-12', factors: 'CAT-30' });
    expect(JSON.stringify(r.body)).toContain('A feature template needs at least one rating factor.');
  });

  it('AC-P21-2: overlapping, gapped or reversed bands are refused (CAT-16); clean bands pass', async () => {
    const { staff, health } = await people();
    const typeId = (await health(staff.token)).id;
    const d = await draft(staff, typeId, { features: FEATURES, factors: [{ ...AGE, bands: [{ from: 18, to: 40 }, { from: 36, to: 45 }, { from: 50, to: 60 }, { from: 70, to: 65 }] }] });
    const r = await as(staff.token).post(`/admin/templates/${d.id}/submit`, { rev: d.rev });
    expect(fieldIds(r)).toEqual({ 'factors.0.bands.1': 'CAT-16', 'factors.0.bands.2': 'CAT-16', 'factors.0.bands.3': 'CAT-16' }); // overlap, gap, reversed
    const fixed = (await as(staff.token).put(`/admin/templates/${d.id}`, { rev: d.rev, features: FEATURES, factors: [AGE, ZONE], questions: [{ label: 'Pre-existing disease', dataType: 'Yes/No', required: true }] })).body.data;
    const ok = await as(staff.token).post(`/admin/templates/${d.id}/submit`, { rev: fixed.rev });
    expect(ok.body.meta.message).toBe('Health template version 1 sent for approval.');
  });

  it('maker-checker: the maker cannot approve (CAT-05); a different ADM approves with OTP → ACTIVE; reject → DRAFT with the reason', async () => {
    const { a, b, decide, health } = await people();
    const typeId = (await health(a.token)).id;
    const d = await draft(a, typeId, { features: FEATURES, factors: [AGE] });
    const sub = (await as(a.token).post(`/admin/templates/${d.id}/submit`, { rev: d.rev })).body.data;
    expect(err(await decide(a, `/admin/templates/${d.id}/approve`, { rev: sub.rev }))).toMatchObject({ status: 403, messageId: 'CAT-05' });
    const rej = await decide(b, `/admin/templates/${d.id}/reject`, { rev: sub.rev, reason: 'Add the zone factor' });
    expect(rej.body.meta.message).toBe('Health template version 1 rejected. Reason: Add the zone factor');
    expect(rej.body.data).toMatchObject({ status: 'DRAFT', rejectReason: 'Add the zone factor' });
    expect(rej.body.data.features).toHaveLength(2); // kept for editing
    const again = (await as(a.token).put(`/admin/templates/${d.id}`, { rev: rej.body.data.rev, features: FEATURES, factors: [AGE, ZONE], questions: [] })).body.data;
    const sub2 = (await as(a.token).post(`/admin/templates/${d.id}/submit`, { rev: again.rev })).body.data;
    const ok = await decide(b, `/admin/templates/${d.id}/approve`, { rev: sub2.rev });
    expect(ok.body.meta.message).toBe('Health template version 1 approved.');
    expect(ok.body.data.status).toBe('ACTIVE');
    expect((await as(b.token).get('/admin/approvals')).body.data).toEqual([]);
  });

  it('AC-P21-1: approving version 2 retires version 1; version 1 itself is unchanged (products keep using it)', async () => {
    const { a, b, staff, decide, health } = await people();
    const typeId = (await health(staff.token)).id;
    const v1 = await draft(staff, typeId, { features: FEATURES, factors: [AGE] });
    const s1 = (await as(staff.token).post(`/admin/templates/${v1.id}/submit`, { rev: v1.rev })).body.data;
    await decide(a, `/admin/templates/${v1.id}/approve`, { rev: s1.rev });
    // version 2 starts as a copy of version 1, with one feature removed
    const v2start = (await as(staff.token).post(`/admin/types/${typeId}/templates`, {})).body.data;
    expect(v2start).toMatchObject({ number: 2, status: 'DRAFT' });
    expect(v2start.features.map((f: { key: string }) => f.key)).toEqual(['room_rent_limit', 'pre_existing_disease_waiting_period']);
    const v2 = (await as(staff.token).put(`/admin/templates/${v2start.id}`, { rev: v2start.rev, features: [v2start.features[0]], factors: v2start.factors, questions: [] })).body.data;
    const s2 = (await as(staff.token).post(`/admin/templates/${v2.id}/submit`, { rev: v2.rev })).body.data;
    await decide(b, `/admin/templates/${v2.id}/approve`, { rev: s2.rev });
    const old = await TemplateVersion.findById(v1.id).lean();
    expect(old).toMatchObject({ status: 'RETIRED' });
    expect(old!.features).toHaveLength(2); // removing a feature never changes older versions
    expect((await health(staff.token)).activeTemplate).toMatchObject({ id: v2.id, number: 2 });
  });

  it('one open version per type (CAT-08); two makers saving one draft: the second gets GEN-05; two approvers: GEN-04', async () => {
    const { a, b, staff, health } = await people();
    const typeId = (await health(staff.token)).id;
    const d = (await as(staff.token).post(`/admin/types/${typeId}/templates`, {})).body.data;
    expect(err(await as(a.token).post(`/admin/types/${typeId}/templates`, {}))).toMatchObject({ status: 409, messageId: 'CAT-08' });
    const first = await as(staff.token).put(`/admin/templates/${d.id}`, { rev: d.rev, features: FEATURES, factors: [AGE], questions: [] });
    expect(first.status).toBe(200);
    expect(err(await as(a.token).put(`/admin/templates/${d.id}`, { rev: d.rev, features: [], factors: [], questions: [] }))).toMatchObject({ status: 409, messageId: 'GEN-05' });
    const sub = (await as(staff.token).post(`/admin/templates/${d.id}/submit`, { rev: first.body.data.rev })).body.data;
    const [ta, tb] = [await stepUp(a.token, a.mobile), await stepUp(b.token, b.mobile)];
    const [x, y] = await Promise.all([
      as(a.token).post(`/admin/templates/${d.id}/approve`, { rev: sub.rev }, { 'X-Step-Up-Token': ta }),
      as(b.token).post(`/admin/templates/${d.id}/approve`, { rev: sub.rev }, { 'X-Step-Up-Token': tb }),
    ]);
    expect([x.status, y.status].sort()).toEqual([200, 409]);
    expect(err(x.status === 409 ? x : y)).toMatchObject({ messageId: 'GEN-04' });
    expect(await TemplateVersion.countDocuments({ typeId, status: 'ACTIVE' })).toBe(1);
  });

  it('AC-P21-3: deactivating a type shows the impact (CAT-09) and makes it INACTIVE; activate reverses it', async () => {
    const { a, health } = await people();
    const adv = await registerAdvisor('Asha Rao');
    const p = (await as(adv.token).get('/profile')).body.data;
    await as(adv.token).put('/profile/professional', { version: p.sections.professional.version, categories: ['Health'] });
    const h = await health(a.token);
    const ask = await as(a.token).post(`/admin/types/${h.id}/deactivate`, { version: h.version });
    expect(err(ask)).toMatchObject({ status: 409, messageId: 'CAT-09' });
    expect(ask.body.error.message).toBe('Deactivating Health hides 0 products from new quotations and affects 1 advisors. Existing quotations and policies do not change. Continue?');
    const off = await as(a.token).post(`/admin/types/${h.id}/deactivate`, { version: h.version, confirm: ['CAT-09'] });
    expect(off.body.data.status).toBe('INACTIVE');
    expect((await as(a.token).post(`/admin/types/${h.id}/activate`, { version: off.body.data.version })).body.data.status).toBe('ACTIVE');
  });
});