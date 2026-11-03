-- DESIGN REVIEW ONLY. NOT A DEPLOYABLE MIGRATION.
-- NO EXECUTION ON THE QUICKDISPATCH PRODUCTION DATABASE.
-- This draft supports only service_role and verified legacy dev admins.
-- Member approval retains existing 7-day initial license behavior.

CREATE SCHEMA IF NOT EXISTS qa_private;
REVOKE ALL ON SCHEMA qa_private FROM PUBLIC, anon, authenticated;

CREATE TABLE IF NOT EXISTS qa_private.member_review_actions (
  idempotency_key uuid PRIMARY KEY,
  auth_user_id uuid NOT NULL,
  admin_id integer NOT NULL,
  member_id integer NOT NULL,
  action text NOT NULL CHECK (action IN ('member.approve','member.reject')),
  reason text,
  status text NOT NULL CHECK (status IN ('approved','rejected')),
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE qa_private.member_review_actions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON qa_private.member_review_actions FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.qa_svc_member_review(
  p_auth_user_id uuid, p_action text, p_member_id integer,
  p_expected_status text, p_idempotency_key uuid, p_reason text
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $function$
DECLARE
  v_admin_id integer;
  v_role text;
  v_current_status text;
  v_status text;
  v_log_id uuid;
  v_prev qa_private.member_review_actions%ROWTYPE;
  v_result jsonb;
BEGIN
  -- PostgREST request must originate from server-held service_role key.
  IF current_setting('request.jwt.claim.role',true) IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'restricted' USING ERRCODE='42501';
  END IF;

  IF p_auth_user_id IS NULL
     OR p_action NOT IN ('member.approve','member.reject')
     OR p_expected_status IS DISTINCT FROM 'pending'
     OR p_member_id IS NULL OR p_member_id<1
     OR p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'invalid_request' USING ERRCODE='22023';
  END IF;
  IF p_action='member.approve' AND p_reason IS NOT NULL THEN
    RAISE EXCEPTION 'unexpected_reason' USING ERRCODE='22023';
  END IF;
  IF p_action='member.reject' AND
     (p_reason IS NULL OR char_length(btrim(p_reason)) NOT BETWEEN 1 AND 200) THEN
    RAISE EXCEPTION 'reason_required' USING ERRCODE='22023';
  END IF;

  -- Re-read verified admin mapping before each privileged operation.
  SELECT a.id,a.role INTO v_admin_id,v_role
  FROM qa_private.admin_identities AS ai
  JOIN public.admins AS a ON a.id=ai.admin_id
  WHERE ai.auth_user_id=p_auth_user_id
    AND ai.enabled IS TRUE AND ai.disabled_at IS NULL
  LIMIT 1;

  -- No master / branch / sub writes until a reviewed policy is approved.
  IF NOT FOUND OR v_role IS DISTINCT FROM 'dev' THEN
    RAISE EXCEPTION 'review_permission_denied' USING ERRCODE='42501';
  END IF;

  INSERT INTO qa_private.member_review_actions
    (idempotency_key,auth_user_id,admin_id,member_id,action,reason,status,result)
  VALUES
    (p_idempotency_key,p_auth_user_id,v_admin_id,p_member_id,p_action,
     CASE WHEN p_reason IS NULL THEN NULL ELSE btrim(p_reason) END,
     CASE WHEN p_action='member.approve' THEN 'approved' ELSE 'rejected' END,
     '{}'::jsonb)
  ON CONFLICT (idempotency_key) DO NOTHING
  RETURNING idempotency_key INTO v_log_id;

  IF v_log_id IS NULL THEN
    SELECT * INTO v_prev FROM qa_private.member_review_actions
      WHERE idempotency_key=p_idempotency_key FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'idempotency_retry' USING ERRCODE='40001';
    END IF;
    IF v_prev.auth_user_id<>p_auth_user_id
       OR v_prev.member_id<>p_member_id
       OR v_prev.action<>p_action
       OR v_prev.reason IS DISTINCT FROM
          CASE WHEN p_reason IS NULL THEN NULL ELSE btrim(p_reason) END THEN
      RAISE EXCEPTION 'idempotency_conflict' USING ERRCODE='23505';
    END IF;
    RETURN jsonb_build_object('memberId',v_prev.member_id,
      'status',v_prev.status,'outcome','duplicate');
  END IF;

  SELECT u.status INTO v_current_status
  FROM public.users AS u WHERE u.id=p_member_id FOR UPDATE;
  IF NOT FOUND OR v_current_status IS DISTINCT FROM 'pending' THEN
    RAISE EXCEPTION 'member_state_conflict' USING ERRCODE='23514';
  END IF;

  IF p_action='member.approve' THEN
    UPDATE public.users SET
      status='approved', approved_at=now(),
      license_expires_at=now()+interval '7 days',
      is_new=true,is_free_user=false,rejection_reason=NULL
    WHERE id=p_member_id;
    v_status:='approved';
  ELSE
    UPDATE public.users SET
      status='rejected',rejection_reason=btrim(p_reason)
    WHERE id=p_member_id;
    v_status:='rejected';
  END IF;

  v_result:=jsonb_build_object('memberId',p_member_id,
    'status',v_status,'outcome','updated');
  UPDATE qa_private.member_review_actions
    SET result=v_result,status=v_status
  WHERE idempotency_key=p_idempotency_key;
  RETURN v_result;
END;
$function$;

-- SECURITY DEFINER defaults to PUBLIC execute; deny explicitly.
REVOKE ALL ON FUNCTION public.qa_svc_member_review(uuid,text,integer,text,uuid,text)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.qa_svc_member_review(uuid,text,integer,text,uuid,text)
  TO service_role;

-- REVIEW GATES: real JWT is verified by Edge, mapping rechecked by SQL,
-- role dev only, pending-only transition, atomic 7-day license issuance,
-- idempotency concurrency, closed access to anon/authenticated,
-- revoked admin denied, full rollback upon errors.
-- Do not run in Supabase production without isolated verification and
-- explicit operational signoff.
