# QUICK ADMIN — security migration (development branch)

> **Status: NOT READY FOR PRODUCTION.** This branch must not be merged until server-side authentication and data-access gates below are implemented and tested.

## Verified security findings (2026-11-03)

- QUICK ADMIN's `index.html` uses the browser Supabase client to query `public.admins` and compares an unsalted SHA-256 password value in a database filter.
- Before this change, `tryAutoLogin()` restored administrator privileges from the `qa_session.adminId` browser storage value without a server-verified session.
- Browser JavaScript invokes Supabase `.from(...)` directly to read and mutate `admins`, `users`, `payment_requests`, `user_devices`, `branches`, and others.
- The `quickdispatch` Supabase project has 13 `public` tables with RLS disabled, and `anon` has SELECT/UPDATE/DELETE privileges on important tables.
- The separate DUO administrative workflow uses server-mediated functions; do not assume its tokens/roles automatically authorize legacy QUICK ADMIN operations.

## Work in this branch

1. **Immediate dev-branch protection:** disable the unsafe `qa_session.adminId` automatic administrator restore. The normal login UI remains, but its legacy browser-side password flow is **not** secure and must be replaced before production release.
2. Add `security/audit-client.mjs` and `security/audit-client.test.mjs` to enumerate risky client-side DB accesses, detect legacy authentication, and prevent reintroducing localStorage-only auto-login.
3. Design a server-side session and scoped API; implement it on an isolated Supabase development environment, never in production first.
4. Move existing privileged actions to server-verified operations with per-admin and per-branch authorization.
5. Remove public-table privileges and enable RLS with reviewed policies only after all affected clients are migrated and tested.

## Non-negotiable rollout gates

- No production `main` changes from this work until review and a completed end-to-end migration.
- No RLS toggles or GRANT/REVOKE changes directly in production until an isolated test and rollback plan pass.
- No `service_role` or secret key in GitHub Pages or mobile clients.
- No trust in browser-supplied `adminId`, `role`, `branch_id`, or `qa_session` values for server authorization.
- Every request must derive the acting administrator from a **server-verified** identity and check the permitted organization scope.
- Do not assume existing DUO access grants equal upstream Insung device registration approval.

## Admin roles and scope

Legacy roles: `dev`, `master`, `branch`, `sub`. The browser currently computes organization scope in JavaScript. A replacement backend must recompute it, including descendant branches and active admin status, for every privileged operation.

### Migration order

1. Server-issued, revocable admin sessions and password reset/re-enrollment flow.
2. Account and branch directory read endpoints with scope enforcement.
3. User, device, payments and license mutation endpoints (idempotency and audit logging).
4. Settings, announcements, organization and admin-account management endpoints.
5. Switch browser calls from direct `public` tables to the authenticated API.
6. Disable unnecessary `anon`/`authenticated` grants, apply RLS, and rerun complete legacy/DUO regression tests.
7. Release separately from the DUO independent Insung receiver.

## Run local static checks

```bash
node --test security/audit-client.test.mjs
node security/audit-client.mjs
node security/audit-client.mjs --guardrails
```

**Guardrails are not a security certification.** They only prevent known client-side regressions and increased exposure while the remaining direct database access is migrated.

## Recovery

Only the `security/qa-auth-hardening-v212` branch is edited. Do not merge the draft PR if authentication or core operational flows fail. If a later deployment requires rollback, restore the prior verified web release and backend configuration; do not roll back by exposing more anonymous database privileges.

## V2.16 isolated browser pilot (2026-11-03)

A separate frontend API adapter and synthetic-only Korean pilot have been added under `security/ui/` without importing them from the existing `index.html`. The adapter routes only to allowlisted Edge endpoints, obtains a Supabase Auth access JWT via an injected auth session provider, projects safe fields, and prepares immutable, idempotency-keyed action intents. No `service_role` key or browser-controlled admin ID is used. The pilot is hardwired to in-memory fake users and payments and makes **no production network requests**.

The original QUICK ADMIN cannot yet be replaced: the old `doLogin` still uses the public `admins` table, `loadAllData` needs fields intentionally omitted from secure limited read endpoints, and management screens such as settings, organization and admin accounts lack protected APIs. The secure pilot is **not** a live authenticated administrator interface. It is intentionally not published by GitHub Pages.

Tests: `node --test security/ui/secure-admin-client.test.mjs security/ui/secure-pilot.test.mjs`; GitHub Actions runs these alongside all previous Node checks and disposable PostgreSQL tests. Do not merge or deploy without completing account enrollment, backend policies, UI compatibility, and live end-to-end verification.