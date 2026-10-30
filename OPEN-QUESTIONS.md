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
| Q33 | P-18 step 5 automatic reading. **Decision (27-10-2026): Google Document AI, plain OCR processor in asia-south1 (Mumbai)**, fields found by our own parsers (no generative-AI extractor: P-18 forbids PAN/Aadhaar in AI requests). Mumbai single-region access may need Google's request form. CFG-37 (OCR confidence) is not applied to identity fields yet | `DOCUMENT_READER=google` + `DOCUMENT_AI_*`; reading runs after the save (GR-26), 30 s per call, CFG-38 overall; any failure → manual entry (DOC-10). `none` keeps manual entry only |
| Q34 | AC-P18-6 "infected file is refused" needs the scanning service of Q27 | Type, size and damaged-file checks are in place; the infection check waits for Q27 |
| Q35 | P-18 Missing box (DOC-08): only the customer, or also each household member? | The customer only (Aadhaar and PAN) |
| Q36 | P-54 "registration unique in the account": also across SOLD (INACTIVE) vehicles? Taken literally, a car one client sold could not be recorded for the client who bought it | Unique among ACTIVE vehicles only (database rule). Reactivating a sold vehicle whose registration is ACTIVE elsewhere gets VEH-03 |
| Q38 | CU-17 asks for MASKED Aadhaar copies only, but Confirm requires the full 12-digit number (P-18). With a masked copy the number cannot be read and must be typed from elsewhere. Linked to DEC-22 (may the full Aadhaar be stored?) | Masked copies give no number (by design); the user types it, or leaves Aadhaar unconfirmed |
| Q39 | P-21 backend rule assigns CAT-16 to bands that overlap or leave gaps, but CAT-16's text is "Minimum must not be more than maximum." | CAT-16 is returned on the offending band for reversed, overlapping and gapped bands; the screen marks that band. Suggest a dedicated message for overlaps and gaps |
| Q40 | P-21 has no message for a duplicate insurance type name | GEN-04: "This action is not allowed because this insurance type is already in the catalogue." |
| Q37 | P-54 "uploaded photos are discarded after CFG-135" vs files never being deleted (object lock, Q29) | Unattached uploads are never linked to anything and stay unused in storage; a cleanup policy needs deciding with Q29 |
| Q41 | P-22 step 2: which insurers may an advisor build an own product on? Any ACTIVE catalogue insurer, or only those in their My insurers (P-07, appointed with an agent code)? | Any ACTIVE catalogue insurer (the check is in `publishCheck`; the console lists ACTIVE insurers from `GET /insurers`). If P-07 applies, change the backend check, not only the list |
| Q42 | Brochure uploads (`BROCHURE`) are allowed for `products.own` only, so SkyUp cannot attach a brochure to a verified product and must give the insurer page link and the date checked. Intended? P-23 (brochure reading) will need SkyUp uploads | Verified products: link and date. Advisors: brochure optional |
| Q43 | P-22 step 4: the owner chooses UPCOMING, ACTIVE or WITHDRAWN. Should ACTIVE be refused while the launch date is still ahead (it makes the product quotable early)? | Stored as chosen (UPCOMING with a passed launch date already reads as ACTIVE). The console offers the status that matches the launch date |
| Q44 | P-26 scores five facts (room rent, co-pay, pre-existing waiting period, claim settlement ratio) but templates have no fixed feature keys | Facts are found by feature NAME ("room rent", "co-pay", "pre-existing … waiting", "claim settlement"). A type whose template names them differently scores them 0 "Not stated by insurer". Suggest fixed feature keys for these four |
| Q45 | P-26 premium before the quotation engine (P-27): MANUAL_ENTRY products, or rate rows that need a quotation answer ("Asked in the quotation"), have no premium to rank on | Budget fit 0 with the reason shown; the product still ranks on the other four facts |
| Q46 | P-26 AI summary (CFG-101): no AI service is connected yet | Always FIT-05 ("The written summary is not available right now. The scores are complete."); ranking never depends on it |
| Q47 | Authorised categories were limited to the starting types (CFG-115), so types added later with + Type (P-21) could never be authorised or ranked | Choices are CFG-115 plus every ACTIVE catalogue type, checked on save (VAL-22) |
| Q48 | P-27 "Who: ADV", yet P-27 also says override and discount are refused for an assistant (GEN-03), implying assistants work on quotations | Assistants can prepare and generate quotations; price override and discount are the advisor's only (GEN-03) |
| Q49 | Quotation PDF design (companion document CD-04) is not in the BPD | A plain one-page PDF with every P-27 snapshot item; amounts print as "Rs." because standard PDF fonts have no ₹ sign. Replace with the CD-04 design when available |
| Q50 | P-28 Email share needs the email service (Communications, P-39 to P-43, Module 14) | The share runs every check, starts validity and records the email as QUEUED (P-28's own failure rule); it is sent once Module 14 exists |
| Q51 | P-55 step 4 pre-fills nominees "from the customer's default nominee", which P-35 (Module 12) introduces | Nominees start empty until Module 12 adds the default nominee; the P-35 rules (POL-11 to POL-17) already apply |
| Q52 | P-55 creates the policy record AWAITING_ISSUANCE, but policies are Module 12 (P-33) | A minimal policy record (status and frozen members, declarations, nominees, product, premium, payment) is created on Submit; Module 12 extends it |
| Q53 | CFG-174 lists declaration questions for Health, Term Life and Motor only | Types named like "term"/"life" or "motor" use their lists; every other type uses the Health questions |