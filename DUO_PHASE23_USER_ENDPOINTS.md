# Duo verified-user endpoints — Phase 23

Deployed on Supabase quickdispatch. Production QUICK ADMIN (main branch) is unchanged.

## Authenticated RPCs (no anonymous grant)
- `public.duo_submit_signup(p_name text)`: a **previously authenticated Supabase Auth user** submits a Korean full name. A matching account becomes pending; duplicate registration returns the existing state. A pending Duo signup notification is queued by the existing trigger. Does not grant app access.
- `public.duo_submit_dual_request()`: only an approved Duo member may request dual access. Duplicate pending requests reuse the pending request. Notification is queued. Does not grant dual access.
- `public.duo_my_access()`: only returns the caller's own approved/expired/suspended/dual status.
- `GET /functions/v1/duo-access-status`: Edge Function v2; JWT required; calls `duo_my_access`.

## IMPORTANT not yet ready
- The user's desired login form is Korean real name + password. Supabase Auth still needs an identity credential mechanism behind that display. Do not invent fake email aliases or let public users claim names; implement an identity-safe provider or server credential bridge with verified uniqueness/recovery before releasing signup.
- The existing QUICK ADMIN browser SHA256 admin login must not be treated as trusted Duo admin authentication.
- Admin approval/rejection and dual review APIs are **not live**.
- Notifications are queued but not delivered by a trusted Telegram worker.
- No real-member end-to-end testing; no changes to T-oss/Grab tables or production main.
- Existing private data/RLS remains inaccessible to anon.
