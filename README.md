# Bimayantra API

Built to **Business Process Document v3.2** (Bimayantra, SkyUp Digital Solutions LLP). Node.js 22, Express 5,
MongoDB (Mongoose), Redis. What changed from the earlier InsureHub build and what is still to build:
`docs/GAP-ANALYSIS-v3.2.md`. File-by-file changes: `CHANGES-v3.2.md`.

## Run locally

```bash
docker compose up -d                 # Redis (cache + queue)
cp .env.example .env                 # then fill the keys below
npm install
npm run seed:admin                   # first SkyUp Admin, from SEED_ADMIN_NAME / SEED_ADMIN_MOBILE
npm run dev                          # http://localhost:4000/v1
```

Generate the secrets in `.env`:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"   # JWT_*_SECRET, OTP_PEPPER
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"      # PII_ENCRYPTION_KEY, PII_HASH_KEY (different)
```

`MONGO_URI` defaults to the database **bimayantra**, so data from the earlier build (database `insurehub`) is untouched.
There are no passwords: sign in on the web console with the seeded mobile number; with `SMS_PROVIDER=dev` the OTP
appears in the console's **SMS inbox** tab.

### MongoDB replica set (transactions)

Records that must be saved together (P-01 account creation, P-14 conversion, audit with its change) use a transaction
when MongoDB is a replica set. A standalone server works for local testing (writes happen in order and the API logs a
warning); production refuses to start without one. To convert the local Windows service:

1. Add to `mongod.cfg`: `replication:` / `  replSetName: rs0`, then restart the MongoDB service.
2. In `mongosh`: `rs.initiate({ _id: 'rs0', members: [{ _id: 0, host: '127.0.0.1:27017' }] })`
3. Use `MONGO_URI=mongodb://127.0.0.1:27017/bimayantra?replicaSet=rs0`

## Tests

```bash
npm test     # 219 tests: unit + integration on a real MongoDB replica set (mongodb-memory-server) and in-memory Redis
TEST_NO_TX=1 npm test   # the same suite as on a standalone MongoDB (no transactions)
```

mongodb-memory-server downloads MongoDB on first run; set `MONGOMS_SYSTEM_BINARY` to use an installed `mongod`.

## Conventions every client must follow

| Topic | Rule |
|---|---|
| Sessions (P-02) | Web: HttpOnly cookies set by the API; send `credentials` and a trusted `Origin` on writes. Apps: header `X-Client: app` on verify/refresh returns tokens; then `Authorization: Bearer …` |
| Idempotency (GR-10) | `Idempotency-Key` header (8–128 chars) on create, send and status-change requests. Make it when the form opens, reuse it on Retry. A repeat → 409 `ALREADY_SUBMITTED` (GEN-06) with `details.result` |
| Versions (GR-11) | Send the `version` you loaded on edits and status changes. Stale → 409 `VERSION_CONFLICT` (GEN-05) with `details.current` |
| Warnings | 409 `CONFIRMATION_REQUIRED` with `details.warnings` (LD-03, LD-04, CU-03, CU-21, CU-22). Repeat with `confirm: ["LD-03", …]` to "Save anyway" |
| Step-up OTP (CFG-83) | `POST /auth/step-up/otp`, `POST /auth/step-up/verify` → send `X-Step-Up-Token` with the sensitive request |
| Messages | Success: `meta.messageId` + `meta.message`. Error: `error.code`, `error.messageId`, `error.message`, `error.fields[] {field, messageId, message}`, `error.requestId` |
| Read-only (GR-33) | Writes from an EXPIRED subscription → 403 `READ_ONLY` (SUB-03) |

## Endpoints (all under `/v1`)

| Area | Endpoints |
|---|---|
| Access (P-01–P-04) | `POST /auth/register/otp`, `/auth/register/verify`, `/auth/login/otp`, `/auth/login/verify`, `/auth/refresh`, `/auth/logout`; `GET /auth/me`, `/auth/sessions`; `DELETE /auth/sessions/:id`; `POST /auth/step-up/otp`, `/auth/step-up/verify`; `POST /auth/mobile/current/otp`, `/current/verify`, `/new/otp`, `/new/verify` |
| Team | `GET/POST /assistants`, `POST /assistants/:id/disable|enable` (P-53); `GET/POST /staff`, `POST /staff/:id/role|disable|enable` (P-48) |
| Leads (P-12–P-14) | `GET /pipelines`; `GET /leads`, `GET /leads/duplicate-check`, `POST /leads`, `GET/PATCH /leads/:id`, `POST /leads/:id/status`, `/contacts`, `/convert` |
| Customers (P-15–P-17, P-19) | `GET /customers`, `/customers/duplicate-check`, `POST /customers`, `GET/PATCH /customers/:id`, `POST /:id/deactivate|reactivate`, `PUT /:id/identity`, `POST /:id/identity/reveal`, `GET/POST /:id/family`, `PATCH /:id/family/:memberId`, `POST /:id/family/:memberId/deactivate|activate`, `GET/POST /:id/consents` |
| Catalogue (P-20–P-25) | SkyUp: `/admin/insurers`, `/admin/types`, `/admin/templates/:id`, `/admin/products`, `/admin/product-versions/:id` (`PUT`, `/submit`, `/approve`, `/reject`, `/use-current-template`), `/admin/approvals`. Advisors and assistants: `GET /products`, `GET /products/:id`; advisor only: `GET/PUT /products/:id/commercials`, `GET /my-products/types`, `GET /my-products/types/:id/template`, `POST /my-products`, `PUT /my-products/:id`, `POST /my-products/:id/status` |
| Other | `GET /reference` (CFG lists for screens), `GET /audit` (P-50 view), `/health/live`, `/health/ready` |
| Test tools (`DEV_TOOLS=true`, never production) | `GET/DELETE /dev/sms`, `POST /dev/sms/failing`, `GET/POST /dev/clock`, `GET /dev/config`, `PUT/DELETE /dev/config/:id`, `POST /dev/reset-limits` |

## Layout

```
src/
  config/      env.ts (infrastructure only), cfg.ts (every CFG value with its documented default)
  lib/         messages.ts (Section 21 catalogue), fields.ts (Section 2A validators), errors, response, clock (IST, test clock),
               phone (FLD-01), crypto (PII encryption, OTP hashing), mongo (transactions), pagination, rateCounter, logger, redis
  middleware/  authenticate (cookie/Bearer, per-request session checks, CFG-99), authorize (3.2 matrix, read-only),
               idempotency, validate, errorHandler, requestId
  modules/     accounts, auth (OTP, sessions, step-up, SMS), rbac, users, team, leads, tasks, customers (customers, family,
               consent, identity), audit, reference, dev, health
  scripts/     seed-admin.ts, sync-indexes.ts (run `npm run db:indexes` once per release in production)
tests/         *.int.test.ts (MongoDB replica set) and *.unit.test.ts
```