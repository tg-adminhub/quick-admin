# Duo access status API

Deployed Supabase Edge Function: `duo-access-status` (JWT required).

`GET /functions/v1/duo-access-status` with a Supabase Auth bearer token validates the identity and looks up the private Duo member record. Results include `app_access`, `dual_access`, `reason`, `license_expires_at`. The function never returns other members.

States: self signup = pending; admin approval plus active license = standard access; separately approved dual tier = dual access. Suspended or expired users cannot enter Duo.

This is **not** a signup endpoint, admin session endpoint, a substitute for the Insung server's session requirements, or proof of dual order catching. Existing admin frontend uses a separate legacy password scheme; do not send its client-side login state as authentication to this endpoint.

Remaining gates before production: secure member signup and credential recovery; trusted server-side admin login; server-side approval, dual review and sales endpoints; notification delivery worker; developer-only permissions; end-to-end tests. Keep all sensitive Duo operations inaccessible from static GitHub Pages until these are ready.
