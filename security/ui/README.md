# QUICK ADMIN protected browser integration — V2.16 draft

**Development branch only. Do not merge or deploy.** This directory contains a standalone, synthetic-only preview and a reusable API client. The original QUICK ADMIN index.html and existing production login are intentionally unchanged by this stage.

## Files

- `secure-admin-client.mjs` is the browser-facing adapter for the future Edge endpoints. It accepts an access-token provider, uses only fixed approved URLs, validates bounded pagination and action payloads, strips unexpected sensitive fields, uses an idempotency key for every mutation, and never takes a browser admin ID or role as authorization.
- `secure-admin-client.test.mjs` verifies request shape, JWT-only requests, failure behavior, safe field projection, retries, and disallowing extra admin/role fields.
- `synthetic-transport.mjs` is an in-memory fake Edge server. It never invokes global fetch and never accesses Supabase or member data.
- `secure-pilot.html` plus `secure-pilot.mjs` are a Korean-language **demo-only** admin panel using fake members #101/#102 and fake payment #201. There is no real login or database connection.
- `secure-pilot.test.mjs` tests fake member approval, pause/resume, payment review, idempotency and preview isolation.

## How to view the offline pilot locally

From a trusted local clone of this development branch, start a static local file server (for example `python3 -m http.server 8000`) and open `http://localhost:8000/security/ui/secure-pilot.html` in a browser that supports WebCrypto. Nothing is sent to the production Supabase project, even though the mocked client uses a real-looking project URL for request-shape tests. There is NO valid operator session and NO actual account administration capability. The preview is not automatically published by GitHub Pages.

## Exact contract with existing QUICK ADMIN

| Existing screen operation | Prototype API client | Migration gap |
|---|---|---|
| `doLogin`, `tryAutoLogin` | `createSupabaseAuthAdapter` and `getIdentity()` | Existing username/SHA-256 login cannot be reused; re-enroll the 12 administrators with new Supabase Auth credentials. Original login still operates and is insecure. |
| `loadAllData` member list | `getList('members')` | New endpoint returns a deliberately minimal field subset; legacy member cards expect phone, device, memo and many other fields. Full page replacement is **not** ready. |
| `loadAllData` payment list | `getList('payments')` | New endpoint omits depositor note, member phone and extra processor fields. Update UI and design protected detail endpoint if justified. |
| `loadAllData` branch list | `getList('branches')` | New endpoint intentionally omits branch manager PII; legacy organization view expects more fields. |
| `approveM`, `rejectM` | `prepare('approveMember'/'rejectMember')`, `submit()` | Prototype is dev-only; verify original role policy and all necessary UI side effects before switching. |
| `togglePause` | `pauseMember` / `resumeMember` | Must verify legacy real-time login blocking logic; no production connection exists. |
| `resetDeviceBind` | `resetMainDevice` / `resetExtraDevice` | Must verify device ownership, binding semantics and member/device detail UX. |
| `doApproveP`, `rejectP` | `approvePayment` / `rejectPayment` | Ordinary payment only; device-add approval is intentionally blocked; post-commit Telegram notification/outbox is pending. |
| Account management, licenses, organizations, announcements, settings | Not yet migrated | No secure server API or equivalent UI implementation for full parity. |

## Security gates

1. Current PR #2 remains draft; no production merge.
2. The preview always uses `synthetic-transport.mjs`; never replace it with a live Supabase client without a separate audited deployment and feature gate.
3. No service_role key or unreviewed credential inside browser JavaScript.
4. Before any actual user login: re-enrollment into Supabase Auth, private admin mapping, proper Edge deployment, closed anon grants and reviewed RLS.
5. Role scope and record-level permission must be revalidated server-side for every operation; UI role display is never authorization.
6. Existing screens' complete feature parity and rollback must be tested before disabling their current direct database calls.

Run `node --test security/ui/secure-admin-client.test.mjs security/ui/secure-pilot.test.mjs` locally or use the existing GitHub Actions security regression workflow. These are mocked frontend tests, **not** live Supabase authorization tests.