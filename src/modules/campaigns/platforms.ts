/**
 * Meta (Graph API) and LinkedIn (Lead Sync API) clients. Credentials are read from the environment when used, so the
 * channels switch on as soon as the client's approved app details are added (no deploy needed beyond the .env).
 * Errors that mean "sign in again" are raised as ReconnectNeeded.
 */
export class ReconnectNeeded extends Error {}
export class PlatformError extends Error {}

export const metaConfig = () => ({ appId: process.env.META_APP_ID ?? '', appSecret: process.env.META_APP_SECRET ?? '', verifyToken: process.env.META_VERIFY_TOKEN ?? '', version: process.env.META_GRAPH_VERSION ?? 'v22.0' });
export const linkedinConfig = () => ({ clientId: process.env.LINKEDIN_CLIENT_ID ?? '', clientSecret: process.env.LINKEDIN_CLIENT_SECRET ?? '', version: process.env.LINKEDIN_API_VERSION ?? '202609' });
export const isConfigured = (channel: 'META' | 'LINKEDIN') => (channel === 'META' ? !!(metaConfig().appId && metaConfig().appSecret && metaConfig().verifyToken) : !!(linkedinConfig().clientId && linkedinConfig().clientSecret));
export const redirectUri = (channel: 'META' | 'LINKEDIN') => `${process.env.PUBLIC_API_URL ?? 'http://localhost:4000'}/v1/hooks/oauth/${channel.toLowerCase()}/callback`;

async function call(url: string, init: RequestInit & { channel: 'META' | 'LINKEDIN' }) {
  const r = await fetch(url, { ...init, signal: AbortSignal.timeout(15_000) });
  const text = await r.text();
  let j: Record<string, any> = {};
  try { j = text ? JSON.parse(text) : {}; } catch { j = { raw: text.slice(0, 200) }; }
  if (r.ok) return { json: j, headers: r.headers };
  const code = j?.error?.code;
  if ((init.channel === 'META' && (code === 190 || code === 102 || r.status === 401)) || (init.channel === 'LINKEDIN' && (r.status === 401 || r.status === 403 && /token|expired|revoked/i.test(text)))) throw new ReconnectNeeded(j?.error?.message ?? j?.message ?? `HTTP ${r.status}`);
  throw new PlatformError(j?.error?.message ?? j?.message ?? `HTTP ${r.status}`);
}

// ── Meta ──
const graph = (path: string) => `https://graph.facebook.com/${metaConfig().version}/${path}`;
const qs = (o: Record<string, string>) => new URLSearchParams(o).toString();
export const meta = {
  authUrl: (state: string) => `https://www.facebook.com/${metaConfig().version}/dialog/oauth?${qs({ client_id: metaConfig().appId, redirect_uri: redirectUri('META'), state, response_type: 'code',
    scope: 'leads_retrieval,pages_show_list,pages_read_engagement,pages_manage_metadata,pages_manage_ads,ads_read,business_management' })}`,
  /** code → short-lived token → long-lived user token (Page tokens made from it do not expire on their own). */
  async exchange(code: string) {
    const c = metaConfig();
    const short = (await call(`${graph('oauth/access_token')}?${qs({ client_id: c.appId, client_secret: c.appSecret, redirect_uri: redirectUri('META'), code })}`, { channel: 'META' })).json;
    const long = (await call(`${graph('oauth/access_token')}?${qs({ grant_type: 'fb_exchange_token', client_id: c.appId, client_secret: c.appSecret, fb_exchange_token: String(short.access_token) })}`, { channel: 'META' })).json;
    return { token: String(long.access_token ?? short.access_token), expiresIn: Number(long.expires_in ?? 0) || null };
  },
  async pages(userToken: string) {
    const j = (await call(`${graph('me/accounts')}?${qs({ fields: 'id,name,access_token', limit: '100', access_token: userToken })}`, { channel: 'META' })).json;
    return ((j.data ?? []) as Array<{ id: string; name: string; access_token: string }>).map((p) => ({ id: String(p.id), name: String(p.name), token: String(p.access_token) }));
  },
  subscribe: (pageId: string, pageToken: string) => call(`${graph(`${pageId}/subscribed_apps`)}?${qs({ subscribed_fields: 'leadgen', access_token: pageToken })}`, { channel: 'META', method: 'POST' }),
  async forms(pageId: string, pageToken: string) {
    const j = (await call(`${graph(`${pageId}/leadgen_forms`)}?${qs({ fields: 'id,name,status', limit: '100', access_token: pageToken })}`, { channel: 'META' })).json;
    return ((j.data ?? []) as Array<{ id: string; name: string; status: string }>).map((f) => ({ id: String(f.id), name: String(f.name), status: String(f.status ?? '') }));
  },
  /** One lead with its answers and ad attribution (ported from the previous CRM). */
  lead: async (leadgenId: string, pageToken: string) => (await call(`${graph(leadgenId)}?${qs({ fields: 'id,created_time,field_data,form_id,ad_id,ad_name,adset_name,campaign_name,is_organic,platform', access_token: pageToken })}`, { channel: 'META' })).json,
  /** Catch-up: the form's leads created after `since` (seconds). */
  async formLeads(formId: string, pageToken: string, sinceSec: number) {
    const j = (await call(`${graph(`${formId}/leads`)}?${qs({ fields: 'id,created_time,field_data,form_id,ad_id,ad_name,adset_name,campaign_name,is_organic', limit: '100', filtering: JSON.stringify([{ field: 'time_created', operator: 'GREATER_THAN', value: sinceSec }]), access_token: pageToken })}`, { channel: 'META' })).json;
    return (j.data ?? []) as Array<Record<string, any>>;
  },
};
/** Meta field_data → answers (values joined; the field name is the key). */
export const metaAnswers = (lead: Record<string, any>) => ((lead.field_data ?? []) as Array<{ name: string; values?: string[] }>).slice(0, 100).map((f) => ({ key: String(f.name).slice(0, 80), label: String(f.name).replace(/_/g, ' ').slice(0, 120), value: (f.values ?? []).join(', ').slice(0, 2000) }));

// ── LinkedIn ──
const li = (path: string) => `https://api.linkedin.com/rest/${path}`;
const liHeaders = (token: string) => ({ Authorization: `Bearer ${token}`, 'LinkedIn-Version': linkedinConfig().version, 'X-Restli-Protocol-Version': '2.0.0', 'Content-Type': 'application/json' });
export const linkedin = {
  authUrl: (state: string) => `https://www.linkedin.com/oauth/v2/authorization?${qs({ response_type: 'code', client_id: linkedinConfig().clientId, redirect_uri: redirectUri('LINKEDIN'), state, scope: 'r_marketing_leadgen_automation r_ads' })}`,
  async exchange(code: string) {
    const c = linkedinConfig();
    const j = (await call('https://www.linkedin.com/oauth/v2/accessToken', { channel: 'LINKEDIN', method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: qs({ grant_type: 'authorization_code', code, client_id: c.clientId, client_secret: c.clientSecret, redirect_uri: redirectUri('LINKEDIN') }) })).json;
    return { token: String(j.access_token), expiresIn: Number(j.expires_in ?? 0) || null };
  },
  /** The ad accounts this person can see (owners for lead notifications). */
  async adAccounts(token: string) {
    const j = (await call(`${li('adAccountUsers')}?q=authenticatedUser`, { channel: 'LINKEDIN', headers: liHeaders(token) })).json;
    return ((j.elements ?? []) as Array<{ account: string; role?: string }>).map((e) => ({ id: String(e.account), name: String(e.account).split(':').pop() ?? String(e.account), role: e.role ?? null }));
  },
  /** An owner-level lead notification subscription (LinkedIn's recommendation), to our validated HTTPS webhook. */
  subscribe: (accountUrn: string, token: string) => call(li('leadNotifications'), { channel: 'LINKEDIN', method: 'POST', headers: liHeaders(token), body: JSON.stringify({ webhook: `${process.env.PUBLIC_API_URL ?? ''}/v1/hooks/linkedin`, owner: { sponsoredAccount: accountUrn }, leadType: 'SPONSORED' }) }),
  response: async (responseUrn: string, token: string) => (await call(`${li(`leadFormResponses/${encodeURIComponent(responseUrn)}`)}?fields=id,submittedAt,testLead,formResponse,versionedLeadGenFormUrn,owner,leadMetadataInfo,form:(name,id,content)`, { channel: 'LINKEDIN', headers: liHeaders(token) })).json,
  /** Catch-up: an owner's responses submitted after `sinceMs`. */
  async responses(accountUrn: string, token: string, sinceMs: number) {
    const q = `q=owner&owner=(sponsoredAccount:${encodeURIComponent(accountUrn)})&leadType=(leadType:SPONSORED)&submittedAtTimeRange=(start:${sinceMs},end:${Date.now()})&fields=id,submittedAt,testLead,formResponse,versionedLeadGenFormUrn,form:(name,id,content)`;
    return (((await call(`${li('leadFormResponses')}?${q}`, { channel: 'LINKEDIN', headers: liHeaders(token) })).json.elements ?? []) as Array<Record<string, any>>);
  },
};
/** LinkedIn answers: each answer joined to its question; standard questions keep their predefined field as the key. */
export function linkedinAnswers(r: Record<string, any>) {
  const questions = new Map(((r.form?.content?.questions ?? []) as Array<Record<string, any>>).map((q) => [String(q.questionId), q]));
  return ((r.formResponse?.answers ?? []) as Array<Record<string, any>>).slice(0, 100).map((a) => {
    const q = questions.get(String(a.questionId)) ?? {};
    const d = a.answerDetails ?? {};
    const value = d.textQuestionAnswer?.answer ?? (Array.isArray(d.multipleChoiceAnswer?.options) ? d.multipleChoiceAnswer.options.join(', ') : '');
    const key = String(q.predefinedField ?? q.name ?? `question_${a.questionId}`).slice(0, 80);
    return { key, label: String(q.label ?? q.name ?? key).slice(0, 120), value: String(value).slice(0, 2000) };
  });
}