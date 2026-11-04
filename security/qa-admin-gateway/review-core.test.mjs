import {test} from 'node:test';
import assert from 'node:assert/strict';
import {handleMemberReview} from './review-core.mjs';

const URL='https://example.supabase.co/functions/v1/qa-member-review';
const USER='00000000-0000-4000-8000-000000000001';
const IDKEY='c6eb0e6c-d56d-4ba3-886b-3c4a80dc52c0';
const dev={enabled:true,adminId:1,username:'dev',displayName:'Developer',role:'dev',branchId:null,visibleBranchIds:null};
const master={enabled:true,adminId:2,username:'master',displayName:'Master',role:'master',branchId:8,visibleBranchIds:[8,9]};
const approve={action:'member.approve',memberId:44,expectedStatus:'pending',idempotencyKey:IDKEY};
const reject={...approve,action:'member.reject',reason:'Invalid application data'};

function request(body=approve,{token='aaa.bbb.ccc',method='POST',origin='https://tg-adminhub.github.io',url=URL,headers={}}={}) {
  const h={'content-type':'application/json',origin,...headers};
  if(token!==null)h.authorization='Bearer '+token;
  return new Request(url,{method,headers:h,...(['POST','PUT','PATCH'].includes(method)?{body:typeof body==='string'?body:JSON.stringify(body)}:{})});
}

function dependencies(overrides={}) {
  return {
    verifyBearer:async t=>t==='aaa.bbb.ccc'?USER:null,
    loadAdmin:async()=>dev,
    executeReview:async ({action,memberId})=>({memberId,status:action==='member.approve'?'approved':'rejected',outcome:'updated'}),
    ...overrides
  };
}
test('approval allows only server-verified dev and sends bounded allowlisted fields',async()=>{
  let captured;
  const result=await handleMemberReview(request(),dependencies({
    executeReview:async fields=>{captured=fields;return {memberId:44,status:'approved',outcome:'updated',password:'NEVER_RETURN'};}
  }));
  assert.equal(result.status,200);
  assert.deepEqual(await result.json(),{ok:true,memberId:44,status:'approved',outcome:'updated'});
  assert.deepEqual(captured,{authUserId:USER,action:'member.approve',memberId:44,expectedStatus:'pending',idempotencyKey:IDKEY,reason:null});
});

test('rejection requires reason and uses the same protected RPC',async()=>{
  let args;
  const r=await handleMemberReview(request(reject),dependencies({
    executeReview:async x=>{args=x;return {memberId:44,status:'rejected',outcome:'updated'};}
  }));
  assert.equal(r.status,200);
  assert.equal(args.reason,'Invalid application data');
});

test('no JWT, bogus JWT, and invalid Auth rejection never reach DB mutation',async()=>{
  let mutations=0;
  const deps=dependencies({executeReview:async()=>{mutations++;return {}}});
  assert.equal((await handleMemberReview(request(approve,{token:null}),deps)).status,401);
  assert.equal((await handleMemberReview(request(approve,{token:'bogus'}),deps)).status,401);
  assert.equal((await handleMemberReview(request(approve,{token:'different.jwt.string'}),deps)).status,401);
  assert.equal(mutations,0);
});

test('master branch and sub cannot approve because write policy is not yet audited',async()=>{
  let mutations=0;
  for(const role of ['master','branch','sub']) {
    const profile={...master,role};
    const response=await handleMemberReview(request(),dependencies({
      loadAdmin:async()=>profile,
      executeReview:async()=>{mutations++;return {}}
    }));
    assert.equal(response.status,403);
    assert.equal((await response.json()).code,'ADMIN_WRITE_DENIED');
  }
  assert.equal(mutations,0);
});

test('dev mapping revoked on next request prevents subsequent mutation',async()=>{
  let enabled=true, mutations=0;
  const deps=dependencies({
    loadAdmin:async()=>({...dev,enabled}),
    executeReview:async()=>{mutations++;return {memberId:44,status:'approved',outcome:'updated'};}
  });
  assert.equal((await handleMemberReview(request(),deps)).status,200);
  enabled=false;
  assert.equal((await handleMemberReview(request(),deps)).status,403);
  assert.equal(mutations,1);
});

test('reject privileged fields and arbitrary updates from browser',async()=>{
  let mutations=0;
  const deps=dependencies({executeReview:async()=>{mutations++;return {}}});
  for(const injected of [
    {...approve,role:'dev'},
    {...approve,adminId:1},
    {...approve,branchId:8},
    {...approve,license_expires_at:'2099-01-01'},
    {...approve,password:'123456'},
    {...approve,status:'approved'},
    {...approve,amount:5000000},
    {...approve,targetTable:'admins'},
    {...approve,idempotencyKey:'not-a-uuid'},
    {...approve,idempotencyKey:null},
    {...approve,idempotencyKey:'00000000-0000-0000-0000-000000000000'},
    {...approve,memberId:0},
    {...approve,memberId:1.5},
    {...approve,memberId:'44'},
    {...approve,memberId:Number.MAX_SAFE_INTEGER+1},
    {...approve,expectedStatus:'approved'},
    {...approve,action:'member.delete'},
    {...approve,action:'member.suspend'},
    {...approve,reason:'unexpected'},
    {...reject,reason:''},
    {...reject,reason:' '.repeat(10)},
    {...reject,reason:'x'.repeat(201)}
  ]) {
    const r=await handleMemberReview(request(injected),deps);
    assert.equal(r.status,400,JSON.stringify(injected));
  }
  assert.equal(mutations,0);
});

test('unknown paths, methods and query parameters are refused',async()=>{
  const deps=dependencies();
  assert.equal((await handleMemberReview(request(approve,{method:'GET'}),deps)).status,405);
  assert.equal((await handleMemberReview(request(approve,{url:URL+'?adminId=1'}),deps)).status,400);
  assert.equal((await handleMemberReview(request(approve,{url:'https://example.supabase.co/functions/v1/qa-admin-read'}),deps)).status,404);
});

test('untrusted origin and cookie-based session rejected',async()=>{
  const deps=dependencies();
  const r=await handleMemberReview(request(approve,{origin:'https://attacker.example'}),deps);
  assert.equal(r.status,403);
  assert.equal(r.headers.get('access-control-allow-origin'),null);
  assert.equal((await handleMemberReview(request(approve,{headers:{cookie:'qa_session=dev'}}),deps)).status,400);
});

test('no JSON content-type, invalid JSON, array JSON, or oversized body rejected',async()=>{
  const deps=dependencies();
  assert.equal((await handleMemberReview(request(approve,{headers:{'content-type':'text/plain'}}),deps)).status,415);
  for(const input of ['invalid','[]','null',JSON.stringify({...approve,pad:'x'.repeat(5000)})]) {
    assert.equal((await handleMemberReview(request(input),deps)).status,400);
  }
});

test('Auth and database outages fail closed',async()=>{
  assert.equal((await handleMemberReview(request(),dependencies({verifyBearer:async()=>{throw Error('network')}}))).status,503);
  assert.equal((await handleMemberReview(request(),dependencies({loadAdmin:async()=>{throw Error('network')}}))).status,503);
  assert.equal((await handleMemberReview(request(),dependencies({executeReview:async()=>{throw Error('network')}}))).status,503);
});

test('result mismatch and invalid result never report success',async()=>{
  for(const result of [null,{},[],{memberId:43,status:'approved',outcome:'updated'},
    {memberId:44,status:'rejected',outcome:'updated'}, {memberId:44,status:'approved',outcome:'pending'}]) {
    const response=await handleMemberReview(request(),dependencies({executeReview:async()=>result}));
    assert.equal(response.status,503);
    assert.equal((await response.json()).code,'REVIEW_RESULT_INVALID');
  }
});

test('duplicate idempotency result is safe and does not expose internal payload',async()=>{
  const executed=new Set();
  const deps=dependencies({executeReview:async ({idempotencyKey,memberId,action})=>{
    const first=!executed.has(idempotencyKey);
    executed.add(idempotencyKey);
    return {memberId,status:action==='member.approve'?'approved':'rejected',outcome:first?'updated':'duplicate',password:'private'};
  }});
  const first=await handleMemberReview(request(),deps);
  const again=await handleMemberReview(request(),deps);
  assert.deepEqual(await first.json(),{ok:true,memberId:44,status:'approved',outcome:'updated'});
  assert.deepEqual(await again.json(),{ok:true,memberId:44,status:'approved',outcome:'duplicate'});
});

test('preflight does not permit writes and only advertises POST',async()=>{
  const r=await handleMemberReview(request(approve,{method:'OPTIONS',token:null}),dependencies());
  assert.equal(r.status,204);
  assert.equal(r.headers.get('access-control-allow-methods'),'POST, OPTIONS');
});

test('all request fields must originate in the provided allowlist',async()=>{
  const fake=JSON.stringify(approve).replace('"memberId":44','"memberId":44,"__proto__":{"role":"dev"}');
  const result=await handleMemberReview(request(fake),dependencies());
  assert.equal(result.status,400);
});
