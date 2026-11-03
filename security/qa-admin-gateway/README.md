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