import {test} from 'node:test';
import assert from 'node:assert/strict';
import {handleAdminRead, RESOURCES} from './read-core.mjs';

const URL='https://example.supabase.co/functions/v1/qa-admin-read';
const AUTH='00000000-0000-4000-8000-000000000001';
const dev={enabled:true,adminId:10,username:'dev',displayName:'Developer',role:'dev',branchId:null,visibleBranchIds:null};
const branch={enabled:true,adminId:22,username:'branch',displayName:'Branch Manager',role:'branch',branchId:3,visibleBranchIds:[3,4]};
const user=(id,branch_id)=>({id,username:'test'+id,real_name:'Tester',status:'approved',branch_id,
 app_type:'toss',license_expires_at:'2099-01-01T00:00:00Z',password:'MUST_NOT_LEAK',resident_num:'MUST_NOT_LEAK',phone:'MUST_NOT_LEAK'});
const pay=(id,branch_id)=>({id,user_id:55,amount:'12000.00',status:'approved',created_at:'2026-11-01T00:00:00Z',branch_id,admin_note:'MUST_NOT_LEAK'});
const loc=(id)=>({id,name:'Test Branch',parent_id:null,type:'branch',manager_phone:'MUST_NOT_LEAK'});
function req(params='resource=members',options={}) {
  let url=URL+(params===null?'':'?'+params);
  let headers={origin:'https://tg-adminhub.github.io'};
  if(options.token!==null)headers.authorization='Bearer '+(options.token||'aaa.bbb.ccc');
  if(options.origin!==undefined)headers.origin=options.origin;
  if(options.cookie)headers.cookie=options.cookie;
  return new Request(url,{method:options.method||'GET',headers});
}
function d({admin=branch, rows=[user(1,3)], verify=async()=>AUTH, load=async()=>admin, query}={}) {
  return {verifyBearer:verify, loadAdmin:load,
    queryRead:query|| (async()=>rows)};
}

test('member read is scoped and projects only approved fields',async()=>{
  let observed;
  const res=await handleAdminRead(req(),d({
    query:async arg=>{observed=arg;return [user(1,3),user(2,4)]}
  }));
  assert.equal(res.status,200);
  const body=await res.json();
  assert.equal(body.items.length,2);
  assert.deepEqual(Object.keys(body.items[0]),RESOURCES.members);
  assert.equal(JSON.stringify(body).includes('MUST_NOT_LEAK'),false);
  assert.equal(observed.authUserId,AUTH);
  assert.equal(observed.resource,'members');
  assert.equal(observed.limit,25);
  assert.equal(observed.offset,0);
});

test('DB returning any out-of-scope member is rejected in full',async()=>{
  let res=await handleAdminRead(req(),d({rows:[user(1,3),user(2,999)]}));
  assert.equal(res.status,503);
  assert.equal((await res.json()).code,'READ_SCOPE_INTEGRITY_FAILURE');
});

test('DB returning an unassigned member for scoped admin is rejected',async()=>{
  assert.equal((await handleAdminRead(req(),d({rows:[user(1,null)]}))).status,503);
});

test('global developer may read across branches with server-verified role',async()=>{
  const res=await handleAdminRead(req(),d({admin:dev,rows:[user(1,3),user(2,999)]}));
  assert.equal(res.status,200);
  assert.equal((await res.json()).items.length,2);
});

test('payments are scoped to source member branch, not the client query',async()=>{
  const res=await handleAdminRead(req('resource=payments&limit=2&offset=3'),d({
    rows:[pay(8,3),pay(9,4)]
  }));
  assert.equal(res.status,200);
  const body=await res.json();
  assert.equal(body.offset,3);
  assert.equal(body.limit,2);
  assert.equal(body.morePossible,true);
  assert.equal(JSON.stringify(body).includes('admin_note'),false);
  assert.equal(JSON.stringify(body).includes('MUST_NOT_LEAK'),false);
  assert.deepEqual(Object.keys(body.items[0]),RESOURCES.payments);
});

test('payments outside organization scope fail closed',async()=>{
  const res=await handleAdminRead(req('resource=payments'),d({rows:[pay(8,30)]}));
  assert.equal(res.status,503);
});

test('branch directory returns only included branch IDs and safe columns',async()=>{
  const ok=await handleAdminRead(req('resource=branches'),d({rows:[loc(3),loc(4)]}));
  assert.equal(ok.status,200);
  assert.equal(JSON.stringify(await ok.json()).includes('manager_phone'),false);
  const bad=await handleAdminRead(req('resource=branches'),d({rows:[loc(3),loc(7)]}));
  assert.equal(bad.status,503);
});

test('client cannot request app settings or arbitrary tables',async()=>{
  for(const key of ['app_settings','admins','user_devices','users','../../admins','']) {
    assert.equal((await handleAdminRead(req('resource='+encodeURIComponent(key)),d())).status,400);
  }
});

test('client cannot claim another admin, role, sort or branch in query',async()=>{
  for(const extra of ['&adminId=1','&role=dev','&branch_id=3','&order=password']) {
    assert.equal((await handleAdminRead(req('resource=members'+extra),d())).status,400);
  }
});

test('duplicate and invalid pagination is rejected',async()=>{
  for(const params of ['resource=members&limit=0','resource=members&limit=101',
    'resource=members&offset=-1','resource=members&offset=10001',
    'resource=members&limit=5&limit=6','resource=members&offset=1.1',
    'resource=members&offset=1&offset=2']) {
    assert.equal((await handleAdminRead(req(params),d())).status,400);
  }
});

test('unverified JWT never triggers a DB read',async()=>{
  let reads=0;
  const deps=d({verify:async()=>null,query:async()=>{reads++;return []}});
  assert.equal((await handleAdminRead(req(),deps)).status,401);
  assert.equal(reads,0);
  assert.equal((await handleAdminRead(req('resource=members',{token:null}),deps)).status,401);
});

test('revoked mapping denies read even with JWT',async()=>{
  let enabled=true;
  const deps=d({load:async()=>({...branch,enabled})});
  assert.equal((await handleAdminRead(req(),deps)).status,200);
  enabled=false;
  assert.equal((await handleAdminRead(req(),deps)).status,403);
});

test('downstream outages fail closed',async()=>{
  assert.equal((await handleAdminRead(req(),d({verify:async()=>{throw Error('offline')}}))).status,503);
  assert.equal((await handleAdminRead(req(),d({load:async()=>{throw Error('offline')}}))).status,503);
  assert.equal((await handleAdminRead(req(),d({query:async()=>{throw Error('offline')}}))).status,503);
});

test('invalid response shape, oversized result and malformed scope never leak data',async()=>{
  const cases=[null,{},'oops', [user(1,3),user(2,3)], [{id:1,username:'x',branch_id:3},null]];
  for(const rows of cases) {
    const res=await handleAdminRead(req('resource=members&limit=1'),d({rows}));
    assert.equal(res.status,503);
  }
});

test('cross-site origin and cookie-based session denied',async()=>{
  const bad=await handleAdminRead(req('resource=members',{origin:'https://evil.example'}),d());
  assert.equal(bad.status,403);
  assert.equal(bad.headers.get('access-control-allow-origin'),null);
  assert.equal((await handleAdminRead(req('resource=members',{cookie:'qa_session=1'}),d())).status,400);
});

test('GET only, allowed preflight and exact endpoint paths',async()=>{
  assert.equal((await handleAdminRead(req('resource=members',{method:'POST'}),d())).status,405);
  const pf=await handleAdminRead(req('resource=members',{method:'OPTIONS'}),d());
  assert.equal(pf.status,204);
  assert.match(pf.headers.get('access-control-allow-headers'),/authorization/);
  assert.equal((await handleAdminRead(new Request('https://example.supabase.co/functions/v1/qa-admin-gateway'),d())).status,404);
});
