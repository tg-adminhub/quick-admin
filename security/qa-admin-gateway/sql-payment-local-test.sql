-- Disposable PostgreSQL 17 synthetic payment tests.
-- This script is sourced after sql-local-test.sql + sql-maintenance-local-test.sql.
-- NEVER RUN ON A PRODUCTION DATABASE.
\set ON_ERROR_STOP on

CREATE TABLE public.payment_requests(
  id integer PRIMARY KEY,
  user_id integer REFERENCES public.users(id),
  amount numeric,
  status text,
  note text,
  approved_amount numeric,
  processed_at timestamptz,
  admin_note text
);

INSERT INTO public.users(id,status,license_expires_at,is_new,is_free_user,paused)
VALUES
  (51,'approved',now()+interval '10 days',false,false,false),
  (52,'approved',null,true,false,false),
  (53,'approved',now()+interval '5 days',false,false,false),
  (54,'approved',now()+interval '10 days',false,false,false);

INSERT INTO public.payment_requests(id,user_id,amount,status,note)
VALUES
  (91,51,24000,'pending','bank transfer'),
  (92,52,35000,'pending',null),
  (93,53,21000,'pending','needs confirmation'),
  (94,54,15000,'pending','[기기추가]|Extra phone|01000000000'),
  (95,51,17000,'pending',null),
  (96,51,22000,'pending',null);

\ir SQL_PAYMENT_REVIEW_ONLY.sql
SELECT set_config('request.jwt.claim.role','service_role',false);

DO $$
DECLARE r jsonb;expiry timestamptz;
BEGIN
  r:=public.qa_svc_payment_review(
    '00000000-0000-4000-8000-000000000001',
    'payment.approve',91,'pending',
    '71111111-1111-4111-8111-111111111111',24000,null);
  IF r->>'outcome'<>'updated' OR r->>'status'<>'approved' THEN
    RAISE EXCEPTION 'PAYMENT_APPROVAL_RESULT_WRONG';
  END IF;
  SELECT license_expires_at INTO expiry FROM public.users WHERE id=51;
  IF expiry<now()+interval '49 days' OR expiry>now()+interval '51 days'
    OR (SELECT is_free_user FROM public.users WHERE id=51) IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'RENEWAL_40_DAYS_INCORRECT';
  END IF;
  IF (SELECT approved_amount FROM public.payment_requests WHERE id=91)<>24000
     OR (SELECT status FROM public.payment_requests WHERE id=91)<>'approved' THEN
    RAISE EXCEPTION 'PAYMENT_STATE_INCORRECT';
  END IF;

  r:=public.qa_svc_payment_review(
    '00000000-0000-4000-8000-000000000001',
    'payment.approve',91,'pending',
    '71111111-1111-4111-8111-111111111111',24000,null);
  IF r->>'outcome'<>'duplicate'
     OR (SELECT license_expires_at FROM public.users WHERE id=51)<>expiry THEN
    RAISE EXCEPTION 'PAYMENT_NOT_IDEMPOTENT';
  END IF;

  r:=public.qa_svc_payment_review(
    '00000000-0000-4000-8000-000000000001',
    'payment.approve',92,'pending',
    '72222222-2222-4222-8222-222222222222',35000,null);
  IF r->>'status'<>'approved'
     OR (SELECT is_new FROM public.users WHERE id=52) IS DISTINCT FROM false
     OR (SELECT license_expires_at FROM public.users WHERE id=52)<now()+interval '49 days'
     OR (SELECT license_expires_at FROM public.users WHERE id=52)>now()+interval '51 days' THEN
    RAISE EXCEPTION 'NEW_MEMBER_50_DAYS_INCORRECT';
  END IF;

  r:=public.qa_svc_payment_review(
    '00000000-0000-4000-8000-000000000001',
    'payment.reject',93,'pending',
    '73333333-3333-4333-8333-333333333333',null,'  bank transfer not confirmed  ');
  IF r->>'status'<>'rejected'
     OR (SELECT status FROM public.payment_requests WHERE id=93)<>'rejected'
     OR (SELECT admin_note FROM public.payment_requests WHERE id=93)<>'bank transfer not confirmed' THEN
    RAISE EXCEPTION 'REJECTION_STATE_INCORRECT';
  END IF;
END $$;

DO $$
DECLARE denied boolean:=false;
BEGIN
  BEGIN
    PERFORM public.qa_svc_payment_review(
      '00000000-0000-4000-8000-000000000001',
      'payment.approve',94,'pending',
      '74444444-4444-4444-8444-444444444444',15000,null);
  EXCEPTION WHEN check_violation THEN denied:=true;
  END;
  IF NOT denied THEN RAISE EXCEPTION 'DEVICE_ADD_PAYMENT_INCORRECTLY_APPROVED'; END IF;
  IF (SELECT status FROM public.payment_requests WHERE id=94)<>'pending' THEN
    RAISE EXCEPTION 'DEVICE_ADD_PAYMENT_WAS_MUTATED';
  END IF;
END $$;

DO $$
DECLARE denied boolean:=false;
BEGIN
  BEGIN
    PERFORM public.qa_svc_payment_review(
      '00000000-0000-4000-8000-000000000002',
      'payment.approve',95,'pending',
      '75555555-5555-4555-8555-555555555555',17000,null);
  EXCEPTION WHEN insufficient_privilege THEN denied:=true;
  END;
  IF NOT denied THEN RAISE EXCEPTION 'NON_DEV_PAYMENT_APPROVAL_ALLOWED'; END IF;
END $$;

DO $$
DECLARE denied boolean:=false;
BEGIN
  BEGIN
    PERFORM public.qa_svc_payment_review(
      '00000000-0000-4000-8000-000000000001',
      'payment.reject',91,'pending',
      '71111111-1111-4111-8111-111111111111',null,'wrong');
  EXCEPTION WHEN unique_violation THEN denied:=true;
  END;
  IF NOT denied THEN RAISE EXCEPTION 'IDEMPOTENCY_REUSE_ALLOWED'; END IF;
END $$;

DO $$
DECLARE denied boolean:=false;
BEGIN
  BEGIN
    PERFORM public.qa_svc_payment_review(
      '00000000-0000-4000-8000-000000000001',
      'payment.approve',91,'pending',
      '76666666-6666-4666-8666-666666666666',24000,null);
  EXCEPTION WHEN check_violation THEN denied:=true;
  END;
  IF NOT denied THEN RAISE EXCEPTION 'ALREADY_APPROVED_PAYMENT_AGAIN'; END IF;
END $$;

UPDATE qa_private.admin_identities SET enabled=false WHERE admin_id=1;
DO $$
DECLARE denied boolean:=false;
BEGIN
  BEGIN
    PERFORM public.qa_svc_payment_review(
      '00000000-0000-4000-8000-000000000001',
      'payment.approve',95,'pending',
      '77777777-7777-4777-8777-777777777777',17000,null);
  EXCEPTION WHEN insufficient_privilege THEN denied:=true;
  END;
  IF NOT denied THEN RAISE EXCEPTION 'REVOKED_ADMIN_PAYMENT_ALLOWED'; END IF;
END $$;
UPDATE qa_private.admin_identities SET enabled=true WHERE admin_id=1;

SELECT set_config('request.jwt.claim.role','authenticated',false);
DO $$
DECLARE denied boolean:=false;
BEGIN
  BEGIN
    PERFORM public.qa_svc_payment_review(
      '00000000-0000-4000-8000-000000000001',
      'payment.approve',95,'pending',
      '78888888-8888-4888-8888-888888888888',17000,null);
  EXCEPTION WHEN insufficient_privilege THEN denied:=true;
  END;
  IF NOT denied THEN RAISE EXCEPTION 'AUTHENTICATED_PAYMENT_MUTATION_ALLOWED'; END IF;
END $$;
SELECT set_config('request.jwt.claim.role','service_role',false);

DO $$
BEGIN
  IF has_function_privilege('anon',
    'public.qa_svc_payment_review(uuid,text,integer,text,uuid,integer,text)','EXECUTE')
    OR has_function_privilege('authenticated',
    'public.qa_svc_payment_review(uuid,text,integer,text,uuid,integer,text)','EXECUTE')
    OR NOT has_function_privilege('service_role',
    'public.qa_svc_payment_review(uuid,text,integer,text,uuid,integer,text)','EXECUTE') THEN
    RAISE EXCEPTION 'PAYMENT_RPC_GRANTS_INCORRECT';
  END IF;
  IF (SELECT count(*) FROM qa_private.payment_review_actions)<>3 THEN
    RAISE EXCEPTION 'PAYMENT_AUDIT_COUNT_INCORRECT';
  END IF;
  IF (SELECT count(*) FROM public.user_devices)<>1 THEN
    RAISE EXCEPTION 'PAYMENT_CREATED_UNAPPROVED_DEVICE';
  END IF;
  IF (SELECT status FROM public.payment_requests WHERE id=95)<>'pending' THEN
    RAISE EXCEPTION 'REJECTED_APPROVAL_CHANGED_PAYMENT';
  END IF;
END $$;
\echo QA_PAYMENT_SQL_PASS
