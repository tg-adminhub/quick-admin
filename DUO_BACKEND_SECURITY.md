# Duo integration — backend security contract

Status: development only. Never merge without review of server-side admin authentication and RLS.

## Data isolation
- Duo data is in `duo_private` schema and cannot be queried via browser anon/authenticated Supabase clients.
- Existing `public.users`, `public.admins` and `public.payment_requests` are unchanged.
- `duo_private.admin_permissions` initially grants the developer admin only.
- Browser checks in `index.html` are visual hints, NOT authorization.

## Product definitions
| Code | Days | KRW |
|---|---:|---:|
| next (existing T-oss) | 40 | 60000 |
| grab (existing Grab) | 40 | 60000 |
| duo_standard | 40 | 60000 |
| duo_dual | 45 | 90000 |

## Protected server operations needed
1. Authenticate admin using a modern server-side password verifier/session. Existing front-end SHA-256 checks must NOT be trusted for Duo access.
2. Look up the verified admin ID server-side, then consult `duo_private.admin_permissions` before returning Duo data.
3. Only authorized admin can read or approve Duo members. Direct sign-ups start `pending`; admin-created entries start `approved`.
4. Dual is a separate privilege: approve/revoke `duo_private.dual_requests`, update tier and approval timestamp in the same transaction.
5. Extend Duo through `duo_private.extend_duo_license` via a trusted server only. Never let browser specify operator ID without verification. Pass an idempotency key generated for each purchase. The function prevents a reused key from extending twice, and records an audit event. Payment reporting integration is still pending.
6. All member lists, search, counts, exports, revenues and renewal options must apply the same server-side permission filter.
7. Reject all Duo operations for other admins; absence of permissions is denial by default.

## Important remaining work
- Server-issued auth/session for existing admins; strong password hashing migration.
- Safe server endpoints for Duo membership, plan purchase, and admin permission delegation.
- Reconcile sales records with existing revenue reports without exposing Duo to non-authorized admins.
- End-to-end integration tests on a non-production replica, then deploy.

## Current GitHub status
Development branch only. The production main branch does not contain Duo navigation. All Duo action controls remain disabled until backend access checks work.
