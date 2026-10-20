# DUO extension to existing QUICK ADMIN — implementation contract

Status: design specification only; NOT deployed, no production schema/policies modified.

## Non-negotiable compatibility
- Preserve existing T-oss / Grab navigation, membership, sales, settlement, dispatch and administrator functions.
- Add DUO as a third service, not a replacement for any existing module.
- Only admins explicitly granted `duo` may see or access DUO administration.
- The 'all' overview aggregates ONLY services AND organization scopes granted to that administrator; never an implicit global overview.

## Independent server-enforced entitlements
1. Service visibility: `toss`, `grab`, `duo`. Default DENY new DUO grants.
2. Capabilities per service: `member.read`, `member.approve`, `member.suspend`, `dual.approve`, `revenue.read`, `settlement.read`, `admin.delegate` (minimal grants only).
3. Organization scope: `own`, `subtree`, `global`; global allowed only for independently verified owner/superadmin role.
4. Scopes and capabilities must be checked SERVER-SIDE on EVERY read, aggregate, export, mutation and direct URL. No client-side filters as a security boundary.
5. Delegation: grantor may delegate only services, capabilities, organizations and time periods they personally control; cannot modify their own permissions or elevate global access.
6. Parent revenue: recursively descendants via `branches.parent_id` + own branch; child must never read ancestor, sibling or other root data. Explicit company revenue rights are separate from menu visibility.
7. Request and event logs record actor UUID, target UUID/branch, changes, timestamp and reason (excluding passwords/tokens).

## DUO driver lifecycle
- Signup: verified credential identity (UUID) + displayed Korean real name, account password handled by authentication provider, never in admin DB.
- Distinct states: pending/approved/rejected/suspended.
- Distinct permissions: `app_access` and `dual_access`; dual access does NOT imply app access.
- App access required to enter authenticated app. Dual features require dual access as well.
- Do not activate real dispatch/catch/cancel until sanctioned integration is separately verified.
- Retain debug-only offline preview distinct from authenticated sessions.

## Deployment gates
- Map current QUICK ADMIN auth, admins/branches/users/payment_requests schemas and server endpoints.
- Address existing public tables with disabled RLS using staged policies and tests; never enable RLS en masse without understanding existing clients.
- First create dedicated migration/policies and server endpoints in staging; negative authorization tests for forbidden cross-tree reads, direct URLs, exports, sibling branch and cross-service requests.
- Only after regression tests and approval should admin UI be published to main/GitHub Pages.
