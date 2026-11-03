# QUICK ADMIN — verified administrator gateway (draft)

**Not deployed.** This module lives on the security/qa-auth-hardening-v212 development branch only. It does not modify the operational QUICK ADMIN login, Supabase production tables or the DUO upstream receiver.

## Implemented

- core.mjs: fail-closed HTTP handler, with injected Auth token verifier and protected profile loader.
- core.test.mjs: unit tests for JWT rejection, missing/revoked admin mapping, branch scope, untrusted client input, CORS and upstream outages.
- index.ts: draft Edge entrypoint; server verifies the bearer with Supabase Auth and calls a service-role-only profile RPC. No secret is returned to the client.
- SQL_REVIEW_ONLY.sql: draft private admin mapping and protected RPC. This is NOT a migration to execute.

## Request contract

After provisioning: GET /functions/v1/qa-admin-gateway with Authorization: Bearer <Supabase Auth JWT>.
200 returns an admin display profile and server-computed branch scope. 401 denotes invalid JWT, 403 denotes no active admin mapping or invalid scope, 503 denotes unavailable Auth/RPC.

Never trust browser-supplied admin ID, role, or branch; never return the legacy admins.password value.

## Admin enrollment must happen separately

1. Verify each real administrator identity through an out-of-band trusted process.
2. Issue a NEW Supabase Auth credential with invitation/password reset, preferably MFA. Never import existing SHA-256 hashes as credentials.
3. Bind that verified Auth UUID to exactly one legacy public.admins ID in qa_private.admin_identities, initially enabled=false.
4. Review each admin role and branch, then explicitly enable the mapping.
5. Revocation must flip mapping enabled=false; each gateway request re-reads active permission.

Existing administrators are NOT automatically enrolled. Until the mapping exists the new gateway rejects access. The old login is still insecure and cannot be deployed as secure just because this module exists.

## Role and scope

- dev: global scope.
- master/branch/sub: own branch and descendants, computed server-side with cycle guard.
- The browser's getVisibleBranchIds is only for UI; subsequent CRUD endpoints must independently enforce per-record branch scope server-side.

## Before any deployment

- Obtain an isolated Supabase test project/branch and confirm any associated cost.
- Convert SQL_REVIEW_ONLY.sql to a real reviewed Supabase CLI migration on the test environment; confirm private RLS and PUBLIC/anon/authenticated execute restrictions.
- Bundle core.mjs with index.ts as a new Edge Function configured to verify JWT. Run on development only.
- Verify Auth credentials, mapping revocation, role changes, branch hierarchy, invalid JWT, CORS, and zero secret leakage.
- Replace ALL legacy browser-origin direct table access with server-side scoped APIs.
- Only then design/prove RLS policies for the 13 public tables and stage a controlled production cutover and rollback.

## Local tests

Run: node --test security/qa-admin-gateway/core.test.mjs

Passing mocked unit tests is not proof of live authentication. No Supabase or GitHub main deployment is performed here.
## Scoped read-only API (additional development work)

A second Edge Function draft, `read-index.ts`, exposes `GET /functions/v1/qa-admin-read` in a future **development-only** deployment. Resource allowlist: `members`, `payments`, `branches` with bounded `limit` (1–100) and `offset` (0–10000). This endpoint is not deployed.

- `read-core.mjs`: independently verifies Supabase Auth JWT and calls the protected admin mapping. All read requests are passed to a service-only RPC with the **verified auth user ID**. No browser-provided admin ID, role, or branch is used.
- `read-core.test.mjs`: tests branch-scope enforcement, out-of-scope rows, strict field projection, invalid JWT, revoked mapping, forbidden resource names, limits, and failed upstream dependencies.
- `SQL_READ_REVIEW_ONLY.sql`: proposed `qa_svc_admin_read` RPC. It independently recomputes the administrator's permitted organization scope, returns only safe columns and explicitly revokes execute from PUBLIC/anon/authenticated. This is a **review-only draft**, not executed.
- Member read results deliberately omit `password`, `resident_num`, `phone`, and `main_android_id`. Payment results omit `admin_note` and `note`. Settings and devices are not exposed by this first prototype.

These endpoints cannot replace the existing QUICK ADMIN yet: the legacy web app still directly reads/writes public tables, and the 12 administrators require safe new Supabase Auth credentials. Do not route production traffic to these draft endpoints until an isolated development database, audited migration, and end-to-end test plan are ready.

## Development without a paid Supabase branch (2026-11-03)

The user chose **not** to create a paid Supabase development branch. Development remains confined to this GitHub security branch. No Supabase project, production database, or existing QUICK ADMIN/ZAPGO-V6/DUO deployments were modified.

### Member approval/rejection prototype

- `review-core.mjs` — POST-only, dev-only, fail-closed member-review API. A newly verified Supabase Auth identity and active private admin mapping are required. Only the actions `member.approve` / `member.reject` are accepted. Client-admin IDs, arbitrary fields, and unaudited roles are rejected.
- `review-index.ts` — undeployed Edge Function adapter. Secrets remain server-side.
- `SQL_REVIEW_MUTATE_ONLY.sql` — review-only transaction proposal for pending member approval (including the existing 7-day initial license), rejection with reason, and idempotent audit record. **Do not execute on production.**
- `review-core.test.mjs` — mocked authorization, input validation, revoked mapping, replay handling, and error tests.
- `sql-local-test.sql` — synthetic-data verification of the SQL proposals using a disposable PostgreSQL 17 service in GitHub Actions; the service and test rows are discarded after the workflow.

GitHub Actions job `security-regression` and disposable `sql-isolated-postgres` passed after the SQL syntax fix. These do **not** test Supabase Auth accounts, PostgREST deployment settings, or production-compatible RLS. A reviewed deployment and live permission check are still required before changing production.

Legacy QUICK ADMIN manual login and direct browser DB access are still present. Keep PR #2 in **draft** and do not merge or deploy.
