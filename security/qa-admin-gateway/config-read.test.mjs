import {test} from 'node:test';
import assert from 'node:assert/strict';
import {handleAdminRead} from './read-core.mjs';
import {createProtectedAdminClient} from '../ui/secure-admin-client.mjs';

const UID='00000000-0000-4000-8000-000000000001';
const URL='https://example.supabase.co/functions/v1/qa-admin-read';
const DEV={enabled:true,adminId:1,username:'dev',displayName:'Developer',role:'dev',branchId:null,visibleBranchIds:null};
const BRANCH={enabled:true,adminId:2,username:'branch',displayName:'Manager',role:'branch',branchId:3,visibleBranchIds:[3]};
const SAMPLE_ADMINS=[
  {id:1,username:'dev-test',name:'Developer',role:'dev',branch_id:null,password:'HASH_NOT_FOR_BROWSER'},
  {id:2,username:'branch-test',name:'Branch',role:'branch',branch_id:3,password:'HASH_NOT_FOR_BROWSER'}
];
const SAMPLE_FLAGS=[
  {id:1,key:'payment_visible',value:'true',updated_at:'2026-11-03T00:00:00Z',secret:'NEVER'},
  {id:2,key:'maintenance_mode',value:'false',updated_at:'2026-11-03T00:00:00Z',secret:'NEVER'}
];
function req(resource) {
  return new Request(URL+'?resource='+resource,{headers:{
    origin:'https://tg-adminhub.github.io',authorization:'Bearer a.b.c'
  }});
}
function dep(profile,rows,spy) {
  return {verifyBearer:async()=>UID,loadAdmin:async()=>profile,
    queryRead:async data=>{spy.calls++;assert.equal(data.authUserId,UID);return rows}};
}
test('dev-only admin directory returns no password/hash',async()=>{
  const spy={calls:0};
  const r=await handleAdminRead(req('admin_directory'),dep(DEV,SAMPLE_ADMINS,spy));
  assert.equal(r.status,200);
  const result=await r.json();
  assert.deepEqual(Object.keys(result.items[0]),['id','username','name','role','branch_id']);
  assert.equal(JSON.stringify(result).includes('HASH_NOT_FOR_BROWSER'),false);
  assert.equal(spy.calls,1);
});
test('nondev cannot query admins or settings even if DB mock would return data',async()=>{
  for(const resource of ['admin_directory','setting_flags']){
    const spy={calls:0};
    const r=await handleAdminRead(req(resource),dep(BRANCH,
      resource==='admin_directory'?SAMPLE_ADMINS:SAMPLE_FLAGS,spy));
    assert.equal(r.status,403);
    assert.equal(spy.calls,0);
  }
});
test('only two nonsecret boolean flags may pass; a secret row fails entire response',async()=>{
  const spy={calls:0};
  const yes=await handleAdminRead(req('setting_flags'),dep(DEV,SAMPLE_FLAGS,spy));
  assert.equal(yes.status,200);
  const data=await yes.json();
  assert.deepEqual(Object.keys(data.items[0]),['id','key','value','updated_at']);
  assert.equal(JSON.stringify(data).includes('NEVER'),false);
  for(const row of [
    {id:10,key:'tg_bot_token',value:'SENSITIVE'},
    {id:11,key:'payment_account',value:'123'},
    {id:12,key:'payment_visible',value:'on'},
    {id:13,key:'maintenance_mode',value:null}
  ]){
    const fail=await handleAdminRead(req('setting_flags'),dep(DEV,[row],{calls:0}));
    assert.equal(fail.status,503);
  }
});
test('invalid admin directory records fail closed',async()=>{
  for(const row of [
    {id:6,username:'admin',name:'Name',role:'owner'},
    {id:6,username:'',name:'Name',role:'dev'},
    {id:6,username:'admin',name:'',role:'dev'}
  ]){
    const r=await handleAdminRead(req('admin_directory'),dep(DEV,[row],{calls:0}));
    assert.equal(r.status,503);
  }
});
test('browser adapter can read only projected admin directory and flags via fixed gateway',async()=>{
  const calls=[];
  const api=createProtectedAdminClient({
    getAccessToken:async()=> 'a.b.c',randomUUID:()=> '00000000-0000-4000-8000-000000000001',
    fetchImpl:async(url)=>{
      calls.push(url);
      const q=new URL(url).searchParams, resource=q.get('resource');
      const rows=resource==='admin_directory'?SAMPLE_ADMINS:SAMPLE_FLAGS;
      return {ok:true,status:200,json:async()=>({
        ok:true,resource,limit:25,offset:0,items:rows
      })};
    }
  });
  const admins=await api.getList('admin_directory');
  assert.equal(admins.length,2);
  assert.equal(admins[0].password,undefined);
  const flags=await api.getList('setting_flags');
  assert.equal(flags[0].secret,undefined);
  assert.equal(calls.length,2);
  assert.ok(calls.every(c=>new URL(c).pathname==='/functions/v1/qa-admin-read'));
  await assert.rejects(api.getList('admins'),e=>e.code==='INVALID_QUERY');
  await assert.rejects(api.getList('app_settings'),e=>e.code==='INVALID_QUERY');
});
