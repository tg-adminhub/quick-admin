-- REVIEW ONLY. DO NOT APPLY TO PRODUCTION SUPABASE.
-- Development draft for QA organization/admin/configuration safe changes.
-- Only dev admins with server-verified Supabase Auth mapping.
-- No password, role, branch hierarchy, secret, delete or account-creation APIs.
CREATE SCHEMA IF NOT EXISTS qa_private;
REVOKE ALL ON SCHEMA qa_private FROM PUBLIC,anon,authenticated;

CREATE TABLE IF NOT EXISTS qa_private.config_actions(
  idempotency_key uuid PRIMARY KEY,
  auth_user_id uuid NOT NULL,
  admin_id integer NOT NULL,
  action text NOT NULL CHECK(action IN ('branch.rename','admin.rename','setting.toggle')),
  target_id integer,
  setting_key text,
  expected_value text NOT NULL,
  new_value text NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE qa_private.config_actions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON qa_private.config_actions FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION public.qa_svc_admin_config(
  p_auth_user_id uuid,p_action text,p_branch_id integer,p_admin_id integer,
  p_setting_key text,p_expected text,p_new text,p_idempotency_key uuid
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=''
AS $function$
DECLARE
  v_actor_id integer;
  v_role text;
  v_target_id integer;
  v_current text;
  v_inserted uuid;
  v_prior qa_private.config_actions%ROWTYPE;
  v_result jsonb;
  v_target jsonb;
BEGIN
  -- Service role only. The Edge must freshly verify the actual Auth JWT
  -- and pass the verified user ID, not any browser-provided account ID.
  IF current_setting('request.jwt.claim.role',true) IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'restricted' USING ERRCODE='42501';
  END IF;
  IF p_auth_user_id IS NULL OR p_idempotency_key IS NULL
     OR p_action NOT IN ('branch.rename','admin.rename','setting.toggle') THEN
    RAISE EXCEPTION 'invalid_config_request' USING ERRCODE='22023';
  END IF;
  IF p_expected IS NULL OR p_new IS NULL OR p_expected=p_new THEN
    RAISE EXCEPTION 'invalid_value_change' USING ERRCODE='22023';
  END IF;

  IF p_action='branch.rename' THEN
    IF p_branch_id IS NULL OR p_branch_id<1 OR p_admin_id IS NOT NULL
       OR p_setting_key IS NOT NULL THEN
      RAISE EXCEPTION 'invalid_branch_target' USING ERRCODE='22023';
    END IF;
    v_target_id:=p_branch_id;
  ELSIF p_action='admin.rename' THEN
    IF p_admin_id IS NULL OR p_admin_id<1 OR p_branch_id IS NOT NULL
       OR p_setting_key IS NOT NULL THEN
      RAISE EXCEPTION 'invalid_admin_target' USING ERRCODE='22023';
    END IF;
    v_target_id:=p_admin_id;
  ELSE
    IF p_branch_id IS NOT NULL OR p_admin_id IS NOT NULL
       OR p_setting_key NOT IN ('payment_visible','maintenance_mode') THEN
      RAISE EXCEPTION 'invalid_setting_target' USING ERRCODE='22023';
    END IF;
    IF p_expected NOT IN ('true','false') OR p_new NOT IN ('true','false') THEN
      RAISE EXCEPTION 'invalid_setting_value' USING ERRCODE='22023';
    END IF;
    v_target_id:=NULL;
  END IF;

  IF p_action<>'setting.toggle' THEN
    IF char_length(p_expected) NOT BETWEEN 1 AND 80
       OR char_length(p_new) NOT BETWEEN 1 AND 80
       OR btrim(p_expected)<>p_expected OR btrim(p_new)<>p_new
       OR p_expected ~ '[<>&"[:cntrl:]]'
       OR p_new ~ '[<>&"[:cntrl:]]' THEN
      RAISE EXCEPTION 'invalid_display_name' USING ERRCODE='22023';
    END IF;
  END IF;

  SELECT a.id,a.role INTO v_actor_id,v_role
  FROM qa_private.admin_identities ai JOIN public.admins a ON a.id=ai.admin_id
  WHERE ai.auth_user_id=p_auth_user_id AND ai.enabled IS TRUE AND ai.disabled_at IS NULL
  LIMIT 1;
  IF NOT FOUND OR v_role IS DISTINCT FROM 'dev' THEN
    RAISE EXCEPTION 'admin_config_permission_denied' USING ERRCODE='42501';
  END IF;

  -- Idempotency row + target mutation share one DB transaction.
  INSERT INTO qa_private.config_actions
    (idempotency_key,auth_user_id,admin_id,action,target_id,setting_key,
     expected_value,new_value,result)
  VALUES
    (p_idempotency_key,p_auth_user_id,v_actor_id,p_action,v_target_id,
     p_setting_key,p_expected,p_new,'{}'::jsonb)
  ON CONFLICT (idempotency_key) DO NOTHING
  RETURNING idempotency_key INTO v_inserted;

  IF v_inserted IS NULL THEN
    SELECT * INTO v_prior FROM qa_private.config_actions
      WHERE idempotency_key=p_idempotency_key FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'idempotency_retry' USING ERRCODE='40001';
    END IF;
    IF v_prior.auth_user_id<>p_auth_user_id OR v_prior.action<>p_action
       OR v_prior.target_id IS DISTINCT FROM v_target_id
       OR v_prior.setting_key IS DISTINCT FROM p_setting_key
       OR v_prior.expected_value<>p_expected OR v_prior.new_value<>p_new THEN
      RAISE EXCEPTION 'idempotency_conflict' USING ERRCODE='23505';
    END IF;
    RETURN jsonb_build_object('action',v_prior.action,
      'target',CASE WHEN v_prior.setting_key IS NOT NULL
        THEN to_jsonb(v_prior.setting_key) ELSE to_jsonb(v_prior.target_id) END,
      'outcome','duplicate');
  END IF;

  IF p_action='branch.rename' THEN
    SELECT b.name INTO v_current FROM public.branches b WHERE b.id=p_branch_id FOR UPDATE;
    IF NOT FOUND OR v_current IS DISTINCT FROM p_expected THEN
      RAISE EXCEPTION 'branch_changed_or_missing' USING ERRCODE='23514';
    END IF;
    UPDATE public.branches SET name=p_new,updated_at=now() WHERE id=p_branch_id;
  ELSIF p_action='admin.rename' THEN
    SELECT a.name INTO v_current FROM public.admins a WHERE a.id=p_admin_id FOR UPDATE;
    IF NOT FOUND OR v_current IS DISTINCT FROM p_expected THEN
      RAISE EXCEPTION 'admin_changed_or_missing' USING ERRCODE='23514';
    END IF;
    -- No mutation to legacy SHA-256 password, role, branch_id, Auth UUID.
    UPDATE public.admins SET name=p_new,updated_at=now() WHERE id=p_admin_id;
  ELSE
    SELECT s.value INTO v_current FROM public.app_settings s
      WHERE s.key=p_setting_key FOR UPDATE;
    IF NOT FOUND OR v_current IS DISTINCT FROM p_expected THEN
      RAISE EXCEPTION 'setting_changed_or_missing' USING ERRCODE='23514';
    END IF;
    UPDATE public.app_settings SET value=p_new,updated_at=now()
      WHERE key=p_setting_key;
  END IF;

  v_target:=CASE WHEN p_setting_key IS NOT NULL
    THEN to_jsonb(p_setting_key) ELSE to_jsonb(v_target_id) END;
  v_result:=jsonb_build_object('action',p_action,'target',v_target,'outcome','updated');
  UPDATE qa_private.config_actions SET result=v_result
    WHERE idempotency_key=p_idempotency_key;
  RETURN v_result;
END
$function$;

-- SECURITY DEFINER is PUBLIC executable by default. Explicitly revoke.
REVOKE ALL ON FUNCTION public.qa_svc_admin_config(
  uuid,text,integer,integer,text,text,text,uuid)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.qa_svc_admin_config(
  uuid,text,integer,integer,text,text,text,uuid) TO service_role;

-- Dev review requirements:
-- * inspect invoker GRANT and Edge session validation with a real Supabase Auth session
-- * do not put a service_role key in the GitHub Pages browser or Android APK
-- * verify distinct idempotency key per independent user action
-- * in-transaction compare-and-swap prevents stale admin/branch display changes
-- * do not allow editing role, password, auth identity, parent_id, secret keys
-- * no production deployment until legacy browser direct access is removed
