-- Disposable PostgreSQL 17 CI only; synthetic fake users and config values.
-- NOT FOR PRODUCTION SUPABASE.
\set ON_ERROR_STOP on

ALTER TABLE public.admins ADD COLUMN updated_at timestamptz DEFAULT now();
ALTER TABLE public.branches ADD COLUMN updated_at timestamptz DEFAULT now();
CREATE TABLE public.app_settings (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  key text NOT NULL UNIQUE,
  value text NOT NULL,
  updated_at timestamptz DEFAULT now()
);
INSERT INTO public.app_settings(key,value) VALUES
  ('payment_visible','false'),
  ('maintenance_mode','true'),
  ('tg_bot_token','SECRET-SHOULD-NOT-BE-EXPOSED');

\ir SQL_CONFIG_REVIEW_ONLY.sql
SELECT set_config('request.jwt.claim.role','service_role',false);

DO $$
DECLARE r jsonb;
BEGIN
  r:=public.qa_svc_admin_config(
    '00000000-0000-4000-8000-000000000001',
    'branch.rename',3,NULL,NULL,'Test Branch 3','New Branch 3',
    '81111111-1111-4111-8111-111111111111');
  IF r->>'action'<>'branch.rename' OR r->>'outcome'<>'updated' OR
     r->>'target'<>'3' THEN RAISE EXCEPTION 'BRANCH_RENAME_RESULT_WRONG'; END IF;
  IF (SELECT name FROM public.branches WHERE id=3)<>'New Branch 3' THEN
     RAISE EXCEPTION 'BRANCH_RENAME_NOT_APPLIED'; END IF;
  r:=public.qa_svc_admin_config(
    '00000000-0000-4000-8000-000000000001',
    'branch.rename',3,NULL,NULL,'Test Branch 3','New Branch 3',
    '81111111-1111-4111-8111-111111111111');
  IF r->>'outcome'<>'duplicate' THEN RAISE EXCEPTION 'BRANCH_RETRY_NOT_IDEMPOTENT'; END IF;

  r:=public.qa_svc_admin_config(
    '00000000-0000-4000-8000-000000000001',
    'admin.rename',NULL,2,NULL,'Branch Demo','Renamed Admin',
    '82222222-2222-4222-8222-222222222222');
  IF r->>'outcome'<>'updated' OR
     (SELECT name FROM public.admins WHERE id=2)<>'Renamed Admin' OR
     (SELECT role FROM public.admins WHERE id=2)<>'branch' THEN
    RAISE EXCEPTION 'ADMIN_RENAME_OR_ROLE_INCORRECT'; END IF;

  r:=public.qa_svc_admin_config(
    '00000000-0000-4000-8000-000000000001',
    'setting.toggle',NULL,NULL,'payment_visible','false','true',
    '83333333-3333-4333-8333-333333333333');
  IF r->>'target'<>'payment_visible' OR
     (SELECT value FROM public.app_settings WHERE key='payment_visible')<>'true' THEN
    RAISE EXCEPTION 'PAYMENT_VISIBILITY_TOGGLE_FAILED'; END IF;

  r:=public.qa_svc_admin_config(
    '00000000-0000-4000-8000-000000000001',
    'setting.toggle',NULL,NULL,'maintenance_mode','true','false',
    '84444444-4444-4444-8444-444444444444');
  IF r->>'outcome'<>'updated' OR
     (SELECT value FROM public.app_settings WHERE key='maintenance_mode')<>'false' THEN
    RAISE EXCEPTION 'MAINTENANCE_SETTING_TOGGLE_FAILED'; END IF;
END $$;

DO $$
DECLARE denied boolean:=false;
BEGIN
  BEGIN
    PERFORM public.qa_svc_admin_config(
      '00000000-0000-4000-8000-000000000002',
      'branch.rename',8,NULL,NULL,'Other Branch','Unwanted Branch',
      '85555555-5555-4555-8555-555555555555');
  EXCEPTION WHEN insufficient_privilege THEN denied:=true;
  END;
  IF NOT denied THEN RAISE EXCEPTION 'NON_DEV_CONFIG_CHANGED'; END IF;
  IF (SELECT name FROM public.branches WHERE id=8)<>'Other Branch' THEN
    RAISE EXCEPTION 'NON_DEV_CHANGED_BRANCH_RECORD'; END IF;
END $$;

DO $$
DECLARE denied boolean:=false;
BEGIN
  BEGIN
    PERFORM public.qa_svc_admin_config(
      '00000000-0000-4000-8000-000000000001',
      'branch.rename',3,NULL,NULL,'Test Branch 3','Hijacked Branch 3',
      '86666666-6666-4666-8666-666666666666');
  EXCEPTION WHEN check_violation THEN denied:=true;
  END;
  IF NOT denied THEN RAISE EXCEPTION 'STALE_WRITE_SUCCEEDED'; END IF;
END $$;

DO $$
DECLARE denied boolean:=false;
BEGIN
  BEGIN
    PERFORM public.qa_svc_admin_config(
      '00000000-0000-4000-8000-000000000001',
      'setting.toggle',NULL,NULL,'tg_bot_token','false','true',
      '87777777-7777-4777-8777-777777777777');
  EXCEPTION WHEN invalid_parameter_value THEN denied:=true;
  END;
  IF NOT denied THEN RAISE EXCEPTION 'SECRET_SETTING_CHANGED'; END IF;
END $$;

DO $$
DECLARE denied boolean:=false;
BEGIN
  BEGIN
    PERFORM public.qa_svc_admin_config(
      '00000000-0000-4000-8000-000000000001',
      'admin.rename',NULL,1,NULL,'Developer Demo','<script>alert(1)</script>',
      '88888888-8888-4888-8888-888888888888');
  EXCEPTION WHEN invalid_parameter_value THEN denied:=true;
  END;
  IF NOT denied THEN RAISE EXCEPTION 'HTML_PAYLOAD_ALLOWED'; END IF;
END $$;

DO $$
DECLARE denied boolean:=false;
BEGIN
  BEGIN
    PERFORM public.qa_svc_admin_config(
      '00000000-0000-4000-8000-000000000001',
      'branch.rename',3,NULL,NULL,'Test Branch 3','Other Branch',
      '81111111-1111-4111-8111-111111111111');
  EXCEPTION WHEN unique_violation THEN denied:=true;
  END;
  IF NOT denied THEN RAISE EXCEPTION 'IDEMPOTENCY_REUSE_ALLOWED'; END IF;
END $$;

UPDATE qa_private.admin_identities SET enabled=false WHERE admin_id=1;
DO $$
DECLARE denied boolean:=false;
BEGIN
  BEGIN
    PERFORM public.qa_svc_admin_config(
      '00000000-0000-4000-8000-000000000001',
      'branch.rename',8,NULL,NULL,'Other Branch','Blocked Branch',
      '89999999-9999-4999-8999-999999999999');
  EXCEPTION WHEN insufficient_privilege THEN denied:=true;
  END;
  IF NOT denied THEN RAISE EXCEPTION 'REVOKED_ADMIN_CONFIG_ALLOWED'; END IF;
END $$;
UPDATE qa_private.admin_identities SET enabled=true WHERE admin_id=1;

SELECT set_config('request.jwt.claim.role','authenticated',false);
DO $$
DECLARE denied boolean:=false;
BEGIN
  BEGIN
    PERFORM public.qa_svc_admin_config(
      '00000000-0000-4000-8000-000000000001',
      'branch.rename',8,NULL,NULL,'Other Branch','Blocked Branch',
      '8aaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  EXCEPTION WHEN insufficient_privilege THEN denied:=true;
  END;
  IF NOT denied THEN RAISE EXCEPTION 'WEB_CLIENT_ROLE_ALLOWED'; END IF;
END $$;
SELECT set_config('request.jwt.claim.role','service_role',false);

DO $$
BEGIN
  IF has_function_privilege('anon',
     'public.qa_svc_admin_config(uuid,text,integer,integer,text,text,text,uuid)','EXECUTE')
  OR has_function_privilege('authenticated',
     'public.qa_svc_admin_config(uuid,text,integer,integer,text,text,text,uuid)','EXECUTE')
  OR NOT has_function_privilege('service_role',
     'public.qa_svc_admin_config(uuid,text,integer,integer,text,text,text,uuid)','EXECUTE') THEN
    RAISE EXCEPTION 'CONFIG_EXECUTE_GRANTS_BAD';
  END IF;
  IF (SELECT count(*) FROM qa_private.config_actions)<>4 THEN
    RAISE EXCEPTION 'CONFIG_AUDIT_COUNT_BAD';
  END IF;
  IF (SELECT value FROM public.app_settings WHERE key='tg_bot_token')
     <>'SECRET-SHOULD-NOT-BE-EXPOSED' THEN
    RAISE EXCEPTION 'SECRET_SETTING_MUTATED';
  END IF;
  IF (SELECT name FROM public.admins WHERE id=1)<>'Developer Demo' THEN
    RAISE EXCEPTION 'DEV_ADMIN_RENAMED_WITHOUT_PERMISSION';
  END IF;
END $$;
\echo QA_ADMIN_CONFIG_SQL_PASS
