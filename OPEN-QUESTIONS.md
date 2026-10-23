# Open questions

v3.2 answered most questions raised against the earlier PRD. The full gap analysis is in
`docs/GAP-ANALYSIS-v3.2.md`; choices made where v3.2 is silent are listed in its §5.

## Answered by BPD v3.2

| # | Earlier question | v3.2 answer | Where it lives now |
|---|---|---|---|
| Q1 | Permission codes | Fixed role matrix, Section 3.2 | `src/modules/rbac/capabilities.ts` |
| Q2 | Response envelope | Section 2.5 status mapping + message IDs | `src/lib/response.ts`, `src/lib/errors.ts` |
| Q3 | Login identity | Mobile OTP only (P-01, P-02) | `src/modules/auth/` |
| Q9 | Lockout values | CFG-03 to CFG-06, CFG-10 | `src/config/cfg.ts` |
| Q10 | Renewal reminder windows | CFG-60, CFG-61 | (renewals module) |
| Q11 | Quote validity / EXPIRED | CFG-46; EXPIRED status in 4.3 | (quotations module) |
| Q12 | Policy statuses | Section 4.3 Policy | (policies module) |
| Q13 | Duplicate leads | Exact duplicate blocked, same mobile warned (Section 7) | `leads.service.ts` |
| Q14 | Nominee total | Exactly 100% (CFG-54) | (policies module) |
| Q16 | Message statuses | Section 4.3 Outgoing message | (communications module) |
| Q19 | Password policy | No passwords | — |
| Q21 | Lead transitions | Section 4.3 Lead | `src/modules/leads/leadStatus.ts` |
| Q22 | Non-Indian numbers | Indian mobiles only (FLD-01) | `src/lib/phone.ts` |
| Q23 | Consent evidence | P-17: how given, declaration, history (evidence file with P-18) | `consent.service.ts` |
| Q24 | Customer minimum age | No minimum; DOB within CFG-14 years (FLD-05) | `src/lib/fields.ts` |

## Still open (owner: the client, Section 22.2)

| # | Question | Default in the code |
|---|---|---|
| DB | PostgreSQL (22.1) vs MongoDB in use | MongoDB, replica set required in production |
| 17A | Mobile-app section missing from the PDF | Apps send `X-Client: app` and get Bearer tokens |
| DEC-19 | MSG91 DLT sender and templates | `SMS_PROVIDER=dev` test inbox; MSG91 not wired |
| DEC-22 | May an advisor store the full Aadhaar? | Stored encrypted, masked, consent first |
| DEC-10 | Consent wording | Declaration texts from P-17 |
| DEC-12 | Retention (audit 8 years, OTP 30 days) | Not enforced yet (SYS-10) |
| Q4–Q8, Q15, Q17, Q18, Q20 | Payment, GST, premium, need analysis, KPIs, providers | Superseded by the v3.2 processes of those modules; review when each is built |
