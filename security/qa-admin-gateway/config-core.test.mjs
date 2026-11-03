import {test} from 'node:test';
import assert from 'node:assert/strict';
import {handleAdminConfig,validateConfigMutation} from './config-core.mjs';

const END='https://example.supabase.co/functions/v1/qa-admin-config';
const UID='00000000-0000-4000-8000-000000000001';
const KEY='0a7f3e5e-08cf-499c-8eb3-a21a557f1e11';
const dev={enabled:true,adminId:1,username:'dev',displayName:'Developer',role:'dev',branchId:null,visibleBranchIds:null};
const scope={enabled:true,adminId:2,username:'branch',displayName:'Branch',role:'branch',branchId:5,visibleBranchIds:[5,6]};
const cases=[
  {action:'branch.rename',branchId:5,expectedName:'Old Branch',newName:'New Branch',idempotencyKey:KEY},
  {action:'admin.rename',adminId:9,expectedName:'Old Admin',newName:'New Admin',idempotencyKey:KEY},
  {action:'setting.toggle',key:'payment_visible',expectedValue:'false',newValue:'true',idempotencyKey:KEY},
  {action:'setting.toggle',key:'maintenance_mode',expectedValue:'true',newValue:'false',idempotencyKey:KEY}
];
const target=x=>x.branchId??x.adminId??x.key;
function req(body=cases[0],options={}){
  const method=options.method??'POST';
  const h={origin:options.origin??'https://tg-adminhub.github.io',
    'content-type':options.contentType??'application/json'};
  if(options.token!==null)h.authorization='Bearer '+(options.token??'a.b.c');
  if(options.cookie)h.cookie=options.cookie;
  return new Request(options.url??END,{method,headers:h,
    ...(method==='POST'?{body:typeof body==='string'?body:JSON.stringify(body)}:{})});
}
function deps(overrides={}){
  return {verifyBearer:async token=>token==='a.b.c'?UID:null,
    loadAdmin:async()=>dev,
    executeConfig:async arg=>({action:arg.action,target:target(arg),outcome:'updated'}),
    ...overrides};
}
test('all four allowed dev operations pass only reviewed data to DB RPC',async()=>{
  for(const c of cases){
    let received;
    const res=await handleAdminConfig(req(c),deps({executeConfig:async arg=>{
      received=arg;return {action:arg.action,target:target(arg),outcome:'updated',password:'NEVER'};
    }}));
    assert.equal(res.status,200);
    assert.deepEqual(await res.json(),{ok:true,action:c.action,target:target(c),outcome:'updated'});
    assert.deepEqual(received,{authUserId:UID,...c});
    assert.equal(Object.isFrozen(validateConfigMutation(c)),true);
  }
});
test('unverified user, revoked mapping and scoped roles do not execute',async()=>{
  let calls=0;
  const executeConfig=async()=>{calls++;return {}};
  assert.equal((await handleAdminConfig(req(cases[0],{token:null}),deps({executeConfig}))).status,401);
  assert.equal((await handleAdminConfig(req(cases[0],{token:'invalid'}),deps({executeConfig}))).status,401);
  assert.equal((await handleAdminConfig(req(),deps({verifyBearer:async()=>null,executeConfig}))).status,401);
  assert.equal((await handleAdminConfig(req(),deps({loadAdmin:async()=>({...dev,enabled:false}),executeConfig}))).status,403);
  for(const role of ['master','branch','sub']){
    assert.equal((await handleAdminConfig(req(),deps({loadAdmin:async()=>({...scope,role}),executeConfig}))).status,403);
  }
  assert.equal(calls,0);
});
test('unknown operations and dangerous updates are not representable',async()=>{
  let calls=0;
  const executeConfig=async()=>{calls++;return {}};
  for(const invalid of [
    {...cases[0],action:'branch.move'},
    {...cases[0],action:'branch.delete'},
    {...cases[0],parent_id:9},
    {...cases[0],role:'dev'},
    {...cases[0],branchId:0},
    {...cases[0],branchId:'5'},
    {...cases[0],expectedName:'Old <script>'},
    {...cases[0],newName:'<img src=x onerror=alert(1)>'},
    {...cases[0],newName:'New&Admin'},
    {...cases[0],newName:''},
    {...cases[0],newName:'  padded  '},
    {...cases[0],newName:'a'.repeat(81)},
    {...cases[0],newName:'Old Branch'},
    {...cases[1],password:'weak'},
    {...cases[1],role:'dev'},
    {...cases[1],authUserId:UID},
    {...cases[1],adminId:1.4},
    {...cases[2],key:'tg_bot_token'},
    {...cases[2],key:'payment_account'},
    {...cases[2],key:'force_update'},
    {...cases[2],newValue:'false'},
    {...cases[2],newValue:true},
    {...cases[2],newValue:'0'},
    {...cases[2],expectedValue:'maybe'},
    {...cases[0],idempotencyKey:'INVALID'},
    {...cases[0],idempotencyKey:'00000000-0000-0000-0000-000000000000'}
  ]){
    const response=await handleAdminConfig(req(invalid),deps({executeConfig}));
    assert.equal(response.status,400,JSON.stringify(invalid));
  }
  assert.equal(calls,0);
});
test('Korean names and bounded simple formatting accepted',()=>{
  const c={...cases[0],newName:'경기 제1지사 (신규)'};
  assert.equal(validateConfigMutation(c).newName,'경기 제1지사 (신규)');
  assert.equal(validateConfigMutation({...cases[1],newName:'홍길동_개발팀'}).newName,'홍길동_개발팀');
});
test('two calls check administrator mapping again for revocation',async()=>{
  let enabled=true,executions=0;
  const d=deps({loadAdmin:async()=>({...dev,enabled}),executeConfig:async a=>{
    executions++;return {action:a.action,target:target(a),outcome:'updated'};
  }});
  assert.equal((await handleAdminConfig(req(),d)).status,200);
  enabled=false;
  assert.equal((await handleAdminConfig(req(),d)).status,403);
  assert.equal(executions,1);
});
test('retry with same operation may return duplicate without leaking data',async()=>{
  let calls=0;
  const d=deps({executeConfig:async a=>{
    calls++;return {action:a.action,target:target(a),outcome:calls===1?'updated':'duplicate',secret:'redacted'};
  }});
  assert.equal((await (await handleAdminConfig(req(),d)).json()).outcome,'updated');
  const repeated=await (await handleAdminConfig(req(),d)).json();
  assert.equal(repeated.outcome,'duplicate');
  assert.equal(JSON.stringify(repeated).includes('secret'),false);
});
test('invalid DB responses are rejected as failed',async()=>{
  for(const output of [null,{},[],{action:'admin.rename',target:5,outcome:'updated'},
    {action:'branch.rename',target:6,outcome:'updated'},
    {action:'branch.rename',target:5,outcome:'failed'}]){
    const r=await handleAdminConfig(req(),deps({executeConfig:async()=>output}));
    assert.equal(r.status,503);
    assert.equal((await r.json()).code,'CONFIG_RESULT_INVALID');
  }
});
test('failure paths fail closed',async()=>{
  assert.equal((await handleAdminConfig(req(),deps({verifyBearer:async()=>{throw Error('offline')}}))).status,503);
  assert.equal((await handleAdminConfig(req(),deps({loadAdmin:async()=>{throw Error('offline')}}))).status,503);
  assert.equal((await handleAdminConfig(req(),deps({executeConfig:async()=>{throw Error('offline')}}))).status,503);
});
test('CORS, cookies, query params, paths and HTTP verbs are restricted',async()=>{
  const bad=await handleAdminConfig(req(cases[0],{origin:'https://evil.example'}),deps());
  assert.equal(bad.status,403);
  assert.equal(bad.headers.get('access-control-allow-origin'),null);
  assert.equal((await handleAdminConfig(req(cases[0],{cookie:'qa_session=1'}),deps())).status,400);
  assert.equal((await handleAdminConfig(req(cases[0],{url:END+'?role=dev'}),deps())).status,400);
  assert.equal((await handleAdminConfig(req(cases[0],{url:END+'/admin'}),deps())).status,404);
  assert.equal((await handleAdminConfig(req(cases[0],{method:'GET'}),deps())).status,405);
  assert.equal((await handleAdminConfig(req(cases[0],{contentType:'text/plain'}),deps())).status,415);
  const pf=await handleAdminConfig(req(cases[0],{method:'OPTIONS',token:null}),deps());
  assert.equal(pf.status,204);
});
test('malformed or oversized JSON, object pollution fields are refused',async()=>{
  for(const input of ['invalid','[]','null',JSON.stringify({...cases[0],padding:'x'.repeat(3000)}),
    JSON.stringify(cases[0]).replace('"branchId":5','"branchId":5,"__proto__":{"role":"dev"}')]){
    assert.equal((await handleAdminConfig(req(input),deps())).status,400);
  }
});
