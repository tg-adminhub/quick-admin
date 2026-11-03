-- REVIEW ONLY. DO NOT APPLY TO PRODUCTION OR MERGE UNTIL SECURITY REVIEW.
-- Intended for an isolated Supabase development database after authenticated
-- admin re-enrollment. No user records are inserted by this proposal.
--
-- New SQL must be created as a versioned migration with the Supabase CLI
-- when ready to deploy. This file is a design artifact, not migration history.
BEGIN;

CREATE SCHEMA IF NOT EXISTS qa_private;
REVOKE ALL ON SCHEMA qa_private FROM PUBLIC, anon, authenticated;

CREATE TABLE IF NOT EXISTS qa_private.admin_identities (
  admin_id integer PRIMARY KEY REFERENCES public.admins(id) ON DELETE CASCADE,
  auth_user_id uuid NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT false,
  linked_at timestamptz NOT NULL DEFAULT now(),
  disabled_at timestamptz
);
REVOKE ALL ON qa_private.admin_identities FROM PUBLIC, anon, authenticated;
ALTER TABLE qa_private.admin_identities ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.qa_svc_admin_profile(p_auth_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_id integer;
  v_username text;
  v_name text;
  v_role text;
  v_branch_id integer;
  v_visible integer[];
BEGIN
  -- This function is called only with server-side service_role authorization.
  -- The caller cannot choose a privileged admin id: auth_user_id came from
  -- a fresh server verification of the Supabase Auth user's bearer JWT.
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'restricted' USING ERRCODE = '42501';
  END IF;
  IF p_auth_user_id IS NULL THEN RETURN NULL; END IF;

  SELECT a.id, a.username, a.name, a.role, a.branch_id
    INTO v_id, v_username, v_name, v_role, v_branch_id
  FROM qa_private.admin_identities AS ai
  JOIN public.admins AS a ON a.id = ai.admin_id
  WHERE ai.auth_user_id = p_auth_user_id
    AND ai.enabled IS TRUE
    AND ai.disabled_at IS NULL
  LIMIT 1;

  IF NOT FOUND OR v_role NOT IN ('dev','master','branch','sub') THEN
    RETURN NULL;
  END IF;

  IF v_role = 'dev' THEN
    v_visible := NULL; -- global scope, never inferred from a browser flag
  ELSE
    IF v_branch_id IS NULL THEN RETURN NULL; END IF;
    WITH RECURSIVE descendant AS (
      SELECT b.id, ARRAY[b.id]::integer[] AS visited
      FROM public.branches b WHERE b.id = v_branch_id
      UNION ALL
      SELECT child.id, d.visited || child.id
      FROM public.branches child
      JOIN descendant d ON child.parent_id = d.id
      WHERE cardinality(d.visited) < 25
        AND NOT child.id = ANY(d.visited)
    )
    SELECT COALESCE(array_agg(DISTINCT id), ARRAY[]::integer[])
      INTO v_visible FROM descendant;
    IF cardinality(v_visible) = 0 OR
      NOT v_branch_id = ANY(v_visible) OR
      cardinality(v_visible) > 5000 THEN
      RETURN NULL;
    END IF;
  END IF;

  -- Never return public.admins.password or any other credential/hash.
  RETURN jsonb_build_object(
    'enabled', true,
    'adminId', v_id,
    'username', v_username,
    'displayName', v_name,
    'role', v_role,
    'branchId', v_branch_id,
    'visibleBranchIds', to_jsonb(v_visible)
  );
END
$function$;

-- SECURITY DEFINER defaults to PUBLIC execute unless explicitly revoked.
REVOKE ALL ON FUNCTION public.qa_svc_admin_profile(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.qa_svc_admin_profile(uuid) TO service_role;
COMMIT;

-- Before deployment:
--   1. Review actual grants and RLS findings on an isolated branch.
--   2. Enroll each administrator via Supabase Auth and personally verify
--      the mapping; all rows start enabled=false.
--   3. Set enabled=true only after identity proof / scoped-role review.
--   4. Check function EXECUTE denied to anon/authenticated.
--   5. Test revoke by toggling mapping.enabled=false only in test.
--   6. Keep the legacy portal running until all its direct DB accesses move
--      behind scope-checked server operations and a safe cutover is approved.
