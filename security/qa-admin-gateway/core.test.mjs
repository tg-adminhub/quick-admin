import {test} from 'node:test';
import assert from 'node:assert/strict';
import {handleAdminGateway, ALLOWED_ORIGIN} from './core.mjs';

const USER='00000000-0000-4000-8000-000000000001';
const TOKEN='aaa.bbb.ccc';
const URL='https://example.supabase.co/functions/v1/qa-admin-gateway';
const goodDev = Object.freeze({
  enabled:true, adminId:7, username:'admin-test', displayName:'Dev Admin',
  role:'dev', branchId:null, visibleBranchIds:null,
  password:'FORBIDDEN_TO_EXPOSE'
});
const goodScoped = Object.freeze({
  enabled:true, adminId:11, username:'branch-test', displayName:'Branch Admin',
  role:'branch', branchId:3, visibleBranchIds:[3,4,5]
});
function req({token=TOKEN, origin=ALLOWED_ORIGIN, method='GET', url=URL, extraHeaders={}}={}) {
  const headers={...extraHeaders};
  if (token !== null) headers.authorization='Bearer '+token;
  if (origin !== null) headers.origin=origin;
  return new Request(url,{method,headers});
}
function deps(profile=goodDev) {
  return {verifyBearer:async token=>token===TOKEN?USER:null, loadAdmin:async userId=>userId===USER?profile:null};
}

test('valid verified Auth user and linked dev admin gets minimal profile only',async()=>{
  const res=await handleAdminGateway(req(),deps());
  assert.equal(res.status,200);
  assert.equal(res.headers.get('cache-control'),'no-store');
  assert.equal(res.headers.get('access-control-allow-origin'),ALLOWED_ORIGIN);
  const body=await res.json();
  assert.equal(body.ok,true);
  assert.equal(body.admin.id,7);
  assert.equal(body.admin.visibleBranchIds,null);
  assert.equal(body.admin.role,'dev');
  assert.equal(JSON.stringify(body).includes('FORBIDDEN_TO_EXPOSE'),false);
  assert.equal(JSON.stringify(body).includes('password'),false);
});

test('browser-provided adminId, role and branch cannot override server-verified profile',async()=>{
  const url=URL+'?adminId=1&role=dev';
  const badQuery=await handleAdminGateway(req({url}),deps(goodScoped));
  assert.equal(badQuery.status,400);
  const res=await handleAdminGateway(req(),deps(goodScoped));
  assert.equal(res.status,200);
  const {admin}=await res.json();
  assert.equal(admin.role,'branch');
  assert.equal(admin.branchId,3);
  assert.deepEqual(admin.visibleBranchIds,[3,4,5]);
});

test('server re-reads permissions: revocation takes effect on next request',async()=>{
  let profile=goodScoped;
  const handlers={verifyBearer:async()=>USER,loadAdmin:async()=>profile};
  assert.equal((await handleAdminGateway(req(),handlers)).status,200);
  profile={...goodScoped,enabled:false};
  assert.equal((await handleAdminGateway(req(),handlers)).status,403);
});

test('missing verified Auth mapping is forbidden',async()=>{
  assert.equal((await handleAdminGateway(req(),deps(null))).status,403);
});

test('unverified and malformed bearer tokens denied',async()=>{
  assert.equal((await handleAdminGateway(req({token:null}),deps())).status,401);
  assert.equal((await handleAdminGateway(req({token:'not-jwt'}),deps())).status,401);
  assert.equal((await handleAdminGateway(req({token:'x'.repeat(8200)}),deps())).status,401);
  assert.equal((await handleAdminGateway(req({token:'other.jwt.token'}),deps())).status,401);
});

test('Auth provider outage fails closed to 503',async()=>{
  const h={verifyBearer:async()=>{throw Error('network')},loadAdmin:async()=>goodDev};
  const res=await handleAdminGateway(req(),h);
  assert.equal(res.status,503);
  assert.equal((await res.json()).code,'AUTH_UNAVAILABLE');
});

test('privileged RPC outage fails closed to 503',async()=>{
  const h={verifyBearer:async()=>USER,loadAdmin:async()=>{throw Error('db')}};
  assert.equal((await handleAdminGateway(req(),h)).status,503);
});

test('client supplies wrong origin: no CORS credentials and 403',async()=>{
  const res=await handleAdminGateway(req({origin:'https://evil.example'}),deps());
  assert.equal(res.status,403);
  assert.equal(res.headers.get('access-control-allow-origin'),null);
});

test('preflight only from approved origin',async()=>{
  const res=await handleAdminGateway(req({method:'OPTIONS',token:null}),deps());
  assert.equal(res.status,204);
  assert.match(res.headers.get('access-control-allow-headers'),/authorization/);
  const bad=await handleAdminGateway(req({method:'OPTIONS',origin:'https://evil.example'}),deps());
  assert.equal(bad.status,403);
});

test('no write actions and no unexpected endpoints',async()=>{
  assert.equal((await handleAdminGateway(req({method:'POST'}),deps())).status,405);
  assert.equal((await handleAdminGateway(req({url:'https://example.supabase.co/functions/v1/bad'}),deps())).status,404);
});

test('cookie-based and query-string privilege attempts refused',async()=>{
  assert.equal((await handleAdminGateway(req({extraHeaders:{cookie:'qa_session=admin'}}),deps())).status,400);
  assert.equal((await handleAdminGateway(req({url:URL+'?role=dev'}),deps())).status,400);
});

test('unknown role or malformed scope denied',async()=>{
  for (const profile of [
    {...goodScoped,role:'owner'},
    {...goodScoped,branchId:null},
    {...goodScoped,visibleBranchIds:[]},
    {...goodScoped,visibleBranchIds:[4,5]},
    {...goodScoped,visibleBranchIds:[3,-1]},
    {...goodDev,visibleBranchIds:[1]},
    {...goodScoped,enabled:false},
    {...goodScoped,adminId:'11'}
  ]) assert.equal((await handleAdminGateway(req(),deps(profile))).status,403);
});

test('scope normalization drops duplicates and sorts branch IDs',async()=>{
  const res=await handleAdminGateway(req(),deps({...goodScoped,visibleBranchIds:[5,3,5,4]}));
  assert.equal(res.status,200);
  assert.deepEqual((await res.json()).admin.visibleBranchIds,[3,4,5]);
});

test('allow optional /me suffix for clients',async()=>{
  const res=await handleAdminGateway(req({url:URL+'/me'}),deps());
  assert.equal(res.status,200);
});
