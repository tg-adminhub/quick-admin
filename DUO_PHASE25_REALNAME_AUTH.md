# Duo Phase 25 — Real-name login integration, security gate

## Fixed product contract
- The ONLY visible login ID is the driver's **Korean legal name**; password is the second field.
- It is not acceptable to log into the first account returned from a same-name lookup. Duplicate names must be resolvable through each person's password-derived verified identity, with safe account recovery.
- Direct signup does not grant app access; the member is `pending` until admin approval AND the license is valid.
- Admin-created member is approved but must still have a valid license to run.
- Dual entitlement is separately approved and can be revoked independently.
- Name saving stores ONLY the name locally, never the password.

## Existing deployed components
- `duo_private.members` associates Korean name with a unique `auth_user_id` and tracks status/tier/license.
- Authenticated self-service functions: `duo_submit_signup`, `duo_submit_dual_request`, `duo_my_access`.
- `duo-access-status` edge function requires verified Supabase JWT.
- `duo_private` is not available to public/anon REST clients.

## Gate before user-facing real-name/password login
1. Dedicated trusted authentication service issues credentials linked to an internal unique account UUID; no client-created fake-email credential shortcuts.
2. Verify passwords using a dedicated identity provider or memory-hard hashing with rate limiting, throttling, recovery and audit logging.
3. Avoid storing any password or login secret in app preferences, private Duo member rows, or GitHub static page.
4. Pending or suspended members must not obtain order processing or authenticated Duo member features even if their credentials are valid.
5. Bind every admin action to an authenticated server-side admin ID; never trust a browser-supplied admin ID.
6. Test distinct accounts with the same Korean name and different passwords; fail closed on ambiguity.
7. Existing T-oss/Grab schema and operational MAIN branch remain unchanged.

## Progress
This phase freezes the identity/security contract, not a live login product. Do not advertise real-name login as functional until the trusted authentication provider, recovery, anti-bruteforce and verified app session flows pass tests.
