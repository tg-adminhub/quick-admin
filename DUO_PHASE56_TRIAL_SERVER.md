# Duo secure trial grants — v56

Applied Supabase migrations `duo_admin_trial_grant_secure_v56` and `duo_admin_trial_grant_audit_fix_v56`.

RPC: `public.duo_admin_grant_trial(p_member_id bigint,p_days integer)`.

- Requires a verified Supabase Auth identity bound to `duo_private.admin_permissions.verified_auth_user_id`, plus view and sell grants.
- Accepts 1 to 60 days for approved members only.
- Extends from the later of existing expiry or now, with row locking; writes `duo_private.audit_events` entry for tracking.
- `anon` EXECUTE denied, `authenticated` EXECUTE granted but permission checked server side.
- **No administrators are yet linked to verified authentication identities; QUICK ADMIN buttons must remain locked.**
- Does not implement InSung protocol, create native sessions or validate actual order catching.
- The API has not yet been exercised using an authenticated admin session or tested end-to-end from Android.
