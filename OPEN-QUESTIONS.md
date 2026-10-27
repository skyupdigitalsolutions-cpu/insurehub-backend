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
| Q32 | P-18 step 6: Aadhaar/PAN read from a document replace the customer's value "after the user confirms a change", but the BPD has no message text for that confirmation | Never overwritten automatically: Confirm saves the document and reports `identity.differs`; the screen offers the P-15 identity change, which has its own messages |
| Q33 | P-18 step 5 automatic reading: Google Document AI [TO CONFIRM]. Also confirm its processing region (Aadhaar and PAN are personal data; see Q29) | `DOCUMENT_READER=none`: the verify screen opens empty for manual entry (DOC-10, the BPD's own fallback). AC-P18-4 holds either way |
| Q34 | AC-P18-6 "infected file is refused" needs the scanning service of Q27 | Type, size and damaged-file checks are in place; the infection check waits for Q27 |
| Q35 | P-18 Missing box (DOC-08): only the customer, or also each household member? | The customer only (Aadhaar and PAN) |