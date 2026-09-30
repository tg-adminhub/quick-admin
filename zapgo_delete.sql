-- 잡고 회원 삭제: 삭제 기록 보관 테이블 + 원자적 삭제 함수
-- ⚠️ 실행 위치: 브라우저에서 Supabase 프로젝트 "jabgo" (axitncgfghhvmgnqilcl) 의 SQL Editor
--
-- 동작 (한 번에 성공하거나 전부 취소):
--   1) 삭제 기록 보관 (이름·아이디·번호·차량 메모·이용기간·추가 번호 목록·삭제한 관리자·사유)
--      ※ 비밀번호 해시와 인성 로그인 정보는 보관하지 않는다.
--   2) 그 회원의 연장 요청 삭제
--   3) 추가 번호용 하위 계정 삭제
--   4) 회원 삭제
-- 결제 기록(payments)은 삭제하지 않는다. 회원 연결만 끊기고 이름은 그때 값으로 남아 매출이 유지된다.
-- 여러 번 실행해도 안전하다.

create table if not exists public.withdrawn_riders (
  id                    uuid primary key default gen_random_uuid(),
  rider_id              uuid not null,
  username              text,
  name                  text not null default '',
  phone                 text not null default '',
  vehicle_memo          text,
  status                text,
  membership_starts_at  timestamptz,
  membership_expires_at timestamptz,
  rider_created_at      timestamptz,
  extra_phones          jsonb not null default '[]'::jsonb,
  reason                text,
  deleted_by            uuid,
  deleted_at            timestamptz not null default now()
);

create index if not exists withdrawn_riders_deleted_at_idx
  on public.withdrawn_riders (deleted_at desc);

alter table public.withdrawn_riders enable row level security;

create or replace function public.delete_rider_member(
  p_rider  uuid,
  p_admin  uuid,
  p_reason text
) returns void
language plpgsql
as $$
declare
  v_user  public.users%rowtype;
  v_extra jsonb;
begin
  select * into v_user
    from public.users
   where id = p_rider and role = 'rider' and parent_rider_id is null
   for update;
  if not found then
    raise exception 'rider not found' using errcode = 'P0002';
  end if;

  select coalesce(
           jsonb_agg(jsonb_build_object('slot', c.slot, 'phone', c.phone, 'label', c.slot_label) order by c.slot),
           '[]'::jsonb)
    into v_extra
    from public.users c
   where c.parent_rider_id = p_rider;

  insert into public.withdrawn_riders (
    rider_id, username, name, phone, vehicle_memo, status,
    membership_starts_at, membership_expires_at, rider_created_at,
    extra_phones, reason, deleted_by
  ) values (
    v_user.id, v_user.username, v_user.name, v_user.phone, v_user.vehicle_memo, v_user.status,
    v_user.membership_starts_at, v_user.membership_expires_at, v_user.created_at,
    v_extra, nullif(btrim(coalesce(p_reason, '')), ''), p_admin
  );

  delete from public.extension_requests where rider_id = p_rider;
  delete from public.users where parent_rider_id = p_rider;
  delete from public.users where id = p_rider;
end;
$$;

revoke all on function public.delete_rider_member(uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.delete_rider_member(uuid, uuid, text)
  to service_role;
