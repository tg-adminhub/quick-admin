-- REVIEW ONLY — NOT A DEPLOYABLE MIGRATION.
-- DO NOT RUN ON PRODUCTION SUPABASE.
-- Normal payment approvals extend a member license atomically in the DB.
-- Special device-add payments are *explicitly refused* for approval until
-- their separate device allocation policy is reviewed.
-- Only server-verified, actively mapped 'dev' admin may mutate payments.

CREATE SCHEMA IF NOT EXISTS qa_private;
REVOKE ALL ON SCHEMA qa_private FROM PUBLIC,anon,authenticated;

CREATE TABLE IF NOT EXISTS qa_private.payment_review_actions (
  idempotency_key uuid PRIMARY KEY,
  auth_user_id uuid NOT NULL,
  admin_id integer NOT NULL,
  payment_id integer NOT NULL,
  action text NOT NULL CHECK(action IN ('payment.approve','payment.reject')),
  approved_amount integer,
  reason text,
  status text NOT NULL CHECK(status IN ('approved','rejected')),
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE qa_private.payment_review_actions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON qa_private.payment_review_actions FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION public.qa_svc_payment_review(
  p_auth_user_id uuid,
  p_action text,
  p_payment_id integer,
  p_expected_status text,
  p_idempotency_key uuid,
  p_approved_amount integer,
  p_reason text
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=''
AS $function$
DECLARE
  v_admin_id integer;
  v_role text;
  v_payment public.payment_requests%ROWTYPE;
  v_user public.users%ROWTYPE;
  v_inserted uuid;
  v_previous qa_private.payment_review_actions%ROWTYPE;
  v_status text;
  v_result jsonb;
  v_days integer;
BEGIN
  IF current_setting('request.jwt.claim.role',true) IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'restricted' USING ERRCODE='42501';
  END IF;
  IF p_auth_user_id IS NULL OR p_payment_id IS NULL OR p_payment_id<1
     OR p_idempotency_key IS NULL OR p_expected_status IS DISTINCT FROM 'pending'
     OR p_action NOT IN ('payment.approve','payment.reject') THEN
    RAISE EXCEPTION 'invalid_payment_review' USING ERRCODE='22023';
  END IF;
  IF p_action='payment.approve' AND
     (p_reason IS NOT NULL OR p_approved_amount IS NULL
      OR p_approved_amount<1 OR p_approved_amount>10000000) THEN
    RAISE EXCEPTION 'invalid_approved_amount' USING ERRCODE='22023';
  END IF;
  IF p_action='payment.reject' AND
     (p_approved_amount IS NOT NULL OR p_reason IS NULL
      OR char_length(btrim(p_reason)) NOT BETWEEN 1 AND 200) THEN
    RAISE EXCEPTION 'invalid_rejection_reason' USING ERRCODE='22023';
  END IF;

  SELECT a.id,a.role INTO v_admin_id,v_role
  FROM qa_private.admin_identities ai JOIN public.admins a ON a.id=ai.admin_id
  WHERE ai.auth_user_id=p_auth_user_id AND ai.enabled IS TRUE
    AND ai.disabled_at IS NULL LIMIT 1;
  IF NOT FOUND OR v_role IS DISTINCT FROM 'dev' THEN
    RAISE EXCEPTION 'payment_permission_denied' USING ERRCODE='42501';
  END IF;

  INSERT INTO qa_private.payment_review_actions
    (idempotency_key,auth_user_id,admin_id,payment_id,action,approved_amount,reason,status,result)
  VALUES
    (p_idempotency_key,p_auth_user_id,v_admin_id,p_payment_id,p_action,p_approved_amount,
     NULLIF(btrim(p_reason),''),
     CASE WHEN p_action='payment.approve' THEN 'approved' ELSE 'rejected' END,
     '{}'::jsonb)
  ON CONFLICT (idempotency_key) DO NOTHING
  RETURNING idempotency_key INTO v_inserted;

  IF v_inserted IS NULL THEN
    SELECT * INTO v_previous FROM qa_private.payment_review_actions
    WHERE idempotency_key=p_idempotency_key FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'idempotency_retry' USING ERRCODE='40001';
    END IF;
    IF v_previous.auth_user_id<>p_auth_user_id
       OR v_previous.payment_id<>p_payment_id
       OR v_previous.action<>p_action
       OR v_previous.approved_amount IS DISTINCT FROM p_approved_amount
       OR v_previous.reason IS DISTINCT FROM NULLIF(btrim(p_reason),'') THEN
      RAISE EXCEPTION 'idempotency_conflict' USING ERRCODE='23505';
    END IF;
    RETURN jsonb_build_object('paymentId',v_previous.payment_id,
      'status',v_previous.status,'outcome','duplicate');
  END IF;

  SELECT * INTO v_payment FROM public.payment_requests
  WHERE id=p_payment_id FOR UPDATE;
  IF NOT FOUND OR v_payment.status IS DISTINCT FROM 'pending' THEN
    RAISE EXCEPTION 'payment_not_pending' USING ERRCODE='23514';
  END IF;

  IF p_action='payment.approve' THEN
    -- Existing frontend treats the [device-add] note as a distinct workflow.
    -- It must not accidentally extend a license or allocate an unverified device.
    IF left(coalesce(v_payment.note,''),length('[기기추가]|'))='[기기추가]|' THEN
      RAISE EXCEPTION 'device_add_requires_separate_review' USING ERRCODE='23514';
    END IF;
    SELECT * INTO v_user FROM public.users
    WHERE id=v_payment.user_id FOR UPDATE;
    IF NOT FOUND OR v_user.status IS DISTINCT FROM 'approved'
       OR v_user.paused IS DISTINCT FROM false THEN
      RAISE EXCEPTION 'member_not_eligible' USING ERRCODE='23514';
    END IF;
    -- Never trust the browser's isNewApproval flag: derive from locked DB row.
    v_days:=CASE WHEN v_user.is_new IS TRUE THEN 50 ELSE 40 END;
    UPDATE public.users SET
      license_expires_at=GREATEST(COALESCE(v_user.license_expires_at,now()),now())
        +make_interval(days=>v_days),
      is_free_user=false,
      is_new=false
    WHERE id=v_payment.user_id;
    UPDATE public.payment_requests SET
      status='approved',
      approved_amount=p_approved_amount,
      processed_at=now()
    WHERE id=p_payment_id;
    v_status:='approved';
  ELSE
    UPDATE public.payment_requests SET
      status='rejected',
      admin_note=btrim(p_reason),
      processed_at=now()
    WHERE id=p_payment_id;
    v_status:='rejected';
  END IF;

  v_result:=jsonb_build_object('paymentId',p_payment_id,
    'status',v_status,'outcome','updated');
  UPDATE qa_private.payment_review_actions SET result=v_result,status=v_status
  WHERE idempotency_key=p_idempotency_key;
  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.qa_svc_payment_review(uuid,text,integer,text,uuid,integer,text)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.qa_svc_payment_review(uuid,text,integer,text,uuid,integer,text)
  TO service_role;

-- REVIEW GATES:
-- * verified Auth UUID, active private mapping, and dev-only role rechecked.
-- * pending-only payment transitions, locked member, 40/50-day renewal.
-- * device-add payment intentionally denied until separate device flow.
-- * true transactional atomicity: payment+license+audit all succeed or rollback.
-- * idempotency key replay identical=duplicate; changed params=conflict.
-- * no public/anon/authenticated EXECUTE privilege.
-- * no direct client-side table mutation in the final release.
-- * payment notifications require a separate idempotent outbox after review.
