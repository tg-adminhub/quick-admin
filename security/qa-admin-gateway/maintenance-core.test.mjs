import {test} from 'node:test';
import assert from 'node:assert/strict';
import {handleMemberMaintenance,validateMaintenanceBody} from './maintenance-core.mjs';

const U='00000000-0000-4000-8000-000000000001';
const URL='https://example.supabase.co/functions/v1/qa-member-maintenance';
const KEY='8707257c-91a8-4c32-a70b-971c4f447c95';
const dev={enabled:true,adminId:1,username:'dev',displayName:'Developer',role:'dev',branchId:null,visibleBranchIds:null};
const branch={enabled:true,adminId:2,username:'branch',displayName:'Manager',role:'branch',branchId:3,visibleBranchIds:[3,4]};
const pause={action:'member.pause',memberId:44,expectedState:'active',idempotencyKey:KEY};
const resume={...pause,action:'member.resume',expectedState:'paused'};
const resetMain={...pause,action:'device.reset_main',expectedState:'bound'};
const resetExtra={...pause,action:'device.reset_extra',expectedState:'bound',deviceId:7};
function make(body=pause,{token='aaa.bbb.ccc',origin='https://tg-adminhub.github.io',method='POST',url=URL,headers={}}={}){
  const h={origin,'content-type':'application/json',...headers};
  if(token!==null)h.authorization='Bearer '+token;
  return new Request(url,{method,headers:h,...(method==='POST'?{body:typeof body==='string'?body:JSON.stringify(body)}:{})});
}
function deps(overrides={}){
  return {
    verifyBearer:async token=>token==='aaa.bbb.ccc'?U:null,
    loadAdmin:async()=>dev,
    executeMutation:async ({action,memberId})=>({action,memberId,outcome:'updated'}),
    ...overrides
  };
}

test('all four allowlisted maintenance actions are normalized and audited',async()=>{
  for(const body of [pause,resume,resetMain,resetExtra]){
    let received;
    const res=await handleMemberMaintenance(make(body),deps({
      executeMutation:async x=>{received=x;return {action:x.action,memberId:x.memberId,outcome:'updated',android_id:'DO_NOT_LEAK'};}
    }));
    assert.equal(res.status,200,body.action);
    assert.deepEqual(await res.json(),{ok:true,memberId:44,action:body.action,outcome:'updated'});
    assert.equal(received.authUserId,U);
    assert.equal(received.deviceId,body.action==='device.reset_extra'?7:null);
    assert.equal(received.idempotencyKey,KEY);
    assert.equal(received.expectedState,body.expectedState);
  }
});

test('extra device reset requires deviceId; all other actions must omit it',()=>{
  assert.equal(validateMaintenanceBody({...resetExtra,deviceId:null}),null);
  assert.equal(validateMaintenanceBody({...resetExtra,deviceId:'7'}),null);
  assert.equal(validateMaintenanceBody({...resetExtra,deviceId:0}),null);
  assert.equal(validateMaintenanceBody({...resetMain,deviceId:7}),null);
  assert.equal(validateMaintenanceBody({...pause,deviceId:7}),null);
});

test('unknown fields and client-supplied role, admin ID, timestamps are refused',async()=>{
  let changed=0;
  const d=deps({executeMutation:async()=>{changed++;return {};}});
  for(const obj of [
    {...pause,adminId:1},{...pause,role:'dev'},{...pause,branchId:3},
    {...pause,expiresAt:'2099-01-01'},{...pause,remainingDays:3650},
    {...pause,androidId:'attacker-value'},{...pause,main_android_id:null},
    {...pause,action:'member.delete'},{...pause,action:'device.add'},
    {...pause,expectedState:'paused'},{...resume,expectedState:'active'},
    {...pause,memberId:0},{...pause,memberId:1.5},{...pause,memberId:'44'},
    {...pause,idempotencyKey:'bogus'},
    {...pause,idempotencyKey:'00000000-0000-0000-0000-000000000000'},
    {...pause,expectedState:null},
    {...resetExtra,deviceId:Number.MAX_SAFE_INTEGER+1}
  ]){
    const r=await handleMemberMaintenance(make(obj),d);
    assert.equal(r.status,400,JSON.stringify(obj));
  }
  assert.equal(changed,0);
});

test('unverified session, revoked admin and non-dev role are denied',async()=>{
  let mutations=0;
  const fn=async()=>{mutations++;return {memberId:44,action:'member.pause',outcome:'updated'}};
  assert.equal((await handleMemberMaintenance(make(pause,{token:null}),deps({executeMutation:fn}))).status,401);
  assert.equal((await handleMemberMaintenance(make(pause,{token:'bad'}),deps({executeMutation:fn}))).status,401);
  assert.equal((await handleMemberMaintenance(make(),deps({verifyBearer:async()=>null,executeMutation:fn}))).status,401);
  assert.equal((await handleMemberMaintenance(make(),deps({loadAdmin:async()=>({...dev,enabled:false}),executeMutation:fn}))).status,403);
  for(const role of ['master','branch','sub']){
    const r=await handleMemberMaintenance(make(),deps({loadAdmin:async()=>({...branch,role}),executeMutation:fn}));
    assert.equal(r.status,403);
  }
  assert.equal(mutations,0);
});

test('revoking admin mapping between calls stops next mutation',async()=>{
  let enabled=true;let count=0;
  const d=deps({loadAdmin:async()=>({...dev,enabled}),executeMutation:async x=>{count++;return {action:x.action,memberId:x.memberId,outcome:'updated'}}});
  assert.equal((await handleMemberMaintenance(make(),d)).status,200);
  enabled=false;
  assert.equal((await handleMemberMaintenance(make(),d)).status,403);
  assert.equal(count,1);
});

test('duplicate idempotency response is bounded',async()=>{
  const seen=new Set();
  const d=deps({executeMutation:async x=>{
    const exists=seen.has(x.idempotencyKey);
    seen.add(x.idempotencyKey);
    return {action:x.action,memberId:x.memberId,outcome:exists?'duplicate':'updated',password:'secret'};
  }});
  assert.equal((await (await handleMemberMaintenance(make(),d)).json()).outcome,'updated');
  const repeated=await (await handleMemberMaintenance(make(),d)).json();
  assert.equal(repeated.outcome,'duplicate');
  assert.equal(JSON.stringify(repeated).includes('secret'),false);
});

test('unexpected DB results are never successful',async()=>{
  for(const result of [null,{},[],{action:'member.resume',memberId:44,outcome:'updated'},
      {action:'member.pause',memberId:45,outcome:'updated'},
      {action:'member.pause',memberId:44,outcome:'unknown'}]){
    const r=await handleMemberMaintenance(make(),deps({executeMutation:async()=>result}));
    assert.equal(r.status,503);
    assert.equal((await r.json()).code,'MAINTENANCE_RESULT_INVALID');
  }
});

test('provider outages fail closed',async()=>{
  assert.equal((await handleMemberMaintenance(make(),deps({verifyBearer:async()=>{throw Error('offline')}}))).status,503);
  assert.equal((await handleMemberMaintenance(make(),deps({loadAdmin:async()=>{throw Error('offline')}}))).status,503);
  assert.equal((await handleMemberMaintenance(make(),deps({executeMutation:async()=>{throw Error('offline')}}))).status,503);
});

test('unexpected paths, methods, cookie and query-string attempts are denied',async()=>{
  assert.equal((await handleMemberMaintenance(make(pause,{url:URL+'?role=dev'}),deps())).status,400);
  assert.equal((await handleMemberMaintenance(make(pause,{url:URL+'/grant'}),deps())).status,404);
  assert.equal((await handleMemberMaintenance(make(pause,{method:'GET'}),deps())).status,405);
  assert.equal((await handleMemberMaintenance(make(pause,{headers:{cookie:'qa_session=1'}}),deps())).status,400);
  const pf=await handleMemberMaintenance(make(pause,{method:'OPTIONS',token:null}),deps());
  assert.equal(pf.status,204);
  assert.equal(pf.headers.get('access-control-allow-methods'),'POST, OPTIONS');
});

test('CORS origin is not authorization and attacker origins are refused',async()=>{
  const r=await handleMemberMaintenance(make(pause,{origin:'https://attacker.example'}),deps());
  assert.equal(r.status,403);
  assert.equal(r.headers.get('access-control-allow-origin'),null);
});

test('malformed, oversized and non-JSON bodies are refused',async()=>{
  assert.equal((await handleMemberMaintenance(make(pause,{headers:{'content-type':'text/plain'}}),deps())).status,415);
  for(const body of ['invalid','[]','null',JSON.stringify({...pause,pad:'x'.repeat(4000)})]){
    assert.equal((await handleMemberMaintenance(make(body),deps())).status,400);
  }
});

test('prototype pollution keys are not accepted as fields',async()=>{
  const raw=JSON.stringify(pause).replace('"memberId":44','"memberId":44,"__proto__":{"role":"dev"}');
  assert.equal((await handleMemberMaintenance(make(raw),deps())).status,400);
});
