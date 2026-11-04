import {test} from 'node:test';
import assert from 'node:assert/strict';
import {handlePaymentReview,validatePaymentReview} from './payment-core.mjs';

const URL='https://example.supabase.co/functions/v1/qa-payment-review';
const USER='00000000-0000-4000-8000-000000000001';
const KEY='41a7f50f-6f8d-4fe9-a53f-e67f88a4228a';
const dev={enabled:true,adminId:1,username:'dev',displayName:'Developer',role:'dev',branchId:null,visibleBranchIds:null};
const branch={enabled:true,adminId:2,username:'manager',displayName:'Manager',role:'branch',branchId:5,visibleBranchIds:[5,6]};
const approve={action:'payment.approve',paymentId:17,expectedStatus:'pending',idempotencyKey:KEY,approvedAmount:35000};
const reject={action:'payment.reject',paymentId:17,expectedStatus:'pending',idempotencyKey:KEY,reason:'Bank transfer not verified'};
function req(body=approve,{token='aaa.bbb.ccc',origin='https://tg-adminhub.github.io',url=URL,method='POST',headers={}}={}){
  const h={origin,'content-type':'application/json',...headers};
  if(token!==null)h.authorization='Bearer '+token;
  return new Request(url,{method,headers:h,...(method==='POST'?{body:typeof body==='string'?body:JSON.stringify(body)}:{})});
}
function deps(overrides={}){
  return {
    verifyBearer:async token=>token==='aaa.bbb.ccc'?USER:null,
    loadAdmin:async()=>dev,
    executeReview:async ({action,paymentId})=>({paymentId,status:action==='payment.approve'?'approved':'rejected',outcome:'updated'}),
    ...overrides
  };
}
test('approved payment has server-verified user and bounded amount, no arbitrary fields',async()=>{
  let received;
  const r=await handlePaymentReview(req(),deps({
    executeReview:async x=>{received=x;return {paymentId:17,status:'approved',outcome:'updated',bankAccount:'private'};}
  }));
  assert.equal(r.status,200);
  assert.deepEqual(await r.json(),{ok:true,paymentId:17,status:'approved',outcome:'updated'});
  assert.deepEqual(received,{authUserId:USER,action:'payment.approve',paymentId:17,expectedStatus:'pending',idempotencyKey:KEY,approvedAmount:35000,reason:null});
});

test('payment rejection reason is required, trimmed, and never disclosed in response',async()=>{
  let received;
  const res=await handlePaymentReview(req({...reject,reason:'  not paid  '}),deps({
    executeReview:async x=>{received=x;return {paymentId:17,status:'rejected',outcome:'updated'};}
  }));
  assert.equal(res.status,200);
  assert.equal(received.reason,'not paid');
  assert.equal(JSON.stringify(await res.json()).includes('not paid'),false);
});

test('untrusted role, admin, amount override and other fields are rejected',async()=>{
  let calls=0;
  const d=deps({executeReview:async()=>{calls++;return {};}});
  for(const o of [
    {...approve,adminId:1},{...approve,role:'dev'},
    {...approve,branchId:3},{...approve,days:5000},
    {...approve,memberId:1},{...approve,userId:7},
    {...approve,deviceId:1},{...approve,isNew:true},
    {...approve,license_expires_at:'2099-01-01'},
    {...approve,expectedStatus:'approved'},
    {...approve,action:'payment.delete'},
    {...approve,action:'payment.device_add'},
    {...approve,paymentId:0},{...approve,paymentId:'17'},
    {...approve,approvedAmount:0},{...approve,approvedAmount:10000001},
    {...approve,approvedAmount:5.5},{...approve,approvedAmount:'35000'},
    {...approve,approvedAmount:null},{...approve,idempotencyKey:'not-uuid'},
    {...approve,idempotencyKey:'00000000-0000-0000-0000-000000000000'},
    {...reject,reason:''},{...reject,reason:'   '},
    {...reject,reason:'x'.repeat(201)},{...reject,approvedAmount:35000}
  ]){
    const r=await handlePaymentReview(req(o),d);
    assert.equal(r.status,400,JSON.stringify(o));
  }
  assert.equal(calls,0);
});

test('suspension, no mapping and non-dev roles deny mutation',async()=>{
  let calls=0;
  const executeReview=async()=>{calls++;return {}};
  assert.equal((await handlePaymentReview(req(approve,{token:null}),deps({executeReview}))).status,401);
  assert.equal((await handlePaymentReview(req(approve,{token:'bad'}),deps({executeReview}))).status,401);
  assert.equal((await handlePaymentReview(req(),deps({loadAdmin:async()=>null,executeReview}))).status,403);
  assert.equal((await handlePaymentReview(req(),deps({loadAdmin:async()=>({...dev,enabled:false}),executeReview}))).status,403);
  for(const role of ['master','branch','sub'])
    assert.equal((await handlePaymentReview(req(),deps({loadAdmin:async()=>({...branch,role}),executeReview}))).status,403);
  assert.equal(calls,0);
});

test('mapping revocation is checked again on each request',async()=>{
  let enabled=true,changes=0;
  const d=deps({
    loadAdmin:async()=>({...dev,enabled}),
    executeReview:async x=>{changes++;return {paymentId:x.paymentId,status:'approved',outcome:'updated'};}
  });
  assert.equal((await handlePaymentReview(req(),d)).status,200);
  enabled=false;
  assert.equal((await handlePaymentReview(req(),d)).status,403);
  assert.equal(changes,1);
});

test('retry result is idempotent and never exposes private data',async()=>{
  const seen=new Set();
  const d=deps({executeReview:async x=>{
    const exists=seen.has(x.idempotencyKey);
    seen.add(x.idempotencyKey);
    return {paymentId:x.paymentId,status:'approved',outcome:exists?'duplicate':'updated',accountNumber:'never-leak'};
  }});
  assert.equal((await (await handlePaymentReview(req(),d)).json()).outcome,'updated');
  const repeated=await (await handlePaymentReview(req(),d)).json();
  assert.equal(repeated.outcome,'duplicate');
  assert.equal(JSON.stringify(repeated).includes('never-leak'),false);
});

test('invalid DB results are not treated as successful',async()=>{
  for(const result of [null,{},[],{paymentId:17,status:'pending',outcome:'updated'},
    {paymentId:18,status:'approved',outcome:'updated'},
    {paymentId:17,status:'approved',outcome:'error'}]){
    const res=await handlePaymentReview(req(),deps({executeReview:async()=>result}));
    assert.equal(res.status,503);
    assert.equal((await res.json()).code,'PAYMENT_REVIEW_RESULT_INVALID');
  }
});

test('provider errors fail closed',async()=>{
  assert.equal((await handlePaymentReview(req(),deps({verifyBearer:async()=>{throw Error('offline')}}))).status,503);
  assert.equal((await handlePaymentReview(req(),deps({loadAdmin:async()=>{throw Error('offline')}}))).status,503);
  assert.equal((await handlePaymentReview(req(),deps({executeReview:async()=>{throw Error('offline')}}))).status,503);
});

test('no arbitrary URL, GET, cookies, query privileges or cross-origin requests',async()=>{
  const d=deps();
  assert.equal((await handlePaymentReview(req(approve,{method:'GET'}),d)).status,405);
  assert.equal((await handlePaymentReview(req(approve,{url:URL+'?role=dev'}),d)).status,400);
  assert.equal((await handlePaymentReview(req(approve,{url:URL+'/admin'}),d)).status,404);
  assert.equal((await handlePaymentReview(req(approve,{headers:{cookie:'qa_session=admin'}}),d)).status,400);
  const bad=await handlePaymentReview(req(approve,{origin:'https://attacker.example'}),d);
  assert.equal(bad.status,403);
  assert.equal(bad.headers.get('access-control-allow-origin'),null);
  const preflight=await handlePaymentReview(req(approve,{method:'OPTIONS',token:null}),d);
  assert.equal(preflight.status,204);
});

test('oversize and invalid JSON requests refused',async()=>{
  const d=deps();
  for(const body of ['invalid','[]','null',JSON.stringify({...approve,pad:'x'.repeat(3500)})])
    assert.equal((await handlePaymentReview(req(body),d)).status,400);
  assert.equal((await handlePaymentReview(req(approve,{headers:{'content-type':'text/plain'}}),d)).status,415);
});

test('prototype pollution-style unknown JSON keys cannot authorize actions',async()=>{
  const raw=JSON.stringify(approve).replace('"paymentId":17','"paymentId":17,"__proto__":{"role":"dev"}');
  assert.equal((await handlePaymentReview(req(raw),deps())).status,400);
});

test('approval and rejection shape allowlist disallows accidental new-license or device-add flags',()=>{
  assert.equal(validatePaymentReview({...approve,isNewApproval:true}),null);
  assert.equal(validatePaymentReview({...approve,isDevAdd:true}),null);
  assert.equal(validatePaymentReview({...approve,deviceAddPhone:'01000000000'}),null);
  assert.equal(validatePaymentReview({...approve,reason:'not allowed'}),null);
});
