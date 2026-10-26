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
| Q25 | P-05: Business has a CFG-124 weight (10%) but no required item. When does it count? | Counts once the advisor has saved the Business section, so a new advisor starts at 0% (`profile.service.ts`) |
| Q26 | FLD-34: should the GSTIN check character be verified? The BPD gives the shape only, and its own example (29ABCDE1234F1Z5) fails the official check | Shape only. Recommended: verify it (`gstinChecksumValid()` exists) and correct the example in VAL-39 |
| Q27 | FLD-22 / VAL-27: which virus-scanning service checks uploaded files? | No scan yet; VAL-27 is never shown until a scanner is chosen (needed before go-live) |
| Q28 | P-07 needs ACTIVE insurers, which the catalogue (P-20, Module 8) maintains | The insurer record has every P-20 field and state now. Until Module 8, insurers are created with the development tools (`POST /v1/dev/insurers`, refused in production) |
| DEC-09 | Same insurer and agent code in two accounts | Both mappings are flagged silently (`flaggedAt`); SkyUp sees them at `GET /v1/admin/agent-code-flags`. Neither advisor is told. To confirm |
| Q29 | File storage. The BPD specifies S3 with object lock. **Decision (Shashikant, 23-10-2026): Cloudinary for all files**, pending (a) Cloudinary's written confirmation that assets are stored in India and (b) legal review against the IRDAI Information and Cyber Security Guidelines 2023 (data of regulated entities stored in India). Needs BPD change-request sign-off | `FILE_STORAGE=cloudinary`: private (authenticated) raw assets, never overwritten, read only through the API; SHA-256 checked on every read (Cloudinary has no object lock). Enable Cloudinary backups. `local` for development |
| Q30 | P-06 step 5 emails the advisor the KYC result | Bell notification is created now; the email goes out once the communications outbox (P-39 to P-43) exists |
| Q31 | AC-P06-5: with CFG-100 = Yes an unverified advisor cannot share quotations | CFG-100 is in place (default No); the check itself is built with P-28 (share a quotation) |