-- REVIEW-ONLY DRAFT. NEVER RUN THIS IN PRODUCTION.
-- Requires the qa_private.admin_identities mapping and the reviewed
-- public.qa_svc_admin_profile(uuid) described in SQL_REVIEW_ONLY.sql.
-- Service-role-only endpoint: do not grant execution to anon/authenticated.
-- Convert to a versioned Supabase CLI migration ONLY on a test project.

CREATE OR REPLACE FUNCTION public.qa_svc_admin_read(
  p_auth_user_id uuid,
  p_resource text,
  p_limit integer DEFAULT 25,
  p_offset integer DEFAULT 0
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_profile jsonb;
  v_role text;
  v_scope integer[];
  v_items jsonb;
BEGIN
  -- Defense in depth: requests from browser keys cannot invoke this RPC.
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'restricted' USING ERRCODE = '42501';
  END IF;
  IF p_auth_user_id IS NULL OR p_resource NOT IN ('members','payments','branches')
     OR p_limit IS NULL OR p_limit < 1 OR p_limit > 100
     OR p_offset IS NULL OR p_offset < 0 OR p_offset > 10000 THEN
    RAISE EXCEPTION 'invalid_query' USING ERRCODE = '22023';
  END IF;

  -- Recompute the administrator, role, and descendants from the DB for
  -- EVERY request. Do not accept adminId, role or branch_ids from the browser.
  SELECT public.qa_svc_admin_profile(p_auth_user_id)
    INTO v_profile;
  IF v_profile IS NULL THEN
    RAISE EXCEPTION 'admin_access_denied' USING ERRCODE = '42501';
  END IF;
  v_role := v_profile->>'role';
  IF v_role NOT IN ('dev','master','branch','sub') THEN
    RAISE EXCEPTION 'admin_role_denied' USING ERRCODE = '42501';
  END IF;
  IF v_role = 'dev' THEN
    v_scope := NULL;
  ELSE
    IF jsonb_typeof(v_profile->'visibleBranchIds') <> 'array' THEN
      RAISE EXCEPTION 'scope_unavailable' USING ERRCODE = '42501';
    END IF;
    SELECT array_agg((value)::integer) INTO v_scope
    FROM jsonb_array_elements_text(v_profile->'visibleBranchIds') AS e(value);
    IF v_scope IS NULL OR cardinality(v_scope)=0 THEN
      RAISE EXCEPTION 'scope_empty' USING ERRCODE = '42501';
    END IF;
  END IF;

  IF p_resource = 'members' THEN
    SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY t.id DESC),'[]'::jsonb)
      INTO v_items
    FROM (
      SELECT u.id, u.username, u.real_name, u.status, u.branch_id,
             u.app_type, u.license_expires_at
      FROM public.users AS u
      WHERE v_role='dev' OR u.branch_id = ANY(v_scope)
      ORDER BY u.id DESC
      LIMIT p_limit OFFSET p_offset
    ) t;

  ELSIF p_resource = 'payments' THEN
    SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY t.id DESC),'[]'::jsonb)
      INTO v_items
    FROM (
      SELECT p.id, p.user_id, p.amount, p.status, p.created_at, u.branch_id
      FROM public.payment_requests AS p
      JOIN public.users AS u ON u.id = p.user_id
      WHERE v_role='dev' OR u.branch_id = ANY(v_scope)
      ORDER BY p.id DESC
      LIMIT p_limit OFFSET p_offset
    ) t;

  ELSIF p_resource = 'branches' THEN
    SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY t.id),'[]'::jsonb)
      INTO v_items
    FROM (
      SELECT b.id, b.name, b.parent_id, b.type
      FROM public.branches AS b
      WHERE v_role='dev' OR b.id = ANY(v_scope)
      ORDER BY b.id
      LIMIT p_limit OFFSET p_offset
    ) t;
  END IF;

  -- The Edge read-core also validates scope and projects only safe fields.
  RETURN COALESCE(v_items,'[]'::jsonb);
END
$function$;

REVOKE ALL ON FUNCTION public.qa_svc_admin_read(uuid,text,integer,integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.qa_svc_admin_read(uuid,text,integer,integer)
  TO service_role;

-- Mandatory test-environment verification before any production migration:
-- * anonymous/authenticated roles cannot invoke qa_svc_admin_read.
-- * branch and sub admins cannot read other branches' members or payments.
-- * dev has global scope only when server-verified and admin mapping enabled.
-- * suspended admin mapping fails closed on the next call.
-- * users.password, users.resident_num, user_devices.android_id, phone,
--   payment_requests.admin_note are never present in response.
-- * pagination bounds, idempotence and non-public schema permissions.
