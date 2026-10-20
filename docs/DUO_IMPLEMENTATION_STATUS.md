# DUO Admin implementation status (2026-10-20)

## Done on Supabase project pvdhdnvbgytfaydyyuat
- Additive private tables with RLS ON / anon + authenticated access revoked:
  - duo_private.service_plans
  - duo_private.admin_service_grants
- Draft plan values, disabled by default:
  - duo_normal = 60,000 KRW / 40 days
  - duo_dual = 90,000 KRW / 45 days
- No admin grants assigned, no existing user or admin records modified.

## NOT DEPLOYED to live QUICK ADMIN
- DUO sidebar/tab / admin authorization middleware
- Login/signup and admin approval flows
- T-oss/Grab price-setting changes
- Scoped revenue RPC and organization hierarchy checks
- Password reset workflow

## Security blockers
Existing public.admins/users tables contain a password column, and several public tables have RLS disabled. Existing QUICK ADMIN uses a browser-side admin query. Do not add new privileged controls to this trust boundary. Replace with authenticated server-side membership, service grants and branch-descendant constraints, then regression test all services before releasing UI.
