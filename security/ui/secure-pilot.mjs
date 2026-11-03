import {createProtectedAdminClient,GatewayError} from './secure-admin-client.mjs';
import {createSyntheticTransport} from './synthetic-transport.mjs';

// Strictly synthetic pilot: no real account, network request, or database data.
let client;
let currentResource='members';
let events=[];

const el=id=>document.getElementById(id);
function make(tag,content='',className=''){
  const e=document.createElement(tag);
  e.textContent=String(content);
  if(className)e.className=className;
  return e;
}
function errorDescription(e){
  if(!(e instanceof GatewayError))return '가상 작업을 실행하지 못했습니다';
  const codes={
    GATEWAY_UNAVAILABLE:'가상 기록 상태가 요청 조건과 맞지 않습니다. 데이터를 초기화해 다시 시험하세요.',
    AUTH_REQUIRED:'유효한 테스트 세션이 없습니다',
    ADMIN_ACCESS_DENIED:'관리자 권한이 없습니다',
    INVALID_ACTION_INPUT:'시연 작업 요청이 잘못되었습니다'
  };
  return codes[e.code]??('모의 API 응답: '+e.code);
}
function newClient(){
  if(typeof crypto?.randomUUID!=='function')
    throw Error('이 시연 화면에는 HTTPS 보안 환경이 필요합니다');
  const fake=createSyntheticTransport({randomUUID:()=>crypto.randomUUID()});
  return createProtectedAdminClient(fake);
}
function log(text){
  events.unshift(text);
  events=events.slice(0,12);
  el('activity').textContent=events.join('\n');
}
function displayRow(record,resource){
  const card=make('div','','record');
  const primary=resource==='members'
    ? String(record.real_name??'가상회원')+' · '+String(record.username??'-')
    : resource==='payments'
      ? '가상 결제 #'+record.id+' · ₩'+Number(record.amount??0).toLocaleString('ko-KR')
      : (record.name??'가상 지점');
  card.append(make('p',primary));
  const secondary=resource==='members'
    ? 'ID '+record.id+' / 상태 '+(record.status??'-')+' / 소속 '+(record.branch_id??'-')+' / 앱 '+(record.app_type??'-')
    : resource==='payments'
      ? 'ID '+record.id+' / 상태 '+(record.status??'-')+' / 회원 '+(record.user_id??'-')
      : 'ID '+record.id+' / 구분 '+(record.type??'-');
  card.append(make('small',secondary));
  return card;
}
async function load(){
  const title={members:'가상 회원 목록',payments:'가상 결제 목록',branches:'가상 지점 목록'};
  el('list-title').textContent=title[currentResource];
  const host=el('records');
  host.replaceChildren(make('p','모의 API 조회 중…'));
  try{
    const rows=await client.getList(currentResource,{limit:25,offset:0});
    host.replaceChildren();
    if(!rows.length){host.append(make('p','가상 기록이 없습니다'));return;}
    for(const row of rows)host.append(displayRow(row,currentResource));
  }catch(e){host.replaceChildren(make('p',errorDescription(e)));}
}
async function restore(){
  client=newClient();
  events=[];
  el('activity').textContent='모의 작업 내역 없음';
  try{
    const profile=await client.getIdentity();
    el('identity').textContent='이름: '+profile.name+'\n등급: '+profile.role+'\nID: '+profile.id+'\n인증: 모의 JWT만 사용';
  }catch(e){el('identity').textContent=errorDescription(e);}
  await load();
}
for(const button of document.querySelectorAll('[data-resource]')){
  button.addEventListener('click',async()=>{
    currentResource=button.dataset.resource;
    for(const other of document.querySelectorAll('[data-resource]'))
      other.classList.toggle('active',other===button);
    await load();
  });
}
for(const button of document.querySelectorAll('[data-action]')){
  button.addEventListener('click',async()=>{
    button.disabled=true;
    const action=button.dataset.action;
    const id=Number(button.dataset.id);
    const extras=action==='rejectMember'||action==='rejectPayment'?
      {reason:'가상 검증용 거절 사유'}:
      action==='approvePayment'?{approvedAmount:35000}:{};
    try{
      const intent=client.prepare(action,id,extras);
      const result=await client.submit(intent);
      log('성공 (가상) · '+result.action+' / ID '+result.id+' / '+result.outcome);
      await load();
    }catch(e){log('실행 거부 (가상) · '+action+' / ID '+id+' / '+errorDescription(e));}
    finally{button.disabled=false;}
  });
}
el('reset').addEventListener('click',restore);
restore().catch(e=>{el('identity').textContent=String(e?.message??'시연 실패');});
