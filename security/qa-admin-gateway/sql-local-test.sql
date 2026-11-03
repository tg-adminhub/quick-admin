-- PostgreSQL 17 ephemeral CI ONLY. Uses exclusively synthetic rows.
-- Never run on production or any existing customer database.
\set ON_ERROR_STOP on

CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN;
CREATE SCHEMA auth;

CREATE TABLE auth.users(id uuid PRIMARY KEY);
CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE
AS $$ SELECT current_setting('request.jwt.claim.role',true) $$;

CREATE TABLE public.admins(
  id integer PRIMARY KEY,username text NOT NULL,
  name text NOT NULL,role text NOT NULL,branch_id integer
);
CREATE TABLE public.branches(
  id integer PRIMARY KEY,name text NOT NULL,
  parent_id integer,type text NOT NULL
);
CREATE TABLE public.users(
  id integer PRIMARY KEY,status text,
  approved_at timestamptz,license_expires_at timestamptz,
  is_new boolean,is_free_user boolean,rejection_reason text
);

INSERT INTO auth.users(id) VALUES
  ('00000000-0000-4000-8000-000000000001'),
  ('00000000-0000-4000-8000-000000000002');
INSERT INTO public.admins VALUES
  (1,'dev-demo','Developer Demo','dev',null),
  (2,'branch-demo','Branch Demo','branch',3);
INSERT INTO public.branches VALUES
  (3,'Test Branch 3',null,'branch'),
  (4,'Test Branch 4',3,'sub'),
  (8,'Other Branch',null,'branch');
INSERT INTO public.users(id,status) VALUES
  (44,'pending'),(45,'pending'),(46,'pending');

\ir SQL_REVIEW_ONLY.sql
\ir SQL_REVIEW_MUTATE_ONLY.sql

INSERT INTO qa_private.admin_identities(admin_id,auth_user_id,enabled)
VALUES
  (1,'00000000-0000-4000-8000-000000000001',true),
  (2,'00000000-0000-4000-8000-000000000002',true);

SELECT set_config('request.jwt.claim.role','service_role',false);

DO $$
DECLARE p jsonb;
BEGIN
  p:=public.qa_svc_admin_profile('00000000-0000-4000-8000-000000000001');
  IF p->>'role' <> 'dev' OR p->'visibleBranchIds'<>'null'::jsonb THEN
    RAISE EXCEPTION 'DEV_PROFILE_INCORRECT';
  END IF;
  p:=public.qa_svc_admin_profile('00000000-0000-4000-8000-000000000002');
  IF p->>'role'<>'branch'
     OR NOT (p->'visibleBranchIds') @> '[3,4]'::jsonb
     OR (p->'visibleBranchIds') @> '[8]'::jsonb THEN
    RAISE EXCEPTION 'BRANCH_SCOPE_INCORRECT';
  END IF;
END $$;

DO $$
DECLARE r jsonb; v_status text; v_license timestamptz;
BEGIN
  r:=public.qa_svc_member_review(
    '00000000-0000-4000-8000-000000000001',
    'member.approve',44,'pending',
    '11111111-1111-4111-8111-111111111111',null
  );
  IF r->>'status'<>'approved' OR r->>'outcome'<>'updated' THEN
    RAISE EXCEPTION 'FIRST_APPROVAL_FAILED';
  END IF;
  SELECT status,license_expires_at INTO v_status,v_license
    FROM public.users WHERE id=44;
  IF v_status<>'approved' OR v_license<now()+interval '6 days'
     OR v_license>now()+interval '8 days' THEN
    RAISE EXCEPTION 'APPROVAL_LICENSE_WRONG';
  END IF;

  r:=public.qa_svc_member_review(
    '00000000-0000-4000-8000-000000000001',
    'member.approve',44,'pending',
    '11111111-1111-4111-8111-111111111111',null
  );
  IF r->>'outcome'<>'duplicate' THEN RAISE EXCEPTION 'NOT_IDEMPOTENT'; END IF;

  r:=public.qa_svc_member_review(
    '00000000-0000-4000-8000-000000000001',
    'member.reject',45,'pending',
    '22222222-2222-4222-8222-222222222222','  invalid submission  '
  );
  IF r->>'status'<>'rejected' THEN RAISE EXCEPTION 'REJECT_FAILED'; END IF;
  IF (SELECT rejection_reason FROM public.users WHERE id=45)
     <> 'invalid submission' THEN RAISE EXCEPTION 'REASON_NOT_TRIMMED'; END IF;
END $$;

DO $$
DECLARE denied boolean:=false;
BEGIN
  BEGIN
    PERFORM public.qa_svc_member_review(
      '00000000-0000-4000-8000-000000000002',
      'member.approve',46,'pending',
      '33333333-3333-4333-8333-333333333333',null);
  EXCEPTION WHEN insufficient_privilege THEN denied:=true;
  END;
  IF NOT denied THEN RAISE EXCEPTION 'BRANCH_WRITE_ALLOWED'; END IF;
END $$;

DO $$
DECLARE denied boolean:=false;
BEGIN
  BEGIN
    PERFORM public.qa_svc_member_review(
      '00000000-0000-4000-8000-000000000001',
      'member.reject',44,'pending',
      '11111111-1111-4111-8111-111111111111','changed');
  EXCEPTION WHEN unique_violation THEN denied:=true;
  END;
  IF NOT denied THEN RAISE EXCEPTION 'IDEMPOTENCY_REUSE_ALLOWED'; END IF;
END $$;

DO $$
DECLARE denied boolean:=false;
BEGIN
  BEGIN
    PERFORM public.qa_svc_member_review(
      '00000000-0000-4000-8000-000000000001',
      'member.approve',44,'pending',
      '44444444-4444-4444-8444-444444444444',null);
  EXCEPTION WHEN check_violation THEN denied:=true;
  END;
  IF NOT denied THEN RAISE EXCEPTION 'NONPENDING_REAPPROVED'; END IF;
END $$;

-- DEFENSE IN DEPTH: a browser role claim is insufficient even from a
-- superuser test connection, because service_role must be the request claim.
SELECT set_config('request.jwt.claim.role','authenticated',false);
DO $$
DECLARE denied boolean:=false;
BEGIN
  BEGIN
    PERFORM public.qa_svc_member_review(
      '00000000-0000-4000-8000-000000000001',
      'member.approve',46,'pending',
      '55555555-5555-4555-8555-555555555555',null);
  EXCEPTION WHEN insufficient_privilege THEN denied:=true;
  END;
  IF NOT denied THEN RAISE EXCEPTION 'NON_SERVICE_CLAIM_ALLOWED'; END IF;
END $$;

SELECT set_config('request.jwt.claim.role','service_role',false);
DO $$
BEGIN
  IF has_function_privilege('anon',
    'public.qa_svc_member_review(uuid,text,integer,text,uuid,text)','EXECUTE')
    OR has_function_privilege('authenticated',
    'public.qa_svc_member_review(uuid,text,integer,text,uuid,text)','EXECUTE')
    OR NOT has_function_privilege('service_role',
    'public.qa_svc_member_review(uuid,text,integer,text,uuid,text)','EXECUTE') THEN
    RAISE EXCEPTION 'RPC_EXECUTE_GRANT_INCORRECT';
  END IF;
  IF (SELECT count(*) FROM qa_private.member_review_actions)<>2 THEN
    RAISE EXCEPTION 'IDEMPOTENCY_AUDIT_COUNT_INCORRECT';
  END IF;
  IF (SELECT status FROM public.users WHERE id=46)<>'pending' THEN
    RAISE EXCEPTION 'REJECTED_ACTION_MUTATED_MEMBER';
  END IF;
END $$;

\echo QA_LOCAL_SQL_SECURITY_PASS
