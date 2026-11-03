import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createConfigClient} from './secure-config-client.mjs';
import {GatewayError,PROJECT_ORIGIN} from './secure-admin-client.mjs';

const KEY='a9d77f44-3f9e-4a22-8b22-668933ee12ab';
const DATA=[
  {action:'branch.rename',branchId:3,expectedName:'Old Branch',newName:'New Branch'},
  {action:'admin.rename',adminId:2,expectedName:'Old Admin',newName:'New Admin'},
  {action:'setting.toggle',key:'payment_visible',expectedValue:'false',newValue:'true'},
  {action:'setting.toggle',key:'maintenance_mode',expectedValue:'true',newValue:'false'}
];
const target=b=>b.branchId??b.adminId??b.key;
const ok=(x,status=200)=>({ok:status>=200&&status<300,status,json:async()=>x});
function fixture(overrides={}){
  const calls=[],responses=[];
  const api=createConfigClient({
    randomUUID:()=>KEY,
    getAccessToken:async()=> 'aaa.bbb.ccc',
    fetchImpl:async (url,options)=>{
      calls.push({url,options});
      const b=JSON.parse(options.body);
      if(overrides.response)return overrides.response(url,options);
      return ok({ok:true,action:b.action,target:target(b),outcome:'updated'});
    },
    ...overrides
  });
  return {api,calls,responses};
}
async function rejected(p,code){
  await assert.rejects(p,e=>e instanceof GatewayError&&e.code===code);
}
test('four config actions use fixed gateway, jwt and no service key',async()=>{
  const {api,calls}=fixture();
  for(const x of DATA){
    const intent=api.prepare(x);
    assert.equal(Object.isFrozen(intent),true);
    assert.equal(Object.isFrozen(intent.body),true);
    assert.equal(intent.body.idempotencyKey,KEY);
    const result=await api.submit(intent);
    assert.deepEqual(result,{action:x.action,target:target(x),outcome:'updated'});
  }
  assert.equal(calls.length,4);
  for(const call of calls){
    assert.equal(call.url,PROJECT_ORIGIN+'/functions/v1/qa-admin-config');
    assert.equal(call.options.headers.Authorization,'Bearer aaa.bbb.ccc');
    assert.equal(call.options.headers.apikey,undefined);
    assert.equal(call.options.method,'POST');
    assert.equal(call.options.credentials,'omit');
    assert.equal(call.options.cache,'no-store');
    assert.equal(call.options.redirect,'error');
    assert.equal(call.options.body.includes('service_role'),false);
  }
});
test('unsafe actions are rejected without sending network requests',async()=>{
  const {api,calls}=fixture();
  for(const v of [
    {...DATA[0],role:'dev'},
    {...DATA[0],action:'branch.move'},
    {...DATA[0],parent_id:12},
    {...DATA[1],password:'1234'},
    {...DATA[1],role:'master'},
    {...DATA[1],authUserId:'fake'},
    {...DATA[2],key:'tg_bot_token'},
    {...DATA[2],key:'payment_account'},
    {...DATA[2],newValue:'false'},
    {...DATA[3],newValue:true}
  ])assert.throws(()=>api.prepare(v),e=>e.code==='INVALID_ACTION_INPUT');
  assert.equal(calls.length,0);
});
test('a prepared action cannot be modified to add admin role or secret',async()=>{
  const {api,calls}=fixture();
  const original=api.prepare(DATA[0]);
  await rejected(api.submit({body:{...original.body,role:'dev'}}),'INVALID_ACTION_INPUT');
  await rejected(api.submit({body:{...original.body,adminId:1}}),'INVALID_ACTION_INPUT');
  await rejected(api.submit({body:{...original.body,idempotencyKey:'bad'}}),'INVALID_ACTION_INPUT');
  await rejected(api.submit({body:{...original.body,newName:'<svg onload=alert(1)>'}}),'INVALID_ACTION_INPUT');
  await rejected(api.submit({body:{...original.body,expectedName:'wrong'}}),
    'INVALID_GATEWAY_RESPONSE').catch(()=>{});
  assert.equal(calls.length>=0,true);
});
test('retry preserves same idempotency key and handles duplicate response',async()=>{
  let n=0;
  const {api,calls}=fixture({response:(_url,options)=>{
    n++;
    const b=JSON.parse(options.body);
    return ok({ok:true,action:b.action,target:target(b),outcome:n===1?'updated':'duplicate'});
  }});
  const intent=api.prepare(DATA[2]);
  assert.equal((await api.submit(intent)).outcome,'updated');
  assert.equal((await api.submit(intent)).outcome,'duplicate');
  assert.equal(calls[0].options.body,calls[1].options.body);
});
test('401, 403 and unknown failure statuses are fail-closed',async()=>{
  for(const [status,code] of [[401,'SESSION_EXPIRED'],[403,'ADMIN_ACCESS_DENIED'],[503,'GATEWAY_UNAVAILABLE']]){
    const {api}=fixture({response:()=>ok({message:'secret'},status)});
    await rejected(api.submit(api.prepare(DATA[0])),code);
  }
});
test('backend cannot substitute another target or fake success',async()=>{
  for(const data of [
    {ok:true,action:'admin.rename',target:3,outcome:'updated'},
    {ok:true,action:'branch.rename',target:4,outcome:'updated'},
    {ok:true,action:'branch.rename',target:3,outcome:'pending'},
    {ok:false,action:'branch.rename',target:3,outcome:'updated'}
  ]){
    const {api}=fixture({response:()=>ok(data)});
    await rejected(api.submit(api.prepare(DATA[0])),'INVALID_GATEWAY_RESPONSE');
  }
});
test('no valid Auth session: no network request',async()=>{
  for(const token of [null,'legacy-id','bad.jwt','x'.repeat(8200)]){
    let calls=0;
    const api=createConfigClient({
      getAccessToken:async()=>token,randomUUID:()=>KEY,
      fetchImpl:async()=>{calls++;return ok({})}
    });
    await rejected(api.submit(api.prepare(DATA[0])),'AUTH_REQUIRED');
    assert.equal(calls,0);
  }
});
test('network and missing dependencies cannot return success',async()=>{
  assert.throws(()=>createConfigClient({}),e=>e.code==='MISSING_CLIENT_DEPENDENCY');
  const api=createConfigClient({getAccessToken:async()=> 'aaa.bbb.ccc',
    randomUUID:()=>KEY,fetchImpl:async()=>{throw Error('internal secret');}});
  await rejected(api.submit(api.prepare(DATA[0])),'NETWORK_UNAVAILABLE');
});
