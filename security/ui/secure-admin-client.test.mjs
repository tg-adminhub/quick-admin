import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
  PROJECT_ORIGIN, GatewayError,
  createProtectedAdminClient,createSupabaseAuthAdapter
} from './secure-admin-client.mjs';

const KEY='b9844c95-8501-44f9-bcea-08aa98d9fc9a';
const AUTH='aaa.bbb.ccc';
const ADMIN={id:1,username:'demo-dev',name:'Demo Admin',role:'dev',
  branchId:null,visibleBranchIds:null};
const BRANCH={id:3,username:'branch',name:'Branch Admin',role:'branch',
  branchId:5,visibleBranchIds:[5,6]};
const member={id:11,username:'demo-member',real_name:'Test',status:'approved',branch_id:5,
  app_type:'toss',license_expires_at:'2099-01-01T00:00:00Z'};
const payment={id:12,user_id:11,amount:12000,status:'pending',
  created_at:'2026-10-31T00:00:00Z',branch_id:5};

function setup({token=AUTH,response,identity=ADMIN,throwFetch=false}={}){
  const calls=[];
  const fetchImpl=async (url,options)=>{
    calls.push({url,options});
    if(throwFetch)throw Error('network failure (sensitive detail)');
    if(response)return response(url,options);
    const path=new URL(url).pathname;
    if(path.endsWith('qa-admin-gateway'))return good({ok:true,admin:identity});
    if(path.endsWith('qa-admin-read')){
      const qp=new URL(url).searchParams;
      const resource=qp.get('resource');
      const items=resource==='members'?[member]:
        resource==='payments'?[payment]:[{id:5,name:'Branch',type:'branch',parent_id:null}];
      return good({ok:true,resource,items,
        limit:Number(qp.get('limit')),offset:Number(qp.get('offset'))});
    }
    const body=JSON.parse(options.body);
    const k=path.endsWith('qa-payment-review')?'paymentId':'memberId';
    return good({ok:true,[k]:body[k],
      ...(k==='paymentId'||path.endsWith('qa-member-review')?
        {status:body.action.endsWith('.approve')?'approved':'rejected'}:
        {action:body.action}),
      outcome:'updated'});
  };
  const client=createProtectedAdminClient({getAccessToken:async()=>token,
    fetchImpl,randomUUID:()=>KEY});
  return {client,calls};
}
function good(data,status=200){return {ok:status>=200&&status<300,status,json:async()=>data};}
async function errorCode(promise,code){
  await assert.rejects(promise,e=>e instanceof GatewayError && e.code===code);
}
test('secure identity uses verified gateway, never browser adminId',async()=>{
  const {client,calls}=setup();
  assert.deepEqual(await client.getIdentity(),ADMIN);
  assert.equal(calls[0].url,PROJECT_ORIGIN+'/functions/v1/qa-admin-gateway');
  assert.equal(calls[0].options.headers.Authorization,'Bearer '+AUTH);
  assert.equal(calls[0].options.method,'GET');
  assert.equal(calls[0].options.credentials,'omit');
  assert.equal(calls[0].options.redirect,'error');
  assert.equal(calls[0].options.cache,'no-store');
  assert.equal(calls[0].options.headers.apikey,undefined);
  assert.equal(calls[0].options.body,undefined);
});
test('branch-scoped identity comes only from returned trusted API profile',async()=>{
  const {client}=setup({identity:BRANCH});
  assert.deepEqual(await client.getIdentity(),BRANCH);
});
test('malformed backend identity is rejected fail-closed',async()=>{
  for(const identity of [
    {...ADMIN,role:'owner'}, {...ADMIN,visibleBranchIds:[5]},
    {...BRANCH,branchId:7}, {...BRANCH,visibleBranchIds:[5,'6']},
    {...BRANCH,visibleBranchIds:null},{...BRANCH,id:'3'}
  ]){
    const {client}=setup({identity});
    await errorCode(client.getIdentity(),'INVALID_GATEWAY_RESPONSE');
  }
});
test('allowlisted read queries are bounded and use fixed resources only',async()=>{
  const {client,calls}=setup();
  assert.deepEqual(await client.getList('members'),[member]);
  assert.deepEqual(await client.getList('payments',{limit:20,offset:2}),[payment]);
  assert.deepEqual(await client.getList('branches'),[{id:5,name:'Branch',type:'branch',parent_id:null}]);
  assert.equal(new URL(calls[0].url).searchParams.get('resource'),'members');
  assert.equal(new URL(calls[1].url).searchParams.get('limit'),'20');
  assert.equal(new URL(calls[1].url).searchParams.get('offset'),'2');
  assert.equal(calls.every(c=>c.url.startsWith(PROJECT_ORIGIN+'/functions/v1/qa-admin-')),true);
});
test('arbitrary table, extra search filters, and invalid pagination are rejected without network',async()=>{
  const {client,calls}=setup();
  for(const r of ['admins','users','payment_requests','app_settings','withdrawn_users','../admins','']){
    await errorCode(client.getList(r),'INVALID_QUERY');
  }
  for(const params of [{limit:0},{limit:101},{offset:-1},{offset:10001},{limit:'5'}]){
    await errorCode(client.getList('members',params),'INVALID_QUERY');
  }
  assert.equal(calls.length,0);
});
test('member approval/rejection, pause and device reset map to allowlisted actions',async()=>{
  const {client,calls}=setup();
  const types=[
    ['approveMember',{},'qa-member-review','member.approve','pending'],
    ['rejectMember',{reason:' verified '},'qa-member-review','member.reject','pending'],
    ['pauseMember',{},'qa-member-maintenance','member.pause','active'],
    ['resumeMember',{},'qa-member-maintenance','member.resume','paused'],
    ['resetMainDevice',{},'qa-member-maintenance','device.reset_main','bound'],
    ['resetExtraDevice',{deviceId:73},'qa-member-maintenance','device.reset_extra','bound'],
    ['approvePayment',{approvedAmount:35000},'qa-payment-review','payment.approve','pending'],
    ['rejectPayment',{reason:'invalid transfer'},'qa-payment-review','payment.reject','pending']
  ];
  for(const [type,extra,path,action,state] of types){
    const intent=client.prepare(type,17,extra);
    assert.equal(Object.isFrozen(intent),true);
    assert.equal(Object.isFrozen(intent.body),true);
    assert.equal(intent.body.idempotencyKey,KEY);
    assert.equal(intent.body.action,action);
    assert.equal(intent.body.expectedState??intent.body.expectedStatus,state);
    const result=await client.submit(intent);
    assert.equal(result.action,action);
    assert.equal(result.outcome,'updated');
    const sent=calls.at(-1);
    assert.ok(sent.url.endsWith('/'+path));
    assert.equal(sent.options.method,'POST');
    assert.equal(sent.options.credentials,'omit');
    assert.equal(JSON.parse(sent.options.body).idempotencyKey,KEY);
    assert.equal(JSON.parse(sent.options.body).adminId,undefined);
  }
  assert.equal(calls.length,8);
});
test('server errors and network errors never disclose sensitive upstream text',async()=>{
  for(const [response,expected] of [
    [()=>good({message:'SECRET'},401),'SESSION_EXPIRED'],
    [()=>good({message:'SECRET'},403),'ADMIN_ACCESS_DENIED'],
    [()=>good({message:'SECRET'},503),'GATEWAY_UNAVAILABLE'],
    [()=>good({ok:false},200),'INVALID_GATEWAY_RESPONSE']
  ]){
    const {client}=setup({response});
    await assert.rejects(client.getIdentity(),e=>{
      assert.equal(e instanceof GatewayError,true);
      assert.equal(e.code,expected);
      assert.equal(e.message.includes('SECRET'),false);
      return true;
    });
  }
  const {client}=setup({throwFetch:true});
  await errorCode(client.getIdentity(),'NETWORK_UNAVAILABLE');
});
test('missing, malformed or unavailable Auth token fails before HTTP',async()=>{
  for(const token of [null,'legacy_adminId','bad.jwt','x'.repeat(8200)]){
    const {client,calls}=setup({token});
    await errorCode(client.getIdentity(),'AUTH_REQUIRED');
    assert.equal(calls.length,0);
  }
});
test('response resource, row and page shape must match original request',async()=>{
  for(const payload of [
    {ok:true,resource:'admins',limit:25,offset:0,items:[member]},
    {ok:true,resource:'members',limit:1,offset:0,items:[member]},
    {ok:true,resource:'members',limit:25,offset:9,items:[member]},
    {ok:true,resource:'members',limit:25,offset:0,items:null},
    {ok:true,resource:'members',limit:25,offset:0,items:[{id:'11'}]}
  ]){
    const {client}=setup({response:()=>good(payload)});
    await errorCode(client.getList('members'),'INVALID_GATEWAY_RESPONSE');
  }
});
test('tampered action objects cannot inject privileged fields',async()=>{
  const {client,calls}=setup();
  const intent=client.prepare('approvePayment',17,{approvedAmount:45000});
  for(const change of [
    {...intent,body:{...intent.body,role:'dev'}},
    {...intent,body:{...intent.body,approvedAmount:900000000}},
    {...intent,body:{...intent.body,adminId:1}},
    {...intent,body:{...intent.body,expectedStatus:'approved'}},
    {...intent,id:18},
    {...intent,type:'deletePayment'},
    {...intent,body:{...intent.body,idempotencyKey:'invalid'}}
  ])await assert.rejects(client.submit(change),e=>
    e instanceof GatewayError &&
    ['INVALID_ACTION_INPUT','INVALID_AMOUNT','INVALID_IDEMPOTENCY_KEY'].includes(e.code)
  );
  assert.equal(calls.length,0);
});
test('same intent retries preserve idempotency key',async()=>{
  const {client,calls}=setup({response:(url,options)=>{
    const b=JSON.parse(options.body);
    return good({ok:true,paymentId:b.paymentId,status:'approved',
      outcome:calls.length===1?'updated':'duplicate'});
  }});
  const i=client.prepare('approvePayment',8,{approvedAmount:10000});
  assert.equal((await client.submit(i)).outcome,'updated');
  assert.equal((await client.submit(i)).outcome,'duplicate');
  assert.equal(calls[0].options.body,calls[1].options.body);
});
test('arbitrary API hosts and missing crypto/fetch dependencies are blocked',()=>{
  assert.throws(()=>createProtectedAdminClient({
    getAccessToken:async()=>AUTH,fetchImpl:async()=>good({}),randomUUID:()=>KEY,
    apiOrigin:'https://attacker.example'
  }),e=>e.code==='UNTRUSTED_API_ORIGIN');
  assert.throws(()=>createProtectedAdminClient({}),e=>e.code==='MISSING_CLIENT_DEPENDENCY');
});
test('Supabase email login adapter does not use legacy username or SHA256 lookup',async()=>{
  const actions=[];
  const supabase={auth:{
    signInWithPassword:async input=>{actions.push(['signin',input]);return {error:null}},
    getSession:async()=>({data:{session:{access_token:AUTH}},error:null}),
    signOut:async()=>{actions.push(['signout']);return {error:null}}
  }};
  const auth=createSupabaseAuthAdapter(supabase);
  await auth.signIn('admin@example.test','new-secure-password');
  assert.deepEqual(actions[0],['signin',{email:'admin@example.test',password:'new-secure-password'}]);
  assert.equal(await auth.getAccessToken(),AUTH);
  await auth.signOut();
  assert.deepEqual(actions.at(-1),['signout']);
  await errorCode(auth.signIn('legacyUsername','password'),'INVALID_CREDENTIAL_INPUT');
});
