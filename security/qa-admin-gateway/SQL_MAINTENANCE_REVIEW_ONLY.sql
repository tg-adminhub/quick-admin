-- REVIEW ONLY. DO NOT APPLY TO QUICKDISPATCH PRODUCTION.
-- Designed for an isolated PostgreSQL smoke test using synthetic rows.
-- Requires qa_private.admin_identities (review SQL in SQL_REVIEW_ONLY.sql).
--
-- Conservative operations:
--   member.pause          : approved, not-paused -> paused (preserve remaining days)
--   member.resume         : approved, paused -> unpaused (reissue stored remaining days)
--   device.reset_main     : approved member with main_android_id -> null
--   device.reset_extra    : approved member owns extra device with android_id -> null
-- Only dev admin is allowed until a reviewed scoped-write policy exists.

CREATE SCHEMA IF NOT EXISTS qa_private;
REVOKE ALL ON SCHEMA qa_private FROM PUBLIC, anon, authenticated;

CREATE TABLE IF NOT EXISTS qa_private.maintenance_actions (
  idempotency_key uuid PRIMARY KEY,
  auth_user_id uuid NOT NULL,
  admin_id integer NOT NULL,
  member_id integer NOT NULL,
  device_id integer,
  action text NOT NULL CHECK(action IN
    ('member.pause','member.resume','device.reset_main','device.reset_extra')),
  expected_state text NOT NULL CHECK(expected_state IN ('active','paused','bound')),
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE qa_private.maintenance_actions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON qa_private.maintenance_actions FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.qa_svc_member_maintenance(
  p_auth_user_id uuid,
  p_action text,
  p_member_id integer,
  p_device_id integer,
  p_expected_state text,
  p_idempotency_key uuid
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=''
AS $function$
DECLARE
  v_admin_id integer;
  v_role text;
  v_member public.users%ROWTYPE;
  v_device public.user_devices%ROWTYPE;
  v_inserted uuid;
  v_previous qa_private.maintenance_actions%ROWTYPE;
  v_remaining integer;
  v_result jsonb;
BEGIN
  IF current_setting('request.jwt.claim.role',true) IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'restricted' USING ERRCODE='42501';
  END IF;
  IF p_auth_user_id IS NULL OR p_member_id IS NULL OR p_member_id<1
     OR p_idempotency_key IS NULL OR p_action NOT IN
     ('member.pause','member.resume','device.reset_main','device.reset_extra') THEN
    RAISE EXCEPTION 'invalid_request' USING ERRCODE='22023';
  END IF;
  IF (p_action='member.pause' AND p_expected_state IS DISTINCT FROM 'active')
     OR (p_action='member.resume' AND p_expected_state IS DISTINCT FROM 'paused')
     OR (p_action IN ('device.reset_main','device.reset_extra')
         AND p_expected_state IS DISTINCT FROM 'bound') THEN
    RAISE EXCEPTION 'invalid_expected_state' USING ERRCODE='22023';
  END IF;
  IF (p_action='device.reset_extra' AND (p_device_id IS NULL OR p_device_id<1))
     OR (p_action<>'device.reset_extra' AND p_device_id IS NOT NULL) THEN
    RAISE EXCEPTION 'invalid_device_id' USING ERRCODE='22023';
  END IF;

  SELECT a.id,a.role INTO v_admin_id,v_role
  FROM qa_private.admin_identities ai JOIN public.admins a ON a.id=ai.admin_id
  WHERE ai.auth_user_id=p_auth_user_id AND ai.enabled IS TRUE
    AND ai.disabled_at IS NULL LIMIT 1;
  IF NOT FOUND OR v_role IS DISTINCT FROM 'dev' THEN
    RAISE EXCEPTION 'maintenance_permission_denied' USING ERRCODE='42501';
  END IF;

  INSERT INTO qa_private.maintenance_actions
    (idempotency_key,auth_user_id,admin_id,member_id,device_id,action,expected_state,result)
  VALUES
    (p_idempotency_key,p_auth_user_id,v_admin_id,p_member_id,p_device_id,p_action,p_expected_state,'{}'::jsonb)
  ON CONFLICT (idempotency_key) DO NOTHING
  RETURNING idempotency_key INTO v_inserted;

  IF v_inserted IS NULL THEN
    SELECT * INTO v_previous FROM qa_private.maintenance_actions
    WHERE idempotency_key=p_idempotency_key FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'idempotency_retry' USING ERRCODE='40001';
    END IF;
    IF v_previous.auth_user_id<>p_auth_user_id
       OR v_previous.member_id<>p_member_id
       OR v_previous.action<>p_action
       OR v_previous.device_id IS DISTINCT FROM p_device_id
       OR v_previous.expected_state<>p_expected_state THEN
      RAISE EXCEPTION 'idempotency_conflict' USING ERRCODE='23505';
    END IF;
    RETURN jsonb_build_object('memberId',v_previous.member_id,
      'action',v_previous.action,'outcome','duplicate');
  END IF;

  SELECT * INTO v_member FROM public.users WHERE id=p_member_id FOR UPDATE;
  IF NOT FOUND OR v_member.status IS DISTINCT FROM 'approved' THEN
    RAISE EXCEPTION 'member_not_approved' USING ERRCODE='23514';
  END IF;

  IF p_action='member.pause' THEN
    IF v_member.paused IS DISTINCT FROM false THEN
      RAISE EXCEPTION 'member_not_active' USING ERRCODE='23514';
    END IF;
    v_remaining:=GREATEST(0,CEIL(EXTRACT(EPOCH FROM
      (COALESCE(v_member.license_expires_at,now())-now()))/86400)::integer);
    IF v_remaining>3650 THEN
      RAISE EXCEPTION 'remaining_days_out_of_bounds' USING ERRCODE='23514';
    END IF;
    -- Compatibility with existing QUICK ADMIN pause format; member is also
    -- marked paused and cannot be considered active by an auth validator.
    UPDATE public.users SET paused=true,paused_remaining_days=v_remaining,
      paused_at=now(),license_expires_at=now()+interval '10 years'
    WHERE id=p_member_id;

  ELSIF p_action='member.resume' THEN
    IF v_member.paused IS DISTINCT FROM true
       OR v_member.paused_remaining_days IS NULL
       OR v_member.paused_remaining_days<0
       OR v_member.paused_remaining_days>3650 THEN
      RAISE EXCEPTION 'member_not_paused' USING ERRCODE='23514';
    END IF;
    UPDATE public.users SET paused=false,paused_remaining_days=0,
      paused_at=NULL,
      license_expires_at=now()+make_interval(days=>v_member.paused_remaining_days)
    WHERE id=p_member_id;

  ELSIF p_action='device.reset_main' THEN
    IF v_member.main_android_id IS NULL THEN
      RAISE EXCEPTION 'main_device_not_bound' USING ERRCODE='23514';
    END IF;
    UPDATE public.users SET main_android_id=NULL WHERE id=p_member_id;

  ELSE
    SELECT * INTO v_device FROM public.user_devices
    WHERE id=p_device_id AND user_id=p_member_id FOR UPDATE;
    IF NOT FOUND OR v_device.android_id IS NULL THEN
      RAISE EXCEPTION 'device_not_owned_or_unbound' USING ERRCODE='23514';
    END IF;
    UPDATE public.user_devices SET android_id=NULL WHERE id=p_device_id AND user_id=p_member_id;
  END IF;

  v_result:=jsonb_build_object('memberId',p_member_id,'action',p_action,'outcome','updated');
  UPDATE qa_private.maintenance_actions SET result=v_result
  WHERE idempotency_key=p_idempotency_key;
  RETURN v_result;
END;
$function$;

-- SECURITY DEFINER defaults to PUBLIC execute unless revoked explicitly.
REVOKE ALL ON FUNCTION public.qa_svc_member_maintenance(uuid,text,integer,integer,text,uuid)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.qa_svc_member_maintenance(uuid,text,integer,integer,text,uuid)
  TO service_role;

-- REQUIRED deployment gates:
-- * Independently inspect SQL scope and audit design.
-- * Verify server-side Supabase Auth and private admin identity mapping.
-- * Test non-dev denial, wrong owner device denial, mid-session revocation,
--   idempotency concurrency, pause/resume date semantics and password secrecy.
-- * Keep member status, paused, and license expiry aligned with actual
--   auth validation; never rely solely on a 10-year expiry.
-- * No production execution without explicit safe rollout approval.
