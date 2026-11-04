-- Synthetic PostgreSQL 17 extension to sql-local-test.sql.
-- NEVER RUN ON THE PRODUCTION DATABASE.
\set ON_ERROR_STOP on

ALTER TABLE public.users
  ADD COLUMN paused boolean NOT NULL DEFAULT false,
  ADD COLUMN paused_remaining_days integer NOT NULL DEFAULT 0,
  ADD COLUMN paused_at timestamptz,
  ADD COLUMN main_android_id text;
CREATE TABLE public.user_devices (
  id integer PRIMARY KEY,
  user_id integer NOT NULL REFERENCES public.users(id),
  android_id text
);

INSERT INTO public.users(id,status,license_expires_at,main_android_id)
VALUES
  (47,'approved',now()+interval '8 days',null),
  (48,'approved',now()+interval '8 days',null),
  (49,'approved',now()+interval '8 days','TEST-DEVICE-MAIN'),
  (50,'approved',now()+interval '8 days',null);
INSERT INTO public.user_devices VALUES (701,50,'TEST-DEVICE-EXTRA');

\ir SQL_MAINTENANCE_REVIEW_ONLY.sql
SELECT set_config('request.jwt.claim.role','service_role',false);

DO $$
DECLARE r jsonb;v_days integer;v_expiry timestamptz;
BEGIN
  r:=public.qa_svc_member_maintenance(
    '00000000-0000-4000-8000-000000000001',
    'member.pause',47,null,'active',
    '61111111-1111-4111-8111-111111111111');
  IF r->>'outcome'<>'updated' OR r->>'action'<>'member.pause' THEN
    RAISE EXCEPTION 'PAUSE_RESULT_INCORRECT';
  END IF;
  SELECT paused,paused_remaining_days,license_expires_at
  INTO STRICT r,v_days,v_expiry
  FROM (
    SELECT to_jsonb(paused) paused,paused_remaining_days,license_expires_at
    FROM public.users WHERE id=47
  ) s;
  IF r <> 'true'::jsonb OR v_days NOT BETWEEN 7 AND 9
     OR v_expiry < now()+interval '9 years' THEN
    RAISE EXCEPTION 'PAUSE_STATE_INCORRECT';
  END IF;

  r:=public.qa_svc_member_maintenance(
    '00000000-0000-4000-8000-000000000001',
    'member.pause',47,null,'active',
    '61111111-1111-4111-8111-111111111111');
  IF r->>'outcome'<>'duplicate' THEN
    RAISE EXCEPTION 'PAUSE_NOT_IDEMPOTENT';
  END IF;

  r:=public.qa_svc_member_maintenance(
    '00000000-0000-4000-8000-000000000001',
    'member.resume',47,null,'paused',
    '62222222-2222-4222-8222-222222222222');
  IF r->>'outcome'<>'updated' THEN RAISE EXCEPTION 'RESUME_RESULT_BAD'; END IF;
  IF (SELECT paused FROM public.users WHERE id=47) IS DISTINCT FROM false
     OR (SELECT paused_remaining_days FROM public.users WHERE id=47)<>0
     OR (SELECT paused_at FROM public.users WHERE id=47) IS NOT NULL
     OR (SELECT license_expires_at FROM public.users WHERE id=47)<now()+interval '7 days'
     OR (SELECT license_expires_at FROM public.users WHERE id=47)>now()+interval '9 days' THEN
     RAISE EXCEPTION 'RESUME_STATE_INCORRECT';
  END IF;

  r:=public.qa_svc_member_maintenance(
    '00000000-0000-4000-8000-000000000001',
    'device.reset_main',49,null,'bound',
    '63333333-3333-4333-8333-333333333333');
  IF r->>'outcome'<>'updated'
     OR (SELECT main_android_id FROM public.users WHERE id=49) IS NOT NULL THEN
    RAISE EXCEPTION 'MAIN_DEVICE_RESET_FAILED';
  END IF;

  r:=public.qa_svc_member_maintenance(
    '00000000-0000-4000-8000-000000000001',
    'device.reset_extra',50,701,'bound',
    '64444444-4444-4444-8444-444444444444');
  IF r->>'outcome'<>'updated'
     OR (SELECT android_id FROM public.user_devices WHERE id=701) IS NOT NULL THEN
    RAISE EXCEPTION 'EXTRA_DEVICE_RESET_FAILED';
  END IF;
END $$;

DO $$
DECLARE denied boolean:=false;
BEGIN
  BEGIN
    PERFORM public.qa_svc_member_maintenance(
      '00000000-0000-4000-8000-000000000002',
      'member.pause',48,null,'active',
      '65555555-5555-4555-8555-555555555555');
  EXCEPTION WHEN insufficient_privilege THEN denied:=true;
  END;
  IF NOT denied THEN RAISE EXCEPTION 'NON_DEV_MUTATION_ALLOWED'; END IF;
END $$;

DO $$
DECLARE denied boolean:=false;
BEGIN
  BEGIN
    PERFORM public.qa_svc_member_maintenance(
      '00000000-0000-4000-8000-000000000001',
      'device.reset_extra',49,701,'bound',
      '66666666-6666-4666-8666-666666666666');
  EXCEPTION WHEN check_violation THEN denied:=true;
  END;
  IF NOT denied THEN RAISE EXCEPTION 'CROSS_MEMBER_DEVICE_RESET_ALLOWED'; END IF;
END $$;

DO $$
DECLARE denied boolean:=false;
BEGIN
  BEGIN
    PERFORM public.qa_svc_member_maintenance(
      '00000000-0000-4000-8000-000000000001',
      'member.resume',48,null,'paused',
      '67777777-7777-4777-8777-777777777777');
  EXCEPTION WHEN check_violation THEN denied:=true;
  END;
  IF NOT denied THEN RAISE EXCEPTION 'RESUME_NONPAUSED_ALLOWED'; END IF;
END $$;

DO $$
DECLARE denied boolean:=false;
BEGIN
  BEGIN
    PERFORM public.qa_svc_member_maintenance(
      '00000000-0000-4000-8000-000000000001',
      'member.pause',48,null,'paused',
      '68888888-8888-4888-8888-888888888888');
  EXCEPTION WHEN invalid_parameter_value THEN denied:=true;
  END;
  IF NOT denied THEN RAISE EXCEPTION 'EXPECTED_STATE_BYPASS_ALLOWED'; END IF;
END $$;

DO $$
DECLARE denied boolean:=false;
BEGIN
  BEGIN
    PERFORM public.qa_svc_member_maintenance(
      '00000000-0000-4000-8000-000000000001',
      'device.reset_extra',50,999,'bound',
      '69999999-9999-4999-8999-999999999999');
  EXCEPTION WHEN check_violation THEN denied:=true;
  END;
  IF NOT denied THEN RAISE EXCEPTION 'UNKNOWN_EXTRA_DEVICE_ALLOWED'; END IF;
END $$;

DO $$
DECLARE denied boolean:=false;
BEGIN
  BEGIN
    PERFORM public.qa_svc_member_maintenance(
      '00000000-0000-4000-8000-000000000001',
      'device.reset_extra',50,999,'bound',
      '61111111-1111-4111-8111-111111111111');
  EXCEPTION WHEN unique_violation THEN denied:=true;
  END;
  IF NOT denied THEN RAISE EXCEPTION 'IDEMPOTENCY_REUSE_ALLOWED'; END IF;
END $$;

UPDATE qa_private.admin_identities SET enabled=false WHERE admin_id=1;
DO $$
DECLARE denied boolean:=false;
BEGIN
  BEGIN
    PERFORM public.qa_svc_member_maintenance(
      '00000000-0000-4000-8000-000000000001',
      'member.pause',48,null,'active',
      '6aaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  EXCEPTION WHEN insufficient_privilege THEN denied:=true;
  END;
  IF NOT denied THEN RAISE EXCEPTION 'REVOKED_ADMIN_ACTION_ALLOWED'; END IF;
END $$;
UPDATE qa_private.admin_identities SET enabled=true WHERE admin_id=1;

SELECT set_config('request.jwt.claim.role','authenticated',false);
DO $$
DECLARE denied boolean:=false;
BEGIN
  BEGIN
    PERFORM public.qa_svc_member_maintenance(
      '00000000-0000-4000-8000-000000000001',
      'member.pause',48,null,'active',
      '6bbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
  EXCEPTION WHEN insufficient_privilege THEN denied:=true;
  END;
  IF NOT denied THEN RAISE EXCEPTION 'AUTHENTICATED_ROLE_MUTATION_ALLOWED'; END IF;
END $$;

SELECT set_config('request.jwt.claim.role','service_role',false);
DO $$
BEGIN
  IF has_function_privilege('anon',
    'public.qa_svc_member_maintenance(uuid,text,integer,integer,text,uuid)','EXECUTE')
    OR has_function_privilege('authenticated',
    'public.qa_svc_member_maintenance(uuid,text,integer,integer,text,uuid)','EXECUTE')
    OR NOT has_function_privilege('service_role',
    'public.qa_svc_member_maintenance(uuid,text,integer,integer,text,uuid)','EXECUTE') THEN
    RAISE EXCEPTION 'MAINTENANCE_EXECUTE_GRANT_INCORRECT';
  END IF;
  IF (SELECT count(*) FROM qa_private.maintenance_actions)<>4 THEN
    RAISE EXCEPTION 'MAINTENANCE_AUDIT_COUNT_INCORRECT';
  END IF;
  IF (SELECT paused FROM public.users WHERE id=48) IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'DENIED_REQUEST_CHANGED_MEMBER';
  END IF;
END $$;

\echo QA_MAINTENANCE_SQL_PASS
